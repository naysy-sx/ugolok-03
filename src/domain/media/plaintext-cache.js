// Общий кэш расшифрованных байт на сессию (TZ-FOLLOWUP-DECISIONS §4).
// Бабл и оверлей читают одно и то же; lock() обязан очистить — plaintext
// и preview URL не живут на экране пароля.
export const PLAINTEXT_CACHE_BUDGET_BYTES = 48 * 1024 * 1024;

const cache = new Map(); // digest -> { bytes, mime, size, previewUrl }

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

export function putPlaintextBytes(digest, bytes, mime) {
	const existing = cache.get(digest);
	if (existing) {
		cache.delete(digest);
		cache.set(digest, existing);
		return existing.bytes;
	}
	cache.set(digest, { bytes, mime, size: bytes.length, previewUrl: null });
	evictPlaintextCache();
	return bytes;
}

export function setPreviewUrl(digest, url) {
	const entry = cache.get(digest);
	if (!entry) return url;
	if (entry.previewUrl && entry.previewUrl !== url) {
		try {
			URL.revokeObjectURL(entry.previewUrl);
		} catch {
			// node / уже отозван
		}
	}
	entry.previewUrl = url;
	return url;
}

function evictPlaintextCache(budgetBytes = PLAINTEXT_CACHE_BUDGET_BYTES) {
	let total = 0;
	for (const entry of cache.values()) total += entry.size;
	if (total <= budgetBytes) return;
	for (const [key, entry] of cache.entries()) {
		if (total <= budgetBytes) break;
		if (entry.previewUrl) {
			try {
				URL.revokeObjectURL(entry.previewUrl);
			} catch {
				// ignore
			}
		}
		cache.delete(key);
		total -= entry.size;
	}
}

export function clearPlaintextCache() {
	for (const entry of cache.values()) {
		if (entry.previewUrl) {
			try {
				URL.revokeObjectURL(entry.previewUrl);
			} catch {
				// ignore
			}
		}
	}
	cache.clear();
}
