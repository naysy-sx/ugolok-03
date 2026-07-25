// Этап 50 (CONTACTS-FSM.md §7) — "Журнал": персистентный лог сработавших
// уведомлений. notify() (notifier.js) НЕ меняется — остаётся чистой функцией
// с backend-инъекцией (существующие тесты не трогаются). notifyAndLog — тонкая
// обёртка поверх нeё: тот же результат для тоста/звука, плюс best-effort
// запись в journalEntries, если уведомление реально сработало (level !== "off").
import { db } from "../../core/store/database.js";
import { toEncryptedRow, fromEncryptedRow } from "../../core/store/encrypted-table.js";
import { JOURNAL_ENTRIES_PLAINTEXT_FIELDS } from "../../core/store/table-fields.js";
import { notify } from "./notifier.js";

export async function writeJournalEntry(ownerPubkey, dbKey, { category, title, body, navTarget }) {
	const entry = {
		id: crypto.randomUUID(),
		owner: ownerPubkey,
		createdAt: Date.now(),
		category,
		title,
		body,
		navTarget,
		read: false,
	};
	await db.table("journalEntries").put(toEncryptedRow(entry, JOURNAL_ENTRIES_PLAINTEXT_FIELDS, dbKey));
	return entry;
}

export async function listJournalEntries(ownerPubkey, dbKey) {
	const rows = await db.table("journalEntries").where("owner").equals(ownerPubkey).toArray();
	return rows.map((row) => fromEncryptedRow(row, dbKey)).sort((a, b) => b.createdAt - a.createdAt);
}

// read — plaintext-поле (JOURNAL_ENTRIES_PLAINTEXT_FIELDS) — update() патчит
// его прямо в сыром объекте, не трогая nonce/ciphertext title/body/navTarget.
export async function markJournalEntryRead(id) {
	await db.table("journalEntries").update(id, { read: true });
}

export async function notifyAndLog(ownerPubkey, dbKey, settings, category, subcategory, options, entityId, backend) {
	const level = notify(settings, category, subcategory, options, entityId, backend);
	if (level !== "off") {
		try {
			await writeJournalEntry(ownerPubkey, dbKey, { category, title: options.title, body: options.body, navTarget: options.navTarget });
		} catch {
			// персистентность Журнала — best-effort, тот же принцип, что остальные
			// non-critical записи в этой кодовой базе (ensureProfilesFetched и т.п.)
		}
	}
	return level;
}
