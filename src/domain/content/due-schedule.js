// Редизайн интерфейса, этап 4 (CONTRACTS.md) — группировка listDueRecords
// (post.js) на просрочено/сегодня/дальше для экрана "Сегодня". Границы дня —
// ЛОКАЛЬНОЕ время (setHours, не getUTCHours), тот же принцип, что dayKey
// в journal.jsx: смена суток обязана совпадать с тем, что видно на часах.
// records уже отсортирован (listDueRecords, индекс по dueAt) — один проход
// без пересортировки сохраняет порядок внутри каждой корзины.
export function groupDueRecords(records, nowUnix = Math.floor(Date.now() / 1000)) {
	const startOfToday = new Date(nowUnix * 1000).setHours(0, 0, 0, 0) / 1000;
	const startOfTomorrow = startOfToday + 86400;

	const overdue = [];
	const today = [];
	const later = [];
	for (const record of records) {
		if (record.dueAt < startOfToday) overdue.push(record);
		else if (record.dueAt < startOfTomorrow) today.push(record);
		else later.push(record);
	}
	return { overdue, today, later };
}
