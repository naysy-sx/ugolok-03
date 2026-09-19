#!/usr/bin/env node
// GATEWAY-TZ-1.md §4. Бюджет зеркальных данных: срок хранения и потолок
// объёма, отдельно от своих событий (свои не вытесняются никогда — см.
// selectMirrorEvictions). strfry не умеет квоты по источнику, поэтому это
// внешняя очистка: `strfry scan` → выбор → `strfry delete`. Запускать по
// таймеру (cron/systemd), раз в час-сутки.
//
//   node server/strfry/mirror-prune.mjs [--dry-run]
import { readFileSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { selectMirrorEvictions } from "./mirror-lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const STRFRY = process.env.STRFRY_BIN ?? join(HERE, "strfry-src/strfry");
const CONFIG = process.env.STRFRY_CONFIG ?? join(HERE, "strfry.conf");
const STATE_PATH = join(HERE, "mirror-state.json");
const dryRun = process.argv.includes("--dry-run");
const DELETE_BATCH = 500;

const readJson = (p, fb) => {
	try {
		return JSON.parse(readFileSync(p, "utf8"));
	} catch {
		return fb;
	}
};

const peers = readJson(join(HERE, "peers.json"), null);
const whitelist = new Set((readJson(join(HERE, "whitelist.json"), []) ?? []).map((k) => String(k).toLowerCase()));
if (!peers?.peers?.length) {
	console.error("[prune] peers.json пуст — зеркальных данных нет, делать нечего");
	process.exit(0);
}

// Сканируем всё: отличить свои события от чужих можно только по pubkey, а
// фильтр strfry не умеет «не эти авторы». Для больших баз — редкий запуск.
const events = [];
const scan = spawn(STRFRY, [`--config=${CONFIG}`, "scan", "{}"], { stdio: ["ignore", "pipe", "inherit"] });
for await (const line of createInterface({ input: scan.stdout })) {
	try {
		const e = JSON.parse(line);
		events.push({ id: e.id, pubkey: e.pubkey, kind: e.kind, created_at: e.created_at, size: line.length });
	} catch {}
}

const result = selectMirrorEvictions(events, { whitelist, peers, nowSec: Math.floor(Date.now() / 1000), sizeOf: (e) => e.size });
if (result.error) {
	console.error(`[prune] ${result.error}`);
	process.exit(1);
}
console.error(`[prune] к удалению ${result.ids.length}, останется зеркальных ~${Math.round(result.keptBytes / 1024)} КБ${dryRun ? " (dry-run)" : ""}`);
if (!dryRun) {
	for (let i = 0; i < result.ids.length; i += DELETE_BATCH) {
		const batch = result.ids.slice(i, i + DELETE_BATCH);
		const r = spawnSync(STRFRY, [`--config=${CONFIG}`, "delete", `--filter=${JSON.stringify({ ids: batch })}`], { stdio: ["ignore", "ignore", "inherit"] });
		if (r.status !== 0) process.exit(r.status ?? 1);
	}
	// Граница для mirror-pull.mjs: не тянуть заново то, что вытеснено по объёму.
	if (result.sizeCutoffSec > 0) writeFileSync(STATE_PATH, JSON.stringify({ pruneCutoffSec: result.sizeCutoffSec }) + "\n");
}
