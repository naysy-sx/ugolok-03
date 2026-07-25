import { signal } from "@preact/signals";
import { listJournalEntries, markJournalEntryRead, markAllJournalEntriesRead } from "../../domain/notifications/journal.js";
import { navigateFromNotification } from "./notification-nav.js";

// Этап 50 (CONTACTS-FSM.md §7) — сигнал полностью пересчитывается из БД (не
// инкрементально) на каждый вызов refreshJournal, тот же принцип, что
// contacts.js/groups.js — простой список для персонального лога, без нужды в
// собственном runtime/Map.
export const journalEntries = signal([]);

export async function refreshJournal(ownerPubkey, dbKey) {
	journalEntries.value = await listJournalEntries(ownerPubkey, dbKey);
}

// Клик по записи "Журнала" — помечает read (если ещё не прочитана) И переходит
// "к месту события" тем же механизмом, что уже используют тосты/нативные
// уведомления (navigateFromNotification/pendingNavTarget, app.jsx).
export async function openJournalEntry(ownerPubkey, dbKey, entry) {
	if (!entry.read) {
		await markJournalEntryRead(entry.id);
		await refreshJournal(ownerPubkey, dbKey);
	}
	navigateFromNotification(entry.navTarget);
}

// "Отметить всё прочитанным" (пользователь, живая проверка).
export async function markAllRead(ownerPubkey, dbKey) {
	await markAllJournalEntriesRead(ownerPubkey, dbKey);
	await refreshJournal(ownerPubkey, dbKey);
}
