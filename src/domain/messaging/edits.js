import { sendMessage } from "./chat.js";
import { db } from "../../core/store/database.js";
import { toEncryptedRow, fromEncryptedRow } from "../../core/store/encrypted-table.js";
import { MESSAGES_PLAINTEXT_FIELDS } from "../../core/store/table-fields.js";
import { DomainError } from "../errors.js";

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
	const raw = await db.table("messages").where("[ownerPubkey+chatId+msgId]").equals([ownerPubkey, contactPubkey, msgId]).first();
	if (!raw || raw.senderPubkey !== ownerPubkey) {
		throw new DomainError("нельзя редактировать чужое сообщение", "errors.cannotEditOthersMessage");
	}
	if (raw.deleted) {
		throw new DomainError("нельзя редактировать удалённое сообщение", "errors.cannotEditDeletedMessage");
	}
	const result = await sendMessage(ownerPubkey, privKey, dbKey, contactPubkey, buildEditText(msgId, newText), lamportTs, publish);
	// text/edited/editedAt — sensitive поля (CONTRACTS.md, Tier 1): partial .modify()
	// писал бы их plaintext поверх зашифрованной строки, минуя ciphertext вовсе —
	// поэтому decrypt-merge-encrypt через put(), не modify().
	const merged = { ...fromEncryptedRow(raw, dbKey), text: newText, edited: true, editedAt: lamportTs };
	await db.table("messages").put(toEncryptedRow(merged, MESSAGES_PLAINTEXT_FIELDS, dbKey));
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
	const raw = await db
		.table("messages")
		.where("[ownerPubkey+chatId+msgId]")
		.equals([ownerPubkey, groupRow.contactPubkey, parsed.msgId])
		.first();
	if (!raw) return false; // правка раньше оригинала — тот же прецедент, что delete
	if (raw.deleted) return false;
	if (raw.senderPubkey !== editorPubkey) return false; // F-EV-08 аналог

	const targetRow = fromEncryptedRow(raw, dbKey);
	const editLamportTs = receivedResult.lamportTs;
	if (targetRow.editedAt !== undefined && targetRow.editedAt >= editLamportTs) return false; // LWW

	const merged = { ...targetRow, text: parsed.text, edited: true, editedAt: editLamportTs };
	await db.table("messages").put(toEncryptedRow(merged, MESSAGES_PLAINTEXT_FIELDS, dbKey));
	return true;
}
