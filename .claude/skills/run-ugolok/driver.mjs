// REPL-драйвер для "Уголок" (Preact SPA, сборка в один файл через
// vite-plugin-singlefile). chromium-cli в этом окружении недоступен ->
// водим настоящий Chromium через Playwright (уже devDependency, браузеры
// уже закешированы). Работает поверх dev-сервера Vite (npm run dev,
// по умолчанию http://localhost:5173).
//
// Рассчитан на агентов: команды текстом через stdin (по одной в строке),
// результат — в stdout. Для интерактивной отладки — под tmux/send-keys.
import { chromium } from "playwright";
import * as readline from "node:readline";
import * as fs from "node:fs";
import * as path from "node:path";

const BASE_URL = process.env.BASE_URL || "http://localhost:5173";
const SHOT_DIR = process.env.SCREENSHOT_DIR || "/tmp/ugolok-shots";
fs.mkdirSync(SHOT_DIR, { recursive: true });

let browser = null;
let page = null;

const COMMANDS = {
	async launch() {
		if (browser) return console.log("already launched");
		browser = await chromium.launch({ args: ["--no-sandbox"] });
		page = await browser.newPage();
		page.on("console", (msg) => {
			if (msg.type() === "error") console.log("[console error]", msg.text());
		});
		await page.goto(`${BASE_URL}/#/main`, { waitUntil: "domcontentloaded", timeout: 30_000 });
		console.log("launched:", page.url());
	},

	// НАСТОЯЩАЯ перезагрузка (page.reload(), не goto тем же URL — goto на
	// идентичный URL с тем же #hash Chromium трактует как same-document
	// навигацию и НЕ перезагружает документ вовсе, JS-состояние остаётся
	// как есть, экран unlock не покажется даже после "выхода"). Тот же
	// browser context, те же локальные аккаунты (IndexedDB) — нужно для
	// проверки "Sign in" после register() в рамках ОДНОЙ сессии драйвера
	// (новый launch поднимает новый временный профиль, старые аккаунты
	// не увидит).
	async reload() {
		if (!page) return console.log("ERROR: launch first");
		await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 });
		console.log("reloaded:", page.url());
	},

	async ss(name) {
		if (!page) return console.log("ERROR: launch first");
		const f = path.join(SHOT_DIR, (name || `ss-${Date.now()}`) + ".png");
		await page.screenshot({ path: f });
		console.log("screenshot:", f);
	},

	// У Preact controlled-инпутов события — через настоящий ввод (page.fill/
	// type), НЕ через eval `el.value = ...` (onInput так не сработает,
	// значение останется "невидимым" для состояния компонента).
	async fill(args) {
		if (!page) return console.log("ERROR: launch first");
		const [sel, ...rest] = args.split(" ");
		const value = rest.join(" ");
		try {
			await page.fill(sel, value);
			console.log("fill", sel, "-> OK");
		} catch (e) {
			console.log("ERROR:", e.message);
		}
	},

	async click(sel) {
		if (!page) return console.log("ERROR: launch first");
		try {
			await page.click(sel, { timeout: 10_000 });
			console.log("click", sel, "-> OK");
		} catch (e) {
			console.log("ERROR:", e.message);
		}
	},

	async "click-text"(text) {
		if (!page) return console.log("ERROR: launch first");
		const r = await page.evaluate((t) => {
			const els = [...document.querySelectorAll("button, a, [role='button'], [role='tab']")];
			const el = els.find((e) => e.textContent?.trim() === t) ?? els.find((e) => e.textContent?.includes(t));
			if (!el) return "NOT_FOUND";
			el.click();
			return "OK: " + el.tagName;
		}, text);
		console.log("click-text", JSON.stringify(text), "->", r);
	},

	async type(text) {
		if (page) await page.keyboard.type(text, { delay: 20 });
	},
	async press(key) {
		if (page) await page.keyboard.press(key);
	},

	async wait(sel) {
		if (!page) return console.log("ERROR: launch first");
		try {
			await page.waitForSelector(sel, { timeout: 15_000 });
			console.log("found:", sel);
		} catch {
			console.log("TIMEOUT:", sel);
		}
	},

	async "wait-text"(text) {
		if (!page) return console.log("ERROR: launch first");
		try {
			await page.waitForFunction((t) => document.body.innerText.includes(t), text, { timeout: 15_000 });
			console.log("found text:", text);
		} catch {
			console.log("TIMEOUT waiting for text:", text);
		}
	},

	async eval(expr) {
		if (!page) return console.log("ERROR: launch first");
		try {
			console.log(JSON.stringify(await page.evaluate(expr)));
		} catch (e) {
			console.log("ERROR:", e.message);
		}
	},

	async text(sel) {
		if (!page) return console.log("ERROR: launch first");
		console.log(await page.evaluate((s) => (s ? document.querySelector(s) : document.body)?.innerText ?? "(null)", sel || null));
	},

	// Составная команда: экран unlock.jsx's "Create" — 4 шага (никнейм+
	// пароль -> сгенерированная мнемоника -> повторный ввод мнемоники для
	// подтверждения -> готово), и мнемонику нужно пронести между двумя
	// экранами — REPL-команды со stdin между собой состояние не делят,
	// поэтому весь цикл выполнен ВНУТРИ одной команды.
	// Использование: register <login> <password>
	async register(args) {
		if (!page) return console.log("ERROR: launch first");
		const [login, password] = args.split(" ");
		if (!login || !password) return console.log("usage: register <login> <password>");
		await page.fill('input[type="text"]', login);
		await page.fill("#reg-password", password);
		await page.fill("#reg-password-confirm", password);
		await COMMANDS["click-text"]("Continue");
		await page.waitForSelector("ol li", { timeout: 15_000 });
		const mnemonic = (await page.evaluate(() => [...document.querySelectorAll("ol li")].map((li) => li.textContent.trim()))).join(" ");
		console.log("mnemonic:", mnemonic);
		await COMMANDS["click-text"]("I've saved the phrase");
		await page.waitForSelector("#confirm-mnemonic", { timeout: 10_000 });
		await page.fill("#confirm-mnemonic", mnemonic);
		await COMMANDS["click-text"]("Confirm");
		await page.waitForSelector("text=/Go to the app|Continue/", { timeout: 10_000 }).catch(() => {});
		await COMMANDS["click-text"]("Go to the app");
		console.log("register: done, url =", page.url());
	},

	// Составная команда: вход в УЖЕ существующий (в этом же browser context)
	// аккаунт — вкладка "Sign in", клик по нужному никнейму в списке,
	// ввод пароля, сабмит. Тот же путь, каким живой пользователь логинится
	// повторно; полезно после reload().
	// Использование: login <login> <password>
	async login(args) {
		if (!page) return console.log("ERROR: launch first");
		const [login, password] = args.split(" ");
		if (!login || !password) return console.log("usage: login <login> <password>");
		await COMMANDS["click-text"]("Sign in");
		await page.waitForSelector(".account-name", { timeout: 10_000 });
		const r = await page.evaluate((name) => {
			const els = [...document.querySelectorAll(".account-name")];
			const el = els.find((e) => e.textContent?.trim() === name);
			if (!el) return "NOT_FOUND";
			el.closest("button").click();
			return "OK";
		}, login);
		if (r !== "OK") return console.log("login: account not found in list:", login);
		await page.waitForSelector("#login-password", { timeout: 10_000 });
		await page.fill("#login-password", password);
		await page.keyboard.press("Enter");
		console.log("login: submitted, url =", page.url());
	},

	// Трюк с динамическим импортом прямо в модули приложения (signals) —
	// позволяет управлять роутингом/состоянием напрямую, когда для нужного
	// экрана ещё нет пути через UI (например, сразу открыть чат/канал по
	// pubkey). Тот же приём использовался вручную через claude-in-chrome
	// весь сеанс живой проверки CHANNEL-V2.
	// Пример: eval-module /src/ui/signals/place.js mod.openChat('deadbeef...')
	async "eval-module"(args) {
		if (!page) return console.log("ERROR: launch first");
		const spaceIdx = args.indexOf(" ");
		const modPath = args.slice(0, spaceIdx);
		const code = args.slice(spaceIdx + 1);
		try {
			const result = await page.evaluate(
				async ({ modPath, code }) => {
					const mod = await import(modPath);
					// eslint-disable-next-line no-eval
					return (0, eval)(code);
				},
				{ modPath, code },
			);
			console.log(JSON.stringify(result));
		} catch (e) {
			console.log("ERROR:", e.message);
		}
	},

	async quit() {
		if (browser) await browser.close().catch(() => {});
		browser = null;
		page = null;
	},
	help() {
		console.log("commands:", Object.keys(COMMANDS).join(", "));
	},
};

// Стдин без TTY (пайп/heredoc) — readline отдаёт ВСЕ буферизованные строки
// событием 'line' сразу, не дожидаясь завершения async-обработчика первой.
// Без очереди "launch" и следующая за ней "ss foo" гонялись бы одновременно,
// и "ss" срабатывала на ещё не открытом браузере. Простая FIFO-очередь
// сериализует выполнение команд.
const stdin = fs.createReadStream(null, { fd: fs.openSync("/dev/stdin", "r") });
const rl = readline.createInterface({ input: stdin, output: process.stdout, prompt: "driver> " });

let queue = Promise.resolve();
let closed = false;

rl.on("line", (line) => {
	queue = queue.then(() => runLine(line));
});
rl.on("close", () => {
	closed = true;
	queue = queue.then(async () => {
		await COMMANDS.quit();
		process.exit(0);
	});
});

async function runLine(line) {
	const trimmed = line.trim();
	if (!trimmed) return;
	const spaceIdx = trimmed.indexOf(" ");
	const cmd = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
	const rest = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1);
	const fn = COMMANDS[cmd];
	if (!fn) {
		console.log("unknown:", cmd, "- try: help");
		if (!closed) rl.prompt();
		return;
	}
	try {
		await fn(rest);
	} catch (e) {
		console.log("ERROR:", e.message);
	}
	if (cmd === "quit") {
		rl.close();
		process.exit(0);
	}
	if (!closed) rl.prompt();
}

console.log('"Уголок" driver - "help" for commands, "launch" to start');
rl.prompt();
