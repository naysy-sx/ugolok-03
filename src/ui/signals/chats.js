import { signal } from "@preact/signals";
import { db } from "../../core/store/database.js";
import { ensureChatEstablished, sendMessage } from "../../domain/messaging/chat.js";
import { deleteMessage, deleteMessageForMe, clearChatHistory } from "../../domain/messaging/deletions.js";
import { editMessage } from "../../domain/messaging/edits.js";
import { markChatAsRead } from "../../domain/messaging/read-status.js";
import { saveDraft } from "../../domain/messaging/drafts.js";
import { fromEncryptedRow } from "../../core/store/encrypted-table.js";

// Находка 2 (CONTRACTS.md, этап 27): диспетчер transport.js работает вне React
// re-render — этот сигнал сообщает UI "что-то изменилось" (новое сообщение/Welcome/
// contact-request/коммит), чат.jsx/contacts.jsx перечитывают своё состояние при изменении.
export const messagingActivity = signal(0);

export function bumpMessagingActivity() {
	messagingActivity.value++;
}

// НАЙДЕНО РЕАЛЬНЫМ ИСПОЛЬЗОВАНИЕМ (не домысел): .toArray() без фильтра возвращал ЧАТЫ
// ВСЕХ локальных аккаунтов на этом устройстве, не только текущего ownerPubkey — второй
// локальный аккаунт (мультиаккаунт, этап 11) видел чужую переписку в списке диалогов.
export async function listChatPartners(ownerPubkey, dbKey) {
	const rows = await db.table("mlsGroups").where("ownerPubkey").equals(ownerPubkey).toArray();
	return [...new Set(rows.map((r) => fromEncryptedRow(r, dbKey).contactPubkey))];
}

// Находка 3 (CONTRACTS.md, этап 27): ensureChatEstablished не подписывает устройство
// на #h новой группы само — refreshGroupMessageSubscription обязана вызываться следом,
// безусловно на каждую отправку (идемпотентна — дешевле, чем проверять "было ли создано").
// attachment (этап 29) — необязательный, проброс в sendMessage как есть.
export async function sendChatMessageAction(
	ownerPubkey,
	privKey,
	dbKey,
	contactPubkey,
	text,
	lamportTs,
	publish,
	fetchKeyPackage,
	refreshGroupMessageSubscription,
	attachment,
) {
	await ensureChatEstablished(ownerPubkey, privKey, dbKey, contactPubkey, publish, fetchKeyPackage);
	await refreshGroupMessageSubscription(ownerPubkey, privKey, publish);
	return sendMessage(ownerPubkey, privKey, dbKey, contactPubkey, text, lamportTs, publish, attachment);
}

export async function deleteChatMessageAction(ownerPubkey, privKey, dbKey, contactPubkey, msgId, lamportTs, publish) {
	return deleteMessage(ownerPubkey, privKey, dbKey, contactPubkey, msgId, lamportTs, publish);
}

// "Удалить у себя" — локально, без публикации (см. CONTRACTS.md, этап 27-довесок-5).
export async function deleteMessageForMeAction(ownerPubkey, contactPubkey, msgId) {
	return deleteMessageForMe(ownerPubkey, contactPubkey, msgId);
}

// "Очистить переписку" — локально, у собеседника всё остаётся (mlsGroups не трогается).
export async function clearChatHistoryAction(ownerPubkey, contactPubkey) {
	return clearChatHistory(ownerPubkey, contactPubkey);
}

// Редактирование — этап 27-довесок-6, DESIGN.md (LWW-инвариант).
export async function editChatMessageAction(ownerPubkey, privKey, dbKey, contactPubkey, msgId, newText, lamportTs, publish) {
	return editMessage(ownerPubkey, privKey, dbKey, contactPubkey, msgId, newText, lamportTs, publish);
}

export async function markChatReadAction(ownerPubkey, privKey, dbKey, contactPubkey, lastReadLamportTs, publish) {
	return markChatAsRead(ownerPubkey, privKey, dbKey, contactPubkey, lastReadLamportTs, publish);
}

export async function saveChatDraftAction(ownerPubkey, privKey, dbKey, contactPubkey, text, publish) {
	return saveDraft(ownerPubkey, privKey, dbKey, contactPubkey, text, publish);
}
