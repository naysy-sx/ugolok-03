// Чистая версия формулы таймаута + адаптивного окна из service-worker.js (тот
// файл не проходит сборку Vite — emitServiceWorker копирует текст как есть,
// импорт из src туда не резолвится, поэтому ОБА продублированы там вручную).
// Этот модуль существует, чтобы их можно было проверить node --test'ом
// (FILES-FIX-SPEC.md §10.1, TZ-FIX-FILES-MEDIA-STATIC.md §7.1, MEDIA-PERF-TZ.md
// §5.3) — при правке менять оба места разом (service-worker.js и этот файл).
export const PLAYER_FIRST_WINDOW_BYTES = 512 * 1024;
// MEDIA-PERF-TZ.md §5.3 — потолок адаптивного окна (растёт при последовательном
// чтении, сбрасывается при разрыве/перемотке). 512К -> 1М -> 2М -> 4М.
export const PLAYER_MAX_WINDOW_BYTES = 4 * 1024 * 1024;
export const FILES_CONTENT_TIMEOUT_FLOOR_MS = 15000;
// §5.3 — было 60000: достаточно для окна 512 КБ (формула ниже даёт ~31с), но
// СЛИШКОМ МАЛО для выросшего окна 4 МиБ (формула даёт ~143с) — фиксированный
// потолок при большом окне на медленной сети даёт ложный обрыв (504), именно
// то, чего этот проход должен избежать. 150000 покрывает 4 МиБ с запасом, для
// маленьких окон ничего не меняет (формула и так даёт значение много меньше
// и старого, и нового потолка).
export const FILES_CONTENT_TIMEOUT_CEIL_MS = 150000;

export function resolveFilesContentTimeoutMs(expectedBytes) {
	const ms = FILES_CONTENT_TIMEOUT_FLOOR_MS + (expectedBytes / 32768) * 1000;
	return Math.min(FILES_CONTENT_TIMEOUT_CEIL_MS, Math.max(FILES_CONTENT_TIMEOUT_FLOOR_MS, ms));
}

// MEDIA-PERF-TZ-4.md §6 — окно удваивалось при последовательном чтении
// НЕЗАВИСИМО от фактической скорости канала: на 200 КБ/с окно 4 МиБ — это
// ~20с ожидания ОДНОГО 206-ответа, всё это время браузеру нечего показывать.
// target — сколько байт канал должен успеть отдать за WINDOW_TARGET_SECONDS
// при НАБЛЮДАЕМОЙ скорости; удвоение остаётся верхней границей ОДНОГО шага
// (не растим больше чем вдвое за раз, даже на быстром канале).
// MEDIA-PERF-TZ-5.md §4 — вернули 3 (было временно 1 в задаче 1): ответ SW
// теперь потоковый (service-worker.js возвращает Response(ReadableStream)
// сразу на range-open, чанки уходят в controller.enqueue() по мере
// готовности) — окно снова задаёт РАЗМЕР БУФЕРА, не длину молчания. Большое
// окно больше не значит "<video> три секунды не получает ни байта" (это и
// было причиной цикла переоткрытия Range, §0 п.3 прошлого прохода) — оно
// значит "SW успевает прислать больше данных за то же число round-trip'ов".
export const WINDOW_TARGET_SECONDS = 3;
// Сглаживание наблюдаемой скорости (EMA) — один медленный чанк не должен
// обрушивать окно до следующего замера, один быстрый — не должен раздувать
// его мгновенно. 0.3 — компромисс из ТЗ, не замер.
export const SPEED_SMOOTHING_ALPHA = 0.3;

// state — { lastEnd, windowBytes, bytesPerSec } | undefined (первый запрос по
// этому digest в этой SW-сессии, либо state забыт после ошибки). start —
// начало ЗАПРОШЕННОГО диапазона (байт исходного файла, из Range-заголовка/
// нормализации SW).
//
// sequential — start ровно там, где закончился предыдущий ОТВЕТ (lastEnd+1):
// браузер продолжает буферизацию линейно вперёд. Иначе (первый запрос ИЛИ
// перемотка/разрыв) -> сброс в PLAYER_FIRST_WINDOW_BYTES — маленький диапазон
// должен падать быстро при сбое, не тащить за собой раздутый таймаут от
// предыдущей, не связанной последовательности. bytesPerSec (если уже
// измерена) — свойство КАНАЛА, не позиции чтения: вызывающая сторона обязана
// пронести её через перемотку в СЛЕДУЮЩИЙ state, эта функция сама её не трогает.
export function nextAdaptiveWindow(state, start) {
	const sequential = !!state && start === state.lastEnd + 1;
	if (!sequential) return { windowBytes: PLAYER_FIRST_WINDOW_BYTES, sequential: false };

	const doubled = Math.min(state.windowBytes * 2, PLAYER_MAX_WINDOW_BYTES);
	if (!state.bytesPerSec) return { windowBytes: doubled, sequential: true }; // скорость ещё не измерена — просто удвоение, как раньше

	const targetBytes = state.bytesPerSec * WINDOW_TARGET_SECONDS;
	const windowBytes = Math.min(Math.max(Math.min(targetBytes, doubled), PLAYER_FIRST_WINDOW_BYTES), PLAYER_MAX_WINDOW_BYTES);
	return { windowBytes, sequential: true };
}

// EMA скорости канала. prevBytesPerSec == null -> первый замер, без сглаживания
// (не с чем сглаживать). elapsedMs <= 0 -> вырожденный случай (мгновенный
// ответ, например из кэша) — возвращаем предыдущую оценку как есть, ноль/Infinity
// испортил бы будущие расчёты окна.
export function updateObservedSpeed(prevBytesPerSec, bytesTransferred, elapsedMs) {
	if (!(elapsedMs > 0)) return prevBytesPerSec ?? 0;
	const sample = (bytesTransferred / elapsedMs) * 1000;
	if (prevBytesPerSec == null) return sample;
	return SPEED_SMOOTHING_ALPHA * sample + (1 - SPEED_SMOOTHING_ALPHA) * prevBytesPerSec;
}

// MEDIA-PERF-TZ-4.md §5 — потолок таймаута моста подняли 60с->150с вслед за
// выросшим окном (§5.3 прошлого прохода), но побочный эффект: при мёртвом
// Blossom плеер "грузится" почти 2.5 минуты вместо одной — ровно то ощущение
// зависания, ради которого затевался весь третий проход. Второй, независимый
// таймер: сбрасывается на КАЖДЫЙ фактически пришедший чанк (progress()),
// стреляет через STALL_TIMEOUT_MS молчания. Общий потолок (ceilingMs) не
// сбрасывается вовсе — честная медленная, но ЖИВАЯ передача (чанки идут,
// просто редко) не должна упереться в застойный таймер, только в потолок.
//
// Использует ГЛОБАЛЬНЫЙ setTimeout/clearTimeout напрямую (не инъекция) —
// тесты этого модуля мокают их через node:test's t.mock.timers, тот же приём,
// что уже есть в tests/relay-auth.test.js и соседних.
export const STALL_TIMEOUT_MS = 12000;

export function createStallGuard({ ceilingMs, stallMs = STALL_TIMEOUT_MS }, onTimeout) {
	let settled = false;
	// Застойный таймер НЕ стартует до первого progress(): иначе getManifest +
	// TTFB первого чанка на мобильной сети регулярно > 12с, SW отдаёт 504, и
	// <video> так и не получает ни байта. «Вообще ничего не пришло» ловит
	// потолок (тот же бюджет, что был до детектора простоя). После первого
	// чанка молчание дольше stallMs — уже простой.
	let stallTimer = null;
	let ceilingTimer = setTimeout(() => fire("ceiling"), ceilingMs);

	function fire(reason) {
		if (settled) return;
		settled = true;
		clearTimeout(stallTimer);
		clearTimeout(ceilingTimer);
		onTimeout(reason);
	}

	return {
		// Чанк реально пришёл — застойный таймер начинается заново. Потолок НЕ трогаем.
		progress() {
			if (settled) return;
			clearTimeout(stallTimer);
			stallTimer = setTimeout(() => fire("stall"), stallMs);
		},
		// Запрос успешно завершился (или уже отклонён иначе) — оба таймера гасим,
		// дальнейшие progress()/повторные fire() — no-op.
		settle() {
			if (settled) return;
			settled = true;
			clearTimeout(stallTimer);
			clearTimeout(ceilingTimer);
		},
	};
}
