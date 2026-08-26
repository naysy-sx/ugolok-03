// Device-level endpoints до логина (localStorage). ICE в uiSettings /
// kind-событие НЕ кладётся — этого слоя достаточно для стартового экрана
// и звонков с этого устройства.
import { BUILD_DEFAULT_RELAYS, BUILD_DEFAULT_BLOSSOM_SERVERS, BUILD_DEFAULT_ICE_SERVERS } from '../../config.js';

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

export function parseIceUrl(raw) {
	if (typeof raw !== 'string') return null;
	const trimmed = raw.trim();
	const match = /^(turns?|stuns?):(.+)$/i.exec(trimmed);
	if (!match || !match[2].trim()) return null;
	const scheme = match[1].toLowerCase();
	const rest = match[2].trim();
	const urls = scheme + ':' + rest;
	let host = rest.split(/[:/?]/)[0] || '';
	host = host.replace(/^\[|\]$/g, '');
	if (host === '127.0.0.1' || host === 'localhost' || host === '::1') {
		return { urls, username: 'ugolok', credential: 'ugolok-dev' };
	}
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

function buildTimeDefaults() {
	return {
		relayUrl: BUILD_DEFAULT_RELAYS[0] ?? '',
		blossomUrl: BUILD_DEFAULT_BLOSSOM_SERVERS[0] ?? '',
		iceServers: Array.isArray(BUILD_DEFAULT_ICE_SERVERS) ? BUILD_DEFAULT_ICE_SERVERS.map((s) => ({ ...s })) : [],
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
		return {
			relayUrl: parsed.relayUrl,
			blossomUrl: parsed.blossomUrl,
			iceServers: parsed.iceServers,
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
