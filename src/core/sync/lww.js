export function lwwWinner(a, b) {
  if (a.created_at !== b.created_at) {
    return a.created_at > b.created_at ? a : b;
  }
  return a.id > b.id ? a : b;
}

export function pickLatest(events) {
  return events.reduce(lwwWinner);
}
