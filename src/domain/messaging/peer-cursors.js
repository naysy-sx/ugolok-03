// Часть A (READ-STATUS-AND-LAST-SEEN-TZ.md) — курсоры delivered/read на пару
// (owner, contact). Хранится чужой курсор (меня прочитали). Исходящий курсор
// дебаунсится: склейка 3 с, не чаще одного события на пару в 10 с.

import { db } from "../../core/store/database.js";

export const CURSOR_MARKER_PREFIX = "__ugolok_cursor__:";
export const CURSOR_COALESCE_MS = 3000;
export const CURSOR_MIN_INTERVAL_MS = 10_000;

export const cursorClock = {
	now: () => Date.now(),
	setTimeout: (fn, ms) => setTimeout(fn, ms),
	clearTimeout: (id) => clearTimeout(id),
};

const sessions = new Map();

function sessionKey(ownerPubkey, contactPubkey) {
	return `${ownerPubkey}:${contactPubkey}`;
}

function getSession(ownerPubkey, contactPubkey) {
	const k = sessionKey(ownerPubkey, contactPubkey);
	let s = sessions.get(k);
	if (!s) {
		s = { ownerPubkey, contactPubkey };
		sessions.set(k, s);
	}
	return s;
}

export function buildCursorText({ d, r }) {
	const payload = {};
	if (typeof d === "number") payload.d = d;
	if (typeof r === "number") payload.r = r;
	return CURSOR_MARKER_PREFIX + JSON.stringify(payload);
}

export function parseCursorText(text) {
	if (typeof text !== "string" || !text.startsWith(CURSOR_MARKER_PREFIX)) return null;
	try {
		const parsed = JSON.parse(text.slice(CURSOR_MARKER_PREFIX.length));
		if (typeof parsed !== "object" || parsed === null) return null;
		const out = {};
		if (typeof parsed.d === "number") out.d = parsed.d;
		if (typeof parsed.r === "number") out.r = parsed.r;
		if (out.d === undefined && out.r === undefined) return null;
		return out;
	} catch {
		return null;
	}
}

export function extractCursorFromPayload(parsed) {
	if (!parsed || typeof parsed !== "object") return null;
	const fromText = parseCursorText(parsed.text);
	if (fromText) return fromText;
	const out = {};
	if (typeof parsed.d === "number") out.d = parsed.d;
	else if (typeof parsed.ackUpTo === "number") out.d = parsed.ackUpTo;
	if (typeof parsed.r === "number") out.r = parsed.r;
	if (out.d === undefined && out.r === undefined) return null;
	return out;
}

export async function applyPeerCursor(ownerPubkey, contactPubkey, incoming) {
	if (!incoming) return getPeerCursor(ownerPubkey, contactPubkey);
	const existing = await db.table("peerCursors").get([ownerPubkey, contactPubkey]);
	let deliveredUpTo = existing?.deliveredUpTo ?? 0;
	let readUpTo = existing?.readUpTo ?? 0;
	if (typeof incoming.d === "number" && incoming.d > deliveredUpTo) deliveredUpTo = incoming.d;
	if (typeof incoming.r === "number" && incoming.r > readUpTo) readUpTo = incoming.r;
	if (readUpTo > deliveredUpTo) readUpTo = deliveredUpTo;
	if (existing && existing.deliveredUpTo === deliveredUpTo && existing.readUpTo === readUpTo) return existing;
	const row = { ownerPubkey, contactPubkey, deliveredUpTo, readUpTo, updatedAt: cursorClock.now() };
	await db.table("peerCursors").put(row);
	return row;
}

export async function getPeerCursor(ownerPubkey, contactPubkey) {
	const row = await db.table("peerCursors").get([ownerPubkey, contactPubkey]);
	return row ?? { ownerPubkey, contactPubkey, deliveredUpTo: 0, readUpTo: 0, updatedAt: 0 };
}

export function markCursorSent(ownerPubkey, contactPubkey, d, r) {
	const s = getSession(ownerPubkey, contactPubkey);
	if (typeof d === "number") s.lastSentD = Math.max(s.lastSentD ?? 0, d);
	if (typeof r === "number") s.lastSentR = Math.max(s.lastSentR ?? 0, r);
	s.lastSentAt = cursorClock.now();
}

export function cursorGrewSinceLastSend(ownerPubkey, contactPubkey, d, r) {
	const s = getSession(ownerPubkey, contactPubkey);
	const grewD = typeof d === "number" && d > (s.lastSentD ?? 0);
	const grewR = typeof r === "number" && r > (s.lastSentR ?? 0);
	return grewD || grewR;
}

export function bindCursorFlush(ownerPubkey, contactPubkey, flushFn) {
	const s = getSession(ownerPubkey, contactPubkey);
	s.flushFn = flushFn;
}

function arm(s) {
	if (s.timer) return;
	s.timer = cursorClock.setTimeout(() => {
		s.timer = null;
		s.flushFn?.();
	}, CURSOR_COALESCE_MS);
}

export function scheduleCursorFlush(ownerPubkey, contactPubkey) {
	arm(getSession(ownerPubkey, contactPubkey));
}

export async function flushCursorNow(ownerPubkey, contactPubkey) {
	const s = sessions.get(sessionKey(ownerPubkey, contactPubkey));
	if (!s) return;
	if (s.timer) {
		cursorClock.clearTimeout(s.timer);
		s.timer = null;
	}
	await s.flushFn?.();
}

export function delayUntilMinInterval(ownerPubkey, contactPubkey) {
	const s = getSession(ownerPubkey, contactPubkey);
	if (!s.lastSentAt) return 0;
	const wait = CURSOR_MIN_INTERVAL_MS - (cursorClock.now() - s.lastSentAt);
	return wait > 0 ? wait : 0;
}

export function rearmAfterMinInterval(ownerPubkey, contactPubkey) {
	const s = getSession(ownerPubkey, contactPubkey);
	const wait = delayUntilMinInterval(ownerPubkey, contactPubkey);
	if (wait <= 0) return false;
	if (s.timer) cursorClock.clearTimeout(s.timer);
	s.timer = cursorClock.setTimeout(() => {
		s.timer = null;
		s.flushFn?.();
	}, wait);
	return true;
}

export function resetCursorRuntime() {
	for (const s of sessions.values()) {
		if (s.timer) cursorClock.clearTimeout(s.timer);
	}
	sessions.clear();
}
