import { signal } from "@preact/signals";

// TZ-diag-trace.md — трассировка звонков за флагом ?diag=1. НЕ меняет логику
// звонков ни на бит: домен (src/domain/calls/*, src/domain/rooms/*) не
// импортирует этот модуль — вызывает инъецированный колбэк onTrace, который
// UI-слой (call.js, quick.jsx, transport.js, room-session.js) собирает здесь
// и передаёт внутрь (TZ §0.3). Этот файл — единственное место, которое знает
// про sessionStorage/localStorage/downloads для звонковой диагностики.
//
// Санитизация (TZ §4) — централизована ЗДЕСЬ, а не в местах вызова: домену
// не нужно знать политику маскировки, а разбросанная по десятку файлов
// логика "не забыть замаскировать IP" рано или поздно даст пропуск. record()
// прогоняет КАЖДУЮ запись через sanitizePayload() перед тем, как она попадёт
// в буфер — даже если какой-то будущий вызов onTrace передаст лишнее.

const ENABLED_KEY = "ugolok.diag.enabled";
const STORAGE_KEY = "ugolok.diag.trace.v1";
const MAX_ENTRIES = 5000;
const MAX_BYTES = 2 * 1024 * 1024; // 2 МиБ, TZ §3
const PERSIST_INTERVAL_MS = 5000;

// Ключи, которые НИКОГДА не попадают в запись — даже если что-то по ошибке
// их передаст (TZ §4: приватные ключи, содержимое, секреты, пароль TURN,
// SDP целиком).
const DENY_KEYS = new Set([
	"privkey",
	"privatekey",
	"seckey",
	"secretkey",
	"mnemonic",
	"secret",
	"staticauthsecret",
	"credential",
	"password",
	"content",
	"plaintext",
	"sdp",
]);

// Публичные ключи — усечь до 8 символов (TZ §4).
const TRUNCATE_HEX_KEYS = new Set([
	"pubkey",
	"peer",
	"peerpubkey",
	"frompubkey",
	"topubkey",
	"selfpubkey",
	"senderpubkey",
	"mypubkey",
]);

// IP-адреса — маскировать до /24 (IPv4) либо аналогично для IPv6 (TZ не
// уточняет IPv6 — здесь взято независимое решение: усечение до первых 4
// групп, ближайший аналог /24 для v6; см. заметку в docs/diag-trace-schema.md).
const MASK_ADDRESS_KEYS = new Set(["address", "ip"]);

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function maskAddress(value) {
	if (typeof value !== "string") return value;
	const m = IPV4_RE.exec(value);
	if (m) return `${m[1]}.${m[2]}.${m[3]}.0/24`;
	if (value.includes(":")) {
		const groups = value.split(":");
		return groups.slice(0, 4).join(":") + "::/64";
	}
	return "masked";
}

function truncateHex(value) {
	if (typeof value !== "string" || value.length <= 8) return value;
	return value.slice(0, 8) + "…";
}

// Рекурсивный обход с потолком глубины — защита от патологических структур,
// не от честных данных трассировки (которые все плоские/двухуровневые).
function sanitizeValue(value, depth) {
	if (value === null || value === undefined) return value;
	if (depth > 5) return "[обрезано]";
	if (Array.isArray(value)) return value.map((v) => sanitizeValue(v, depth + 1));
	if (typeof value === "object") return sanitizePayload(value, depth + 1);
	return value;
}

function sanitizePayload(payload, depth = 0) {
	if (!payload || typeof payload !== "object") return payload;
	const out = {};
	for (const [key, rawValue] of Object.entries(payload)) {
		const lower = key.toLowerCase();
		if (DENY_KEYS.has(lower)) continue; // выкинуть целиком, не маскировать
		let value = rawValue;
		if (MASK_ADDRESS_KEYS.has(lower)) {
			value = maskAddress(value);
		} else if (TRUNCATE_HEX_KEYS.has(lower)) {
			value = truncateHex(value);
		} else {
			value = sanitizeValue(value, depth);
		}
		out[key] = value;
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

function hasLocation() {
	return typeof location !== "undefined";
}

function readDiagParamFromLocation() {
	if (!hasLocation()) return false;
	try {
		return new URLSearchParams(location.search).get("diag") === "1";
	} catch {
		return false;
	}
}

// sessionStorage, не localStorage (TZ §1): переживает форс-релоад SW, но не
// расползается на будущие вкладки/визиты, где пользователь не просил запись.
function readEnabledFlag() {
	if (typeof sessionStorage === "undefined") return false;
	return readStorage(sessionStorage, ENABLED_KEY) === "1";
}

// Модуль-уровневая инициализация — ОДИН РАЗ на загрузку вкладки. ?diag=1
// взводит sessionStorage-флаг сразу; дальше isTraceEnabled() читает только
// его, независимо от того, остался ли параметр в адресной строке.
if (readDiagParamFromLocation() && typeof sessionStorage !== "undefined") {
	writeStorage(sessionStorage, ENABLED_KEY, "1");
}

export function isTraceEnabled() {
	return readEnabledFlag();
}

// TZ §1 — "постоянный ненавязчивый признак, что запись идёт", видимый с
// ЛЮБОГО экрана (diag-trace-badge.jsx, смонтирован в app.jsx рядом с
// CallOverlay/ToastHost) — сигнал, а не просто функция, чтобы бейдж
// перерисовался сразу при переключении тумблера на экране диагностики, без
// опроса по таймеру.
export const traceEnabledSignal = signal(readEnabledFlag());

export function setTraceEnabled(on) {
	if (typeof sessionStorage === "undefined") return;
	if (on) writeStorage(sessionStorage, ENABLED_KEY, "1");
	else removeStorage(sessionStorage, ENABLED_KEY);
	traceEnabledSignal.value = on;
}

function randomId() {
	try {
		return crypto.randomUUID().replace(/-/g, "").slice(0, 12);
	} catch {
		return Math.random().toString(36).slice(2, 14);
	}
}

// sid — один на загрузку вкладки, вычисляется один раз независимо от флага
// (дешёвая генерация id — не таймер, не подписка, не запись в хранилище;
// не подпадает под "нулевую стоимость" из TZ §0.4, которая перечисляет
// именно эти три вещи).
const SID = randomId();

let rows = [];
let persistTimerId = null;
let listenersBound = false;
let restoredThisLoad = false;

function nowIso() {
	return new Date().toISOString();
}

function currentBufferedBytesEstimate() {
	// Точный byteLength каждый push — лишняя работа на горячем пути (до
	// нескольких записей/сек при активном getStats()-опросе меша на 5
	// человек). Оцениваем размер только в persist(), не на каждый push.
	return JSON.stringify(rows).length;
}

function trimToByteBudget() {
	while (rows.length > 1 && currentBufferedBytesEstimate() > MAX_BYTES) {
		rows.shift();
	}
}

function persist() {
	if (!isTraceEnabled()) return;
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

function ensureStarted() {
	if (!isTraceEnabled()) return;
	restoreOnce();
	if (persistTimerId === null && typeof setInterval === "function") {
		persistTimerId = setInterval(persist, PERSIST_INTERVAL_MS);
		// Node (тесты, любой SSR-подобный контекст) — не держать процесс живым
		// из-за диагностического таймера; в браузере setInterval возвращает
		// число без .unref, ветка просто не выполняется.
		if (typeof persistTimerId?.unref === "function") persistTimerId.unref();
	}
	bindLifecycleListenersOnce();
}

// Восстановление буфера ПРИ ЗАГРУЗКЕ (TZ §3) — только если запись уже шла
// (флаг включён на момент этого вызова: либо ?diag=1 в адресе, либо
// sessionStorage пережил форс-релоад SW). Выполняется один раз за жизнь
// вкладки — повторный вызов ensureStarted() (например, из diagnostics.jsx
// при включении тумблера) не должен повторно "восстанавливать" уже текущий
// буфер как будто это новый reload.
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
	rows.push({
		t: nowIso(),
		mono: safeNow(),
		sid: SID,
		ev: "page-reload",
		payload: { restoredEntries: rows.length },
	});
}

function safeNow() {
	try {
		return performance.now();
	} catch {
		return Date.now();
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

// record(ev, payload) — ЕДИНСТВЕННАЯ точка записи. Вызывается напрямую как
// onTrace из доменных модулей — ОБЯЗАНА никогда не бросать (TZ §0.5): весь
// корпус в try/catch, включая саму сериализацию/санитизацию.
export function record(ev, payload) {
	try {
		if (!isTraceEnabled()) return;
		ensureStarted();
		const entry = {
			t: nowIso(),
			mono: safeNow(),
			sid: SID,
			ev,
			...sanitizePayload(payload || {}),
		};
		rows.push(entry);
		if (rows.length > MAX_ENTRIES) rows.shift();
	} catch {
		// трассировка не должна ронять звонок — TZ §0.5
	}
}

export function getRows() {
	return rows.slice();
}

export function clearTrace() {
	rows = [];
	if (typeof localStorage !== "undefined") removeStorage(localStorage, STORAGE_KEY);
}

// Только для тестов — тот же принцип, что resetBootLogForTests() в
// boot-log.js: rows/persistTimerId/restoredThisLoad — модуль-уровневое
// состояние синглтона, тесты должны стартовать с чистого листа.
export function resetTraceForTests() {
	rows = [];
	stopPersistTimer();
	restoredThisLoad = false;
	listenersBound = false;
}

export function getTraceStats() {
	if (rows.length === 0) return { count: 0, fromT: null, toT: null };
	return { count: rows.length, fromT: rows[0].t, toT: rows[rows.length - 1].t };
}

function traceFileName() {
	return `call-trace_${SID}_${nowIso().replace(/[:.]/g, "-")}.json`;
}

export function traceAsJson() {
	return JSON.stringify({ sid: SID, exportedAt: nowIso(), events: rows }, null, 2);
}

// Выгрузка — три способа (TZ §5), каждый best-effort, ошибка одного не
// должна мешать остальным (телефон без "Скачать", десктоп без Web Share…).
export function downloadTraceFile() {
	if (typeof document === "undefined") return;
	const blob = new Blob([traceAsJson()], { type: "application/json" });
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = traceFileName();
	document.body.appendChild(a);
	a.click();
	a.remove();
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function copyTraceToClipboard() {
	if (typeof navigator === "undefined" || !navigator.clipboard) return false;
	try {
		await navigator.clipboard.writeText(traceAsJson());
		return true;
	} catch {
		return false;
	}
}

export async function shareTraceIfAvailable() {
	if (typeof navigator === "undefined" || typeof navigator.share !== "function") return false;
	try {
		const file = new File([traceAsJson()], traceFileName(), { type: "application/json" });
		if (navigator.canShare && !navigator.canShare({ files: [file] })) return false;
		await navigator.share({ files: [file], title: traceFileName() });
		return true;
	} catch {
		return false;
	}
}

// Консольный хелпер (TZ §5) — вешается безусловно (дешёвое присваивание
// поля объекту window, не подписка/не таймер), полезен при отладке по кабелю
// даже если человек не открывал экран диагностики.
if (typeof window !== "undefined") {
	window.__ugolokTrace = {
		rows: getRows,
		save: downloadTraceFile,
		clear: clearTrace,
	};
}
