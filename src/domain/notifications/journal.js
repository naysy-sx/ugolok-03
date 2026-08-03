// Этап 50 (CONTACTS-FSM.md §7) — "Журнал": персистентный лог сработавших
// уведомлений. notify() (notifier.js) НЕ меняется — остаётся чистой функцией
// с backend-инъекцией (существующие тесты не трогаются). notifyAndLog — тонкая
// обёртка поверх нeё: тот же результат для тоста/звука, плюс best-effort
// запись в journalEntries, если уведомление реально сработало (level !== "off").
import { db } from "../../core/store/database.js";
import { toEncryptedRow, fromEncryptedRow } from "../../core/store/encrypted-table.js";
import { JOURNAL_ENTRIES_PLAINTEXT_FIELDS } from "../../core/store/table-fields.js";
import { notify } from "./notifier.js";

// Этап 50-довесок (пользователь, живая проверка) — createdAt (момент, когда
// ЭТО устройство записало уведомление) и occurredAt (момент, когда событие
// РЕАЛЬНО произошло — created_at исходного rumor'а/события) — РАЗНЫЕ вещи,
// расходятся ровно тогда, когда важно (догнать историю после offline/релогина).
// occurredAt — опционален у вызывающего (options.occurredAt в notifyAndLog);
// если не передан (звонки — событие ВСЕГДА "сейчас", либо вызывающий код ещё
// не прокинул), по умолчанию равен createdAt.
//
// Этап 64 (i18n генерируемого контента) — titleKey/titleParams/bodyKey/bodyParams
// (опциональны) хранятся РЯДОМ с уже отрендеренными title/body, не вместо них:
// journal.jsx предпочитает *Key (рендер через t() в ТЕКУЩЕЙ локали читателя),
// title/body — резерв для записей без ключа (старый формат, записанный ДО этого
// этапа — миграция не нужна, пользователь подтвердил, что они остаются на русском).
export async function writeJournalEntry(ownerPubkey, dbKey, { category, title, body, navTarget, occurredAt, titleKey, titleParams, bodyKey, bodyParams }) {
	const createdAt = Date.now();
	const entry = {
		id: crypto.randomUUID(),
		owner: ownerPubkey,
		createdAt,
		occurredAt: occurredAt ?? createdAt,
		category,
		title,
		body,
		titleKey,
		titleParams,
		bodyKey,
		bodyParams,
		navTarget,
		read: false,
	};
	await db.table("journalEntries").put(toEncryptedRow(entry, JOURNAL_ENTRIES_PLAINTEXT_FIELDS, dbKey));
	return entry;
}

// Сортировка по occurredAt (не createdAt) — пользователь просматривает Журнал
// как хронологию РЕАЛЬНЫХ событий (и календарь-переход, ниже в UI, опирается
// именно на эту хронологию); в подавляющем большинстве случаев (не было offline)
// они совпадают день-в-день, расхождение — только полезное исключение.
export async function listJournalEntries(ownerPubkey, dbKey) {
	const rows = await db.table("journalEntries").where("owner").equals(ownerPubkey).toArray();
	return rows.map((row) => fromEncryptedRow(row, dbKey)).sort((a, b) => b.occurredAt - a.occurredAt);
}

// read — plaintext-поле (JOURNAL_ENTRIES_PLAINTEXT_FIELDS) — update() патчит
// его прямо в сыром объекте, не трогая nonce/ciphertext title/body/navTarget.
export async function markJournalEntryRead(id) {
	await db.table("journalEntries").update(id, { read: true });
}

// "Отметить всё прочитанным" (пользователь) — read уже plaintext, фильтр по
// нему прямо на сырых строках, расшифровка не нужна вовсе.
export async function markAllJournalEntriesRead(ownerPubkey, dbKey) {
	const rows = await db.table("journalEntries").where("owner").equals(ownerPubkey).toArray();
	await Promise.all(rows.filter((row) => !row.read).map((row) => db.table("journalEntries").update(row.id, { read: true })));
}

export async function notifyAndLog(ownerPubkey, dbKey, settings, category, subcategory, options, entityId, backend) {
	const level = notify(settings, category, subcategory, options, entityId, backend);
	if (level !== "off") {
		try {
			await writeJournalEntry(ownerPubkey, dbKey, {
				category,
				title: options.title,
				body: options.body,
				navTarget: options.navTarget,
				occurredAt: options.occurredAt,
				titleKey: options.titleKey,
				titleParams: options.titleParams,
				bodyKey: options.bodyKey,
				bodyParams: options.bodyParams,
			});
		} catch {
			// персистентность Журнала — best-effort, тот же принцип, что остальные
			// non-critical записи в этой кодовой базе (ensureProfilesFetched и т.п.)
		}
	}
	return level;
}
