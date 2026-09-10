import { test } from "node:test";
import assert from "node:assert/strict";
import {
	resolveFilesContentTimeoutMs,
	nextAdaptiveWindow,
	updateObservedSpeed,
	createStallGuard,
	FILES_CONTENT_TIMEOUT_FLOOR_MS,
	FILES_CONTENT_TIMEOUT_CEIL_MS,
	PLAYER_FIRST_WINDOW_BYTES,
	PLAYER_MAX_WINDOW_BYTES,
	WINDOW_TARGET_SECONDS,
	STALL_TIMEOUT_MS,
} from "../src/domain/files/sw-timeout.js";

test("resolveFilesContentTimeoutMs: нулевой ожидаемый объём -> ровно пол (15с)", () => {
	assert.equal(resolveFilesContentTimeoutMs(0), FILES_CONTENT_TIMEOUT_FLOOR_MS);
});

test("resolveFilesContentTimeoutMs: растёт с объёмом", () => {
	const small = resolveFilesContentTimeoutMs(32768);
	const big = resolveFilesContentTimeoutMs(32768 * 10);
	assert.ok(big > small, "больший ожидаемый объём -> больший бюджет");
});

test("resolveFilesContentTimeoutMs: потолок не превышается даже на огромном объёме", () => {
	assert.equal(resolveFilesContentTimeoutMs(100 * 1024 * 1024), FILES_CONTENT_TIMEOUT_CEIL_MS);
});

// MEDIA-PERF-TZ.md §5.3/§5.4 — было: фиксированные 512 КБ на КАЖДЫЙ открытый
// диапазон, даже когда браузер уже давно буферизует линейно вперёд. Таймаут
// прежнего потолка (60с) был откалиброван под это окно — растущее окно 4 МиБ
// на медленной сети (эта аудитория) не укладывалось бы в 60с и рвалось 504.
test("resolveFilesContentTimeoutMs: таймаут окна 4 МиБ БОЛЬШЕ, чем таймаут окна 512 КБ", () => {
	const smallWindow = resolveFilesContentTimeoutMs(PLAYER_FIRST_WINDOW_BYTES);
	const bigWindow = resolveFilesContentTimeoutMs(PLAYER_MAX_WINDOW_BYTES);
	assert.ok(bigWindow > smallWindow, `таймаут 4 МиБ (${bigWindow}) должен быть больше таймаута 512 КБ (${smallWindow})`);
	assert.ok(bigWindow < FILES_CONTENT_TIMEOUT_CEIL_MS, "4 МиБ не должно упираться в сам потолок — иначе потолок недостаточен");
});

// nextAdaptiveWindow — §5.3.
test("nextAdaptiveWindow: первый запрос по digest (state=undefined) -> базовое окно 512 КБ", () => {
	const { windowBytes, sequential } = nextAdaptiveWindow(undefined, 0);
	assert.equal(windowBytes, PLAYER_FIRST_WINDOW_BYTES);
	assert.equal(sequential, false);
});

test("nextAdaptiveWindow: последовательное продолжение (start = lastEnd+1) -> окно УДВАИВАЕТСЯ", () => {
	const state = { lastEnd: PLAYER_FIRST_WINDOW_BYTES - 1, windowBytes: PLAYER_FIRST_WINDOW_BYTES };
	const { windowBytes, sequential } = nextAdaptiveWindow(state, PLAYER_FIRST_WINDOW_BYTES);
	assert.equal(sequential, true);
	assert.equal(windowBytes, PLAYER_FIRST_WINDOW_BYTES * 2);
});

test("nextAdaptiveWindow: рост доходит до потолка 4 МиБ и дальше не растёт", () => {
	let state = undefined;
	let start = 0;
	let windowBytes;
	for (let i = 0; i < 10; i++) {
		({ windowBytes } = nextAdaptiveWindow(state, start));
		state = { lastEnd: start + windowBytes - 1, windowBytes };
		start = state.lastEnd + 1;
	}
	assert.equal(windowBytes, PLAYER_MAX_WINDOW_BYTES);
});

test("nextAdaptiveWindow: разрыв (перемотка) -> сброс в базовое окно, не продолжение роста", () => {
	const state = { lastEnd: 10_000_000, windowBytes: PLAYER_MAX_WINDOW_BYTES }; // окно уже разрослось
	const { windowBytes, sequential } = nextAdaptiveWindow(state, 500); // перемотка в начало
	assert.equal(sequential, false);
	assert.equal(windowBytes, PLAYER_FIRST_WINDOW_BYTES, "перемотка не наследует раздувшееся окно предыдущей последовательности");
});

test("nextAdaptiveWindow: start НЕ ровно lastEnd+1 (даже на 1 байт иначе) -> НЕ считается последовательным", () => {
	const state = { lastEnd: 99, windowBytes: PLAYER_FIRST_WINDOW_BYTES };
	assert.equal(nextAdaptiveWindow(state, 101).sequential, false, "пропуск байта — тоже разрыв, не только перемотка назад");
	assert.equal(nextAdaptiveWindow(state, 100).sequential, true, "ровно lastEnd+1 — последовательно");
});

// MEDIA-PERF-TZ-4.md §6 — рост окна по фактической скорости.

test("updateObservedSpeed: первый замер — без сглаживания (не с чем сглаживать)", () => {
	assert.equal(updateObservedSpeed(null, 500_000, 1000), 500_000);
});

test("updateObservedSpeed: EMA коэффициент 0.3 — новый замер тянет к себе, но не заменяет целиком", () => {
	// prev=100 КБ/с, новый замер даёт 300 КБ/с за 1с -> 0.3*300000 + 0.7*100000 = 160000
	const next = updateObservedSpeed(100_000, 300_000, 1000);
	assert.equal(next, 0.3 * 300_000 + 0.7 * 100_000);
});

test("updateObservedSpeed: elapsedMs<=0 (мгновенный ответ, например из кэша) -> предыдущая оценка без изменений, не Infinity/NaN", () => {
	assert.equal(updateObservedSpeed(200_000, 500_000, 0), 200_000);
	assert.equal(updateObservedSpeed(undefined, 500_000, 0), 0);
});

test("nextAdaptiveWindow: медленный канал -> окно НЕ растёт до потолка, целится в WINDOW_TARGET_SECONDS передачи", () => {
	// Разгон: несколько шагов с обновлением bytesPerSec после каждого, как это
	// будет делать service-worker.js (нет доступа к нему напрямую — воспроизводим
	// его цикл здесь тем же кодом, что sw-timeout.js экспортирует).
	//
	// bytesPerSec подобран ОТНОСИТЕЛЬНО WINDOW_TARGET_SECONDS (не жёстко "200
	// КБ/с"), чтобы targetBytes = bytesPerSec * WINDOW_TARGET_SECONDS оставался
	// заметно ВЫШЕ пола PLAYER_FIRST_WINDOW_BYTES независимо от текущего
	// значения константы (MEDIA-PERF-TZ-5.md §2 — временно 1, до задачи 3
	// вернётся к 3). При маленьком WINDOW_TARGET_SECONDS фиксированная скорость
	// "200 КБ/с" давала бы targetBytes НИЖЕ пола — формула тогда всегда упирается
	// в пол, и тест перестаёт проверять целевую логику EMA, а не поведение
	// сломано.
	const bytesPerSec = Math.ceil((PLAYER_FIRST_WINDOW_BYTES * 2) / WINDOW_TARGET_SECONDS);
	let state = undefined;
	let start = 0;
	let windowBytes;
	for (let i = 0; i < 6; i++) {
		({ windowBytes } = nextAdaptiveWindow(state, start));
		state = { lastEnd: start + windowBytes - 1, windowBytes, bytesPerSec };
		start = state.lastEnd + 1;
	}
	const targetBytes = bytesPerSec * WINDOW_TARGET_SECONDS; // ~2×PLAYER_FIRST_WINDOW_BYTES, см. комментарий выше
	assert.ok(windowBytes <= targetBytes * 1.05, `окно (${windowBytes}) не должно заметно превышать целевые ${targetBytes} байт на ${WINDOW_TARGET_SECONDS}с передачи`);
	assert.ok(windowBytes < PLAYER_MAX_WINDOW_BYTES, "на медленном канале окно НЕ должно доходить до потолка 4 МиБ");
});

test("nextAdaptiveWindow: скорость 5 МБ/с (быстро) -> доходит до потолка 4 МиБ за несколько шагов", () => {
	const bytesPerSec = 5 * 1024 * 1024;
	let state = undefined;
	let start = 0;
	let windowBytes;
	for (let i = 0; i < 6; i++) {
		({ windowBytes } = nextAdaptiveWindow(state, start));
		state = { lastEnd: start + windowBytes - 1, windowBytes, bytesPerSec };
		start = state.lastEnd + 1;
	}
	assert.equal(windowBytes, PLAYER_MAX_WINDOW_BYTES);
});

test("nextAdaptiveWindow: удвоение остаётся потолком ОДНОГО шага, даже если целевой объём по скорости больше", () => {
	// bytesPerSec огромный (target >> prevWindow*2) — шаг всё равно не больше 2×.
	const state = { lastEnd: PLAYER_FIRST_WINDOW_BYTES - 1, windowBytes: PLAYER_FIRST_WINDOW_BYTES, bytesPerSec: 50 * 1024 * 1024 };
	const { windowBytes } = nextAdaptiveWindow(state, PLAYER_FIRST_WINDOW_BYTES);
	assert.equal(windowBytes, PLAYER_FIRST_WINDOW_BYTES * 2, "даже на очень быстром канале один шаг растёт не больше чем вдвое");
});

test("nextAdaptiveWindow: перемотка сбрасывает окно в 512 КБ независимо от скорости (сама функция скорость не трогает — забота вызывающей стороны её пронести)", () => {
	const state = { lastEnd: 10_000_000, windowBytes: PLAYER_MAX_WINDOW_BYTES, bytesPerSec: 5 * 1024 * 1024 };
	const { windowBytes, sequential } = nextAdaptiveWindow(state, 500);
	assert.equal(sequential, false);
	assert.equal(windowBytes, PLAYER_FIRST_WINDOW_BYTES);
});

// MEDIA-PERF-TZ-4.md §5 — детектор простоя.

test("createStallGuard: тишина до первого progress -> потолок, не stall (мобильный TTFB > 12с не должен 504)", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	let firedReason = null;
	createStallGuard({ ceilingMs: 30_000, stallMs: 12_000 }, (reason) => {
		firedReason = reason;
	});
	t.mock.timers.tick(12_000);
	assert.equal(firedReason, null, "до первого чанка застойный таймер ещё не запущен");
	t.mock.timers.tick(18_000);
	assert.equal(firedReason, "ceiling");
	t.mock.timers.reset();
});

test("createStallGuard: после первого progress тишина дольше stallMs -> onTimeout('stall')", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	let firedReason = null;
	const guard = createStallGuard({ ceilingMs: 150_000, stallMs: 12_000 }, (reason) => {
		firedReason = reason;
	});
	guard.progress();
	t.mock.timers.tick(12_000);
	assert.equal(firedReason, "stall");
	t.mock.timers.reset();
});

// TZ-4 §5, тест 1: "три чанка из восьми, дальше тишина 13 с -> отказ".
test("createStallGuard: три progress() внутри окна тишины, потом 13с молчания -> stall", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	let firedReason = null;
	const guard = createStallGuard({ ceilingMs: 150_000, stallMs: 12_000 }, (reason) => {
		firedReason = reason;
	});
	t.mock.timers.tick(3_000);
	guard.progress(); // чанк 1
	t.mock.timers.tick(3_000);
	guard.progress(); // чанк 2
	t.mock.timers.tick(3_000);
	guard.progress(); // чанк 3
	assert.equal(firedReason, null, "пока чанки идут регулярнее stallMs — тишина не засчитывается");
	t.mock.timers.tick(13_000); // дальше 13с тишины — дольше stallMs=12000
	assert.equal(firedReason, "stall");
	t.mock.timers.reset();
});

// TZ-4 §5, тест 2: "восемь чанков с паузами по 10 с (суммарно 80 с) -> успех, общий потолок не сработал".
test("createStallGuard: восемь progress() с паузами по 10с (суммарно 80с, < 12с между каждой) -> НЕ срабатывает ни stall, ни потолок", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	let fired = false;
	const guard = createStallGuard({ ceilingMs: 150_000, stallMs: 12_000 }, () => {
		fired = true;
	});
	for (let i = 0; i < 8; i++) {
		t.mock.timers.tick(10_000); // < stallMs (12с) каждый раз
		guard.progress();
	}
	assert.equal(fired, false, "паузы по 10с короче stallMs=12с — простой таймер не должен сработать");
	guard.settle();
	t.mock.timers.tick(150_000); // после settle() дальнейшее время не должно ничего вызывать
	assert.equal(fired, false);
	t.mock.timers.reset();
});

test("createStallGuard: общий потолок срабатывает, даже если progress() продолжает приходить (застойный таймер не маскирует бесконечно медленную передачу)", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	let firedReason = null;
	const guard = createStallGuard({ ceilingMs: 30_000, stallMs: 12_000 }, (reason) => {
		firedReason = reason;
	});
	for (let i = 0; i < 4; i++) {
		t.mock.timers.tick(10_000); // каждый раз < stallMs, суммарно 40с > ceilingMs=30с
		guard.progress();
	}
	assert.equal(firedReason, "ceiling", "потолок должен сработать, даже если чанки продолжают идти реже него, но чаще stallMs");
	t.mock.timers.reset();
});

test("createStallGuard: settle() гасит оба таймера, дальнейшие progress()/тики — no-op", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	let fired = false;
	const guard = createStallGuard({ ceilingMs: 150_000, stallMs: 12_000 }, () => {
		fired = true;
	});
	guard.settle();
	assert.doesNotThrow(() => guard.progress());
	t.mock.timers.tick(150_000);
	assert.equal(fired, false);
	t.mock.timers.reset();
});

test("STALL_TIMEOUT_MS: значение по умолчанию — 12000 (§5)", () => {
	assert.equal(STALL_TIMEOUT_MS, 12_000);
});

test("resolveFilesContentTimeoutMs: 160 последовательных чанков по 64КиБ при TTFB 100мс укладывается в бюджет окна первого запроса (регрессия S5)", () => {
	// FILES-FIX-SPEC.md §1: 10 МБ файл, 64 КиБ чанк, TTFB 1.1-1.6с живьём давал
	// ~160 последовательных Range-GET и таймаут 15с фиксированный. После §6.1
	// окно первого запроса ограничено PLAYER_FIRST_WINDOW_BYTES (512 КиБ) —
	// бюджет считается от НЕГО, не от всего файла.
	const PLAYER_FIRST_WINDOW_BYTES = 512 * 1024;
	const ttfbMs = 100;
	const chunksInWindow = Math.ceil(PLAYER_FIRST_WINDOW_BYTES / 65536);
	const worstCaseMs = chunksInWindow * ttfbMs;
	assert.ok(worstCaseMs <= resolveFilesContentTimeoutMs(PLAYER_FIRST_WINDOW_BYTES), `${worstCaseMs}мс должно укладываться в бюджет окна`);
});
