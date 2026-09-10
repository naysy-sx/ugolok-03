// Blossom-доступ для раздела «Файлы» — обёртка над уже существующим
// core/transport/blossom-client.js (CONTRACTS.md, этап 53, задача 2.2:
// "перенос... без изменения поведения" — put/get не переписаны заново,
// переиспользованы как есть) + НОВОЕ: Range-GET для чтения отдельного
// чанка (нужен content.getRange/плееру, П-4 подтвердил живым запросом,
// что Blossom-сервер проекта отвечает 206 на Range).
import { uploadBlob, downloadBlob as blossomDownloadBlob, deleteBlob, checkUploadRequirements } from "../../core/transport/blossom-client.js";
import { blossomQueue, PRIORITY } from "../../core/transport/blossom-queue.js";

export { uploadBlob, deleteBlob, checkUploadRequirements, PRIORITY };

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
	const { priority = PRIORITY.PREVIEW, signal, fetchImpl = globalThis.fetch } = options;
	return blossomQueue.schedule(
		priority,
		async () => {
			const url = `${stripTrailingSlash(serverUrl)}/${sha256Hex}`;
			// signal — необязательный (FILES-FIX-SPEC.md §6.3: "зависший Range-GET
			// съедает весь бюджет SW молча") — проброс есть, реальный AbortController
			// на путь плеера подключается вызывающей стороной по мере необходимости,
			// не всеми путями сразу (картинки/getRange не отменяются никогда).
			const response = await fetchImpl(url, { headers: { Range: `bytes=${start}-${end}` }, signal });
			if (response.status !== 206) {
				// П-4 (CONTRACTS.md): сервер, вернувший 200 вместо 206, отдаёт ВЕСЬ блоб —
				// молча подставить его вместо запрошенного диапазона значило бы тихо
				// испортить расшифровку чанка (индекс/смещение разъедутся). Громкий отказ,
				// не тихий фолбэк на "скачать всё".
				throw new Error(`Blossom Range GET не поддержан (ожидался 206, получен ${response.status}) для ${sha256Hex}`);
			}
			return new Uint8Array(await response.arrayBuffer());
		},
		{ signal },
	);
}

// getManifest (маленький, но блокирует всё дальнейшее) — тот же принцип:
// обёртка над blossom-client.js::downloadBlob, priority по умолчанию PREVIEW.
export async function downloadBlob(serverUrl, sha256Hex, options = {}) {
	const { priority = PRIORITY.PREVIEW, signal, ...rest } = options;
	return blossomQueue.schedule(priority, () => blossomDownloadBlob(serverUrl, sha256Hex, { ...rest, signal }), { signal });
}
