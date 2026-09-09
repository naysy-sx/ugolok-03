// MEDIA-PERF-TZ.md §3 — счётчики внутри клиента вместо стенда: живой телефон
// в реальной сети говорит правду, throttled-профиль на десктопе — нет.
// Включение: localStorage["ugolok:perf"] === "1". По умолчанию выключено —
// mark/count/end на выключенном флаге НЕ форматируют строки и не копят
// массивы фаз, только два переиспользуемых no-op'а (NOOP_TRACE), без
// аллокации на каждый вызов startTrace().
//
// MEDIA-PERF-TZ-4.md §7 (задача D) — на телефоне без удалённой отладки
// console.info и ручной localStorage.setItem() недоступны вовсе:
// инструментирование третьего прохода было неснимаемым на целевом
// устройстве. Три довеска: (1) ?perf=1/?perf=0 в адресе — тот же приём, что
// ?diag=1 в src/core/diag/call-trace.js; (2) кольцевой журнал последних 200
// операций, переживающий перезагрузку; (3) getPerfLog()/readControllerCounters()
// читает UI экрана настроек (settings.jsx) для копирования в буфер обмена.
const TRACE_FLAG_KEY = "ugolok:perf";
const SW_COUNTER_KEY = "ugolok:perf:sw";
const LOG_KEY = "ugolok:perf:log";
const LOG_MAX_ENTRIES = 200;

function readLocalStorage(key) {
	try {
		return typeof localStorage !== "undefined" ? localStorage.getItem(key) : null;
	} catch {
		return null; // приватные вкладки/квота — трассировка не критична, тихо выключаем
	}
}

function writeLocalStorage(key, value) {
	try {
		if (typeof localStorage !== "undefined") localStorage.setItem(key, value);
	} catch {
		// ignore
	}
}

function removeLocalStorage(key) {
	try {
		if (typeof localStorage !== "undefined") localStorage.removeItem(key);
	} catch {
		// ignore
	}
}

// §7 задача D — "Включение через адрес": ?perf=1 взводит флаг, ?perf=0 снимает.
// Тот же приём, что ?diag=1 (call-trace.js): МОДУЛЬ-уровневая проверка один
// раз на загрузку вкладки, до первого чтения isPerfTraceEnabled(). В отличие
// от diag (sessionStorage — "не расползается на будущие визиты"), здесь
// СОЗНАТЕЛЬНО localStorage — ТЗ прямо указывает ключ ugolok:perf, флаг должен
// пережить обычную (не форс-релоад) навигацию между экранами, пока человек
// открывает картинки/видео по сценарию замера.
function readPerfParamFromLocation() {
	if (typeof location === "undefined") return null;
	try {
		const v = new URLSearchParams(location.search).get("perf");
		if (v === "1") return true;
		if (v === "0") return false;
		return null;
	} catch {
		return null;
	}
}

const perfParam = readPerfParamFromLocation();
if (perfParam === true) writeLocalStorage(TRACE_FLAG_KEY, "1");
else if (perfParam === false) removeLocalStorage(TRACE_FLAG_KEY);

export function isPerfTraceEnabled() {
	return readLocalStorage(TRACE_FLAG_KEY) === "1";
}

function now() {
	return typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
}

function formatSize(bytes) {
	if (bytes == null || Number.isNaN(bytes)) return "?";
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${(bytes / 1024 / 1024).toFixed(2)}MB`;
}

// §7 задача D — "Кольцевой журнал": последние 200 записей, одна строка на
// операцию, поля через ";" (вставляется в таблицу как есть — Google Sheets/
// Excel понимают ";" как разделитель не хуже запятой, а запятая уже занята
// внутри JSON-подобных значений extra). Пишется СИНХРОННО на каждый end() —
// объём (≤200 коротких строк) не требует периодического persist(), как у
// call-trace.js (там счёт на тысячи записей в секунду при getStats()-опросе).
function readLogEntries() {
	const raw = readLocalStorage(LOG_KEY);
	if (!raw) return [];
	try {
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

function pushLogEntry(line) {
	const entries = readLogEntries();
	entries.push(line);
	while (entries.length > LOG_MAX_ENTRIES) entries.shift();
	writeLocalStorage(LOG_KEY, JSON.stringify(entries));
}

export function getPerfLog() {
	return readLogEntries();
}

export function clearPerfLog() {
	removeLocalStorage(LOG_KEY);
}

const NOOP_TRACE = Object.freeze({
	mark() {},
	count() {},
	end() {},
});

// startTrace(kind, digest, size) -> { mark(phase, ms?), count(name, n?), end(extra?) }.
// mark(phase, ms) — ms передан явно: СУММИРУЕТ в именованную фазу (для операций
// с несколькими перекрывающимися под-вызовами — N чанков читаются параллельно,
// "net" и "decrypt" не идут строго друг за другом). mark(phase) без ms — дельта
// от последнего mark/start (для простых последовательных фаз вроде decode/draw/encode
// в raster-image.js). count(name, n) — сумма произвольного счётчика (число HTTP-
// запросов и т.п.), в строку идёт как "name=N". end(extra) — печатает ОДНУ строку
// в console.info И дублирует её (с ISO-таймстампом, через ";") в кольцевой журнал.
export function startTrace(kind, digest, size) {
	if (!isPerfTraceEnabled()) return NOOP_TRACE;

	const t0 = now();
	let lastDelta = t0;
	const phases = new Map();
	const counters = new Map();

	return {
		mark(phase, ms) {
			const delta = typeof ms === "number" ? ms : (() => {
				const t = now();
				const d = t - lastDelta;
				lastDelta = t;
				return d;
			})();
			phases.set(phase, (phases.get(phase) || 0) + delta);
		},
		count(name, n = 1) {
			counters.set(name, (counters.get(name) || 0) + n);
		},
		end(extra = {}) {
			const total = now() - t0;
			const digestShort = digest ? String(digest).slice(0, 8) : "?";
			const fields = [
				kind,
				`d=${digestShort}`,
				`size=${formatSize(size)}`,
				...[...phases.entries()].map(([p, ms]) => `${p}=${Math.round(ms)}`),
				...[...counters.entries()].map(([n, v]) => `${n}=${v}`),
				`total=${Math.round(total)}`,
				...Object.entries(extra).map(([k, v]) => `${k}=${v}`),
			];
			console.info(fields.join(" "));
			pushLogEntry(`${new Date().toISOString()};${fields.join(";")}`);
		},
	};
}

// §3.3 — фолбэк без SW-controller живёт или мёртв в проде? Единственный способ
// узнать без стенда: копить накопительно, пишется ВСЕГДА, независимо от флага
// ugolok:perf (объём — два целых числа, не строки/логи).
export function recordControllerCheck(ok) {
	const raw = readLocalStorage(SW_COUNTER_KEY);
	let counters;
	try {
		counters = raw ? JSON.parse(raw) : { ok: 0, null: 0 };
	} catch {
		counters = { ok: 0, null: 0 };
	}
	if (ok) counters.ok = (counters.ok || 0) + 1;
	else counters.null = (counters.null || 0) + 1;
	writeLocalStorage(SW_COUNTER_KEY, JSON.stringify(counters));
	return counters;
}

export function readControllerCounters() {
	const raw = readLocalStorage(SW_COUNTER_KEY);
	if (!raw) return { ok: 0, null: 0 };
	try {
		return JSON.parse(raw);
	} catch {
		return { ok: 0, null: 0 };
	}
}
