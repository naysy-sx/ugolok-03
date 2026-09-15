import { signal } from "@preact/signals";

// Этап 0 (PROCESS-DOCS/AUDIT/MESSAGE-DELIVERY-TZ.md, З0.1) — журнал доставки
// 1:1 сообщений. Прямой архитектурный клон src/core/diag/call-trace.js (тот
// же класс задачи: диагностика поверх горячего пути, обязана быть no-op по
// умолчанию и никогда не ронять вызывающий код) — та же схема ?diag=1 →
// sessionStorage-флаг → in-memory кольцевой буфер → периодический localStorage-
// персист → выгрузка. НЕ таблица Dexie (ТЗ предлагало deliveryTrace как
// Dexie-таблицу — автор ТЗ прямо пишет, что код не читал, п.3 брифинга):
// localStorage-путь уже проверен в бою на call-trace.js, переживает форс-
// релоад SW, не требует миграции схемы (db.version) ради диагностического,
// не пользовательского, состояния. При необходимости пережить полный сброс
// localStorage (приватный режим и т.п.) — не задача этого модуля, тот же
// компромисс уже принят для звонков.

const ENABLED_KEY = "ugolok.diag.delivery.enabled";
const STORAGE_KEY = "ugolok.diag.delivery.trace.v1";
const MAX_ENTRIES = 3000;
const MAX_BYTES = 1 * 1024 * 1024; // 1 МиБ — доставка менее "чатливая", чем getStats() звонков
const PERSIST_INTERVAL_MS = 5000;

// Точки записи (З0.1) — единственный контракт "что значит stage":
// ui.send.click, establish.enter, establish.throw, keypackages.req,
// keypackages.eose, encrypt.done, state.persisted, event.signed,
// outbox.enqueued, publish.sent, publish.ok, publish.reject, message.upsert,
// recv.445, recv.445.nogroup, recv.445.decryptfail, recv.welcome,
// drain.start, drain.done, relay.state — каждый вызывающий код передаёт своё
// имя строкой, модуль их не валидирует (та же позиция, что call-trace.js:
// список — контракт по конвенции, не enum в коде).

const DENY_KEYS = new Set(["text", "content", "plaintext", "privkey", "privatekey", "seckey", "secretkey", "mnemonic", "dbkey", "attachments"]);

const TRUNCATE_HEX_KEYS = new Set(["pubkey", "peer", "contactpubkey", "ownerpubkey", "senderpubkey", "groupidhex", "groupid", "eventid", "msgid"]);

function truncateHex(value) {
	if (typeof value !== "string" || value.length <= 10) return value;
	return value.slice(0, 10) + "…";
}

function sanitizeDetail(detail) {
	if (!detail || typeof detail !== "object") return detail;
	const out = {};
	for (const [key, rawValue] of Object.entries(detail)) {
		const lower = key.toLowerCase();
		if (DENY_KEYS.has(lower)) continue;
		out[key] = TRUNCATE_HEX_KEYS.has(lower) ? truncateHex(rawValue) : rawValue;
	}
	return out;
}

function readStorage(storage, key) {
	try {
		return storage.getItem(key);
	} catch {
		return null;
	}
}

function writeStorage(storage, key, value) {
	try {
		storage.setItem(key, value);
	} catch {
		// приватный режим/квота — трассировка best-effort, не роняем приложение
	}
}

function removeStorage(storage, key) {
	try {
		storage.removeItem(key);
	} catch {
		// ignore
	}
}

function readDiagParamFromLocation() {
	if (typeof location === "undefined") return false;
	try {
		return new URLSearchParams(location.search).get("diag") === "1";
	} catch {
		return false;
	}
}

function readEnabledFlag() {
	if (typeof sessionStorage === "undefined") return false;
	return readStorage(sessionStorage, ENABLED_KEY) === "1";
}

if (readDiagParamFromLocation() && typeof sessionStorage !== "undefined") {
	writeStorage(sessionStorage, ENABLED_KEY, "1");
}

export function isDeliveryTraceEnabled() {
	return readEnabledFlag();
}

export const deliveryTraceEnabledSignal = signal(readEnabledFlag());

export function setDeliveryTraceEnabled(on) {
	if (typeof sessionStorage === "undefined") return;
	if (on) writeStorage(sessionStorage, ENABLED_KEY, "1");
	else removeStorage(sessionStorage, ENABLED_KEY);
	deliveryTraceEnabledSignal.value = on;
}

function randomId() {
	try {
		return crypto.randomUUID().replace(/-/g, "").slice(0, 12);
	} catch {
		return Math.random().toString(36).slice(2, 14);
	}
}

const SID = randomId();

let rows = [];
let persistTimerId = null;
let listenersBound = false;
let restoredThisLoad = false;

function nowIso() {
	return new Date().toISOString();
}

function safeNow() {
	try {
		return performance.now();
	} catch {
		return Date.now();
	}
}

function currentBufferedBytesEstimate() {
	return JSON.stringify(rows).length;
}

function trimToByteBudget() {
	while (rows.length > 1 && currentBufferedBytesEstimate() > MAX_BYTES) {
		rows.shift();
	}
}

function persist() {
	if (!isDeliveryTraceEnabled()) return;
	if (typeof localStorage === "undefined") return;
	trimToByteBudget();
	try {
		writeStorage(localStorage, STORAGE_KEY, JSON.stringify(rows));
	} catch {
		// сериализация/квота — трассировка best-effort
	}
}

function stopPersistTimer() {
	if (persistTimerId !== null) {
		clearInterval(persistTimerId);
		persistTimerId = null;
	}
}

function bindLifecycleListenersOnce() {
	if (listenersBound) return;
	if (typeof document === "undefined" || typeof window === "undefined") return;
	listenersBound = true;
	window.addEventListener("pagehide", persist);
	document.addEventListener("visibilitychange", () => {
		if (document.visibilityState === "hidden") persist();
	});
}

function restoreOnce() {
	if (restoredThisLoad) return;
	restoredThisLoad = true;
	if (typeof localStorage === "undefined") return;
	const raw = readStorage(localStorage, STORAGE_KEY);
	if (!raw) return;
	try {
		const prev = JSON.parse(raw);
		if (Array.isArray(prev)) rows = prev;
	} catch {
		return;
	}
	rows.push({ t: nowIso(), mono: safeNow(), sid: SID, stage: "page-reload", detail: { restoredEntries: rows.length } });
}

function ensureStarted() {
	if (!isDeliveryTraceEnabled()) return;
	restoreOnce();
	if (persistTimerId === null && typeof setInterval === "function") {
		persistTimerId = setInterval(persist, PERSIST_INTERVAL_MS);
		if (typeof persistTimerId?.unref === "function") persistTimerId.unref();
	}
	bindLifecycleListenersOnce();
}

// record(stage, detail) — ЕДИНСТВЕННАЯ точка записи. Вызывается напрямую из
// src/domain/messaging/chat.js и src/ui/signals/transport.js (не наоборот —
// этот модуль ничего не импортирует из домена, тот же принцип разделения,
// что call-trace.js/onTrace). ОБЯЗАНА никогда не бросать — весь корпус в
// try/catch, включая сериализацию/санитизацию (иначе диагностика подставляет
// саму отправку сообщения под риск).
export function record(stage, detail) {
	try {
		if (!isDeliveryTraceEnabled()) return;
		ensureStarted();
		const entry = { t: nowIso(), mono: safeNow(), sid: SID, stage, detail: sanitizeDetail(detail || {}) };
		rows.push(entry);
		if (rows.length > MAX_ENTRIES) rows.shift();
	} catch {
		// трассировка не должна ронять отправку сообщения
	}
}

export function getDeliveryTraceRows() {
	return rows.slice();
}

export function clearDeliveryTrace() {
	rows = [];
	if (typeof localStorage !== "undefined") removeStorage(localStorage, STORAGE_KEY);
}

// Только для тестов — тот же принцип, что resetTraceForTests() в call-trace.js.
export function resetDeliveryTraceForTests() {
	rows = [];
	stopPersistTimer();
	restoredThisLoad = false;
	listenersBound = false;
}

export function getDeliveryTraceStats() {
	if (rows.length === 0) return { count: 0, fromT: null, toT: null };
	return { count: rows.length, fromT: rows[0].t, toT: rows[rows.length - 1].t };
}

function traceFileName() {
	return `delivery-trace_${SID}_${nowIso().replace(/[:.]/g, "-")}.json`;
}

export function deliveryTraceAsJson() {
	return JSON.stringify({ sid: SID, exportedAt: nowIso(), events: rows }, null, 2);
}

export function downloadDeliveryTraceFile() {
	if (typeof document === "undefined") return;
	const blob = new Blob([deliveryTraceAsJson()], { type: "application/json" });
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = traceFileName();
	document.body.appendChild(a);
	a.click();
	a.remove();
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function copyDeliveryTraceToClipboard() {
	if (typeof navigator === "undefined" || !navigator.clipboard) return false;
	try {
		await navigator.clipboard.writeText(deliveryTraceAsJson());
		return true;
	} catch {
		return false;
	}
}

if (typeof window !== "undefined") {
	window.__ugolokDeliveryTrace = {
		rows: getDeliveryTraceRows,
		save: downloadDeliveryTraceFile,
		clear: clearDeliveryTrace,
	};
}
