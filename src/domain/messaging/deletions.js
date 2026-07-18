import { sendMessage } from "./chat.js";
import { db } from "../../core/store/database.js";

const DELETE_MARKER_PREFIX = "__ugolok_delete__:";

export function buildDeletionText(msgId) {
	return DELETE_MARKER_PREFIX + msgId;
}

export function parseDeletionText(text) {
	if (typeof text !== "string" || !text.startsWith(DELETE_MARKER_PREFIX)) return null;
	return text.slice(DELETE_MARKER_PREFIX.length);
}

export async function deleteMessage(ownerPubkey, privKey, contactPubkey, msgId, lamportTs, publish) {
	// Авторизация СВОЕЙ же стороны (найдено адверсарным тестом, не домысел): без этой
	// проверки deleteMessage могла бы "удалить" (локально) чужое сообщение (Боба), не только
	// своё — та же F-EV-08 граница, что applyIncomingDeletionIfMarker уже проверяет на приёме.
	const targetRow = await db.table("messages").where("[chatId+msgId]").equals([contactPubkey, msgId]).first();
	if (!targetRow || targetRow.senderPubkey !== ownerPubkey) {
		throw new Error("нельзя удалить чужое сообщение");
	}
	const result = await sendMessage(ownerPubkey, privKey, contactPubkey, buildDeletionText(msgId), lamportTs, publish);
	await db.table("messages").where("[chatId+msgId]").equals([contactPubkey, msgId]).modify({ deleted: true, text: "" });
	return result;
}

// Вызывается ПОСЛЕ receiveGroupMessageEvent (chat.js) в диспетчере kind 445 (transport.js),
// не внутри chat.js — держит зону ответственности за границей самого крипто-модуля.
export async function applyIncomingDeletionIfMarker(event, receivedResult) {
	if (!receivedResult) return false;
	const targetMsgId = parseDeletionText(receivedResult.text);
	if (!targetMsgId) return false;

	const hTag = event.tags.find((t) => t[0] === "h");
	if (!hTag) return false;
	const groupRow = await db.table("mlsGroups").get(hTag[1]);
	if (!groupRow) return false;

	// deleterPubkey — НЕ event.pubkey (эфемерный на kind 445, та же находка этапа 24 п.7) —
	// contactPubkey уже резолвится из mlsGroups, тем же способом, что receiveGroupMessageEvent.
	const deleterPubkey = groupRow.contactPubkey;
	const targetRow = await db
		.table("messages")
		.where("[chatId+msgId]")
		.equals([groupRow.contactPubkey, targetMsgId])
		.first();
	if (!targetRow) return false;
	// Авторизация — аналог validateDeletion (этап 22, F-EV-08): только автор может удалить своё.
	if (targetRow.senderPubkey !== deleterPubkey) return false;

	await db.table("messages").where("[chatId+msgId]").equals([groupRow.contactPubkey, targetMsgId]).modify({
		deleted: true,
		text: "",
	});
	return true;
}
