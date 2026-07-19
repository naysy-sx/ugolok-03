import { generateSecretKey } from "nostr-tools/pure";
import { bytesToHex } from "@noble/hashes/utils.js";
import { addMember, deserializeState, serializeState, deriveNostrEnvelopeKeys } from "../../core/crypto/mls-session.js";
import { wrap as nip59Wrap } from "../../core/crypto/nip59.js";
import { encrypt as nip44Encrypt } from "../../core/crypto/nip44.js";
import { sign } from "../../core/crypto/sign.js";
import { db } from "../../core/store/database.js";
import { getOrCreateDeviceId } from "../identity/device.js";
import { toEncryptedRow, fromEncryptedRow } from "../../core/store/encrypted-table.js";
import { MLS_GROUPS_PLAINTEXT_FIELDS } from "../../core/store/table-fields.js";

function encodeBase64(bytes) {
	return btoa(String.fromCharCode.apply(null, bytes));
}

async function requirePublishOk(publish, event) {
	const result = await publish(event);
	if (!result.ok) throw new Error(result.reason || "relay отклонил публикацию");
}

// Добавляет один sibling-KeyPackage в ОДНУ группу. Вынесено в отдельную функцию, чтобы
// syncDeviceMembership могла обернуть каждый вызов в try/catch — одно повреждённое/
// злонамеренное объявление или сбой addMember НЕ должны прерывать обработку остальных
// групп/устройств (найдено адверсарным заходом; тот же принцип, что giftWrapSubscriber/
// refreshGroupMessageSubscription в transport.js — "не ронять батч").
async function addSiblingToGroup(ownerPubkey, privKey, dbKey, publish, knownRow, group) {
	const state = deserializeState(group.state);
	// Ключ конверта СТАРОЙ (пред-коммитной) эпохи — ей всё ещё пользуется
	// contactPubkey (Bob, уже существующий участник группы), пока не применит
	// коммит ниже. Захватить ДО addMember, не после (DESIGN.md, "Этап 25", раздел 1c).
	const { privateKey: oldEnvPriv, publicKey: oldEnvPub } = await deriveNostrEnvelopeKeys(state);

	const { newSessionState, welcomeWireBytes, commitWireBytes } = await addMember(state, knownRow.wireBytes);
	await db.table("mlsGroups").put(
		toEncryptedRow(
			{
				ownerPubkey,
				groupId: group.groupId,
				contactPubkey: group.contactPubkey,
				state: serializeState(newSessionState),
			},
			MLS_GROUPS_PLAINTEXT_FIELDS,
			dbKey,
		),
	);

	// НАЙДЕНО ПРИ ПОДГОТОВКЕ ЖИВОЙ ПРОВЕРКИ (не домысел, до фактического запуска):
	// в отличие от ensureChatEstablished (этап 24, брендовая 2-местная группа —
	// там commitWireBytes оправданно отбрасывается, узнавать НЕЧЕГО не участнику),
	// здесь В ГРУППЕ УЖЕ ЕСТЬ contactPubkey (Bob) — существующий участник, которому
	// НЕОБХОДИМ именно коммит, чтобы продвинуть свою эпоху; Welcome предназначен
	// ТОЛЬКО новому участнику (сиблингу). Без публикации коммита contactPubkey
	// навсегда застрял бы на старой эпохе и не смог бы расшифровать ничего, что
	// отправлено ПОСЛЕ добавления сиблинга — тихая порча канала, не сразу заметная.
	// Коммит доставляется ТЕМ ЖЕ каналом, что обычные сообщения (kind 445, #h),
	// под ключом конверта СТАРОЙ эпохи (см. выше) — contactPubkey уже подписан на
	// этот #h и обработает его через уже существующую ветку result.kind==="control"
	// в receiveGroupMessageEvent (chat.js, этап 24) — правка здесь не нужна.
	const commitContent = nip44Encrypt(encodeBase64(commitWireBytes), oldEnvPriv, bytesToHex(oldEnvPub));
	const commitEvent = sign(
		{ kind: 445, tags: [["h", group.groupId]], content: commitContent, created_at: Math.floor(Date.now() / 1000) },
		generateSecretKey(),
	);
	await requirePublishOk(publish, commitEvent);

	// tags: [["contact", ...]] — Welcome-отправитель здесь Я САМ (другое устройство
	// той же identity), поэтому получатель НЕ может определить, с кем этот 1:1-чат,
	// из rumor.pubkey (это тоже Я). Кладём contactPubkey явно в тег — дешёвый способ
	// переиспользовать ту же acceptWelcome/computeGroupId(owner, contact) логику, что
	// и для обычного Welcome от контакта (DESIGN.md, "Этап 25", раздел 1).
	const welcomeEvent = nip59Wrap(
		{ kind: 444, content: encodeBase64(welcomeWireBytes), tags: [["contact", group.contactPubkey]] },
		privKey,
		ownerPubkey,
	);
	await requirePublishOk(publish, welcomeEvent);

	// Персист СРАЗУ после каждого успешного добавления (не после всего цикла) —
	// иначе сбой на N-й группе откатил бы прогресс по 1..N-1, уже реально
	// добавленным (DESIGN.md, "Этап 25", раздел 1).
	knownRow.addedGroupIds.push(group.groupId);
	await db.table("knownDevices").put(knownRow);
}

export async function syncDeviceMembership(ownerPubkey, privKey, dbKey, publish, fetchOwnKeyPackageAnnounces) {
	const myDeviceId = await getOrCreateDeviceId();
	const announces = await fetchOwnKeyPackageAnnounces();

	for (const announce of announces) {
		if (!announce.deviceId || announce.deviceId === myDeviceId) continue;

		let knownRow = await db.table("knownDevices").get([ownerPubkey, announce.deviceId]);
		if (!knownRow) {
			knownRow = {
				ownerPubkey,
				deviceId: announce.deviceId,
				wireBytes: announce.wireBytes,
				addedGroupIds: [],
			};
			await db.table("knownDevices").put(knownRow);
		}

		// НАЙДЕНО РЕАЛЬНЫМ ИСПОЛЬЗОВАНИЕМ (не домысел): .toArray() без фильтра возвращал
		// ГРУППЫ ВСЕХ локальных аккаунтов на этом устройстве, не только текущего ownerPubkey —
		// приводило к попытке добавить сиблинга в ЧУЖУЮ (другого локального аккаунта) группу.
		const allGroupsRaw = await db.table("mlsGroups").where("ownerPubkey").equals(ownerPubkey).toArray();
		const allGroups = allGroupsRaw.map((g) => fromEncryptedRow(g, dbKey));
		for (const group of allGroups) {
			if (knownRow.addedGroupIds.includes(group.groupId)) continue;

			try {
				await addSiblingToGroup(ownerPubkey, privKey, dbKey, publish, knownRow, group);
			} catch (e) {
				console.warn("syncDeviceMembership: не удалось добавить устройство в группу", announce.deviceId, group.groupId, e);
			}
		}
	}
}
