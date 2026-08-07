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
import { DomainError } from "../errors.js";
import { computeGroupId, isCommitter } from "./chat.js";

function encodeBase64(bytes) {
	return btoa(String.fromCharCode.apply(null, bytes));
}

async function requirePublishOk(publish, event) {
	const result = await publish(event);
	if (!result.ok) {
		if (result.reason) throw new Error(result.reason);
		throw new DomainError("relay отклонил публикацию", "errors.relayRejected");
	}
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
	// Этап 73.5 — М6: переносим (не сбрасываем) consecutiveDecryptFailures/desynced —
	// добавление сиблинга не относится к "смог ли я расшифровать что-то от собеседника".
	await db.table("mlsGroups").put(
		toEncryptedRow(
			{
				ownerPubkey,
				groupId: group.groupId,
				contactPubkey: group.contactPubkey,
				state: serializeState(newSessionState),
				consecutiveDecryptFailures: group.consecutiveDecryptFailures ?? 0,
				desynced: group.desynced ?? false,
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

// Симметрична addSiblingToGroup выше, но добавляет устройство КОНТАКТА (не
// своё) — появившееся ПОСЛЕ установления чата (этап 72, DESIGN.md). Коммит —
// той же механикой, тем же #h-каналом (существующие участники, включая
// другие устройства контакта, уже подписаны). Welcome — БЕЗ тега "contact"
// (в отличие от addSiblingToGroup): отправитель Welcome — я сам, получатель —
// контакт, обычная, ничем не осложнённая семантика (та же, что у самого
// первого Welcome в ensureChatEstablished).
async function addContactDeviceToGroup(ownerPubkey, privKey, dbKey, publish, contactPubkey, deviceId, wireBytes, group) {
	const state = deserializeState(group.state);
	const { privateKey: oldEnvPriv, publicKey: oldEnvPub } = await deriveNostrEnvelopeKeys(state);

	const { newSessionState, welcomeWireBytes, commitWireBytes } = await addMember(state, wireBytes);
	// Этап 73.5 — М6: переносим (не сбрасываем), тот же принцип, что addSiblingToGroup.
	await db.table("mlsGroups").put(
		toEncryptedRow(
			{
				ownerPubkey,
				groupId: group.groupId,
				contactPubkey: group.contactPubkey,
				state: serializeState(newSessionState),
				consecutiveDecryptFailures: group.consecutiveDecryptFailures ?? 0,
				desynced: group.desynced ?? false,
			},
			MLS_GROUPS_PLAINTEXT_FIELDS,
			dbKey,
		),
	);

	const commitContent = nip44Encrypt(encodeBase64(commitWireBytes), oldEnvPriv, bytesToHex(oldEnvPub));
	const commitEvent = sign(
		{ kind: 445, tags: [["h", group.groupId]], content: commitContent, created_at: Math.floor(Date.now() / 1000) },
		generateSecretKey(),
	);
	await requirePublishOk(publish, commitEvent);

	const welcomeEvent = nip59Wrap({ kind: 444, content: encodeBase64(welcomeWireBytes), tags: [] }, privKey, contactPubkey);
	await requirePublishOk(publish, welcomeEvent);

	// Персист СРАЗУ после успешного добавления (SM-2, тот же принцип, что addSiblingToGroup).
	await db.table("knownContactDevices").put({ ownerPubkey, contactPubkey, deviceId, wireBytes });
}

// АДВЕРСАРНО НАЙДЕНО (этап 72, тестом, не домыслом): два конкурентных вызова
// handleDeviceAnnounce для ОДНОГО И ТОГО ЖЕ (ownerPubkey, announcerPubkey,
// deviceId) — редоставка того же kind:443 живой подпиской, либо гонка с
// batch-проходом syncDeviceMembership — оба независимо ЧИТАЮТ ОДНО И ТО ЖЕ
// пред-коммитное состояние группы (ни один ещё не успел записать своё),
// оба публикуют welcome — потерянное обновление (ts-mls НЕ ловит это как
// "уже участник", т.к. с точки зрения КАЖДОГО вызова участника ещё нет).
// handleDeviceAnnounceInFlight коалесцирует одновременные вызовы с одинаковым
// ключом в ОДНО реальное выполнение — второй вызов просто ждёт результата
// первого, не гоняет свою копию логики. Это НЕ то же самое, что И2 в
// DESIGN.md ("Этап 72") — тот описывает ИСТИННО межпроцессную гонку (два
// разных устройства/вкладки), нерешаемую без координирующего сервиса; этот
// guard закрывает гонку ВНУТРИ одного процесса (тот же JS event loop), что
// полностью решаемо и не требует такого допущения.
const handleDeviceAnnounceInFlight = new Map();

// Единая точка входа для ОДНОГО входящего kind:443-анонса — вызывается живой
// подпиской (transport.js's refreshGroupMessageSubscription, этап 72), не
// пакетом. Ветвление: announcerPubkey===ownerPubkey — свой сиблинг (тот же
// addSiblingToGroup/knownDevices, что и syncDeviceMembership); иначе —
// устройство КОНТАКТА, добавляется ТОЛЬКО если чат с ним уже установлен
// (иначе — no-op, реальное первое установление идёт через ensureChatEstablished,
// не через эту функцию).
export async function handleDeviceAnnounce(ownerPubkey, privKey, dbKey, publish, announcerPubkey, deviceId, wireBytes) {
	if (!deviceId) return;

	const key = `${ownerPubkey}:${announcerPubkey}:${deviceId}`;
	const inFlight = handleDeviceAnnounceInFlight.get(key);
	if (inFlight) return inFlight;

	const promise = (async () => {
		if (announcerPubkey === ownerPubkey) {
			const myDeviceId = await getOrCreateDeviceId();
			if (deviceId === myDeviceId) return;

			let knownRow = await db.table("knownDevices").get([ownerPubkey, deviceId]);
			if (!knownRow) {
				knownRow = { ownerPubkey, deviceId, wireBytes, addedGroupIds: [] };
				await db.table("knownDevices").put(knownRow);
			}

			const allGroupsRaw = await db.table("mlsGroups").where("ownerPubkey").equals(ownerPubkey).toArray();
			const allGroups = allGroupsRaw.map((g) => fromEncryptedRow(g, dbKey));
			for (const group of allGroups) {
				if (knownRow.addedGroupIds.includes(group.groupId)) continue;
				try {
					await addSiblingToGroup(ownerPubkey, privKey, dbKey, publish, knownRow, group);
				} catch (e) {
					console.warn("handleDeviceAnnounce: не удалось добавить своё устройство в группу", deviceId, group.groupId, e);
				}
			}
			return;
		}

		const contactPubkey = announcerPubkey;
		// НАЙДЕНО ХАРНЕССОМ (m1-repro.test.js, этап 73.3, не домысел): без этого
		// условия ДВЕ СТОРОНЫ независимо коммитят добавление ОДНОГО и того же
		// нового устройства — я (contact-branch, здесь) ОДНОВременно с самим
		// владельцем нового устройства (sibling-branch, на ЕГО стороне) —
		// классический М2: два commit'а в одну эпоху одной группы. Ограничение
		// коммиттером (И3) для СОЗДАНИЯ группы уже есть в ensureChatEstablished —
		// то же правило распространяется и на ДОБАВЛЕНИЕ устройств контакта:
		// только коммиттер этой пары когда-либо коммитит в эту группу, я —
		// проигравшая сторона — молчу и жду, пока contact сам добавит себя
		// (через свой sibling-sync, код без изменений).
		if (!isCommitter(ownerPubkey, contactPubkey)) return;

		const groupIdHex = bytesToHex(computeGroupId(ownerPubkey, contactPubkey));
		const groupRaw = await db.table("mlsGroups").get([ownerPubkey, groupIdHex]);
		if (!groupRaw) return; // нет установленной переписки — нечего досинхронизировать

		const group = fromEncryptedRow(groupRaw, dbKey);
		const known = await db.table("knownContactDevices").get([ownerPubkey, contactPubkey, deviceId]);
		if (known) return;

		try {
			await addContactDeviceToGroup(ownerPubkey, privKey, dbKey, publish, contactPubkey, deviceId, wireBytes, group);
		} catch (e) {
			console.warn("handleDeviceAnnounce: не удалось добавить устройство контакта в группу", deviceId, groupIdHex, e);
		}
	})().finally(() => handleDeviceAnnounceInFlight.delete(key));

	handleDeviceAnnounceInFlight.set(key, promise);
	return promise;
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
