import { test } from "node:test";
import assert from "node:assert/strict";
import { startTrace, isPerfTraceEnabled, recordControllerCheck, readControllerCounters, getPerfLog, clearPerfLog } from "../src/domain/media/perf-trace.js";

// Node --test не даёт настоящий localStorage — эмулируем минимальный контракт
// (getItem/setItem), тот же приём, что остальные тесты используют для DOM-API
// (URL.createObjectURL и т.п. — платформенные глобалы Node 20+; localStorage —
// нет, эмулируем сами).
function installFakeLocalStorage() {
	const store = new Map();
	globalThis.localStorage = {
		getItem: (k) => (store.has(k) ? store.get(k) : null),
		setItem: (k, v) => store.set(k, String(v)),
		removeItem: (k) => store.delete(k),
	};
	return () => {
		delete globalThis.localStorage;
	};
}

test("isPerfTraceEnabled: выключено по умолчанию (флаг не установлен)", () => {
	const restore = installFakeLocalStorage();
	assert.equal(isPerfTraceEnabled(), false);
	restore();
});

test("isPerfTraceEnabled: включается ТОЛЬКО строкой '1'", () => {
	const restore = installFakeLocalStorage();
	localStorage.setItem("ugolok:perf", "true");
	assert.equal(isPerfTraceEnabled(), false);
	localStorage.setItem("ugolok:perf", "1");
	assert.equal(isPerfTraceEnabled(), true);
	restore();
});

test("startTrace: выключенный флаг — mark/count/end не бросают, ничего не печатают", () => {
	const restore = installFakeLocalStorage();
	const logs = [];
	const origInfo = console.info;
	console.info = (...args) => logs.push(args);
	const trace = startTrace("image", "abcd1234", 1000);
	trace.mark("net", 10);
	trace.mark("decrypt");
	trace.count("requests");
	trace.end({ cacheHit: 0 });
	assert.equal(logs.length, 0, "при выключенном флаге end() не должен печатать строку");
	console.info = origInfo;
	restore();
});

test("startTrace: выключенный флаг — всегда один и тот же no-op объект (без аллокации на каждый вызов)", () => {
	const restore = installFakeLocalStorage();
	const a = startTrace("image", "d1", 1);
	const b = startTrace("video", "d2", 2);
	assert.equal(a, b, "оба вызова должны вернуть один и тот же переиспользуемый no-op");
	restore();
});

test("startTrace: включённый флаг — end() печатает одну строку с kind/digest/size/total", () => {
	const restore = installFakeLocalStorage();
	localStorage.setItem("ugolok:perf", "1");
	const logs = [];
	const origInfo = console.info;
	console.info = (...args) => logs.push(args.join(" "));
	const trace = startTrace("image", "ab12cd34ef", 2_500_000);
	trace.mark("net", 1840);
	trace.mark("decrypt", 310);
	trace.mark("raster", 1290);
	trace.end();
	assert.equal(logs.length, 1, "ровно одна строка на завершённую операцию");
	const line = logs[0];
	assert.match(line, /^image /);
	assert.match(line, /d=ab12cd34/);
	assert.match(line, /size=2\.\d+MB/);
	assert.match(line, /net=1840/);
	assert.match(line, /decrypt=310/);
	assert.match(line, /raster=1290/);
	assert.match(line, /total=\d+/);
	console.info = origInfo;
	restore();
});

test("startTrace: mark(phase, ms) — накопительная сумма для нескольких под-вызовов одной фазы (параллельные чанки)", () => {
	const restore = installFakeLocalStorage();
	localStorage.setItem("ugolok:perf", "1");
	const logs = [];
	const origInfo = console.info;
	console.info = (...args) => logs.push(args.join(" "));
	const trace = startTrace("player-window", "digest", 100);
	trace.mark("net", 50);
	trace.mark("net", 70);
	trace.mark("net", 30);
	trace.count("requests");
	trace.count("requests");
	trace.count("requests");
	trace.end();
	assert.match(logs[0], /net=150/, "три под-вызова net суммируются");
	assert.match(logs[0], /requests=3/);
	console.info = origInfo;
	restore();
});

test("startTrace: mark(phase) без ms — дельта от предыдущего mark/start (последовательные фазы)", () => {
	const restore = installFakeLocalStorage();
	localStorage.setItem("ugolok:perf", "1");
	const logs = [];
	const origInfo = console.info;
	console.info = (...args) => logs.push(args.join(" "));
	const trace = startTrace("image-overlay", "digest", 100);
	trace.mark("decode");
	trace.mark("draw");
	trace.end();
	assert.match(logs[0], /decode=\d+/);
	assert.match(logs[0], /draw=\d+/);
	console.info = origInfo;
	restore();
});

test("recordControllerCheck/readControllerCounters: пишется НЕЗАВИСИМО от флага ugolok:perf", () => {
	const restore = installFakeLocalStorage();
	// флаг трассировки НЕ установлен вовсе
	assert.equal(isPerfTraceEnabled(), false);
	recordControllerCheck(true);
	recordControllerCheck(true);
	recordControllerCheck(false);
	const counters = readControllerCounters();
	assert.equal(counters.ok, 2);
	assert.equal(counters.null, 1);
	restore();
});

test("readControllerCounters: пусто по умолчанию", () => {
	const restore = installFakeLocalStorage();
	assert.deepEqual(readControllerCounters(), { ok: 0, null: 0 });
	restore();
});

// MEDIA-PERF-TZ-4.md §7 задача D — кольцевой журнал.

test("getPerfLog: пусто по умолчанию", () => {
	const restore = installFakeLocalStorage();
	assert.deepEqual(getPerfLog(), []);
	restore();
});

test("startTrace.end(): при включённом флаге дублирует запись в кольцевой журнал (getPerfLog)", () => {
	const restore = installFakeLocalStorage();
	localStorage.setItem("ugolok:perf", "1");
	const origInfo = console.info;
	console.info = () => {};
	const trace = startTrace("image", "digest1234", 1000);
	trace.mark("net", 100);
	trace.end();
	const log = getPerfLog();
	assert.equal(log.length, 1);
	assert.match(log[0], /^\d{4}-\d{2}-\d{2}T/, "запись начинается с ISO-таймстампа");
	assert.match(log[0], /;image;/);
	assert.match(log[0], /;net=100;/);
	console.info = origInfo;
	restore();
});

test("startTrace.end(): при ВЫКЛЮЧЕННОМ флаге НЕ пишет в журнал (NOOP_TRACE)", () => {
	const restore = installFakeLocalStorage();
	const trace = startTrace("image", "d", 1);
	trace.end();
	assert.deepEqual(getPerfLog(), []);
	restore();
});

test("кольцевой журнал: не больше 200 записей, старые вытесняются", () => {
	const restore = installFakeLocalStorage();
	localStorage.setItem("ugolok:perf", "1");
	const origInfo = console.info;
	console.info = () => {};
	for (let i = 0; i < 205; i++) {
		const trace = startTrace("image", `d${i}`, 1);
		trace.end();
	}
	const log = getPerfLog();
	assert.equal(log.length, 200, "потолок 200 записей");
	assert.match(log[0], /;d=d5;/, "самые старые (индексы 0-4) вытеснены, первая оставшаяся запись — d5");
	assert.match(log[log.length - 1], /;d=d204;/, "последняя запись — самая свежая (d204)");
	console.info = origInfo;
	restore();
});

test("clearPerfLog: опустошает журнал", () => {
	const restore = installFakeLocalStorage();
	localStorage.setItem("ugolok:perf", "1");
	const origInfo = console.info;
	console.info = () => {};
	startTrace("image", "d", 1).end();
	assert.equal(getPerfLog().length, 1);
	clearPerfLog();
	assert.deepEqual(getPerfLog(), []);
	console.info = origInfo;
	restore();
});

test("recordControllerCheck: без localStorage (например, приватный режим бросает) не падает", () => {
	const orig = globalThis.localStorage;
	Object.defineProperty(globalThis, "localStorage", {
		configurable: true,
		get() {
			throw new Error("SecurityError");
		},
	});
	assert.doesNotThrow(() => recordControllerCheck(true));
	Object.defineProperty(globalThis, "localStorage", { configurable: true, value: orig });
});
