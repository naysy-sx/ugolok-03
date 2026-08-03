import { db } from "../../core/store/database.js";
import { acceptWelcome } from "./chat.js";
import { toEncryptedRow, fromEncryptedRow } from "../../core/store/encrypted-table.js";
import { INBOX_REQUESTS_PLAINTEXT_FIELDS } from "../../core/store/table-fields.js";
import { DomainError } from "../errors.js";

// Этап 49-довесок (найдено живым E2E, этап 50) — таблица contacts вытеснена
// единой contactRelationships (CONTACTS-FSM.md), но остаётся в схеме и
// перманентно пуста после однократной миграции (contact-runtime.js). Запрос
// к старой таблице здесь молча ломал автопринятие Welcome от УЖЕ принятых
// контактов — каждый Welcome шёл в inbox незнакомца, даже от настоящего
// контакта. state — plaintext поле индекса [owner+peer], расшифровка не нужна.
export async function isKnownContact(ownerPubkey, candidatePubkey) {
	const row = await db.table("contactRelationships").get([ownerPubkey, candidatePubkey]);
	return row?.state === "CONTACT";
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
	if (!raw) throw new DomainError("нет такого входящего запроса", "errors.noSuchInboxRequest");
	const row = fromEncryptedRow(raw, dbKey);
	await acceptWelcome(ownerPubkey, dbKey, senderPubkey, row.welcomeWireBytes);
	await db.table("inboxRequests").delete([ownerPubkey, senderPubkey]);
}

export async function rejectInboxRequest(ownerPubkey, senderPubkey) {
	await db.table("inboxRequests").delete([ownerPubkey, senderPubkey]);
}
