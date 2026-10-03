// ТЗ-05 — единственное место, где решается «какой Blossom-сервер».
//   uploadTarget()       — ОДИН адрес, куда заливать;
//   readCandidates(hint) — упорядоченный список адресов для чтения, без повторов.
// Порядок источников: настройки пользователя → config.json → константа сборки.
// Настройки регистрируются из ui-settings.js при загрузке и сохранении (синхронный
// доступ из доменного слоя, как registerTrustedImageOrigins).
import { BUILD_DEFAULT_BLOSSOM_SERVERS } from "../../config.js";
import { getRuntimeConfig } from "../settings/runtime-config.js";
import { parseBlossomUrl } from "../settings/bootstrap-endpoints.js";

const MAX_HINT_SERVERS = 3;

let userActive = null;
let userUrls = [];

function clean(url) {
	if (typeof url !== "string") return "";
	return url.trim().replace(/\/+$/, "");
}

function cleanList(list) {
	const out = [];
	for (const item of Array.isArray(list) ? list : []) {
		const url = clean(item);
		if (url && !out.includes(url)) out.push(url);
	}
	return out;
}

export function registerUserServers({ activeUrl, urls } = {}) {
	userActive = clean(activeUrl) || null;
	userUrls = cleanList(urls);
}

export function resetUserServers() {
	userActive = null;
	userUrls = [];
}

function ownServers() {
	return cleanList([userActive, ...userUrls]);
}

function fallbackServers() {
	return cleanList([...(getRuntimeConfig().blossomServers ?? []), ...(BUILD_DEFAULT_BLOSSOM_SERVERS ?? [])]);
}

export function uploadTarget() {
	return ownServers()[0] ?? fallbackServers()[0] ?? "";
}

// Подсказка приходит из чужого сообщения — данные недоверенные: только корректные
// http(s)-адреса (канонический вид), не больше MAX_HINT_SERVERS, без повторов.
export function sanitizeServerHint(hint) {
	const raw = Array.isArray(hint) ? hint : typeof hint === "string" ? [hint] : [];
	const out = [];
	for (const item of raw) {
		const url = parseBlossomUrl(item);
		if (typeof url === "string" && !out.includes(url)) out.push(url);
		if (out.length >= MAX_HINT_SERVERS) break;
	}
	return out;
}

// hint — адреса из дескриптора вложения (куда файл реально залит); необязателен.
export function readCandidates(hint) {
	return cleanList([...sanitizeServerHint(hint), ...ownServers(), ...fallbackServers()]);
}

// Чтение: подсказка из дескриптора + явно переданный адрес (строка или список) + обычный порядок.
export function resolveReadServers(hint, explicit) {
	const list = readCandidates(hint);
	const given = Array.isArray(explicit) ? explicit : explicit ? [explicit] : [];
	if (given.length === 0) return list;
	const clean = cleanList(given);
	// Явный адрес идёт сразу после подсказки: вызывающий знает его лучше общего порядка.
	const hinted = sanitizeServerHint(hint);
	return cleanList([...hinted, ...clean, ...list]);
}

// Для белого списка источников (url-guard): всё, чему клиент доверяет как своему хранилищу.
export function knownServers() {
	return readCandidates();
}
