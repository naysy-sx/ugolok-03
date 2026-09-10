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
			withRetry(
				async () => {
					const url = `${stripTrailingSlash(serverUrl)}/${sha256Hex}`;
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
			withRetry(
				async () => {
					try {
						return await blossomDownloadBlob(serverUrl, sha256Hex, {
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
		{ signal },
	);
}
