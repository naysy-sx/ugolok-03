import { db } from "../../core/store/database.js";
import { acceptWelcome } from "./chat.js";

export async function isKnownContact(ownerPubkey, candidatePubkey) {
	const row = await db.table("contacts").get([ownerPubkey, candidatePubkey]);
	return Boolean(row);
}

// welcomeWireBytes хранится СЫРЫМ, joinFromWelcome НЕ вызывается здесь — Welcome
// остаётся нераспакованным, пока пользователь явно не примет решение (accept/reject).
export async function storeInboxRequest(ownerPubkey, senderPubkey, welcomeWireBytes, createdAt) {
	await db.table("inboxRequests").put({ owner: ownerPubkey, senderPubkey, welcomeWireBytes, createdAt });
}

export async function listInboxRequests(ownerPubkey) {
	return db.table("inboxRequests").where("owner").equals(ownerPubkey).toArray();
}

export async function acceptInboxRequest(ownerPubkey, dbKey, senderPubkey) {
	const row = await db.table("inboxRequests").get([ownerPubkey, senderPubkey]);
	if (!row) throw new Error("нет такого входящего запроса");
	await acceptWelcome(ownerPubkey, dbKey, senderPubkey, row.welcomeWireBytes);
	await db.table("inboxRequests").delete([ownerPubkey, senderPubkey]);
}

export async function rejectInboxRequest(ownerPubkey, senderPubkey) {
	await db.table("inboxRequests").delete([ownerPubkey, senderPubkey]);
}
