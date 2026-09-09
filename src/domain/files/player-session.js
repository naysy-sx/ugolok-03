// Конвейер плеера: диапазон -> чанки -> кэш/расшифровка -> склейка, плюс
// упреждающая подкачка (CONTRACTS.md/DESIGN.md, этап 53 И4, задачи 4.2/4.3).
// Пространство имён кэша — manifest.blobSha256 (уникален на файл, уже есть
// в манифесте — не нужен отдельный manifestDigest-параметр).
import { concatBytes } from "@noble/hashes/utils.js";
import { getChunk, mapPool } from "./content.js";
import { rangeToChunks } from "./manifest.js";
import { startTrace } from "../media/perf-trace.js";

// MEDIA-PERF-TZ.md §8 п.4 — Blossom за Caddy без явного `tls alpn http/1.1`
// на blossom.<host> (в отличие от relay.<host>, где HTTP/1.1 форсирован из-за
// WS) — TLS-сайты Caddy по умолчанию отдают HTTP/2, лимит "6 соединений на
// origin" из HTTP/1.1 не действует. Та же константа, что content.js::getRange
// (GET_RANGE_CONCURRENCY) — держим оба места в одном числе намеренно, не
// экспортируем оттуда, чтобы не тянуть модуль ради одной константы.
const WINDOW_CONCURRENCY = 6;

// MEDIA-PERF-TZ.md §5.1 — было: for+await, чанки ОДНОГО Range-окна SW грузились
// строго последовательно (в отличие от content.js::getRange, который уже
// параллелит через mapPool). Для типичного chunkSizeFor() 64-256 КБ и окна
// 512 КБ это давало 2-8 последовательных HTTP round-trip'ов на КАЖДЫЙ запрос
// браузера к <video>/<audio>. Теперь — тот же mapPool, что content.js.
export function createPlayerSession({ manifest, fileKey, serverUrl, cache, fetchImpl }) {
	const namespace = manifest.blobSha256;
	const count = manifest.chunks.length;
	const lastChunkSize = manifest.size - (count - 1) * manifest.chunkSize;

	async function loadChunk(index, trace) {
		const key = `${namespace}:${index}`;
		const cached = cache.get(key);
		if (cached) return cached;
		const bytes = await getChunk(manifest, fileKey, index, { serverUrl, fetchImpl, trace });
		// Этап F, F3 (DESIGN.md) — чанк 0 закреплён: любое повторное открытие
		// файла (переоткрытие, переход к началу) попадает в кэш за Θ(1),
		// независимо от того, сколько чанков было загружено после.
		cache.put(key, bytes, { pin: index === 0 });
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

	// MEDIA-PERF-TZ.md §3.2 — trace создаётся ЗДЕСЬ, на каждый вызов readRange
	// (= каждый Range-запрос браузера к <video>/<audio> через SW-мост), не
	// снаружи: у "открытия видео" нет одной чёткой границы начала/конца с
	// точки зрения потребителя (браузер сам решает, когда слать следующий
	// Range) — но у КАЖДОГО такого запроса есть, и именно это троит §5.1/§5.3.
	// onChunkArrived — MEDIA-PERF-TZ-4.md §5 (детектор простоя в SW-мосте):
	// вызывается на КАЖДЫЙ чанк, реально разрешившийся внутри mapPool (кэш-
	// попадание или сеть — оба "чанк в руках", застойный таймер моста должен
	// сброситься на любой прогресс). player-bridge.js пробрасывает это в
	// postMessage к SW (files-content:range-progress); сама функция про SW
	// ничего не знает — чистый хук.
	async function readRange(start, end, { onChunkArrived } = {}) {
		const { firstIdx, lastIdx, skipHead, skipTail } = rangeToChunks(start, end - start, {
			chunkSize: manifest.chunkSize,
			count,
			lastChunkSize,
		});

		const indices = [];
		for (let i = firstIdx; i <= lastIdx; i++) indices.push(i);

		const trace = startTrace("player-window", namespace, end - start);
		trace.count("chunksInWindow", indices.length);
		let inFlight = 0;
		let maxInFlight = 0;
		const parts = await mapPool(indices, WINDOW_CONCURRENCY, async (i) => {
			inFlight++;
			maxInFlight = Math.max(maxInFlight, inFlight);
			try {
				const bytes = await loadChunk(i, trace);
				onChunkArrived?.();
				return bytes;
			} finally {
				inFlight--;
			}
		});
		trace.end({ maxInFlight });

		const joined = concatBytes(...parts);
		const tailCut = skipTail > 0 ? joined.length - skipTail : joined.length;
		const result = joined.subarray(skipHead, tailCut);

		prefetch(lastIdx + 1);
		return result;
	}

	return { readRange };
}
