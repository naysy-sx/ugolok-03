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
// заводим. stored===null/undefined ИЛИ у stored нет createdAt/id (кэша нет
// вовсе, либо запись создана путём, который завёл createdAt, но ещё не id —
// найдено на Части C, C-2: receiveChannelKeyGrant заводит updatedAt сразу,
// lastEventId — только при первом реальном receiveChannelMetadata) — true
// безусловно. ОБЕ половины пары обязаны быть известны для корректного
// тайбрейка: created_at (число) с undefined через `>` в JS всегда false в
// обе стороны, а id (undefined) < ЛЮБОЙ реальной строки — без проверки ОБОИХ
// полей версионная запись могла бы никогда не вытеснить наполовину
// заполненную (created_at есть, id ещё нет).
export function isNewerVersion(incoming, stored) {
  if (!stored || stored.createdAt === undefined || stored.createdAt === null || stored.id === undefined || stored.id === null) return true;
  const winner = lwwWinner(
    { created_at: incoming.createdAt, id: incoming.id },
    { created_at: stored.createdAt, id: stored.id },
  );
  return winner.id === incoming.id;
}
