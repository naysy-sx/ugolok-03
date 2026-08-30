#!/usr/bin/env node
// strfry write-policy plugin — whitelist по event.pubkey (не по NIP-42 authed).
// Обоснование решения — DESIGN.md/CONTRACTS.md, этап 17. Протокол ввода/вывода —
// server/strfry/strfry-src/docs/plugins.md (построчный JSON, stdin/stdout).
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { isClean } from "../../src/domain/discovery/wordfilter.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const WHITELIST_PATH = join(HERE, "whitelist.json");
const STOPWORDS_PATH = join(HERE, "../../src/domain/discovery/stopwords.json");
const DISCOVERY_KIND = 30073;

function loadWhitelist() {
	try {
		const raw = JSON.parse(readFileSync(WHITELIST_PATH, "utf8"));
		return new Set(raw.map((pubkey) => pubkey.toLowerCase()));
	} catch {
		return new Set();
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

function discoveryContentIsClean(event) {
	let content;
	try {
		content = JSON.parse(event.content);
	} catch {
		return true; // не наш формат — не дело этого фильтра решать, whitelist уже пропустил
	}
	const stopwords = loadStopwords();
	const texts = [content?.bio];
	if (Array.isArray(content?.channels)) {
		for (const c of content.channels) {
			texts.push(c?.name, c?.description, c?.rules);
		}
	}
	return texts.every((text) => typeof text !== "string" || isClean(text, stopwords));
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

	// "*" — специальный элемент: allow-all. Дефолт локального dev-relay (см.
	// whitelist.json) — целевая аудитория дев-сборки: любой, кто зарегистрировался
	// на СВОЁМ устройстве в локальной сети (CLAUDE.md), не нуждается в ручном
	// добавлении pubkey просто чтобы попробовать приложение. Deny-by-default
	// (конкретный список без "*") остаётся рабочим режимом для целевой проверки
	// самого механизма whitelist (AC-14, этап 17) — переключается правкой файла,
	// не кода.
	const res = { id: req.event.id };
	if (whitelist.has("*") || whitelist.has(pubkey)) {
		res.action = "accept";
	} else {
		res.action = "reject";
		res.msg = "blocked: pubkey not on whitelist";
	}

	if (res.action === "accept" && req.event.kind === DISCOVERY_KIND && !discoveryContentIsClean(req.event)) {
		res.action = "reject";
		res.msg = "blocked: discovery content failed wordlist filter";
	}

	process.stdout.write(JSON.stringify(res) + "\n");
});
