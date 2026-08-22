import { signal } from "@preact/signals";
import { listDueRecords } from "../../domain/content/post.js";

// Редизайн интерфейса, этап 4 (CONTRACTS.md) — тот же паттерн, что
// signals/journal.js (refreshJournal/journalEntries): сигнал полностью
// пересчитывается из БД на каждый refresh, отдельного runtime-состояния нет.
export const dueBadgeCount = signal(0);
export const dueRecords = signal([]);

function endOfTodayUnix() {
	const d = new Date();
	d.setHours(23, 59, 59, 999);
	return Math.floor(d.getTime() / 1000);
}

// Для кнопки-счётчика — только просрочено+сегодня, ограниченный диапазон
// дешевле расшифровать (listDueRecords, until), дёргается часто.
export async function refreshDueBadge(ownerPubkey, dbKey) {
	const records = await listDueRecords(ownerPubkey, dbKey, { until: endOfTodayUnix() });
	dueBadgeCount.value = records.length;
}

// Для экрана "Сегодня" — весь список без until, дороже, но зовётся только
// при открытии экрана.
export async function refreshDueRecords(ownerPubkey, dbKey) {
	dueRecords.value = await listDueRecords(ownerPubkey, dbKey);
}
