// Поиск в пикере/менеджере — линейный скан, ничего сложнее не нужно при
// заявленном масштабе (ALGO.MD §13: "n слишком мал для индекса", порог для
// индекса n-грамм — примерно n=10⁵). Дебаунс — забота вызывающей стороны
// (UI, по прецеденту chat.jsx: setTimeout/clearTimeout, 100-150мс).
export function normalizeForSearch(str) {
	return str.normalize("NFKD").toLowerCase();
}

export function filterEntries(entries, query) {
	const normalizedQuery = normalizeForSearch(query.trim());
	if (!normalizedQuery) return entries;
	return entries.filter((e) => normalizeForSearch(e.displayName).includes(normalizedQuery));
}
