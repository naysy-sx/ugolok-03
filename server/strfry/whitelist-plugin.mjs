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
import { createLimiter } from "./rate-limit.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
// POLICY_CONF_DIR — каталог с редактируемыми оператором файлами (whitelist.json,
// peers.json, policy.json). В боевом контейнере код смонтирован read-only, а
// конфиги лежат отдельно на хосте и правятся без пересборки (AUDIT-EGOROD G4).
const CONF_DIR = process.env.POLICY_CONF_DIR || HERE;
const WHITELIST_PATH = join(CONF_DIR, "whitelist.json");
const PEERS_PATH = join(CONF_DIR, "peers.json");
const POLICY_PATH = join(CONF_DIR, "policy.json");
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

// AUDIT-EGOROD G4: policy.json — { "mode": "open" | "readonly", "limits": {...} }.
// Нет файла / битый JSON → значения по умолчанию (открыто, лимиты по умолчанию).
function loadPolicy() {
	try {
		return JSON.parse(readFileSync(POLICY_PATH, "utf8"));
	} catch {
		return {};
	}
}

const limiter = createLimiter();

// AUDIT-EGOROD G5: раз в 5 минут — строка со счётчиками в stderr (журнал
// контейнера). Всплеск newPubkeys/limited* — признак атаки. Молчит, если ничего
// не происходило.
const STATS_INTERVAL_MS = 5 * 60 * 1000;
const statsTimer = setInterval(() => {
	const s = limiter.drainStats();
	if (s.accepted + s.limitedPubkey + s.limitedIp + s.limitedNewKeys + s.newPubkeys > 0) {
		process.stderr.write(`[policy-stats] ${JSON.stringify({ at: new Date().toISOString(), windowMinutes: 5, ...s })}\n`);
	}
}, STATS_INTERVAL_MS);
statsTimer.unref();

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
	// Сбой самого лимитера (не решения по whitelist) не должен останавливать
	// запись всего relay: лимиты — защитный слой, а не источник истины.
	let res;
	try {
		res = decide(req, { whitelist: loadWhitelist(), peers: loadPeers(), stopwords: loadStopwords, policy: loadPolicy(), limiter });
	} catch (e) {
		process.stderr.write(`[policy] ошибка политики, событие ${req.event?.id} пропущено без лимитов: ${e?.message}\n`);
		res = decide(req, { whitelist: loadWhitelist(), peers: loadPeers(), stopwords: loadStopwords });
	}
	process.stdout.write(JSON.stringify(res) + "\n");
});
