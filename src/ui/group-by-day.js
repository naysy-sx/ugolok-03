import { currentLocale, t } from "./signals/i18n.js";

// CHANNEL-V2 части C3/E3 — общая группировка по календарному дню, нужна и
// ленте канала, и общему чату (не дублируется). Ключ дня — ЛОКАЛЬНОЕ время
// (не UTC), тот же принцип, что dayKey в journal.jsx: смена суток обязана
// совпадать с тем, что видно на часах.
function dayKey(unixSeconds) {
	const d = new Date(unixSeconds * 1000);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// journal.today/journal.yesterday — уже существующие ключи ("Сегодня"/
// "Вчера"), переиспользуются вместо дублирования перевода на 12 локалей.
function dayLabel(unixSeconds) {
	const now = Math.floor(Date.now() / 1000);
	const key = dayKey(unixSeconds);
	if (key === dayKey(now)) return t("journal.today");
	if (key === dayKey(now - 86400)) return t("journal.yesterday");
	return new Intl.DateTimeFormat(currentLocale.value, { day: "2-digit", month: "long", year: "numeric" }).format(new Date(unixSeconds * 1000));
}

// items уже отсортирован вызывающим кодом (лента/чат) — один проход без
// пересортировки сохраняет порядок внутри каждой группы. getCreatedAt —
// unix seconds (посты/сообщения канала оба используют createdAt в секундах).
export function groupByDay(items, getCreatedAt = (item) => item.createdAt) {
	const groups = [];
	let current = null;
	for (const item of items) {
		const key = dayKey(getCreatedAt(item));
		if (!current || current.key !== key) {
			current = { key, dayLabel: dayLabel(getCreatedAt(item)), items: [] };
			groups.push(current);
		}
		current.items.push(item);
	}
	return groups;
}
