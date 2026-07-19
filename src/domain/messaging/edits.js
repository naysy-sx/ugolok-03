import { sendMessage } from "./chat.js";
import { db } from "../../core/store/database.js";
import { fromEncryptedRow } from "../../core/store/encrypted-table.js";

const EDIT_MARKER_PREFIX = "__ugolok_edit__:";

// JSON, не конкатенация — текст правки может содержать любые символы (в т.ч. ":").
export function buildEditText(msgId, newText) {
	return EDIT_MARKER_PREFIX + JSON.stringify({ msgId, text: newText });
}

// Защита от повреждённого/адверсарного JSON — не бросает, возвращает null.
export function parseEditText(text) {
	if (typeof text !== "string" || !text.startsWith(EDIT_MARKER_PREFIX)) return null;
	let parsed;
	try {
		parsed = JSON.parse(text.slice(EDIT_MARKER_PREFIX.length));
	} catch {
		return null;
	}
	if (typeof parsed?.msgId !== "string" || typeof parsed?.text !== "string") return null;
	return { msgId: parsed.msgId, text: parsed.text };
}

// DESIGN.md, "Этап 27-довесок-6" — lamportTs строки сообщения (позиция в хронологии)
// НЕ трогается; editLamportTs (=lamportTs самой правки, отдельный тик) хранится
// отдельно в editedAt для LWW-разрешения конкурентных правок.
export async function editMessage(ownerPubkey, privKey, dbKey, contactPubkey, msgId, newText, lamportTs, publish) {
	const targetRow = await db.table("messages").where("[ownerPubkey+chatId+msgId]").equals([ownerPubkey, contactPubkey, msgId]).first();
	if (!targetRow || targetRow.senderPubkey !== ownerPubkey) {
		throw new Error("нельзя редактировать чужое сообщение");
	}
	if (targetRow.deleted) {
		throw new Error("нельзя редактировать удалённое сообщение");
	}
	const result = await sendMessage(ownerPubkey, privKey, dbKey, contactPubkey, buildEditText(msgId, newText), lamportTs, publish);
	await db.table("messages").where("[ownerPubkey+chatId+msgId]").equals([ownerPubkey, contactPubkey, msgId]).modify({
		text: newText,
		edited: true,
		editedAt: lamportTs,
	});
	return result;
}

// Вызывается ПОСЛЕ applyIncomingDeletionIfMarker в диспетчере transport.js
// (refreshGroupMessageSubscription) — тот же принцип: no-op (false) на обычные
// сообщения/control, не бросает на неизвестных msgId/группах.
export async function applyIncomingEditIfMarker(ownerPubkey, dbKey, event, receivedResult) {
	if (!receivedResult) return false;
	const parsed = parseEditText(receivedResult.text);
	if (!parsed) return false;

	const hTag = event.tags.find((t) => t[0] === "h");
	if (!hTag) return false;
	const groupRaw = await db.table("mlsGroups").get([ownerPubkey, hTag[1]]);
	if (!groupRaw) return false;
	const groupRow = fromEncryptedRow(groupRaw, dbKey);

	const editorPubkey = groupRow.contactPubkey;
	const targetRow = await db
		.table("messages")
		.where("[ownerPubkey+chatId+msgId]")
		.equals([ownerPubkey, groupRow.contactPubkey, parsed.msgId])
		.first();
	if (!targetRow) return false; // правка раньше оригинала — тот же прецедент, что delete
	if (targetRow.deleted) return false;
	if (targetRow.senderPubkey !== editorPubkey) return false; // F-EV-08 аналог

	const editLamportTs = receivedResult.lamportTs;
	if (targetRow.editedAt !== undefined && targetRow.editedAt >= editLamportTs) return false; // LWW

	await db.table("messages").where("[ownerPubkey+chatId+msgId]").equals([ownerPubkey, groupRow.contactPubkey, parsed.msgId]).modify({
		text: parsed.text,
		edited: true,
		editedAt: editLamportTs,
	});
	return true;
}
