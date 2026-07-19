import { sendMessage } from "./chat.js";
import { db } from "../../core/store/database.js";
import { fromEncryptedRow } from "../../core/store/encrypted-table.js";

const DELETE_MARKER_PREFIX = "__ugolok_delete__:";

export function buildDeletionText(msgId) {
	return DELETE_MARKER_PREFIX + msgId;
}

export function parseDeletionText(text) {
	if (typeof text !== "string" || !text.startsWith(DELETE_MARKER_PREFIX)) return null;
	return text.slice(DELETE_MARKER_PREFIX.length);
}

export async function deleteMessage(ownerPubkey, privKey, dbKey, contactPubkey, msgId, lamportTs, publish) {
	// Авторизация СВОЕЙ же стороны (найдено адверсарным тестом, не домысел): без этой
	// проверки deleteMessage могла бы "удалить" (локально) чужое сообщение (Боба), не только
	// своё — та же F-EV-08 граница, что applyIncomingDeletionIfMarker уже проверяет на приёме.
	// [ownerPubkey+chatId+msgId] (db.version(4), owner-scoping — см. database.js).
	const targetRow = await db.table("messages").where("[ownerPubkey+chatId+msgId]").equals([ownerPubkey, contactPubkey, msgId]).first();
	if (!targetRow || targetRow.senderPubkey !== ownerPubkey) {
		throw new Error("нельзя удалить чужое сообщение");
	}
	const result = await sendMessage(ownerPubkey, privKey, dbKey, contactPubkey, buildDeletionText(msgId), lamportTs, publish);
	await db.table("messages").where("[ownerPubkey+chatId+msgId]").equals([ownerPubkey, contactPubkey, msgId]).modify({ deleted: true, text: "" });
	return result;
}

// Вызывается ПОСЛЕ receiveGroupMessageEvent (chat.js) в диспетчере kind 445 (transport.js),
// не внутри chat.js — держит зону ответственности за границей самого крипто-модуля.
// ownerPubkey (правка контракта — owner-scoping, найдено реальным использованием мультиаккаунта
// на одном устройстве, см. database.js) — идентичность ВЫЗЫВАЮЩЕГО (кто сейчас подключён),
// нужен, чтобы найти ПРАВИЛЬНУЮ (этого владельца) mlsGroups/messages строку.
export async function applyIncomingDeletionIfMarker(ownerPubkey, dbKey, event, receivedResult) {
	if (!receivedResult) return false;
	const targetMsgId = parseDeletionText(receivedResult.text);
	if (!targetMsgId) return false;

	const hTag = event.tags.find((t) => t[0] === "h");
	if (!hTag) return false;
	const groupRaw = await db.table("mlsGroups").get([ownerPubkey, hTag[1]]);
	if (!groupRaw) return false;
	const groupRow = fromEncryptedRow(groupRaw, dbKey);

	// deleterPubkey — НЕ event.pubkey (эфемерный на kind 445, та же находка этапа 24 п.7) —
	// contactPubkey уже резолвится из mlsGroups, тем же способом, что receiveGroupMessageEvent.
	const deleterPubkey = groupRow.contactPubkey;
	const targetRow = await db
		.table("messages")
		.where("[ownerPubkey+chatId+msgId]")
		.equals([ownerPubkey, groupRow.contactPubkey, targetMsgId])
		.first();
	if (!targetRow) return false;
	// Авторизация — аналог validateDeletion (этап 22, F-EV-08): только автор может удалить своё.
	if (targetRow.senderPubkey !== deleterPubkey) return false;

	await db.table("messages").where("[ownerPubkey+chatId+msgId]").equals([ownerPubkey, groupRow.contactPubkey, targetMsgId]).modify({
		deleted: true,
		text: "",
	});
	return true;
}

// "Удалить у себя" — чисто локально, БЕЗ публикации в relay и БЕЗ проверки авторства
// (в отличие от deleteMessage/"у обоих" — здесь скрывается только МОЯ копия, чужие данные
// не затрагиваются, поэтому разрешено для любого msgId, не только своих сообщений).
// Жёсткое удаление строки (не soft-delete с плейсхолдером "Сообщение удалено" — та пометка
// нужна, только когда ОБЕ стороны знают об удалении; здесь знаю только я).
export async function deleteMessageForMe(ownerPubkey, contactPubkey, msgId) {
	await db.table("messages").where("[ownerPubkey+chatId+msgId]").equals([ownerPubkey, contactPubkey, msgId]).delete();
}

// "Очистить переписку" (у себя) — удаляет ВСЕ сообщения этого чата локально. mlsGroups-запись
// (сам канал) не трогается — listChatPartners (chats.js) читает mlsGroups, не messages, чат
// остаётся в списке, просто пустым; переписка продолжает работать при следующей отправке/приёме.
export async function clearChatHistory(ownerPubkey, contactPubkey) {
	await db.table("messages").where("[ownerPubkey+chatId]").equals([ownerPubkey, contactPubkey]).delete();
}
