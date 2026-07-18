#!/usr/bin/env node
// strfry write-policy plugin — whitelist по event.pubkey (не по NIP-42 authed).
// Обоснование решения — DESIGN.md/CONTRACTS.md, этап 17. Протокол ввода/вывода —
// server/strfry/strfry-src/docs/plugins.md (построчный JSON, stdin/stdout).
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const WHITELIST_PATH = join(HERE, "whitelist.json");

function loadWhitelist() {
	try {
		const raw = JSON.parse(readFileSync(WHITELIST_PATH, "utf8"));
		return new Set(raw.map((pubkey) => pubkey.toLowerCase()));
	} catch {
		return new Set();
	}
}

const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });

rl.on("line", (line) => {
	let req;
	try {
		req = JSON.parse(line);
	} catch {
		return;
	}
	if (req.type !== "new") return;

	// Перечитываем whitelist на каждое событие — простой файл, не нагрузочный
	// сценарий для локального/self-hosted relay; исключает рассинхронизацию
	// после правки whitelist.json без перезапуска strfry.
	const whitelist = loadWhitelist();
	const pubkey = (req.event?.pubkey ?? "").toLowerCase();

	const res = { id: req.event.id };
	if (whitelist.has(pubkey)) {
		res.action = "accept";
	} else {
		res.action = "reject";
		res.msg = "blocked: pubkey not on whitelist";
	}
	process.stdout.write(JSON.stringify(res) + "\n");
});
