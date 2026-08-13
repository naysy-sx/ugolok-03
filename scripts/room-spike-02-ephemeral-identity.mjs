#!/usr/bin/env node
// ROOMS-SPEC.md, Этап 0, спайк 0.2 — эфемерная личность + write-policy.
//
// Проверяет: (а) полностью случайный, ни разу не использовавшийся ключ может
// подписать и опубликовать эфемерное событие, и write-policy плагин
// (server/strfry/whitelist-plugin.mjs) его пропускает при текущем
// whitelist.json ("*" — allow-all); (б) deny-by-default режим (whitelist.json
// без "*" и без этого конкретного pubkey) действительно отклоняет публикацию
// — то есть сам механизм whitelist работает, а не просто всегда пропускает.
//
// Временно подменяет server/strfry/whitelist.json и ВСЕГДА восстанавливает
// оригинал (finally) — плагин перечитывает файл на каждое событие (без
// перезапуска strfry), поэтому изменение видно немедленно.
//
// Использование: node scripts/room-spike-02-ephemeral-identity.mjs [relayUrl]

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRelayConnection } from "../src/core/transport/relay-pool.js";
import { createPublisher } from "../src/core/transport/publisher.js";
import { sign } from "../src/core/crypto/sign.js";
import { getPublicKey } from "../src/core/crypto/keys.js";
import { bytesToHex } from "@noble/hashes/utils.js";

const RELAY_URL = process.argv[2] ?? "ws://127.0.0.1:7777";
const TEST_KIND = 29999;
const HERE = dirname(fileURLToPath(import.meta.url));
const WHITELIST_PATH = join(HERE, "..", "server", "strfry", "whitelist.json");

function openConnection(url, label) {
	const listeners = new Set();
	const conn = createRelayConnection(url, {
		onStateChange: (state) => {
			console.log(`[${label}] состояние: ${state}`);
			for (const fn of listeners) fn(state);
		},
	});
	conn.connect();
	function waitForState(predicate, timeoutMs) {
		return new Promise((resolve, reject) => {
			if (predicate(conn.getState())) return resolve();
			const timer = setTimeout(() => {
				listeners.delete(onChange);
				reject(new Error(`[${label}] waitForState: таймаут ${timeoutMs}мс, состояние=${conn.getState()}`));
			}, timeoutMs);
			function onChange(state) {
				if (!predicate(state)) return;
				clearTimeout(timer);
				listeners.delete(onChange);
				resolve();
			}
			listeners.add(onChange);
		});
	}
	return { conn, waitForState };
}

async function publishOnce(relayUrl, privKey, label) {
	const { conn, waitForState } = openConnection(relayUrl, label);
	await waitForState((s) => s === "connected", 8000);
	const pub = createPublisher(conn);
	conn.addMessageHandler(pub.handleMessage);
	const event = sign({ kind: TEST_KIND, content: "rooms-spike-0.2", tags: [], created_at: Math.floor(Date.now() / 1000) }, privKey);
	const result = await pub.publish(event);
	conn.close();
	return result;
}

async function main() {
	console.log(`ROOMS spike 0.2 — relay: ${RELAY_URL}\n`);

	const originalWhitelist = readFileSync(WHITELIST_PATH, "utf8");
	console.log(`Текущий whitelist.json: ${originalWhitelist.trim()}\n`);

	try {
		// --- Часть A: случайная identity, ТЕКУЩИЙ whitelist (ожидаем — как есть) ---
		console.log("--- Часть A: публикация случайной identity при ТЕКУЩЕМ whitelist.json ---");
		const privKeyA = crypto.getRandomValues(new Uint8Array(32));
		const pubkeyA = bytesToHex(getPublicKey(privKeyA));
		console.log(`identity A: ${pubkeyA}`);
		const resultA = await publishOnce(RELAY_URL, privKeyA, "A");
		console.log(`Результат публикации A: ${JSON.stringify(resultA)}`);
		const currentIsAllowAll = originalWhitelist.trim() === '["*"]';
		console.log(
			`РЕЗУЛЬТАТ 0.2a: publish.ok=${resultA.ok}${currentIsAllowAll ? ` (whitelist="*" — ожидали true, ${resultA.ok === true ? "совпало" : "РАСХОЖДЕНИЕ"})` : " (whitelist не allow-all на момент запуска — сверьте вручную)"}`,
		);

		// --- Часть B: deny-by-default — whitelist БЕЗ "*" и без нашего нового ключа ---
		console.log("\n--- Часть B: deny-by-default (whitelist.json = [] на время теста) ---");
		writeFileSync(WHITELIST_PATH, JSON.stringify([]), "utf8");
		console.log("whitelist.json временно заменён на [] (плагин перечитывает файл на каждое событие, перезапуск strfry не нужен)");

		const privKeyB = crypto.getRandomValues(new Uint8Array(32));
		const pubkeyB = bytesToHex(getPublicKey(privKeyB));
		console.log(`identity B (заведомо не в списке): ${pubkeyB}`);
		const resultB = await publishOnce(RELAY_URL, privKeyB, "B");
		console.log(`Результат публикации B: ${JSON.stringify(resultB)}`);
		const denyByDefaultWorks = resultB.ok === false;
		console.log(`РЕЗУЛЬТАТ 0.2b: deny-by-default ${denyByDefaultWorks ? "РАБОТАЕТ (публикация отклонена, как ожидалось)" : "НЕ РАБОТАЕТ — публикация прошла, хотя whitelist пуст! ПРОВЕРИТЬ ПЛАГИН"}`);

		// --- Часть C: восстановленный whitelist снова пропускает ---
		console.log("\n--- Часть C: восстанавливаем оригинальный whitelist.json, проверяем что публикация снова проходит ---");
		writeFileSync(WHITELIST_PATH, originalWhitelist, "utf8");
		console.log("whitelist.json восстановлен");
		const resultC = await publishOnce(RELAY_URL, privKeyB, "C");
		console.log(`Результат публикации C (тем же ключом B, после восстановления): ${JSON.stringify(resultC)}`);

		console.log("\n=== ИТОГ СПАЙКА 0.2 ===");
		console.log(`A (whitelist как есть на старте): publish.ok=${resultA.ok}`);
		console.log(`B (whitelist=[]): publish.ok=${resultB.ok} — deny-by-default ${denyByDefaultWorks ? "OK" : "ПРОВАЛ"}`);
		console.log(`C (whitelist восстановлен): publish.ok=${resultC.ok}`);

		if (!denyByDefaultWorks) {
			console.error("\nСПАЙК 0.2 ЧАСТИЧНО ПРОВАЛЕН — механизм whitelist не отклоняет при пустом списке.");
			process.exitCode = 1;
		}
	} finally {
		// Гарантия восстановления даже при исключении посреди теста.
		const current = readFileSync(WHITELIST_PATH, "utf8");
		if (current !== originalWhitelist) {
			writeFileSync(WHITELIST_PATH, originalWhitelist, "utf8");
			console.log("\n(finally) whitelist.json восстановлен повторно на всякий случай");
		}
	}
}

main().catch((e) => {
	console.error("СПАЙК 0.2 упал с ошибкой:", e);
	process.exitCode = 1;
});
