// Мост страница <-> service worker для перехвата Range (CONTRACTS.md/
// DESIGN.md, этап 53 И4, задачи 4.1/4.2). Модуль разделён на ДВЕ части
// намеренно: registerPlayerFile/unregisterPlayerFile/handleRangeRequest —
// чистая (в терминах отсутствия browser-only API) логика, юнит-тестируема
// в node --test; startPlayerBridge — тонкая обвязка над navigator.
// serviceWorker, DOM-зависима, проверяется только живьём (тот же принцип
// разделения, что во всём проекте — см. "Уроки" PLAN.md).
import { createPlayerSession } from "./player-session.js";
import { createChunkCache, budgetFor } from "./chunk-cache.js";

// Один кэш на ВСЕ одновременно открытые файлы страницы (не по одному на
// файл) — ключи кэша уже пространственно разделены manifest.blobSha256
// (player-session.js), общий бюджет просто означает, что холодные файлы
// вытесняются раньше при нехватке места, а не то, что они конфликтуют.
// MEDIA-PERF-TZ.md §5.2 — было: фиксированные 2.5 МиБ НА ВСЕ файлы разом
// (комментарий сам признавал, что исходная арифметика (k+3)·C была основана
// на неверном предположении о размере чанка — 512 КиБ вместо реальных
// 64 КиБ-4 МиБ из chunkSizeFor). Теперь бюджет растёт с числом РЕАЛЬНО
// открытых файлов (registry.size) — budgetFor()/setBudget() ниже, вызывается
// на каждый register/unregister.
const sharedCache = createChunkCache(budgetFor(0));

// FILES-FIX-SPEC.md §6.1 / TZ-FIX-FILES-MEDIA-STATIC.md решение №6 — открытый
// диапазон (браузер ещё не знает Accept-Ranges, либо явный "bytes=X-") НЕ
// разворачивается в весь файл: 15-секундный бюджет SW × один гигантский GET
// на файл в единицы-десятки МБ — и есть механизм S4/S5 ("потолок ~1.5 МБ",
// молчащее видео). HTTP разрешает 206 короче запрошенного — браузер поймёт
// по Content-Range, что получил часть, и запросит следующее окно сам.
//
// MEDIA-PERF-TZ.md §5.3 — с этапа "адаптивное окно" service-worker.js САМ
// решает конкретный end для открытого диапазона (растёт 512К->1М->2М->4М при
// последовательном чтении, sw-timeout.js::nextAdaptiveWindow) и всегда шлёт
// сюда УЖЕ КОНКРЕТНЫЙ end — в реальном трафике ветка end===null ниже больше
// не срабатывает. Она остаётся как фолбэк-константа для прямых вызовов в
// обход SW (тесты, handleRangeRequest вызванный напрямую) — держит старое
// поведение "не весь файл", если что-то когда-то позовёт эту функцию не
// через мост. Дублируется в service-worker.js/sw-timeout.js (тот файл не
// проходит сборку Vite, импорт невозможен) — править все три места разом.
export const PLAYER_FIRST_WINDOW_BYTES = 512 * 1024;

const registry = new Map(); // manifestDigest -> { manifest, session }

// Плеер (4.4) ОБЯЗАН вызвать это ДО того, как установит src у <video>/<audio> —
// иначе первый же запрос браузера придёт раньше регистрации (гонка закрыта
// порядком вызовов, не таймером — см. CONTRACTS.md/DESIGN.md).
export function registerPlayerFile(manifestDigest, { manifest, fileKey, serverUrl, fetchImpl }) {
	const session = createPlayerSession({ manifest, fileKey, serverUrl, cache: sharedCache, fetchImpl });
	registry.set(manifestDigest, { manifest, session });
	sharedCache.setBudget(budgetFor(registry.size));
}

export function unregisterPlayerFile(manifestDigest) {
	registry.delete(manifestDigest);
	sharedCache.setBudget(budgetFor(registry.size));
}

// start/end — ОБА включительно (HTTP Range семантика, протокол сообщений
// CONTRACTS.md), в отличие от player-session.readRange (end исключающий,
// тот же стиль, что content.js/manifest.js И2) — конвертация здесь, на
// границе протокола, чтобы внутренние модули оставались единообразны.
// end === null/undefined — открытый диапазон ("bytes=X-" без верхней
// границы, либо отсутствие Range вовсе — SW нормализует это в start=0)
// — разрешается в manifest.size-1 ЗДЕСЬ, где manifest уже есть; SW
// сам размер файла не знает до этого ответа.
//
// MEDIA-PERF-TZ-5.md §4 (найдено живой проверкой пользователя — видео
// переставало играть у конца файла) — end ВСЕГДА зажимается в manifest.size-1,
// даже когда пришёл уже конкретным числом. Раньше (решение №6
// TZ-FIX-FILES-MEDIA-STATIC.md) конкретный end уважался как есть без
// ограничения — рассуждение было про ЯВНО присланный браузером большой
// диапазон. На практике конкретный end сюда чаще всего приходит НЕ от
// браузера, а от service-worker.js::nextAdaptiveWindow — SW считает окно для
// ОТКРЫТОГО диапазона ("bytes=X-") вслепую (сам размер файла не знает),
// выросшее окно у ХВОСТА файла легко даёт start+windowBytes-1 ЗА пределами
// manifest.size. RFC 7233: конец диапазона за EOF — не ошибка, сервер должен
// отдать короче (тот же приём "206 короче запрошенного", что уже применяется
// для открытого диапазона несколькими строками выше) — ошибка ТОЛЬКО когда
// НАЧАЛО диапазона невалидно.
// onChunkArrived (MEDIA-PERF-TZ-4.md §5, необязательный) — прокинут насквозь
// в session.readRange; startPlayerBridge ниже использует его, чтобы слать SW
// промежуточный "range-progress" на каждый реально пришедший чанк — иначе SW
// видит только ОДИН финальный ответ на всё окно и не может сбрасывать
// застойный таймер раньше него.
export async function handleRangeRequest({ manifestDigest, start, end, onChunkArrived }) {
	const entry = registry.get(manifestDigest);
	if (!entry) return { ok: false, bytes: null, mime: null, size: null, error: "unknown-digest" };

	const { manifest, session } = entry;
	const resolvedEnd =
		end === null || end === undefined
			? Math.min(manifest.size - 1, start + PLAYER_FIRST_WINDOW_BYTES - 1)
			: Math.min(end, manifest.size - 1);
	if (start < 0 || start > resolvedEnd) {
		return { ok: false, bytes: null, mime: null, size: null, error: "range-out-of-bounds" };
	}

	try {
		const bytes = await session.readRange(start, resolvedEnd + 1, { onChunkArrived });
		return { ok: true, bytes, mime: manifest.mime, size: manifest.size, error: null };
	} catch (e) {
		return { ok: false, bytes: null, mime: null, size: null, error: "decrypt-failed" };
	}
}

// MEDIA-PERF-TZ-5.md §4 — потоковый путь: та же валидация digest/bounds, что
// handleRangeRequest выше (осознанно продублирована, не вынесена в общий
// helper — обе функции короткие, а разное поведение при отказе (return
// объекта vs sink.error()) делает общий helper менее читаемым, чем две явные
// версии), но байты уходят в sink ПО МЕРЕ готовности через
// session.streamRange, не одним финальным объектом.
//
// sink: { open({mime,size,totalBytes}), chunk(seq,bytes), end(), error(code) }.
// open() зовётся СРАЗУ после валидации, ДО первого байта — geometрия
// (mime/size/totalBytes) известна из манифеста уже сейчас, ждать реальных
// чанков незачем (SW должен открыть ReadableStream/206-заголовки как можно
// раньше). Отказ ПОСЛЕ open() (сбой расшифровки чанка) — НЕ смена кода
// ошибки, sink.error() вызывается с тем же "decrypt-failed", что и раньше;
// то, что HTTP-статус уже не откатить на 500 — забота SW-стороны (§4 "Цена,
// которую принимаем"), не этой функции.
export async function handleRangeStreamRequest({ manifestDigest, start, end }, sink) {
	const entry = registry.get(manifestDigest);
	if (!entry) {
		sink.error("unknown-digest");
		return;
	}

	const { manifest, session } = entry;
	// end зажимается в manifest.size-1 (см. развёрнутый комментарий у
	// handleRangeRequest выше — тот же случай, та же причина).
	const resolvedEnd =
		end === null || end === undefined
			? Math.min(manifest.size - 1, start + PLAYER_FIRST_WINDOW_BYTES - 1)
			: Math.min(end, manifest.size - 1);
	if (start < 0 || start > resolvedEnd) {
		sink.error("range-out-of-bounds");
		return;
	}

	sink.open({ mime: manifest.mime, size: manifest.size, totalBytes: resolvedEnd - start + 1 });
	await session.streamRange(start, resolvedEnd + 1, {
		chunk: (seq, bytes) => sink.chunk(seq, bytes),
		end: () => sink.end(),
		// streamRange сама не различает причины отказа (сеть/подмена digest/
		// расшифровка) — до потоковой версии (handleRangeRequest выше) это тоже
		// был единственный код на любую ошибку readRange, здесь то же самое.
		error: () => sink.error("decrypt-failed"),
	});
}

// Обвязка над navigator.serviceWorker — вызывается ОДИН раз (app.jsx's
// MainShell, по прецеденту ensureConnected/темы) после логина. SW шлёт
// запрос диапазона postMessage'ом (CONTRACTS.md) — страница отвечает
// РОВНО туда же (event.source), не broadcast (несколько вкладок с разными
// аккаунтами не должны получать чужие запросы, DESIGN.md "гонка 4").
//
// MEDIA-PERF-TZ-5.md §4 — потоковый протокол (range-open/range-chunk/
// range-end/range-error) заменяет старый единственный range-response;
// отдельный "range-progress"-пинг (MEDIA-PERF-TZ-4.md §5) больше не нужен —
// САМ факт получения range-chunk на стороне SW уже сбрасывает застойный
// таймер (service-worker.js), ждать отдельного сигнала незачем.
export function startPlayerBridge() {
	if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return () => {};

	async function onMessage(event) {
		const msg = event.data;
		if (!msg || msg.type !== "files-content:range-request") return;
		const requestId = msg.requestId;
		const post = (m, transfer) => event.source?.postMessage(m, transfer);
		await handleRangeStreamRequest(msg, {
			open: ({ mime, size, totalBytes }) => post({ type: "files-content:range-open", requestId, mime, size, totalBytes }),
			// bytes может быть subarray() ВНУТРИ большего ArrayBuffer'а
			// расшифрованного чанка, который лежит в chunk-cache.js (в т.ч.
			// закреплённый чанк 0) — переносить (transfer) МОЖНО только буфер,
			// которым страница больше не владеет. slice() — независимая копия
			// СВОЕГО буфера, перенос её не портит кэш (контракт §4).
			chunk: (seq, bytes) => {
				const copy = bytes.slice();
				post({ type: "files-content:range-chunk", requestId, seq, bytes: copy }, [copy.buffer]);
			},
			end: () => post({ type: "files-content:range-end", requestId }),
			error: (error) => post({ type: "files-content:range-error", requestId, error }),
		});
	}

	navigator.serviceWorker.addEventListener("message", onMessage);
	return () => navigator.serviceWorker.removeEventListener("message", onMessage);
}
