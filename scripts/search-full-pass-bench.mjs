#!/usr/bin/env node
// И4 риск-гейт (SEARCH-SPEC.md §10, "И4. Только если замер полного
// прохода потребует") — реальный браузер, реальная IndexedDB, синтетика
// на n = 10³/10⁴/10⁵ строк messages (доминирующий источник, SEARCH-ALGO.md
// §2). Запрос — заведомо непопадающий (случайный uuid), чтобы форсировать
// ПОЛНЫЙ обход без выгоды от досрочного прекращения (ALGO.md §6: "полный
// проход неизбежен на любом запросе, ничего не нашедшем" — именно этот
// случай определяет, нужен ли воркер).
//
// Не in-memory pipeline (это уже отдельно проверено в И0 через
// fake-indexeddb, scripts/search-io-bench.mjs, там нет реального браузера
// и реальной IndexedDB) — здесь честные тайминги на реальном стеке,
// закрывающие оговорку "нижняя граница" из И0/П-2.
//
// Dev-сервер (npm run dev), не vite preview/dist: vite-plugin-singlefile
// склеивает всё в один файл, путей /src/... для динамического импорта в
// dist/ нет вовсе (найдено при первом запуске — TypeError: Failed to
// fetch dynamically imported module). Доминирующая стоимость по ALGO.md
// §4 — расшифровка и чтение IndexedDB, не JS-оркестрация выше неё; для
// ЭТОГО гейта (нужен ли воркер) разница dev/prod по орchestration-коду
// не искажает вывод.
//
// Использование: node scripts/search-full-pass-bench.mjs

import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = 4342;
const SCALES = [1000, 10000, 100000];
const N_FRAME_BUDGET_MS = 50; // SEARCH-SPEC.md §6, N-FRAME
const SECONDS_THRESHOLD_MS = 1500; // ALGO.md §6: "дёргающийся интерфейс в течение нескольких секунд читается как зависание"

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

// Тот же путь, что run-ugolok/driver.mjs's `register` (English locale —
// headless Chromium без --lang берёт en-US, SKILL.md run-ugolok
// "Gotchas"; p-spike-bench.mjs's русские locator'ы для ЭТОЙ среды не
// подходят, найдено при запуске этого скрипта).
async function registerAccount(page) {
	await page.goto(`http://localhost:${PORT}/#/main`, { waitUntil: "load" });
	await page.waitForSelector('input[type="text"]', { timeout: 15_000 });
	const login = "search-bench-" + Date.now();
	await page.fill('input[type="text"]', login);
	await page.fill("#reg-password", "search-bench-password");
	await page.fill("#reg-password-confirm", "search-bench-password");
	await page.getByRole("button", { name: "Continue", exact: true }).click();
	await page.waitForSelector("ol li", { timeout: 15_000 });
	const mnemonic = (await page.evaluate(() => [...document.querySelectorAll("ol li")].map((li) => li.textContent.trim()))).join(" ");
	await page.getByRole("button", { name: "I've saved the phrase" }).click();
	await page.waitForSelector("#confirm-mnemonic", { timeout: 10_000 });
	await page.fill("#confirm-mnemonic", mnemonic);
	await page.getByRole("button", { name: "Confirm", exact: true }).click();
	await page.waitForSelector("text=/Go to the app/", { timeout: 10_000 });
	await page.getByRole("button", { name: "Go to the app" }).click();
	await page.waitForTimeout(500);
}

// Сидирование и замер — ОДНА функция в браузере (реальные модули
// приложения, реальный dbKey уже разблокированной сессии).
async function seedAndMeasure(page, n) {
	return page.evaluate(async (n) => {
		const auth = await import("/src/ui/signals/auth.js");
		const keys = await import("/src/core/crypto/keys.js");
		const dbmod = await import("/src/core/store/database.js");
		const enc = await import("/src/core/store/encrypted-table.js");
		const fields = await import("/src/core/store/table-fields.js");
		const engine = await import("/src/domain/search/engine.js");

		const pub = keys.getPublicKey(auth.privKeySig.value);
		const owner = [...pub].map((b) => b.toString(16).padStart(2, "0")).join("");
		const dbKey = auth.dbKeySig.value;
		const db = dbmod.db;

		await db.table("messages").where("ownerPubkey").equals(owner).delete();

		const ALPHABET = "абвгдежзийклмнопрстуфхцчшщъыьэюя ";
		function randomText(len) {
			let s = "";
			for (let i = 0; i < len; i++) s += ALPHABET[(Math.random() * ALPHABET.length) | 0];
			return s;
		}

		const BATCH = 500;
		for (let i = 0; i < n; i += BATCH) {
			const rows = [];
			const end = Math.min(i + BATCH, n);
			for (let j = i; j < end; j++) {
				rows.push(
					enc.toEncryptedRow(
						{
							ownerPubkey: owner,
							chatId: `bench-chat-${j % 50}`,
							msgId: `bench-${j}`,
							lamportTs: j,
							senderPubkey: owner,
							id: `bench-id-${j}`,
							status: "sent",
							deleted: false,
							sentAt: 1700000000 + j,
							text: randomText(150 + ((j * 37) % 250)),
						},
						fields.MESSAGES_PLAINTEXT_FIELDS,
						dbKey,
					),
				);
			}
			await db.table("messages").bulkAdd(rows);
			await new Promise((r) => setTimeout(r, 0));
		}

		// Заведомо непопадающий запрос — форсирует полный обход без выгоды
		// от досрочного прекращения (ALGO.md §6).
		const query = "zzz-no-match-" + crypto.randomUUID();
		const ctx = { ownerPubkey: owner, dbKey };
		const controller = new AbortController();

		// Heartbeat — засекает максимальный разрыв между тиками во время
		// прохода, косвенный признак блокировки главного потока дольше
		// одного кадра (N-FRAME, SEARCH-SPEC.md §6).
		const gaps = [];
		let lastTick = performance.now();
		const heartbeat = setInterval(() => {
			const now = performance.now();
			gaps.push(now - lastTick);
			lastTick = now;
		}, 4);

		const t0 = performance.now();
		let count = 0;
		for await (const _ of engine.search(ctx, query, { signal: controller.signal, limitPerType: 100 })) {
			count++;
		}
		const elapsedMs = performance.now() - t0;
		clearInterval(heartbeat);

		const maxGapMs = gaps.length ? Math.max(...gaps) : 0;
		return { n, elapsedMs, maxGapMs, matchCount: count };
	}, n);
}

async function main() {
	console.log(`Запускаю vite dev на порту ${PORT}...`);
	const preview = spawn("npx", ["vite", "--port", String(PORT)], { stdio: "ignore", detached: true });
	try {
		await waitForServer(`http://localhost:${PORT}/`);

		const browser = await chromium.launch();
		try {
			const context = await browser.newContext();
			const page = await context.newPage();
			const consoleErrors = [];
			page.on("pageerror", (e) => consoleErrors.push(String(e)));
			page.on("console", (m) => {
				if (m.type() === "error") consoleErrors.push(m.text());
			});

			await registerAccount(page);

			const results = [];
			for (const n of SCALES) {
				console.log(`\n=== n=${n}: сидирование + полный проход (непопадающий запрос) ===`);
				const result = await seedAndMeasure(page, n);
				results.push(result);
				console.log(`  время прохода: ${result.elapsedMs.toFixed(1)} мс, макс. разрыв heartbeat: ${result.maxGapMs.toFixed(1)} мс, совпадений: ${result.matchCount}`);
			}

			if (consoleErrors.length) {
				console.error("\nОшибки консоли браузера за весь прогон:", consoleErrors.join("; "));
			}

			console.log("\n=== Итог ===");
			let anySeconds = false;
			let anyFrameViolation = false;
			for (const r of results) {
				const secondsFlag = r.elapsedMs >= SECONDS_THRESHOLD_MS;
				const frameFlag = r.maxGapMs > N_FRAME_BUDGET_MS;
				anySeconds = anySeconds || secondsFlag;
				anyFrameViolation = anyFrameViolation || frameFlag;
				console.log(`  n=${r.n}: ${r.elapsedMs.toFixed(0)} мс (${secondsFlag ? "СЕКУНДЫ — порог И4.3" : "OK"}), N-FRAME макс. разрыв ${r.maxGapMs.toFixed(0)} мс (${frameFlag ? "ПРЕВЫШЕН" : "OK"})`);
			}

			console.log("\n=== Решение по И4 (SEARCH-SPEC.md §10) ===");
			if (anySeconds || anyFrameViolation) {
				console.log("Порог достигнут — задачи 4.1/4.3 (кэш/воркер) ОБОСНОВАНЫ числами выше.");
			} else {
				console.log("Порог НЕ достигнут ни на одном масштабе — И4 не открывается, порционного обхода достаточно.");
			}
		} finally {
			await browser.close();
		}
	} finally {
		process.kill(-preview.pid);
	}
}

main().catch((e) => {
	console.error("search-full-pass-bench: ошибка", e);
	process.exitCode = 1;
});
