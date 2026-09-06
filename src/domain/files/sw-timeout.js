// Чистая версия формулы таймаута из service-worker.js (тот файл не проходит
// сборку Vite — emitServiceWorker копирует текст как есть, импорт из src
// туда не резолвится, поэтому формула ПРОДУБЛИРОВАНА там вручную). Этот
// модуль существует, чтобы формулу можно было проверить node --test'ом
// (FILES-FIX-SPEC.md §10.1, TZ-FIX-FILES-MEDIA-STATIC.md §7.1) — при правке
// менять оба места разом.
export const PLAYER_FIRST_WINDOW_BYTES = 512 * 1024;
export const FILES_CONTENT_TIMEOUT_FLOOR_MS = 15000;
export const FILES_CONTENT_TIMEOUT_CEIL_MS = 60000;

export function resolveFilesContentTimeoutMs(expectedBytes) {
	const ms = FILES_CONTENT_TIMEOUT_FLOOR_MS + (expectedBytes / 32768) * 1000;
	return Math.min(FILES_CONTENT_TIMEOUT_CEIL_MS, Math.max(FILES_CONTENT_TIMEOUT_FLOOR_MS, ms));
}
