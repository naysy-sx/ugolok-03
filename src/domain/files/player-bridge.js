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
// (LRU без понятия "окно"). При C=512КиБ, k=2: (k+3)·C = 2 621 440 байт
// (=2.5 МиБ) — не оптимизация скорости, освобождение памяти на телефоне;
// чанк 0 закреплён отдельно (player-session.js's loadChunk), переживает
// вытеснение независимо от бюджета.
const DEFAULT_CACHE_BUDGET_BYTES = 2_621_440; // 2.5 МиБ = (k+3)·C, C=512КиБ, k=2
const sharedCache = createChunkCache(DEFAULT_CACHE_BUDGET_BYTES);

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
	const resolvedEnd = end === null || end === undefined ? manifest.size - 1 : end;
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
