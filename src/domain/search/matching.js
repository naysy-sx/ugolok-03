export const SEPARATOR = String.fromCharCode(31);

export function normalize(str) {
  return str.normalize('NFKD').replace(/\p{Mn}/gu, '').toLowerCase();
}

export function parseQuery(raw) {
  const parts = raw.split(/\s+/).map(normalize).filter(Boolean);
  return { parts: [...new Set(parts)].sort((a, b) => b.length - a.length), isEmpty: parts.length === 0 };
}

export function buildHaystack(fields) {
  return fields.map(normalize).join(SEPARATOR);
}

export function matches(haystack, parts) {
  return parts.every(p => haystack.includes(p));
}
