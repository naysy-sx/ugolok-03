#!/usr/bin/env node
// GATEWAY-TZ-1.md §3. Тяга зеркала: инстанс САМ ходит к пирам (исходящее
// соединение) и забирает разрешённые kind'ы встроенной синхронизацией strfry
// (negentropy). Входящих соединений от пиров нет вовсе — граница доверия
// односторонняя. Своего протокола синхронизации здесь нет: это цикл,
// вызывающий `strfry sync <url> --dir down`.
//
// Что тянуть — из peers.json, перечитывается каждый цикл (пира отключают
// правкой файла без перезапуска). Приём каждого события всё равно проходит
// write-policy (whitelist-plugin.mjs, sourceType=Sync): фильтр тяги — первая
// линия, плагин — вторая (враждебный пир может прислать больше, чем просили).
//
//   node server/strfry/mirror-pull.mjs [--once]
import { readFileSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { pullIntervalMs, buildPullFilter, recordAttempt } from "./mirror-lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PEERS_PATH = join(HERE, "peers.json");
const STATE_PATH = join(HERE, "mirror-state.json"); // пишет mirror-prune.mjs
const STRFRY = process.env.STRFRY_BIN ?? join(HERE, "strfry-src/strfry");
const CONFIG = process.env.STRFRY_CONFIG ?? join(HERE, "strfry.conf");
const SYNC_TIMEOUT_SECONDS = 120;

function readJson(path, fallback) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return fallback;
	}
}

function runSync(url, filter) {
	return new Promise((resolve) => {
		const args = [`--config=${CONFIG}`, "sync", url, "--dir=down", `--filter=${JSON.stringify(filter)}`, `--timeout=${SYNC_TIMEOUT_SECONDS}`];
		const proc = spawn(STRFRY, args, { stdio: ["ignore", "ignore", "pipe"] });
		let stderr = "";
		proc.stderr.on("data", (d) => (stderr += d));
		proc.on("error", (err) => resolve({ ok: false, detail: err.message }));
		proc.on("close", (code) => resolve({ ok: code === 0, detail: stderr.trim().split("\n").at(-1) ?? "" }));
	});
}

const state = {};
const once = process.argv.includes("--once");

async function cycle() {
	const peers = readJson(PEERS_PATH, null);
	const intervalMs = pullIntervalMs(peers);
	const pruneCutoffSec = readJson(STATE_PATH, {}).pruneCutoffSec ?? 0;
	for (const peer of peers?.peers ?? []) {
		if (!peer?.url) continue;
		const now = Date.now();
		if ((state[peer.url]?.nextAttemptAt ?? 0) > now) continue;
		const filter = buildPullFilter(peer, peers, { nowSec: Math.floor(now / 1000), pruneCutoffSec });
		if (!filter) continue; // нет разрешённых kind'ов — нечего тянуть
		const { ok, detail } = await runSync(peer.url, filter);
		const [next, log] = recordAttempt(state[peer.url], ok, { nowMs: Date.now(), baseMs: intervalMs });
		state[peer.url] = next;
		if (log === "unreachable") console.error(`[mirror] пир ${peer.name ?? peer.id ?? peer.url} недоступен ${next.failures} попыток подряд: ${detail}`);
		if (log === "recovered") console.error(`[mirror] пир ${peer.name ?? peer.id ?? peer.url} снова доступен`);
	}
	return intervalMs;
}

if (!existsSync(STRFRY)) {
	console.error(`[mirror] strfry не найден: ${STRFRY} (STRFRY_BIN, либо см. server/README.md — сборка)`);
	process.exit(1);
}
for (;;) {
	const intervalMs = await cycle();
	if (once) break;
	await new Promise((r) => setTimeout(r, intervalMs));
}
