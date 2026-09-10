// MEDIA-PERF-TZ-5.md §2 — ОДИН экземпляр очереди на всё приложение,
// разделяемый всеми чтениями с Blossom. Единственная точка внедрения —
// src/domain/files/blob.js (downloadBlobRange/downloadBlob), ни один
// вызывающий очередь сам не создаёт.
//
// Числа — ПРЕДЛОЖЕНИЕ, не замер (обоснование в MEDIA-PERF-TZ-5.md §2:
// замер дал 2.8-3.8с на чанк при ~60 одновременных потоках; при 8 деление
// полосы примерно семикратно мягче). localStorage-оверрайд — чтобы
// подбирать точные значения вживую (§11 контрольный прогон) без
// пересборки.
import { createRequestQueue, PRIORITY } from "./request-queue.js";

export { PRIORITY };

export const QUEUE_LIMIT = 8; // всего одновременных запросов к origin
export const QUEUE_PLAYER_MAX = 6; // не больше стольких занято PLAYER
export const QUEUE_OTHER_MAX = 6; // не больше стольких занято OVERLAY+PREVIEW

function readOverride(key, fallback) {
	try {
		if (typeof localStorage === "undefined") return fallback;
		const raw = localStorage.getItem(key);
		if (raw == null) return fallback;
		const n = Number(raw);
		return Number.isFinite(n) && n > 0 ? n : fallback;
	} catch {
		return fallback; // приватные вкладки/квота — тихо остаёмся на значении по умолчанию
	}
}

export const blossomQueue = createRequestQueue({
	limit: readOverride("ugolok:queue-limit", QUEUE_LIMIT),
	playerMax: readOverride("ugolok:queue-player-max", QUEUE_PLAYER_MAX),
	otherMax: readOverride("ugolok:queue-other-max", QUEUE_OTHER_MAX),
});
