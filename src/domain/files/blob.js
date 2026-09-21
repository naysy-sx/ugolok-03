// Blossom-доступ для раздела «Файлы» — обёртка над уже существующим
// core/transport/blossom-client.js (CONTRACTS.md, этап 53, задача 2.2:
// "перенос... без изменения поведения" — put/get не переписаны заново,
// переиспользованы как есть) + НОВОЕ: Range-GET для чтения отдельного
// чанка (нужен content.getRange/плееру, П-4 подтвердил живым запросом,
// что Blossom-сервер проекта отвечает 206 на Range).
import {
	uploadBlob,
	downloadBlob as blossomDownloadBlob,
	deleteBlob,
	checkUploadRequirements,
	withRetry,
	combineSignals,
	isRetryableStatus,
	isNetworkError,
} from "../../core/transport/blossom-client.js";
import { blossomQueue, PRIORITY } from "../../core/transport/blossom-queue.js";

export { uploadBlob, deleteBlob, checkUploadRequirements, PRIORITY };

// MEDIA-PERF-TZ-5.md §5 — таймаут чтения. Числа — предложение ТЗ, не замер:
// пол 8 с (манифест/маленький чанк), потолок 60 с, скорость запаса 4 КиБ/с.
export const READ_TIMEOUT_FLOOR_MS = 8_000;
export const READ_TIMEOUT_CEIL_MS = 60_000;
export const READ_TIMEOUT_BYTES_PER_SEC = 4096;

export function resolveReadTimeoutMs(bytes) {
	const sized = Math.ceil(Math.max(0, bytes) / READ_TIMEOUT_BYTES_PER_SEC) * 1000;
	return Math.min(READ_TIMEOUT_CEIL_MS, Math.max(READ_TIMEOUT_FLOOR_MS, sized));
}

function readError(code, message, status) {
	const err = new Error(message);
	err.code = code;
	if (status != null) err.status = status;
	return err;
}

function isRetryableReadError(err) {
	if (err?.name === "AbortError") return false;
	return isNetworkError(err) || isRetryableStatus(err?.status);
}

function stripTrailingSlash(url) {
	return url.endsWith("/") ? url.slice(0, -1) : url;
}

// ТЗ-05 §5 — перебор адресов при чтении. serverUrl — строка ИЛИ упорядоченный список
// (readCandidates). Простой обход по порядку, без «здоровья серверов» и параллельных
// попыток. Успешный адрес запоминается на время сессии для этого хеша, чтобы остальные
// диапазонные запросы того же видео не начинали обход заново.
const rememberedServer = new Map();

export function resetRememberedServers() {
	rememberedServer.clear();
}

function candidateList(serverUrl, sha256Hex) {
	const list = (Array.isArray(serverUrl) ? serverUrl : [serverUrl]).filter((u) => typeof u === "string" && u);
	const remembered = rememberedServer.get(sha256Hex);
	if (remembered && list.includes(remembered)) return [remembered, ...list.filter((u) => u !== remembered)];
	return list;
}

// 404 — блоба здесь нет; 401/403 — нет доступа; сетевая ошибка/таймаут — сервер недоступен;
// 5xx (после повторов того же адреса) — сервер не справился. Всё это — «пробуем следующий».
function shouldTryNext(err) {
	if (err?.name === "AbortError") return false;
	if (isNetworkError(err) || err?.code === "network-failed") return true;
	const status = err?.status;
	return status === 404 || status === 401 || status === 403 || (typeof status === "number" && status >= 500);
}

async function firstWorking(serverUrl, sha256Hex, attempt) {
	const candidates = candidateList(serverUrl, sha256Hex);
	if (candidates.length === 0) throw readError("network-failed", "Адрес хранилища не задан");
	let lastError = null;
	let transientError = null;
	for (const url of candidates) {
		try {
			const result = await attempt(url);
			rememberedServer.set(sha256Hex, url);
			return result;
		} catch (err) {
			if (!shouldTryNext(err)) throw err;
			lastError = err;
			// Блоб мог быть на сервере, который временно не отвечает: такой отказ важнее
			// «404» с соседнего — иначе клиент решит, что файла нет вовсе.
			if (err?.status == null || err.status >= 500) transientError = err;
		}
	}
	throw transientError ?? lastError;
}

// MEDIA-PERF-TZ-5.md §2 — единственная точка внедрения общей очереди: обе
// функции ЧТЕНИЯ (эта и downloadBlob ниже) заворачиваются в
// blossomQueue.schedule; заливка/удаление (uploadBlob/deleteBlob) в очередь
// НЕ попадают — идут собственным темпом, смешивать не нужно. priority по
// умолчанию PRIORITY.PREVIEW — самый безопасный низший (превью/миниатюры не
// должны случайно перехватить приоритет у плеера просто потому, что кто-то
// забыл его передать).
//
// start/end — включительно, байтовые смещения В БЛОБЕ (шифротексте), как в
// HTTP Range (RFC 7233), не в исходном файле — пересчёт исходное->блоб
// делает content.js через manifest.js.
export async function downloadBlobRange(serverUrl, sha256Hex, start, end, options = {}) {
	const {
		priority = PRIORITY.PREVIEW,
		signal,
		fetchImpl = globalThis.fetch,
		retries = 2,
		backoffMs = 500,
		timeoutMs,
	} = options;
	const expectedBytes = Math.max(0, end - start + 1);
	const timeout = timeoutMs ?? resolveReadTimeoutMs(expectedBytes);
	return blossomQueue.schedule(
		priority,
		() =>
			firstWorking(serverUrl, sha256Hex, (baseUrl) =>
				withRetry(
					async () => {
						const url = `${stripTrailingSlash(baseUrl)}/${sha256Hex}`;
						const combined = combineSignals(signal, timeout);
						const response = await fetchImpl(url, { headers: { Range: `bytes=${start}-${end}` }, signal: combined });
						if (response.status === 206) {
							return new Uint8Array(await response.arrayBuffer());
						}
						// 4xx не повторяем (ТЗ §5). 502/503/504 — транзиентные, бросаем
						// с .status, withRetry подхватит. 200 вместо 206 — громкий отказ
						// (П-4 CONTRACTS.md), не «скачать всё».
						throw readError(
							"network-failed",
							`Blossom Range GET не поддержан (ожидался 206, получен ${response.status}) для ${sha256Hex}`,
							response.status,
						);
					},
					{ retries, backoffMs, isRetryable: isRetryableReadError },
				),
			),
		{ signal },
	);
}

// getManifest (маленький, но блокирует всё дальнейшее) — тот же принцип:
// обёртка над blossom-client.js::downloadBlob, priority по умолчанию PREVIEW.
export async function downloadBlob(serverUrl, sha256Hex, options = {}) {
	const { priority = PRIORITY.PREVIEW, signal, retries = 2, backoffMs = 500, timeoutMs, ...rest } = options;
	const timeout = timeoutMs ?? READ_TIMEOUT_FLOOR_MS;
	return blossomQueue.schedule(
		priority,
		() =>
			firstWorking(serverUrl, sha256Hex, (baseUrl) =>
				withRetry(
					async () => {
						try {
							return await blossomDownloadBlob(baseUrl, sha256Hex, {
								...rest,
								signal: combineSignals(signal, timeout),
							});
						} catch (err) {
							if (err?.status == null) {
								const m = /failed: (\d+)/.exec(err?.message);
								if (m) err.status = Number(m[1]);
							}
							if (isRetryableStatus(err?.status) || isNetworkError(err)) err.code = "network-failed";
							throw err;
						}
					},
					{ retries, backoffMs, isRetryable: isRetryableReadError },
				),
			),
		{ signal },
	);
}
