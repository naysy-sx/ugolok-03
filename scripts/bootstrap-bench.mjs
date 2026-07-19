#!/usr/bin/env node
// AC-12/AC-13 (TECH.md §15) — реальный замер холодного bootstrap против
// РЕАЛЬНОГО strfry (server/strfry, whitelist.json="*" — открыт локально,
// см. server/README.md), не in-memory pipeline (это уже отдельно проверено
// P-SPIKE/NF-09, scripts/p-spike-bench.mjs — там нет сети вовсе).
//
// Методология: N gift-wrapped CONTACT_REQUEST_KIND (3001) событий, каждое
// от СВОЕГО случайного отправителя (contactRequests таблица — put по
// [owner+senderPubkey], одинаковый отправитель схлопнул бы записи, нужны
// N РАЗНЫХ, не N публикаций одного и того же) — публикуются НАПРЯМУЮ через
// relay-pool.js/publisher.js (без браузера, дешевле и не входит в
// замеряемую фазу). Затем реальный браузер логинится ПОД ЭТИМ ЖЕ owner'ом
// (импорт nsec — тот же ключ, что получал события) и измеряется время от
// входа до появления "Запросы (N)" в контактах (giftWrapSubscriber
// обработал весь backlog).
//
// Использование: node scripts/bootstrap-bench.mjs [--only=1000|5000]

import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { nsecEncode } from "nostr-tools/nip19";
import { bytesToHex } from "@noble/hashes/utils.js";
import { getPublicKey } from "../src/core/crypto/keys.js";
import { wrap as nip59Wrap } from "../src/core/crypto/nip59.js";
import { createRelayConnection } from "../src/core/transport/relay-pool.js";
import { createPublisher } from "../src/core/transport/publisher.js";

const PORT = 4341;
const RELAY_URL = "ws://127.0.0.1:7777";
const THRESHOLDS = { 1000: 10000, 5000: 30000 }; // AC-12/AC-13, мс

function buildContactRequestRumor(greeting) {
	return { kind: 3001, content: greeting, tags: [], created_at: Math.floor(Date.now() / 1000) };
}

async function waitForConnState(conn, predicate, timeoutMs) {
	const t0 = Date.now();
	while (!predicate(conn.getState())) {
		if (Date.now() - t0 > timeoutMs) throw new Error(`таймаут ожидания состояния (сейчас: ${conn.getState()})`);
		await sleep(50);
	}
}

async function publishFixtures(count, ownerPubHex) {
	const conn = createRelayConnection(RELAY_URL, {});
	conn.connect();
	await waitForConnState(conn, (s) => s === "connected", 8000);
	const publisher = createPublisher(conn);
	conn.addMessageHandler(publisher.handleMessage);

	console.log(`  публикация ${count} gift-wrapped contact-request событий (каждое — свой отправитель)...`);
	const t0 = performance.now();
	let ok = 0;
	// Публикуем пачками, чтобы не открывать 1000+ одновременных ожиданий OK —
	// сама публикация НЕ входит в замеряемую фазу (AC-12/13 замеряет BOOTSTRAP,
	// не подготовку фикстур — тот же принцип, что synthetic-fixtures.js/P-SPIKE).
	const BATCH = 50;
	for (let i = 0; i < count; i += BATCH) {
		const batchPromises = [];
		for (let j = i; j < Math.min(i + BATCH, count); j++) {
			const senderPriv = crypto.getRandomValues(new Uint8Array(32));
			const giftWrap = nip59Wrap(buildContactRequestRumor(`bench-${j}`), senderPriv, ownerPubHex);
			batchPromises.push(publisher.publish(giftWrap));
		}
		const results = await Promise.all(batchPromises);
		ok += results.filter((r) => r.ok).length;
	}
	const elapsedMs = performance.now() - t0;
	console.log(`  готово: ${ok}/${count} приняты relay за ${elapsedMs.toFixed(0)} мс (подготовка, не входит в замер AC-12/13)`);
	conn.close();
	if (ok < count) throw new Error(`relay принял только ${ok}/${count} — whitelist? см. server/strfry/whitelist.json`);
}

function run(cmd, args, opts = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(cmd, args, { stdio: "inherit", ...opts });
		child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(" ")} завершился с кодом ${code}`))));
	});
}

async function waitForServer(url, retries = 30) {
	for (let i = 0; i < retries; i++) {
		try {
			const res = await fetch(url);
			if (res.ok) return;
		} catch {
			// сервер ещё не поднялся
		}
		await sleep(300);
	}
	throw new Error(`preview-сервер не ответил за отведённое время: ${url}`);
}

async function measureBootstrap(browser, { nsec, expectedCount }) {
	const context = await browser.newContext();
	const page = await context.newPage();
	const consoleErrors = [];
	page.on("pageerror", (e) => consoleErrors.push(String(e)));
	page.on("console", (m) => console.log("[browser]", m.type(), m.text()));

	await page.goto(`http://localhost:${PORT}/#/onboarding`, { waitUntil: "load" });
	await page.waitForTimeout(400);

	await page.getByText("Другие способы (для опытных пользователей)").click();
	await page.waitForTimeout(200);
	await page.getByRole("button", { name: "Войти по ключу (nsec)" }).click();
	await page.waitForTimeout(200);
	await page.locator("#import-key").fill(nsec);

	const t0 = performance.now();
	await page.getByRole("button", { name: "Продолжить" }).click();
	await page.waitForTimeout(200);
	await page.locator("#adv-login").fill("bootstrap-bench");
	await page.locator("#adv-password").fill("bootstrap-bench-password");
	await page.locator("#adv-password-confirm").fill("bootstrap-bench-password");
	await page.getByRole("button", { name: "Сохранить" }).click();
	await page.waitForTimeout(200);
	await page.getByRole("button", { name: "Перейти в приложение" }).click();

	// Контакты — экран по умолчанию НЕ обязателен, значит открываем явно;
	// сам заход на экран уже вызывает ensureConnected -> connect() -> giftWrapSubscriber.
	await page.getByRole("button", { name: "Контакты", exact: true }).click();

	try {
		await page.waitForFunction(
			(expected) => {
				const heading = document.querySelector("#requests-heading");
				return heading && heading.textContent.includes(`(${expected})`);
			},
			expectedCount,
			{ timeout: 120000 },
		);
	} catch (err) {
		const heading = await page.locator("#requests-heading").textContent().catch(() => "<not found>");
		console.log("DEBUG: #requests-heading содержимое на момент таймаута:", heading);
		throw err;
	}
	const elapsedMs = performance.now() - t0;

	await context.close();
	if (consoleErrors.length) throw new Error(`ошибки консоли браузера: ${consoleErrors.join("; ")}`);
	return elapsedMs;
}

async function main() {
	const onlyArg = process.argv.find((a) => a.startsWith("--only="));
	const only = onlyArg ? Number(onlyArg.split("=")[1]) : null;
	const counts = only ? [only] : [1000, 5000];

	// vite.config.js's buildDefaultRelays(command) даёт РАЗНЫЙ дефолт для 'build'
	// (прод-заглушка wss://relay.example, недостижимая) — нужен явный override на
	// локальный strfry (RUNBOOK.md §3.4: "реальный релиз подставляет relay-список
	// через env"), иначе холодный клиент вообще не подключится ни к чему.
	console.log("Пересобираю dist/ с BUILD_DEFAULT_RELAYS=локальный strfry...");
	await run("npm", ["run", "build"], { env: { ...process.env, BUILD_DEFAULT_RELAYS: JSON.stringify([RELAY_URL]) } });

	console.log(`Запускаю vite preview на порту ${PORT}...`);
	const preview = spawn("npx", ["vite", "preview", "--port", String(PORT)], { stdio: "ignore", detached: true });
	const results = {};
	try {
		await waitForServer(`http://localhost:${PORT}/`);
		const browser = await chromium.launch();
		try {
			for (const count of counts) {
				console.log(`\n=== AC-${count === 1000 ? "12" : "13"}: bootstrap ${count} событий (порог ${THRESHOLDS[count]} мс) ===`);
				const ownerPriv = crypto.getRandomValues(new Uint8Array(32));
				const ownerPubHex = bytesToHex(getPublicKey(ownerPriv));
				const nsec = nsecEncode(ownerPriv);

				await publishFixtures(count, ownerPubHex);

				console.log("  измеряю холодный bootstrap реального клиента...");
				const elapsedMs = await measureBootstrap(browser, { nsec, expectedCount: count });
				const ok = elapsedMs <= (THRESHOLDS[count] ?? Infinity);
				results[count] = { elapsedMs, ok };
				console.log(`  ${elapsedMs.toFixed(0)} мс — ${ok ? "OK" : "ПРОВАЛ"}`);
			}
		} finally {
			await browser.close();
		}

		console.log("\n=== Итог ===");
		let allOk = true;
		for (const count of counts) {
			const r = results[count];
			console.log(`AC-${count === 1000 ? "12" : "13"} (${count} событий, порог ${THRESHOLDS[count] ?? "н/д"} мс): ${r.elapsedMs.toFixed(0)} мс — ${r.ok ? "OK" : "ПРОВАЛ"}`);
			if (!r.ok) allOk = false;
		}
		process.exitCode = allOk ? 0 : 1;
	} finally {
		process.kill(-preview.pid);
	}
}

main().catch((e) => {
	console.error("bootstrap-bench: ошибка", e);
	process.exitCode = 1;
});
