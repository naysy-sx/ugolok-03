#!/usr/bin/env node
// P-SPIKE — перформанс риск-гейт (TECH.md §13.1, PLAN.md этап 15).
// Методология и обоснование — DESIGN.md, раздел "Этап 15".
//
// Запускает реальный пайплайн (batch-verify через crypto.worker.js,
// расшифровка, LWW/G-Set fold, запись через encrypted-table) на 5000
// синтетических событиях внутри РЕАЛЬНОГО браузера (не node --test —
// Worker и реалистичный IndexedDB требуют браузер, см. DESIGN.md) —
// дважды: без троттлинга и под управляемым CPU-троттлингом 1.5×
// (Chrome DevTools Protocol, честный замер, не постфактум-умножение).
// Критерий NF-09: оба прогона ≤ 30000 мс.
//
// Использование: node scripts/p-spike-bench.mjs
// Требует: собранный dist/ (соберёт сам, если нет), playwright (devDependency).

import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = 4340;
const NF09_THRESHOLD_MS = 30000;
const MOBILE_CPU_THROTTLE_RATE = 1.5;

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

async function registerAndOpenDiagnostics(page) {
	await page.goto(`http://localhost:${PORT}/`, { waitUntil: "load" });
	await page.waitForTimeout(400);
	await page.evaluate(() => {
		location.hash = "/onboarding";
	});
	await page.waitForTimeout(300);
	const login = "p-spike-bench-" + Date.now();
	await page.locator("#reg-login").fill(login);
	await page.locator("#reg-password").fill("p-spike-bench-password");
	await page.locator("#reg-password-confirm").fill("p-spike-bench-password");
	await page.getByRole("button", { name: "Зарегистрироваться" }).click();
	await page.waitForTimeout(300);
	await page.getByRole("button", { name: "Перейти в приложение" }).click();
	await page.waitForTimeout(300);
	await page.getByRole("button", { name: "Диагностика", exact: true }).click();
	await page.waitForTimeout(300);
}

async function runBenchmarkOnce(browser, { throttle }) {
	const context = await browser.newContext();
	const page = await context.newPage();
	const consoleErrors = [];
	page.on("pageerror", (e) => consoleErrors.push(String(e)));
	page.on("console", (m) => {
		if (m.type() === "error") consoleErrors.push(m.text());
	});

	await registerAndOpenDiagnostics(page);

	if (throttle) {
		const cdp = await context.newCDPSession(page);
		await cdp.send("Emulation.setCPUThrottlingRate", { rate: MOBILE_CPU_THROTTLE_RATE });
	}

	await page.getByRole("button", { name: "Запустить P-SPIKE (5000 событий)" }).click();

	// прогон пайплайна на 5000 событий может занимать десятки секунд —
	// ждём, пока статус перестанет начинаться с "прогон"/"генерация"
	await page.waitForFunction(
		() => {
			const el = [...document.querySelectorAll("strong")].find((s) => s.previousSibling?.textContent?.includes("Этап 15"));
			return el && !el.textContent.startsWith("не запущен") && !el.textContent.includes("прогон") && !el.textContent.includes("генерация");
		},
		{ timeout: 120000 },
	);

	const statusText = await page.evaluate(() => {
		const el = [...document.querySelectorAll("strong")].find((s) => s.previousSibling?.textContent?.includes("Этап 15"));
		return el?.textContent ?? "";
	});

	await context.close();

	if (consoleErrors.length) {
		throw new Error(`ошибки консоли браузера: ${consoleErrors.join("; ")}`);
	}

	const match = statusText.match(/\((\d+) мс/);
	if (!match) {
		throw new Error(`не удалось распознать результат замера: "${statusText}"`);
	}
	return { elapsedMs: Number(match[1]), statusText };
}

async function main() {
	if (!existsSync("dist/index.html")) {
		console.log("dist/ не найден — собираю...");
		await run("npm", ["run", "build"]);
	}

	console.log(`Запускаю vite preview на порту ${PORT}...`);
	const preview = spawn("npx", ["vite", "preview", "--port", String(PORT)], { stdio: "ignore", detached: true });
	try {
		await waitForServer(`http://localhost:${PORT}/`);

		const browser = await chromium.launch();
		try {
			console.log("\n=== Прогон 1×, без троттлинга ===");
			const normal = await runBenchmarkOnce(browser, { throttle: false });
			console.log(normal.statusText);

			console.log("\n=== Прогон под CPU-троттлингом ×1.5 (реальный замер, не арифметика) ===");
			const throttled = await runBenchmarkOnce(browser, { throttle: true });
			console.log(throttled.statusText);

			const normalOk = normal.elapsedMs <= NF09_THRESHOLD_MS;
			const throttledOk = throttled.elapsedMs <= NF09_THRESHOLD_MS;

			console.log("\n=== Итог (NF-09: ≤30000 мс на 5000 событий) ===");
			console.log(`1×:      ${normal.elapsedMs} мс — ${normalOk ? "OK" : "ПРОВАЛ"}`);
			console.log(`1.5× CPU: ${throttled.elapsedMs} мс — ${throttledOk ? "OK" : "ПРОВАЛ"}`);

			if (!normalOk || !throttledOk) {
				console.error("\nP-SPIKE ПРОВАЛЕН — см. TECH.md §13.1.1 (обратное ребро к решениям этапов 3-4: форма fold, encrypted-table, батчинг IndexedDB)");
				process.exitCode = 1;
			} else {
				console.log("\nP-SPIKE пройден.");
			}
		} finally {
			await browser.close();
		}
	} finally {
		process.kill(-preview.pid);
	}
}

main().catch((e) => {
	console.error("P-SPIKE bench: ошибка", e);
	process.exitCode = 1;
});
