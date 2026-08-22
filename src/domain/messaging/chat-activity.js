import { db } from "../../core/store/database.js";
import { toEncryptedRow, fromEncryptedRow } from "../../core/store/encrypted-table.js";
import { CHAT_ACTIVITY_PLAINTEXT_FIELDS } from "../../core/store/table-fields.js";

// Редизайн интерфейса, этап 5 (CONTRACTS.md) — свежесть переписок для
// сортировки боковой панели (этап 10). Таблица хранит ТОЛЬКО последнее
// событие на чат — безусловный upsert, история не нужна. Вызывающая
// сторона (chat.js) решает, что считается "активностью".
export async function touchChatActivity(ownerPubkey, dbKey, chatId, lastFrom, lastAt) {
	await db.table("chatActivity").put(toEncryptedRow({ ownerPubkey, chatId, lastFrom, lastAt }, CHAT_ACTIVITY_PLAINTEXT_FIELDS, dbKey));
}

// Сортировка по lastAt УБЫВАНИЕМ в памяти — объём (число переписок
// аккаунта, не сообщений) тривиален, тот же принцип, что listChatPartners
// (ui/signals/chats.js). Все поля plaintext — fromEncryptedRow не требует
// расшифровки, вызывается по прецеденту остальных таблиц (единообразие).
export async function listConversations(ownerPubkey, dbKey) {
	const rows = await db.table("chatActivity").where("ownerPubkey").equals(ownerPubkey).toArray();
	return rows.map((r) => fromEncryptedRow(r, dbKey)).sort((a, b) => b.lastAt - a.lastAt);
}
