export const MEMORY_CACHE_BUDGET_BYTES = 50 * 1024 * 1024;

const cache = new Map();

export function getMemoryCachedUrl(sha256Hex) {
  const entry = cache.get(sha256Hex);
  if (!entry) return undefined;
  cache.delete(sha256Hex);
  cache.set(sha256Hex, entry);
  return entry.url;
}

export function putMemoryCachedAttachment(sha256Hex, bytes, mime, options = {}) {
  if (cache.has(sha256Hex)) {
    return getMemoryCachedUrl(sha256Hex);
  }
  const blob = new Blob([bytes], { type: mime });
  const url = URL.createObjectURL(blob);
  cache.set(sha256Hex, { url, size: bytes.length });
  evictMemoryCacheIfNeeded(options);
  return url;
}

export function evictMemoryCacheIfNeeded(options = {}) {
  const { budgetBytes = MEMORY_CACHE_BUDGET_BYTES } = options;
  let total = 0;
  for (const entry of cache.values()) {
    total += entry.size;
  }
  if (total <= budgetBytes) return;
  for (const [key, entry] of cache.entries()) {
    if (total <= budgetBytes) break;
    URL.revokeObjectURL(entry.url);
    cache.delete(key);
    total -= entry.size;
  }
}

export function clearMemoryCache() {
  for (const entry of cache.values()) {
    URL.revokeObjectURL(entry.url);
  }
  cache.clear();
}
