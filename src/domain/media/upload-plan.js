export function chunkSizeFor(size) {
  if (size <= 0) return 65536;
  const raw = Math.sqrt(67 * size);
  const n = Math.round(Math.log2(raw));
  let candidate = Math.pow(2, n);
  return candidate < 65536 ? 65536 : candidate > 4194304 ? 4194304 : candidate;
}

export function orderUploads(files) {
  return [...files].sort((a, b) => a.size - b.size);
}
