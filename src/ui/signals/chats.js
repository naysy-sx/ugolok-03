import { signal } from "@preact/signals";
import { db } from "../../core/store/database.js";
import { ensureChatEstablished, sendMessage } from "../../domain/messaging/chat.js";
import { deleteMessage } from "../../domain/messaging/deletions.js";
import { markChatAsRead } from "../../domain/messaging/read-status.js";
import { saveDraft } from "../../domain/messaging/drafts.js";

// Находка 2 (CONTRACTS.md, этап 27): диспетчер transport.js работает вне React
// re-render — этот сигнал сообщает UI "что-то изменилось" (новое сообщение/Welcome/
// contact-request/коммит), чат.jsx/contacts.jsx перечитывают своё состояние при изменении.
export const messagingActivity = signal(0);

export function bumpMessagingActivity() {
	messagingActivity.value++;
}

export async function listChatPartners(ownerPubkey) {
	const rows = await db.table("mlsGroups").toArray();
	return [...new Set(rows.map((r) => r.contactPubkey))];
}

// Находка 3 (CONTRACTS.md, этап 27): ensureChatEstablished не подписывает устройство
// на #h новой группы само — refreshGroupMessageSubscription обязана вызываться следом,
// безусловно на каждую отправку (идемпотентна — дешевле, чем проверять "было ли создано").
export async function sendChatMessageAction(
	ownerPubkey,
	privKey,
	contactPubkey,
	text,
	lamportTs,
	publish,
	fetchKeyPackage,
	refreshGroupMessageSubscription,
) {
	await ensureChatEstablished(ownerPubkey, privKey, contactPubkey, publish, fetchKeyPackage);
	await refreshGroupMessageSubscription(ownerPubkey, privKey, publish);
	return sendMessage(ownerPubkey, privKey, contactPubkey, text, lamportTs, publish);
}

export async function deleteChatMessageAction(ownerPubkey, privKey, contactPubkey, msgId, lamportTs, publish) {
	return deleteMessage(ownerPubkey, privKey, contactPubkey, msgId, lamportTs, publish);
}

export async function markChatReadAction(ownerPubkey, privKey, contactPubkey, lastReadLamportTs, publish) {
	return markChatAsRead(ownerPubkey, privKey, contactPubkey, lastReadLamportTs, publish);
}

export async function saveChatDraftAction(ownerPubkey, privKey, contactPubkey, text, publish) {
	return saveDraft(ownerPubkey, privKey, contactPubkey, text, publish);
}
