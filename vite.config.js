import { defineConfig } from "vite";
import preact from "@preact/preset-vite";
import { viteSingleFile } from "vite-plugin-singlefile";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { execSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// Метка сборки для версионирования cache (F-OF-06: ugolok-cache-v{BUILD_HASH}).
// ВАЖНО: это НЕ хеш содержимого index.html для NF-18 — тот считается ПОСТ-сборки
// в scripts/release-hash.sh. Здесь — build-time идентификатор, не content-hash.
const BUILD_HASH =
	process.env.BUILD_HASH ??
	(() => {
		try {
			return execSync("git rev-parse --short HEAD").toString().trim();
		} catch {
			return "dev";
		}
	})();

// Поднимает локальный strfry (server/strfry/) вместе с `vite dev`, чтобы
// диагностика всегда имела живой relay, а не таймаутила на "disconnected"
// без ручного запуска run.sh отдельным терминалом. apply:"serve" — на
// build/preview не действует, дефолт-relay продакшн-сборки не трогает.
function devRelayPlugin() {
	const strfryBinary = fileURLToPath(new URL("./server/strfry/strfry-src/strfry", import.meta.url));
	const dbDir = fileURLToPath(new URL("./server/strfry/strfry-db", import.meta.url));
	const runScript = fileURLToPath(new URL("./server/strfry/run.sh", import.meta.url));
	let child;
	return {
		name: "ugolok:dev-relay",
		apply: "serve",
		configureServer(server) {
			if (!existsSync(strfryBinary)) {
				server.config.logger.warn(
					"[ugolok:dev-relay] strfry не собран (см. server/README.md) — диагностика останется без живого relay.",
				);
				return;
			}
			if (!existsSync(dbDir)) mkdirSync(dbDir, { recursive: true });

			child = spawn(runScript, [], { stdio: ["ignore", "pipe", "pipe"] });
			child.stdout.on("data", (d) => process.stdout.write(`[strfry] ${d}`));
			child.stderr.on("data", (d) => process.stderr.write(`[strfry] ${d}`));
			child.on("exit", (code, signal) => {
				if (code !== 0 && signal !== "SIGTERM") {
					// Частая причина — порт 7777 уже занят другим strfry (запущен вручную
					// или другим `vite dev`); не роняем dev-сервер из-за этого.
					server.config.logger.warn(`[ugolok:dev-relay] strfry завершился (code=${code}).`);
				}
			});
			const stop = () => {
				if (child && !child.killed) child.kill();
			};
			process.once("exit", stop);
			server.httpServer?.once("close", stop);
		},
	};
}

// F-RL-01: дефолт-relay компилируется в бандл из env. В dev без явного
// override — локальный strfry (devRelayPlugin поднимает его сам), чтобы
// диагностика/самопроверки всегда имели реальный relay; в проде плейсхолдер,
// который обязана переопределить реальная конфигурация деплоя.
function buildDefaultRelays(command) {
	if (process.env.BUILD_DEFAULT_RELAYS) return JSON.parse(process.env.BUILD_DEFAULT_RELAYS);
	return command === "serve" ? ["ws://127.0.0.1:7777"] : ["wss://relay.example"];
}

// SW не должен инлайниться в index.html, но БАНДЛИТЬ define-константы — должен.
// Эмитим его отдельным ассетом, подставляя BUILD_HASH в плейсхолдер.
function emitServiceWorker(buildHash) {
	return {
		name: "ugolok:emit-sw",
		apply: "build",
		generateBundle() {
			// buildHash — replaceAll(str, fn), не replaceAll(str, str): при
			// строковой замене движок трактует `$`-паттерны в buildHash
			// ($&, $$, ...) специально, что портит подстановку.
			const src = readFileSync("service-worker.js", "utf8").replaceAll(
				"__BUILD_HASH__",
				() => buildHash,
			);
			this.emitFile({
				type: "asset",
				fileName: "service-worker.js",
				source: src,
			});
		},
	};
}

export default defineConfig(({ command }) => ({
	base: "./", // переносимость пары файлов на произвольный путь
	plugins: [
		preact({ devToolsEnabled: false }), // обход бага preset×Vite8×zimmerframe
		emitServiceWorker(BUILD_HASH),
		viteSingleFile(),
		...(command === "serve" ? [devRelayPlugin()] : []),
	],
	define: {
		__BUILD_HASH__: JSON.stringify(BUILD_HASH),
		__BUILD_DEFAULT_RELAYS__: JSON.stringify(buildDefaultRelays(command)),
	},
	build: {
		target: ["chrome100", "firefox100", "safari15.4"], // = твои min-браузеры
	},
}));
