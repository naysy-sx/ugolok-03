// Чистая версия маппинга MediaError.code -> i18n-ключ причины (FILES-FIX-
// SPEC.md §5.1 "различать MEDIA_ERR_NETWORK/DECODE/SRC_NOT_SUPPORTED",
// TZ-FIX-FILES-MEDIA-STATIC.md 5.7). Вынесена из video-player.jsx/audio-
// player.jsx, чтобы маппинг был тестируем node --test'ом — MediaError как
// глобал существует только в браузере, но числовые коды стабильны (HTML
// Living Standard, §4.8.12.11), их можно захардкодить здесь.
export const MEDIA_ERR_ABORTED = 1;
export const MEDIA_ERR_NETWORK = 2;
export const MEDIA_ERR_DECODE = 3;
export const MEDIA_ERR_SRC_NOT_SUPPORTED = 4;

// null — код 1 (MEDIA_ERR_ABORTED, программная отмена — смена src при doNext/
// doPrev, НЕ отказ) — вызывающая сторона не должна показывать ошибку за него.
export function mediaErrorReasonKey(code) {
	if (code === MEDIA_ERR_ABORTED) return null;
	if (code === MEDIA_ERR_SRC_NOT_SUPPORTED) return "attachment.mediaErrorUnsupported";
	if (code === MEDIA_ERR_DECODE) return "attachment.mediaErrorDecode";
	return "attachment.mediaErrorNetwork"; // MEDIA_ERR_NETWORK и любой нераспознанный код
}

// 404 от SW (unknown-digest, гонка next/prev) Chrome часто отдаёт как
// SRC_NOT_SUPPORTED: тело — текст, не медиа. Следом идёт повтор и canplay.
// Плашку сразу не рисуем — та же отложенная логика, что у MEDIA_ERR_NETWORK.
export function isTransientMediaError(code) {
	return code === MEDIA_ERR_NETWORK || code === MEDIA_ERR_SRC_NOT_SUPPORTED;
}
