// Мост страница <-> service worker для перехвата Range (CONTRACTS.md/
// DESIGN.md, этап 53 И4, задачи 4.1/4.2). Модуль разделён на ДВЕ части
// намеренно: registerPlayerFile/unregisterPlayerFile/handleRangeRequest —
// чистая (в терминах отсутствия browser-only API) логика, юнит-тестируема
// в node --test; startPlayerBridge — тонкая обвязка над navigator.
// serviceWorker, DOM-зависима, проверяется только живьём (тот же принцип
// разделения, что во всём проекте — см. "Уроки" PLAN.md).
import { createPlayerSession } from "./player-session.js";
import { createChunkCache } from "./chunk-cache.js";

// Один кэш на ВСЕ одновременно открытые файлы страницы (не по одному на
// файл) — ключи кэша уже пространственно разделены manifest.blobSha256
// (player-session.js), общий бюджет просто означает, что холодные файлы
// вытесняются раньше при нехватке места, а не то, что они конфликтуют.
// Этап F, F3 (DESIGN.md/CONTRACTS.md "Этап F, F3", ALGO.md §3.4) — было 32 МБ
// (LRU без понятия "окно"). Число 2 621 440 (=2.5 МиБ) исторически считалось
// как (k+3)·C при C=512КиБ, k=2 — НО реальный размер чанка манифеста (Files UI)
// — результат chunkSizeFor (upload-plan.js), обычно 64 КиБ, не 512 КиБ.
// Итог: бюджет вмещает не 5 чанков, как задумывалось, а ~40 при C=64КиБ —
// не баг (освобождение памяти на телефоне всё ещё работает), но комментарий
// врал про арифметику. Оставляем абсолютный байтовый бюджет как есть
// (FILES-FIX-SPEC.md §2, §6.2.5) — переход на formulу от РЕАЛЬНОГО chunkSize
// потребовал бы читать manifest здесь, а кэш общий на все файлы разом.
const DEFAULT_CACHE_BUDGET_BYTES = 2_621_440; // 2.5 МиБ, абсолютный потолок (не (k+3)·C)
const sharedCache = createChunkCache(DEFAULT_CACHE_BUDGET_BYTES);

// FILES-FIX-SPEC.md §6.1 / TZ-FIX-FILES-MEDIA-STATIC.md решение №6 — открытый
// диапазон (браузер ещё не знает Accept-Ranges, либо явный "bytes=X-") НЕ
// разворачивается в весь файл: 15-секундный бюджет SW × один гигантский GET
// на файл в единицы-десятки МБ — и есть механизм S4/S5 ("потолок ~1.5 МБ",
// молчащее видео). HTTP разрешает 206 короче запрошенного — браузер поймёт
// по Content-Range, что получил часть, и запросит следующее окно сам.
// Дублируется в service-worker.js (тот файл не проходит сборку Vite, импорт
// невозможен) — править оба места разом, см. комментарий там.
export const PLAYER_FIRST_WINDOW_BYTES = 512 * 1024;

const registry = new Map(); // manifestDigest -> { manifest, session }

// Плеер (4.4) ОБЯЗАН вызвать это ДО того, как установит src у <video>/<audio> —
// иначе первый же запрос браузера придёт раньше регистрации (гонка закрыта
// порядком вызовов, не таймером — см. CONTRACTS.md/DESIGN.md).
export function registerPlayerFile(manifestDigest, { manifest, fileKey, serverUrl, fetchImpl }) {
	const session = createPlayerSession({ manifest, fileKey, serverUrl, cache: sharedCache, fetchImpl });
	registry.set(manifestDigest, { manifest, session });
}

export function unregisterPlayerFile(manifestDigest) {
	registry.delete(manifestDigest);
}

// start/end — ОБА включительно (HTTP Range семантика, протокол сообщений
// CONTRACTS.md), в отличие от player-session.readRange (end исключающий,
// тот же стиль, что content.js/manifest.js И2) — конвертация здесь, на
// границе протокола, чтобы внутренние модули оставались единообразны.
// end === null/undefined — открытый диапазон ("bytes=X-" без верхней
// границы, либо отсутствие Range вовсе — SW нормализует это в start=0)
// — разрешается в manifest.size-1 ЗДЕСЬ, где manifest уже есть; SW
// сам размер файла не знает до этого ответа.
export async function handleRangeRequest({ manifestDigest, start, end }) {
	const entry = registry.get(manifestDigest);
	if (!entry) return { ok: false, bytes: null, mime: null, size: null, error: "unknown-digest" };

	const { manifest, session } = entry;
	// Явные диапазоны с большим end НЕ ограничиваются здесь (решение №6
	// TZ-FIX-FILES-MEDIA-STATIC.md — "если запрошенный диапазон валиден, как
	// сейчас") — на практике браузер запрашивает их редко, открытый диапазон
	// (или отсутствие Range, нормализованное в service-worker.js) — основной
	// путь S4/S5.
	const resolvedEnd =
		end === null || end === undefined ? Math.min(manifest.size - 1, start + PLAYER_FIRST_WINDOW_BYTES - 1) : end;
	if (start < 0 || resolvedEnd >= manifest.size || start > resolvedEnd) {
		return { ok: false, bytes: null, mime: null, size: null, error: "range-out-of-bounds" };
	}

	try {
		const bytes = await session.readRange(start, resolvedEnd + 1);
		return { ok: true, bytes, mime: manifest.mime, size: manifest.size, error: null };
	} catch (e) {
		return { ok: false, bytes: null, mime: null, size: null, error: "decrypt-failed" };
	}
}

// Обвязка над navigator.serviceWorker — вызывается ОДИН раз (app.jsx's
// MainShell, по прецеденту ensureConnected/темы) после логина. SW шлёт
// запрос диапазона postMessage'ом (CONTRACTS.md) — страница отвечает
// РОВНО туда же (event.source), не broadcast (несколько вкладок с разными
// аккаунтами не должны получать чужие запросы, DESIGN.md "гонка 4").
export function startPlayerBridge() {
	if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return () => {};

	async function onMessage(event) {
		const msg = event.data;
		if (!msg || msg.type !== "files-content:range-request") return;
		const res = await handleRangeRequest(msg);
		event.source?.postMessage({
			type: "files-content:range-response",
			requestId: msg.requestId,
			...res,
		});
	}

	navigator.serviceWorker.addEventListener("message", onMessage);
	return () => navigator.serviceWorker.removeEventListener("message", onMessage);
}
