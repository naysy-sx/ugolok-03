// Общий кэш расшифрованных байт на сессию (TZ-FOLLOWUP-DECISIONS §4).
// Бабл и оверлей читают одно и то же; lock() обязан очистить — plaintext
// и preview URL не живут на экране пароля.
//
// MEDIA-PERF-TZ.md §4.1/§8 п.3 — с этапа "картинки" бабл и оверлей больше не
// делят ОДИН preview URL: бабл — уменьшенный растр (previewUrl), оверлей —
// свой растр под свою цель (overlay). Два РАЗНЫХ слота на digest, оба
// ревокаются при вытеснении/lock(). Решение автора (§8 п.3): исходные
// расшифрованные байты ПРОДОЛЖАЮТ храниться здесь после генерации бабл-
// превью — открытие оверлея после бабла не бьёт в сеть повторно, платим
// памятью (48 МиБ бюджет).
//
// MEDIA-PERF-TZ-4.md §4 A.1 — слот overlay ТЕПЕРЬ несёт width вместе с url:
// оверлей растеризуется под текущий вьюпорт (overlayTargetWidth в
// raster-image.js), а вьюпорт может смениться МЕЖДУ открытиями того же
// digest (поворот экрана, resize) — без width в ключе второе открытие
// молча отдало бы растр, посчитанный под ДРУГОЙ вьюпорт (девять-с-ошибкой:
// "картинка размылась сама по себе", TZ-4 §9). getOverlayUrl(digest, width)
// возвращает url ТОЛЬКО при точном совпадении width — иначе undefined,
// вызывающая сторона перегенерирует и setOverlayUrl перезапишет слот
// (revoke старого).
export const PLAINTEXT_CACHE_BUDGET_BYTES = 48 * 1024 * 1024;

const cache = new Map(); // digest -> { bytes, mime, size, previewUrl, overlay: {width, url} | null }

export function getPlaintextBytes(digest) {
	const entry = cache.get(digest);
	if (!entry) return undefined;
	cache.delete(digest);
	cache.set(digest, entry);
	return entry.bytes;
}

export function getPreviewUrl(digest) {
	return cache.get(digest)?.previewUrl;
}

export function getOverlayUrl(digest, width) {
	const overlay = cache.get(digest)?.overlay;
	if (!overlay || overlay.width !== width) return undefined;
	return overlay.url;
}

export function putPlaintextBytes(digest, bytes, mime) {
	const existing = cache.get(digest);
	if (existing) {
		cache.delete(digest);
		cache.set(digest, existing);
		return existing.bytes;
	}
	cache.set(digest, { bytes, mime, size: bytes.length, previewUrl: null, overlay: null });
	evictPlaintextCache();
	return bytes;
}

function revokeUrl(url) {
	if (!url) return;
	try {
		URL.revokeObjectURL(url);
	} catch {
		// node / уже отозван
	}
}

export function setPreviewUrl(digest, url) {
	const entry = cache.get(digest);
	if (!entry) return url;
	if (entry.previewUrl && entry.previewUrl !== url) revokeUrl(entry.previewUrl);
	entry.previewUrl = url;
	return url;
}

export function setOverlayUrl(digest, width, url) {
	const entry = cache.get(digest);
	if (!entry) return url;
	if (entry.overlay && entry.overlay.url !== url) revokeUrl(entry.overlay.url);
	entry.overlay = { width, url };
	return url;
}

function evictPlaintextCache(budgetBytes = PLAINTEXT_CACHE_BUDGET_BYTES) {
	let total = 0;
	for (const entry of cache.values()) total += entry.size;
	if (total <= budgetBytes) return;
	for (const [key, entry] of cache.entries()) {
		if (total <= budgetBytes) break;
		revokeUrl(entry.previewUrl);
		revokeUrl(entry.overlay?.url);
		cache.delete(key);
		total -= entry.size;
	}
}

export function clearPlaintextCache() {
	for (const entry of cache.values()) {
		revokeUrl(entry.previewUrl);
		revokeUrl(entry.overlay?.url);
	}
	cache.clear();
}
