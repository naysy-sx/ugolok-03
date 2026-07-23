import { db } from "../../core/store/database.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { generateChannelKey } from "../../core/crypto/channel-key.js";
import { buildAllowlistEvent } from "../../core/crypto/comment-allowlist.js";
import { deriveMasterSecret } from "../../core/crypto/derivation.js";
import { sendViewGrant } from "./channel-access.js";
import { toEncryptedRow, fromEncryptedRow } from "../../core/store/encrypted-table.js";
import { CHANNEL_KEYS_PLAINTEXT_FIELDS, COMMENT_ALLOWLISTS_PLAINTEXT_FIELDS, CHANNEL_KEY_META_PLAINTEXT_FIELDS } from "../../core/store/table-fields.js";

async function requirePublishOk(publish, event) {
	const result = await publish(event);
	if (!result.ok) {
		throw new Error(result.reason || "relay отклонил публикацию");
	}
}

export async function findChannelIdsByVisibilityGroup(ownerPubkey, groupId) {
	const rows = await db.table("channelVisibilityGroups").where("[ownerPubkey+groupId]").equals([ownerPubkey, groupId]).toArray();
	return rows.map((r) => r.channelId);
}

// СТРОГОЕ ПОДМНОЖЕСТВО moderation.js's banMember: та же ротация channelKey и
// переиздача грантов, НО без публикации бан-объявления (CHANNEL_BAN_KIND), без
// записи в bannedMembers и без скрытия контента — это не модерация, человек не
// нарушил правил, просто вышел из группы, давшей ему видимость.
export async function revokeViewFromMember(ownerPubkey, ownerPrivKey, dbKey, channelId, targetPubkey, publish) {
	const channelRow = await db.table("channels").get([ownerPubkey, channelId]);
	if (!channelRow) return;
	const meta = fromEncryptedRow(await db.table("channelKeyMeta").get([ownerPubkey, channelId]), dbKey);
	const vOld = meta.currentVersion;
	const vNew = vOld + 1;

	const newKeyHex = bytesToHex(generateChannelKey());
	await db.table("channelKeys").put(toEncryptedRow({ ownerPubkey, channelId, keyVersion: vNew, channelKey: newKeyHex }, CHANNEL_KEYS_PLAINTEXT_FIELDS, dbKey));
	// currentVersion — ЕДИНСТВЕННОЕ sensitive-поле этой таблицы (партиал-инвариант,
	// CONTRACTS.md этап 45) — decrypt-merge-encrypt через put(), не голый .update().
	await db.table("channelKeyMeta").put(toEncryptedRow({ ownerPubkey, channelId, currentVersion: vNew }, CHANNEL_KEY_META_PLAINTEXT_FIELDS, dbKey));

	const readers = await db.table("channelReaders").where("[ownerPubkey+channelId]").equals([ownerPubkey, channelId]).toArray();
	const remaining = readers.filter((r) => r.readerPubkey !== targetPubkey);
	const newChannel = { channelId, channelTopic: channelRow.channelTopic, channelKey: newKeyHex };
	for (const r of remaining) {
		await sendViewGrant(ownerPubkey, ownerPrivKey, newChannel, r.readerPubkey, vNew, publish);
	}

	const oldAllowlistRow = fromEncryptedRow(await db.table("commentAllowlists").get([ownerPubkey, channelId, vOld]), dbKey);
	if (oldAllowlistRow) {
		const newAuthors = oldAllowlistRow.allowedAuthors.filter((p) => p !== targetPubkey);
		const masterSecret = deriveMasterSecret(ownerPrivKey);
		const allowlistEvent = buildAllowlistEvent(channelId, channelRow.channelTopic, vNew, newAuthors, newKeyHex, ownerPrivKey, masterSecret);
		await requirePublishOk(publish, allowlistEvent);
		await db.table("commentAllowlists").put(
			toEncryptedRow({ ownerPubkey, channelId, keyVersion: vNew, allowedAuthors: newAuthors }, COMMENT_ALLOWLISTS_PLAINTEXT_FIELDS, dbKey),
		);
	}

	await db.table("channelReaders").delete([ownerPubkey, channelId, targetPubkey]);
}

// Оркестратор: для каждого канала, чья видимость зависит от removedFromGroupId,
// проверяет — виден ли pubkey ЕЩЁ через какую-то ДРУГУЮ привязанную к каналу
// группу (channelVisibilityGroups минус removedFromGroupId). Если НЕТ ни одной
// такой группы, где pubkey всё ещё состоит — И у pubkey ЕСТЬ строка channelReaders
// для этого канала — вызывает revokeViewFromMember. Идемпотентно и defensive:
// если channelReaders записи нет (pubkey никогда не был читателем) — no-op, publish
// не вызывается вовсе.
export async function revokeIfNoLongerVisible(ownerPubkey, ownerPrivKey, dbKey, pubkey, removedFromGroupId, publish) {
	const channelIds = await findChannelIdsByVisibilityGroup(ownerPubkey, removedFromGroupId);
	for (const channelId of channelIds) {
		const visibilityRows = await db.table("channelVisibilityGroups").where("[ownerPubkey+channelId]").equals([ownerPubkey, channelId]).toArray();
		const otherGroupIds = visibilityRows.map((r) => r.groupId).filter((g) => g !== removedFromGroupId);
		let stillVisible = false;
		for (const groupId of otherGroupIds) {
			const member = await db.table("groupMembers").get([groupId, pubkey]);
			if (member) {
				stillVisible = true;
				break;
			}
		}
		if (stillVisible) continue;
		const readerRow = await db.table("channelReaders").get([ownerPubkey, channelId, pubkey]);
		if (!readerRow) continue;
		await revokeViewFromMember(ownerPubkey, ownerPrivKey, dbKey, channelId, pubkey, publish);
	}
}
