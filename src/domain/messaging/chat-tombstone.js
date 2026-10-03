import { db } from "../../core/store/database.js";

// «Надгробие» удалённой переписки (db.version(40)). Чистые чтения/запись таблицы —
// без импортов из chat.js, чтобы chat.js и transport.js могли спрашивать «это событие
// старше удаления?», не порождая циклических зависимостей.
//
// deletedAt — секунды. Событие с createdAt <= deletedAt относится к уже удалённой
// переписке и игнорируется; более свежее (собеседник начал разговор заново, либо я сам
// написал) проходит как обычно.

export async function getChatTombstone(ownerPubkey, contactPubkey) {
	return (await db.table("chatTombstones").get([ownerPubkey, contactPubkey])) ?? null;
}

export async function getChatTombstoneByGroup(ownerPubkey, groupIdHex) {
	return (await db.table("chatTombstones").where("[ownerPubkey+groupId]").equals([ownerPubkey, groupIdHex]).first()) ?? null;
}

export function isCoveredByTombstone(tombstone, createdAt) {
	return !!tombstone && typeof createdAt === "number" && createdAt <= tombstone.deletedAt;
}

export async function isBeforeChatDeletion(ownerPubkey, contactPubkey, createdAt) {
	return isCoveredByTombstone(await getChatTombstone(ownerPubkey, contactPubkey), createdAt);
}

export async function isBeforeChatDeletionByGroup(ownerPubkey, groupIdHex, createdAt) {
	return isCoveredByTombstone(await getChatTombstoneByGroup(ownerPubkey, groupIdHex), createdAt);
}

export async function putChatTombstone({ ownerPubkey, contactPubkey, groupId, deletedAt }) {
	await db.table("chatTombstones").put({ ownerPubkey, contactPubkey, groupId, deletedAt });
}
