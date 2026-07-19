import { db } from "../../core/store/database.js";
import { acceptWelcome } from "./chat.js";
import { toEncryptedRow, fromEncryptedRow } from "../../core/store/encrypted-table.js";
import { INBOX_REQUESTS_PLAINTEXT_FIELDS } from "../../core/store/table-fields.js";

export async function isKnownContact(ownerPubkey, candidatePubkey) {
	const row = await db.table("contacts").get([ownerPubkey, candidatePubkey]);
	return Boolean(row);
}

// welcomeWireBytes хранится СЫРЫМ, joinFromWelcome НЕ вызывается здесь — Welcome
// остаётся нераспакованным, пока пользователь явно не примет решение (accept/reject).
export async function storeInboxRequest(ownerPubkey, dbKey, senderPubkey, welcomeWireBytes, createdAt) {
	await db.table("inboxRequests").put(toEncryptedRow({ owner: ownerPubkey, senderPubkey, welcomeWireBytes, createdAt }, INBOX_REQUESTS_PLAINTEXT_FIELDS, dbKey));
}

export async function listInboxRequests(ownerPubkey, dbKey) {
	const raw = await db.table("inboxRequests").where("owner").equals(ownerPubkey).toArray();
	return raw.map((r) => fromEncryptedRow(r, dbKey));
}

export async function acceptInboxRequest(ownerPubkey, dbKey, senderPubkey) {
	const raw = await db.table("inboxRequests").get([ownerPubkey, senderPubkey]);
	if (!raw) throw new Error("нет такого входящего запроса");
	const row = fromEncryptedRow(raw, dbKey);
	await acceptWelcome(ownerPubkey, dbKey, senderPubkey, row.welcomeWireBytes);
	await db.table("inboxRequests").delete([ownerPubkey, senderPubkey]);
}

export async function rejectInboxRequest(ownerPubkey, senderPubkey) {
	await db.table("inboxRequests").delete([ownerPubkey, senderPubkey]);
}
