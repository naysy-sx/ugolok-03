// Blossom-доступ для раздела «Файлы» — обёртка над уже существующим
// core/transport/blossom-client.js (CONTRACTS.md, этап 53, задача 2.2:
// "перенос... без изменения поведения" — put/get не переписаны заново,
// переиспользованы как есть) + НОВОЕ: Range-GET для чтения отдельного
// чанка (нужен content.getRange/плееру, П-4 подтвердил живым запросом,
// что Blossom-сервер проекта отвечает 206 на Range).
import { uploadBlob, downloadBlob, deleteBlob, checkUploadRequirements } from "../../core/transport/blossom-client.js";

export { uploadBlob, downloadBlob, deleteBlob, checkUploadRequirements };

function stripTrailingSlash(url) {
	return url.endsWith("/") ? url.slice(0, -1) : url;
}

// start/end — включительно, байтовые смещения В БЛОБЕ (шифротексте), как в
// HTTP Range (RFC 7233), не в исходном файле — пересчёт исходное->блоб
// делает content.js через manifest.js.
export async function downloadBlobRange(serverUrl, sha256Hex, start, end, options = {}) {
	const fetchImpl = options.fetchImpl ?? globalThis.fetch;
	const url = `${stripTrailingSlash(serverUrl)}/${sha256Hex}`;
	const response = await fetchImpl(url, { headers: { Range: `bytes=${start}-${end}` } });
	if (response.status !== 206) {
		// П-4 (CONTRACTS.md): сервер, вернувший 200 вместо 206, отдаёт ВЕСЬ блоб —
		// молча подставить его вместо запрошенного диапазона значило бы тихо
		// испортить расшифровку чанка (индекс/смещение разъедутся). Громкий отказ,
		// не тихий фолбэк на "скачать всё".
		throw new Error(`Blossom Range GET не поддержан (ожидался 206, получен ${response.status}) для ${sha256Hex}`);
	}
	return new Uint8Array(await response.arrayBuffer());
}
