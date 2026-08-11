export function lwwWinner(a, b) {
  if (a.created_at !== b.created_at) {
    return a.created_at > b.created_at ? a : b;
  }
  return a.id > b.id ? a : b;
}

export function pickLatest(events) {
  return events.reduce(lwwWinner);
}

// Этап 74 — T7 (CONTRACTS.md/DESIGN.md "Этап 74"): адаптер lwwWinner для
// {createdAt,id}-строк кэша (camelCase — отличие от nostr-событий с
// created_at/id) — единственная реализация сравнения версий, вторую не
// заводим. stored===null/undefined ИЛИ у stored нет createdAt (кэша нет
// вовсе, либо запись предшествует этой версионированной схеме) — true
// безусловно: сравнивать candidate.createdAt (число) с undefined через
// `>` в JS всегда false в обе стороны — без этой проверки версионная
// запись никогда не смогла бы вытеснить дoверсионную/пустую.
export function isNewerVersion(incoming, stored) {
  if (!stored || stored.createdAt === undefined || stored.createdAt === null) return true;
  const winner = lwwWinner(
    { created_at: incoming.createdAt, id: incoming.id },
    { created_at: stored.createdAt, id: stored.id },
  );
  return winner.id === incoming.id;
}
