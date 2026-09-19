// Этап 4A (TZ-cicd-hardening) — рантайм-чтение config.json: deploy-env.sh
// пишет dist/config.json при каждой выкладке, но раньше клиент его не
// загружал вовсе (docs/config.md фиксировал это как допустимое временное
// состояние). Этот модуль отвечает только за слой config.json — localStorage
// разбирает bootstrap-endpoints.js, он же подмешивает результат отсюда как
// свой фолбэк перед build-time дефолтом (docs/config.md, "Приоритет слоёв").
//
// Любая ошибка (сеть, 404, битый JSON, таймаут) -> {} — вызывающая сторона
// откатывается на build-time дефолт, приложение не падает и не виснет.
import { parseRelayUrl, parseBlossomUrl, parseIceUrl } from "./bootstrap-endpoints.js";

const TIMEOUT_MS = 4000;

let cached = {};

function parseUrlList(raw, parseOne) {
	if (!Array.isArray(raw)) return undefined;
	const out = raw.map(parseOne).filter((u) => typeof u === "string");
	return out.length > 0 ? out : undefined;
}

function parseIceServerList(raw) {
	if (!Array.isArray(raw)) return undefined;
	const out = [];
	for (const entry of raw) {
		if (!entry || typeof entry.urls !== "string") continue;
		const parsed = parseIceUrl(entry.urls);
		if (!parsed) continue;
		const server = { urls: parsed.urls };
		if (typeof entry.username === "string") server.username = entry.username;
		else if (parsed.username) server.username = parsed.username;
		if (typeof entry.credential === "string") server.credential = entry.credential;
		else if (parsed.credential) server.credential = parsed.credential;
		out.push(server);
	}
	return out.length > 0 ? out : undefined;
}

// Единственное место схемы config.json на клиенте (deploy/config.example.json
// — тот же контракт на стороне деплоя). Поля-мусор/неизвестного типа просто
// не попадают в результат — не бросаем, невалидный config.json не хуже
// отсутствующего.
function validate(raw) {
	if (!raw || typeof raw !== "object") return {};
	const out = {};
	if (typeof raw.instanceName === "string" && raw.instanceName) out.instanceName = raw.instanceName;
	const relays = parseUrlList(raw.relays, parseRelayUrl);
	if (relays) out.relays = relays;
	const bootstrapRelays = parseUrlList(raw.bootstrapRelays, parseRelayUrl);
	if (bootstrapRelays) out.bootstrapRelays = bootstrapRelays;
	const blossomServers = parseUrlList(raw.blossomServers, parseBlossomUrl);
	if (blossomServers) out.blossomServers = blossomServers;
	const iceServers = parseIceServerList(raw.iceServers);
	if (iceServers) out.iceServers = iceServers;
	// turnCredentialsUrl — этап 6, здесь только пропускаем как строку без
	// дальнейшей интерпретации (потребитель появится там же).
	if (typeof raw.turnCredentialsUrl === "string" && raw.turnCredentialsUrl) out.turnCredentialsUrl = raw.turnCredentialsUrl;
	// AUDIT-EGOROD: явное разрешение слать события на inbox-relay ПОЛУЧАТЕЛЯ (чужие
	// серверы). По умолчанию выключено — см. dm-relay-list.js::selectInboxRelays.
	if (raw.allowForeignInboxRelays === true) out.allowForeignInboxRelays = true;
	return out;
}

// Синхронный доступ к последнему успешно загруженному (или ещё не
// загруженному — {}) config.json. loadRuntimeConfig() должен быть
// дождан ДО первого чтения, иначе этот геттер честно вернёт {} и
// вызывающая сторона откатится на build-time дефолт (см. transport.js).
export function getRuntimeConfig() {
	return cached;
}

export function resetRuntimeConfig() {
	cached = {};
}

export async function loadRuntimeConfig({ fetchImpl = globalThis.fetch, timeoutMs = TIMEOUT_MS, url = "./config.json" } = {}) {
	if (typeof fetchImpl !== "function") return (cached = {});
	let timer;
	const timeout = new Promise((_, reject) => {
		timer = setTimeout(() => reject(new Error("runtime-config: таймаут")), timeoutMs);
	});
	try {
		const res = await Promise.race([fetchImpl(url, { cache: "no-store" }), timeout]);
		if (!res || !res.ok) return (cached = {});
		const raw = await res.json();
		return (cached = validate(raw));
	} catch {
		return (cached = {});
	} finally {
		clearTimeout(timer);
	}
}
