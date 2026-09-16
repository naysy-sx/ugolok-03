// Device-level endpoints до логина (localStorage). ICE в uiSettings /
// kind-событие НЕ кладётся — этого слоя достаточно для стартового экрана
// и звонков с этого устройства.
import { BUILD_DEFAULT_RELAYS, BUILD_DEFAULT_BLOSSOM_SERVERS, BUILD_DEFAULT_ICE_SERVERS } from '../../config.js';
import { getRuntimeConfig } from './runtime-config.js';
import { logWarn } from '../../core/diag/boot-log.js';

export const BOOTSTRAP_ENDPOINTS_KEY = 'ugolok.bootstrapEndpoints.v1';

function canonicalizeHttpWs(url) {
	const path = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '');
	return url.protocol + '//' + url.host + path;
}

export function parseRelayUrl(raw) {
	if (typeof raw !== 'string') return null;
	const trimmed = raw.trim();
	if (!trimmed) return null;
	try {
		const url = new URL(trimmed);
		if (url.protocol !== 'ws:' && url.protocol !== 'wss:') return null;
		return canonicalizeHttpWs(url);
	} catch {
		return null;
	}
}

export function parseBlossomUrl(raw) {
	if (typeof raw !== 'string') return null;
	const trimmed = raw.trim();
	if (!trimmed) return null;
	try {
		const url = new URL(trimmed);
		if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
		return canonicalizeHttpWs(url);
	} catch {
		return null;
	}
}

function iceHostFromRest(rest) {
	let host = (rest || '').split(/[:/?]/)[0] || '';
	return host.replace(/^\[|\]$/g, '').toLowerCase();
}

function isLoopbackIceHost(host) {
	return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

export function turnHostFromServers(iceServers) {
	for (const server of iceServers || []) {
		const u = server && server.urls;
		const list = Array.isArray(u) ? u : u ? [u] : [];
		for (const url of list) {
			if (typeof url !== 'string') continue;
			const match = /^(turns?):(.+)$/i.exec(url);
			if (!match || !match[2].trim()) continue;
			const host = iceHostFromRest(match[2].trim());
			if (host) return host;
		}
	}
	return '';
}

function credentialsFromDefaults(host) {
	if (!host || isLoopbackIceHost(host)) return null;
	for (const server of BUILD_DEFAULT_ICE_SERVERS || []) {
		if (typeof server?.username !== 'string' || typeof server?.credential !== 'string') continue;
		const u = server.urls;
		const list = Array.isArray(u) ? u : u ? [u] : [];
		for (const url of list) {
			if (typeof url !== 'string') continue;
			const match = /^(turns?):(.+)$/i.exec(url);
			if (!match || !match[2].trim()) continue;
			if (iceHostFromRest(match[2].trim()) === host) {
				return { username: server.username, credential: server.credential };
			}
		}
	}
	return null;
}

// Stored ICE for the same island TURN (or leftover localhost) yields to
// build-time servers so UDP+TCP URLs and credentials stay current.
export function resolveIceServers(stored, defaults) {
	const defaultList = Array.isArray(defaults) ? defaults : [];
	const storedList = Array.isArray(stored) ? stored : [];
	const defaultHost = turnHostFromServers(defaultList);
	if (!defaultHost || isLoopbackIceHost(defaultHost)) return storedList;
	const storedHost = turnHostFromServers(storedList);
	if (!storedHost || isLoopbackIceHost(storedHost) || storedHost === defaultHost) {
		return defaultList.map((s) => ({ ...s }));
	}
	return storedList;
}

export function parseIceUrl(raw) {
	if (typeof raw !== 'string') return null;
	const trimmed = raw.trim();
	const match = /^(turns?|stuns?):(.+)$/i.exec(trimmed);
	if (!match || !match[2].trim()) return null;
	const scheme = match[1].toLowerCase();
	const rest = match[2].trim();
	const urls = scheme + ':' + rest;
	const host = iceHostFromRest(rest);
	if (isLoopbackIceHost(host)) {
		return { urls, username: 'ugolok', credential: 'ugolok-dev' };
	}
	const creds = credentialsFromDefaults(host);
	if (creds) return { urls, ...creds };
	return { urls };
}

export function iceUrlFromServers(iceServers) {
	const urls = [];
	for (const server of iceServers || []) {
		const u = server && server.urls;
		if (Array.isArray(u)) urls.push(...u);
		else if (typeof u === 'string') urls.push(u);
	}
	const turn = urls.find((u) => /^turns?:/i.test(u));
	return turn || urls[0] || '';
}

function getStorage(explicit) {
	if (explicit && typeof explicit.getItem === 'function') return explicit;
	try {
		const ls = globalThis.localStorage;
		if (ls && typeof ls.getItem === 'function') return ls;
	} catch {
		// node --test
	}
	return null;
}

// Приоритет (docs/config.md): localStorage (readBootstrapEndpoints, вызывающая
// сторона) > config.json (getRuntimeConfig — этап 4A) > BUILD_DEFAULT_* — этот
// уровень подмешивается здесь, единственном месте, где строятся дефолты.
function buildTimeDefaults() {
	const runtime = getRuntimeConfig();
	const runtimeIce = Array.isArray(runtime.iceServers) && runtime.iceServers.length > 0 ? runtime.iceServers : null;
	return {
		relayUrl: runtime.relays?.[0] ?? BUILD_DEFAULT_RELAYS[0] ?? '',
		blossomUrl: runtime.blossomServers?.[0] ?? BUILD_DEFAULT_BLOSSOM_SERVERS[0] ?? '',
		iceServers: (runtimeIce ?? (Array.isArray(BUILD_DEFAULT_ICE_SERVERS) ? BUILD_DEFAULT_ICE_SERVERS : [])).map((s) => ({ ...s })),
	};
}

function isValidStored(obj) {
	return (
		obj &&
		typeof obj === 'object' &&
		typeof obj.relayUrl === 'string' &&
		typeof obj.blossomUrl === 'string' &&
		Array.isArray(obj.iceServers)
	);
}

function isLoopbackHost(urlStr) {
	if (!urlStr || typeof urlStr !== 'string') return false;
	try {
		const host = new URL(urlStr).hostname;
		return host === '127.0.0.1' || host === 'localhost' || host === '::1';
	} catch {
		return false;
	}
}

export function readBootstrapEndpoints(storage) {
	const store = getStorage(storage);
	if (!store) return buildTimeDefaults();
	let raw;
	try {
		raw = store.getItem(BOOTSTRAP_ENDPOINTS_KEY);
	} catch {
		return buildTimeDefaults();
	}
	if (!raw) return buildTimeDefaults();
	try {
		const parsed = JSON.parse(raw);
		if (!isValidStored(parsed)) return buildTimeDefaults();
		const defaults = buildTimeDefaults();
		const storedLoopback = isLoopbackHost(parsed.relayUrl) || isLoopbackHost(parsed.blossomUrl);
		if (storedLoopback && defaults.relayUrl && !isLoopbackHost(defaults.relayUrl)) return defaults;
		return {
			relayUrl: parsed.relayUrl,
			blossomUrl: parsed.blossomUrl,
			iceServers: resolveIceServers(parsed.iceServers, defaults.iceServers),
		};
	} catch {
		return buildTimeDefaults();
	}
}

export function writeBootstrapEndpoints(value, storage) {
	const store = getStorage(storage);
	const next = { ...readBootstrapEndpoints(storage) };
	if (value && typeof value === 'object') {
		if ('relayUrl' in value) {
			const parsed = parseRelayUrl(value.relayUrl);
			if (parsed) next.relayUrl = parsed;
		}
		if ('blossomUrl' in value) {
			const parsed = parseBlossomUrl(value.blossomUrl);
			if (parsed) next.blossomUrl = parsed;
		}
		if ('iceServers' in value && Array.isArray(value.iceServers)) {
			const cleaned = [];
			for (const entry of value.iceServers) {
				if (!entry || typeof entry.urls !== 'string') continue;
				const parsed = parseIceUrl(entry.urls);
				if (!parsed) continue;
				const out = { urls: parsed.urls };
				if (typeof entry.username === 'string') out.username = entry.username;
				else if (parsed.username) out.username = parsed.username;
				if (typeof entry.credential === 'string') out.credential = entry.credential;
				else if (parsed.credential) out.credential = parsed.credential;
				cleaned.push(out);
			}
			if (cleaned.length > 0) next.iceServers = cleaned;
		}
	}
	if (store) {
		try {
			store.setItem(BOOTSTRAP_ENDPOINTS_KEY, JSON.stringify(next));
		} catch {
			// quota / private mode
		}
	}
	return next;
}

export function resetBootstrapEndpoints(storage) {
	const store = getStorage(storage);
	if (store) {
		try {
			store.removeItem(BOOTSTRAP_ENDPOINTS_KEY);
		} catch {
			// ignore
		}
	}
}

// Этап 6 (TZ-cicd-hardening) — временные TURN-креды с officiального
// эндпоинта (agent/cmd/turncreds-server), НЕ статический пароль из сборки.
// Кэш в памяти до expiry-60с — вкладка живёт часами, повторный fetch на
// КАЖДЫЙ звонок не нужен, пока креды ещё не протухли.
let cachedTurnCreds = null; // { iceServers, expiryMs } | null

export function resetTurnCredentialsCache() {
	cachedTurnCreds = null;
}

// TZ-diag-trace.md §2.1 — чистый геттер поверх уже существующего кэша, НЕ
// повторный запрос кредов. Возвращает null, если кредов ещё/уже нет в кэше.
export function getCachedTurnCredsExpiry() {
	return cachedTurnCreds?.expiryMs ?? null;
}

// TZ-recovery-policy.md §2.3 — "если до истечения осталось меньше половины
// TTL — запросить новые": доля, не абсолютное время, чтобы работать
// одинаково для дефолтного TTL (3600с) и для тестового/настроенного любой
// длины. false, если кредов ещё нет в кэше вообще — это не "протухли", а
// "не запрашивались", вызывающая сторона (fetchTurnCredentials) сама решит.
export function isTurnCredsStale(now = Date.now(), thresholdFraction = 0.5) {
	if (!cachedTurnCreds) return false;
	const totalMs = cachedTurnCreds.expiryMs - cachedTurnCreds.issuedAtMs;
	if (totalMs <= 0) return false;
	const remainingMs = cachedTurnCreds.expiryMs - now;
	return remainingMs <= totalMs * thresholdFraction;
}

// Возвращает массив RTCIceServer (только TURN-записи, по одной на uri) или
// null при любой ошибке (сеть/таймаут/битый ответ/эндпоинт не настроен) —
// вызывающая сторона (resolveCallIceServers) отвечает за откат на STUN-only.
export async function fetchTurnCredentials(url, options = {}) {
	const now = options.now ?? Date.now();
	if (cachedTurnCreds && now < cachedTurnCreds.expiryMs) {
		return cachedTurnCreds.iceServers;
	}
	const fetchImpl = options.fetchImpl ?? globalThis.fetch;
	if (!url || typeof fetchImpl !== 'function') return null;
	const timeoutMs = options.timeoutMs ?? 4000;
	let timer;
	const timeout = new Promise((_, reject) => {
		timer = setTimeout(() => reject(new Error('fetchTurnCredentials: таймаут')), timeoutMs);
	});
	try {
		const res = await Promise.race([fetchImpl(url, { cache: 'no-store' }), timeout]);
		if (!res || !res.ok) return null;
		const data = await res.json();
		if (!data || typeof data.username !== 'string' || typeof data.credential !== 'string' || !Array.isArray(data.uris)) {
			return null;
		}
		const iceServers = data.uris
			.filter((u) => typeof u === 'string' && u)
			.map((urls) => ({ urls, username: data.username, credential: data.credential }));
		if (iceServers.length === 0) return null;
		const ttlSeconds = typeof data.ttl === 'number' && data.ttl > 60 ? data.ttl : 3600;
		cachedTurnCreds = { iceServers, expiryMs: now + (ttlSeconds - 60) * 1000, issuedAtMs: now };
		return iceServers;
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}

// Живая проверка (прод, 2026-09-06) — RTCPeerConnection синхронно бросает
// InvalidAccessError, если ХОТЬ ОДНА запись со схемой turn:/turns: не несёт
// username+credential (спека WebRTC, не баг браузера) — падает КОНСТРУКТОР,
// весь массив целиком, не только эта запись. baseIce (config.json, этап 6)
// содержит turn: без кредов НАРОЧНО — креды не в бандле. Раньше эта функция
// только стирала credential-поля, оставляя схему turn: как есть, и ронять
// каждый ensurePc()/RTCPeerConnection — по факту ВСЕ звонки на проде.
// Фикс — выкидывать turn:/turns: целиком (не просто снимать креды): свежие
// с кредами добавляются отдельно (resolveCallIceServers), а без них корректный
// STUN-only фолбэк — это то, что uris в TURN-схеме вообще отсутствуют.
function stripIceCredentials(list) {
	return list
		.filter((s) => {
			const urls = Array.isArray(s.urls) ? s.urls : s.urls ? [s.urls] : [];
			return !urls.some((u) => typeof u === 'string' && /^turns?:/i.test(u));
		})
		.map((s) => ({ urls: s.urls }));
}

// Общая точка для call.js и quick.jsx (Rooms/mesh) — единственное место,
// где собирается iceServers для НОВОГО RTCPeerConnection (не кэшируется на
// уровне сессии/звонка выше media-controller.js — там уже дожидается свежих
// кредов перед КАЖДЫМ pc, см. media-controller.js/resolveIceServers).
// turnCredentialsUrl отсутствует (self-host/LAN, config.json без него) —
// прежнее поведение: iceServers из bootstrap/build-time дефолта как есть.
export async function resolveCallIceServers(options = {}) {
	const boot = readBootstrapEndpoints();
	const baseIce = boot.iceServers.length ? boot.iceServers : BUILD_DEFAULT_ICE_SERVERS;
	const turnCredentialsUrl = getRuntimeConfig().turnCredentialsUrl;
	if (!turnCredentialsUrl) return baseIce;
	// TZ-recovery-policy.md §2.3 — вызывается media-controller.js's doIceRestart
	// перед КАЖДОЙ попыткой рестарта: если больше половины TTL уже прошло,
	// сбросить кэш и запросить свежие креды, а не ждать полного истечения.
	if (options.refreshIfStale && isTurnCredsStale(options.now)) {
		resetTurnCredentialsCache();
	}
	const turnServers = await fetchTurnCredentials(turnCredentialsUrl, options);
	if (!turnServers) {
		logWarn('TURN: креды недоступны, только STUN');
		return stripIceCredentials(baseIce);
	}
	return [...stripIceCredentials(baseIce), ...turnServers];
}
