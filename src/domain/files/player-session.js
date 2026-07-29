// Конвейер плеера: диапазон -> чанки -> кэш/расшифровка -> склейка, плюс
// упреждающая подкачка (CONTRACTS.md/DESIGN.md, этап 53 И4, задачи 4.2/4.3).
// Пространство имён кэша — manifest.blobSha256 (уникален на файл, уже есть
// в манифесте — не нужен отдельный manifestDigest-параметр).
import { concatBytes } from "@noble/hashes/utils.js";
import { getChunk } from "./content.js";
import { rangeToChunks } from "./manifest.js";

export function createPlayerSession({ manifest, fileKey, serverUrl, cache, fetchImpl }) {
	const namespace = manifest.blobSha256;
	const count = manifest.chunks.length;
	const lastChunkSize = manifest.size - (count - 1) * manifest.chunkSize;

	async function loadChunk(index) {
		const key = `${namespace}:${index}`;
		const cached = cache.get(key);
		if (cached) return cached;
		const bytes = await getChunk(manifest, fileKey, index, { serverUrl, fetchImpl });
		cache.put(key, bytes);
		return bytes;
	}

	// Fire-and-forget: один чанк вперёд (DESIGN.md §3 — последовательное
	// воспроизведение монотонно возрастает, одного шага достаточно, чтобы
	// спрятать задержку следующего запроса без риска впустую качать данные
	// при перемотке). Ошибка — не часть контракта readRange, следующий
	// реальный запрос просто загрузит чанк синхронно, как без prefetch.
	function prefetch(index) {
		if (index >= count) return;
		loadChunk(index).catch(() => {});
	}

	async function readRange(start, end) {
		const { firstIdx, lastIdx, skipHead, skipTail } = rangeToChunks(start, end - start, {
			chunkSize: manifest.chunkSize,
			count,
			lastChunkSize,
		});

		const parts = [];
		for (let i = firstIdx; i <= lastIdx; i++) {
			parts.push(await loadChunk(i));
		}
		const joined = concatBytes(...parts);
		const tailCut = skipTail > 0 ? joined.length - skipTail : joined.length;
		const result = joined.subarray(skipHead, tailCut);

		prefetch(lastIdx + 1);
		return result;
	}

	return { readRange };
}
