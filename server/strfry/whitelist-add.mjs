#!/usr/bin/env node
// Dev-утилита: добавить pubkey в whitelist.json локального тестового relay
// (не трогает write-policy плагин, только данные — whitelist.json уже
// перечитывается на каждое событие, рестарт strfry не нужен).
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const WHITELIST_PATH = join(HERE, "whitelist.json");

const pubkey = process.argv[2];
if (!pubkey || !/^[0-9a-f]{64}$/i.test(pubkey)) {
	console.error("Использование: node server/strfry/whitelist-add.mjs <pubkey-hex>");
	process.exit(1);
}

const list = JSON.parse(readFileSync(WHITELIST_PATH, "utf8"));
const normalized = pubkey.toLowerCase();
if (!list.includes(normalized)) {
	list.push(normalized);
	writeFileSync(WHITELIST_PATH, JSON.stringify(list) + "\n");
	console.log(`Добавлено в whitelist: ${normalized}`);
} else {
	console.log(`Уже в whitelist: ${normalized}`);
}
