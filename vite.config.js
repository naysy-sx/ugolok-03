import { defineConfig } from "vite";
import preact from "@preact/preset-vite";
import { viteSingleFile } from "vite-plugin-singlefile";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

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

// F-RL-01: дефолт-relay компилируется в бандл из env.
const BUILD_DEFAULT_RELAYS = JSON.parse(
	process.env.BUILD_DEFAULT_RELAYS ?? '["wss://relay.example"]',
);

// SW не должен инлайниться в index.html, но БАНДЛИТЬ define-константы — должен.
// Эмитим его отдельным ассетом, подставляя BUILD_HASH в плейсхолдер.
function emitServiceWorker(buildHash) {
	return {
		name: "ugolok:emit-sw",
		apply: "build",
		generateBundle() {
			const src = readFileSync("service-worker.js", "utf8").replaceAll(
				"__BUILD_HASH__",
				buildHash,
			);
			this.emitFile({
				type: "asset",
				fileName: "service-worker.js",
				source: src,
			});
		},
	};
}

export default defineConfig({
	base: "./", // переносимость пары файлов на произвольный путь
	plugins: [
		preact({ devToolsEnabled: false }), // обход бага preset×Vite8×zimmerframe
		emitServiceWorker(BUILD_HASH),
		viteSingleFile(),
	],
	define: {
		__BUILD_HASH__: JSON.stringify(BUILD_HASH),
		__BUILD_DEFAULT_RELAYS__: JSON.stringify(BUILD_DEFAULT_RELAYS),
	},
	build: {
		target: ["chrome100", "firefox100", "safari15.4"], // = твои min-браузеры
	},
});
