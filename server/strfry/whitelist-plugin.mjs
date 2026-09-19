#!/usr/bin/env node
// strfry write-policy plugin — whitelist по event.pubkey (не по NIP-42 authed).
// Обоснование решения — DESIGN.md/CONTRACTS.md, этап 17. Протокол ввода/вывода —
// server/strfry/strfry-src/docs/plugins.md (построчный JSON, stdin/stdout).
// Само решение — write-policy.mjs (чистая функция, GATEWAY-TZ-1.md §2); здесь
// только чтение файлов и ввод/вывод.
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { decide } from "./write-policy.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const WHITELIST_PATH = join(HERE, "whitelist.json");
const PEERS_PATH = join(HERE, "peers.json");
const STOPWORDS_PATH = join(HERE, "../../src/domain/discovery/stopwords.json");

function loadWhitelist() {
	try {
		const raw = JSON.parse(readFileSync(WHITELIST_PATH, "utf8"));
		return new Set(raw.map((pubkey) => pubkey.toLowerCase()));
	} catch {
		return new Set();
	}
}

// GATEWAY-TZ-1.md §2/§4. Политика приёма зеркального потока. Перечитываем на
// каждое событие — тот же приём, что whitelist.json: пира отключают правкой
// файла без перезапуска strfry. Нет файла / битый JSON → null → зеркало
// отвергается целиком (сегодняшнее поведение установки без пиров).
function loadPeers() {
	try {
		return JSON.parse(readFileSync(PEERS_PATH, "utf8"));
	} catch {
		return null;
	}
}

// CONTRACTS.md §DISCOVERY, T7/T8 — strfry поддерживает РОВНО ОДИН write-policy
// плагин, поэтому словарный фильтр — здесь же, в цепочке с whitelist, а не
// отдельным вторым плагином. Декоративен для клиента-нарушителя (тот отправит
// kind 30073 напрямую, минуя приложение), но это единственная точка на СВОЁМ
// реле, которую нарушитель не контролирует. Перечитываем на каждое событие —
// тот же приём, что loadWhitelist (правка файла без перезапуска strfry).
function loadStopwords() {
	try {
		return JSON.parse(readFileSync(STOPWORDS_PATH, "utf8"));
	} catch {
		return [];
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
	// после правки whitelist.json без перезапуска strfry. "*" — allow-all,
	// дефолт локального dev-relay (см. whitelist.json); deny-by-default
	// (конкретный список без "*") — рабочий режим для проверки самого
	// механизма (AC-14, этап 17), переключается правкой файла, не кода.
	const res = decide(req, { whitelist: loadWhitelist(), peers: loadPeers(), stopwords: loadStopwords });
	process.stdout.write(JSON.stringify(res) + "\n");
});
