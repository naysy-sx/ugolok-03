import { db } from "../../core/store/database.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { sign } from "../../core/crypto/sign.js";
import { getPublicKey } from "../../core/crypto/keys.js";
import { encrypt as nip44Encrypt, decrypt as nip44Decrypt } from "../../core/crypto/nip44.js";
import { generateChannelKey, encryptChannelContent } from "../../core/crypto/channel-key.js";
import { buildAllowlistEvent } from "../../core/crypto/comment-allowlist.js";
import { deriveMasterSecret } from "../../core/crypto/derivation.js";
import { wrap as nip59Wrap } from "../../core/crypto/nip59.js";
import { sendViewGrant, buildChannelUnviewRumor } from "./channel-access.js";
import { deleteChannelLocally } from "./moderation.js";
import { toEncryptedRow, fromEncryptedRow } from "../../core/store/encrypted-table.js";
import { CHANNEL_KEYS_PLAINTEXT_FIELDS, COMMENT_ALLOWLISTS_PLAINTEXT_FIELDS, CHANNEL_KEY_META_PLAINTEXT_FIELDS } from "../../core/store/table-fields.js";
import { lwwWinner } from "../../core/sync/lww.js";
import { DomainError } from "../errors.js";

function requireOwnerChannel(raw, dbKey) {
	if (!raw) throw new DomainError("канал не найден", "errors.channelNotFound");
	const channelRow = fromEncryptedRow(raw, dbKey);
	if (channelRow.role !== "owner") throw new DomainError("изменять видимость канала может только владелец", "errors.onlyOwnerCanEditChannel");
	return channelRow;
}

async function requirePublishOk(publish, event) {
	const result = await publish(event);
	if (!result.ok) {
		if (result.reason) throw new Error(result.reason);
		throw new DomainError("relay отклонил публикацию", "errors.relayRejected");
	}
}

export async function findChannelIdsByVisibilityGroup(ownerPubkey, groupId) {
	const rows = await db.table("channelVisibilityGroups").where("[ownerPubkey+groupId]").equals([ownerPubkey, groupId]).toArray();
	return rows.map((r) => r.channelId);
}

// Этап 74 — найдено живой проверкой: channelVisibilityGroups (какие группы дают
// видимость каналу) мутировалась ТОЛЬКО в локальной Dexie, ни разу не публикуясь —
// в отличие от groups (kind:30050), у этой связки не было self-sync между
// sibling-устройствами владельца вовсе. Прямой прецедент buildGroupEvent/
// parseGroupEvent (contacts/groups.js): self-encrypted (nip44 на собственный
// pubkey), parameterized-replaceable, d-tag = channelId. content несёт ПОЛНЫЙ
// текущий набор groupIds (не дельту) — тот же приём, что группа целиком
// переиздаётся при любом изменении состава, не патчится по одному участнику.
export const CHANNEL_VISIBILITY_SYNC_KIND = 30065;

function buildChannelVisibilitySyncEvent(privKey, channelId, groupIds, createdAt = Math.floor(Date.now() / 1000)) {
	const ownPubHex = bytesToHex(getPublicKey(privKey));
	const content = nip44Encrypt(JSON.stringify({ groupIds }), privKey, ownPubHex);
	return sign({ kind: CHANNEL_VISIBILITY_SYNC_KIND, tags: [["d", channelId]], content, created_at: createdAt }, privKey);
}

function parseChannelVisibilitySyncEvent(event, privKey) {
	const ownPubHex = bytesToHex(getPublicKey(privKey));
	const plaintext = nip44Decrypt(event.content, privKey, event.pubkey || ownPubHex);
	const parsed = JSON.parse(plaintext);
	const channelId = event.tags.find((t) => t[0] === "d")[1];
	return { channelId, groupIds: parsed.groupIds };
}

// Delete-all + bulkAdd для [ownerPubkey, channelId] — зеркально foldGroup
// (domain/events/handlers.js): полное замещение набора, не дельта-патч.
async function foldChannelVisibilityGroups(event, privKey, dbKey) {
	const { channelId, groupIds } = parseChannelVisibilitySyncEvent(event, privKey);
	return db.transaction("rw", db.table("channelVisibilityGroups"), async () => {
		await db.table("channelVisibilityGroups").where("[ownerPubkey+channelId]").equals([event.pubkey, channelId]).delete();
		await db.table("channelVisibilityGroups").bulkAdd(groupIds.map((groupId) => ({ ownerPubkey: event.pubkey, channelId, groupId })));
	});
}

// Зеркально rebuildGroups: пересчёт из ПОЛНОЙ локальной истории событий этого
// kind (таблица events), LWW-победитель на d-tag(channelId), затем fold. Тот же
// проверенный механизм, никакого нового поля/потокового LWW-гейта на строке не
// потребовалось — переиспользуется lwwWinner (core/sync/lww.js).
export async function rebuildChannelVisibilityGroups(ownerPubkey, privKey, dbKey) {
	const syncEvents = await db.table("events").where("[pubkey+kind]").equals([ownerPubkey, CHANNEL_VISIBILITY_SYNC_KIND]).toArray();
	const latestByDTag = new Map();
	for (const ev of syncEvents) {
		const dTag = ev.tags.find((t) => t[0] === "d")?.[1];
		if (!dTag) continue;
		const existing = latestByDTag.get(dTag);
		latestByDTag.set(dTag, existing ? lwwWinner(existing, ev) : ev);
	}
	for (const [, event] of latestByDTag) {
		await foldChannelVisibilityGroups(event, privKey, dbKey);
	}
}

// Публикует ТЕКУЩИЙ (уже смутированный локально к моменту вызова) полный набор
// groupIds для channelId — единая точка вызова из ВСЕХ трёх мест, мутирующих
// channelVisibilityGroups (addVisibilityGroup/removeVisibilityGroup ниже,
// createChannel в channel.js).
export async function publishChannelVisibilitySync(ownerPubkey, ownerPrivKey, dbKey, channelId, publish) {
	const groupIds = await listChannelVisibilityGroupIds(ownerPubkey, channelId);
	const event = buildChannelVisibilitySyncEvent(ownerPrivKey, channelId, groupIds);
	await requirePublishOk(publish, event);
}

// СТРОГОЕ ПОДМНОЖЕСТВО moderation.js's banMember: та же ротация channelKey и
// переиздача грантов, НО без публикации бан-объявления (CHANNEL_BAN_KIND), без
// записи в bannedMembers и без скрытия контента — это не модерация, человек не
// нарушил правил, просто вышел из группы, давшей ему видимость.
export async function revokeViewFromMember(ownerPubkey, ownerPrivKey, dbKey, channelId, targetPubkey, publish) {
	const raw = await db.table("channels").get([ownerPubkey, channelId]);
	if (!raw) return;
	const channelRow = fromEncryptedRow(raw, dbKey);
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

	// Этап 74 — найдено живой проверкой (CONTRACTS.md/DESIGN.md "Этап 74"):
	// единственная копия метаданных (kind 30060) на relay оставалась зашифрована
	// СТАРОЙ версией ключа — любой читатель, получивший VIEW ПОСЛЕ этой ротации
	// (включая повторное addVisibilityGroup той же/другой группы), создавал
	// ЛОКАЛЬНУЮ строку со stub-заглушками (receiveChannelKeyGrant, name:"") и
	// НИКОГДА не мог её заполнить — decryptChannelContent требует ТУ ЖЕ версию,
	// что зашифровала content. Живой симптом: "(без названия)", канал без
	// аватара, но полностью функциональный (VIEW/allowlist не зависят от метаданных).
	const metaContent = encryptChannelContent(
		JSON.stringify({
			name: channelRow.name,
			description: channelRow.description,
			rules: channelRow.rules,
			avatar: channelRow.avatar,
			allowChatAttachments: channelRow.allowChatAttachments,
		}),
		newKeyHex,
		vNew,
	);
	const metaEvent = sign(
		{ kind: 30060, content: metaContent, tags: [["d", channelId], ["h", channelRow.channelTopic]], created_at: Math.floor(Date.now() / 1000) },
		ownerPrivKey,
	);
	await requirePublishOk(publish, metaEvent);

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

	// Этап 74 — найдено живой проверкой (CONTRACTS.md/DESIGN.md "Этап 74"):
	// приватное уведомление отозванному — БЕЗ него его локальная строка channels
	// оставалась навсегда с устаревшими данными. Best-effort: сбой доставки не
	// должен откатывать уже совершённую (и корректную) ротацию ключа выше —
	// та же философия, что mirrorBestEffort (mirror.js).
	try {
		const unviewRumor = nip59Wrap(buildChannelUnviewRumor(channelId), ownerPrivKey, targetPubkey);
		await requirePublishOk(publish, unviewRumor);
	} catch (e) {
		console.warn("revokeViewFromMember: не удалось уведомить отозванного читателя", e);
	}
}

// Этап 74 — найдено живой проверкой: приёмная сторона CHANNEL_UNVIEW_KIND
// (rumor уже развёрнут и ПРОВЕРЕН вызывающим giftWrapSubscriber'ом — rumor.pubkey
// аутентифицирован nip59.unwrap, F-EV-05). Та же деградация, что получатель
// публичного бан-объявления (receiveBanAnnouncement, moderation.js) применяет
// к самому себе — deleteChannelLocally, единая точка "забыть канал".
export async function applyChannelUnviewRumor(ownerPubkey, dbKey, rumor) {
	let channelId;
	try {
		({ channelId } = JSON.parse(rumor.content));
	} catch {
		return; // повреждённый/чужеродный content — не роняем диспетчер
	}
	if (!channelId) return;

	const raw = await db.table("channels").get([ownerPubkey, channelId]);
	if (!raw) return; // канал уже неизвестен локально — нечего удалять
	const channelRow = fromEncryptedRow(raw, dbKey);
	// Защита от подделки/ошибки: собственный (role="owner") канал НИКОГДА не
	// удаляется через этот путь — тот же принцип, что receiveBanAnnouncement
	// сверяет event.pubkey === channelRow.creatorPubkey.
	if (channelRow.role === "owner") return;
	if (rumor.pubkey !== channelRow.creatorPubkey) return; // не настоящий владелец — отклонить

	await deleteChannelLocally(ownerPubkey, dbKey, channelId);
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

// Этап 74 — найдено живой проверкой (НЕ баг синхронизации — воспроизводится даже
// на одном устройстве без сети): зеркало revokeIfNoLongerVisible в обратном
// направлении. addVisibilityGroup рассылает гранты только ТЕКУЩИМ на момент
// вызова участникам группы — участник, добавленный в УЖЕ привязанную к каналу
// группу ПОЗЖЕ, никем не догоняется. Направление и условия обхода зеркальны, но
// не идентичны revokeIfNoLongerVisible (тот проверяет "виден ли ЕЩЁ через другую
// группу" при УДАЛЕНИИ из одной; этот — "нужно ли выдать" при ДОБАВЛЕНИИ в одну),
// поэтому отдельная функция, не параметризация одной общей.
export async function grantIfNewlyVisible(ownerPubkey, ownerPrivKey, dbKey, pubkey, addedToGroupId, publish) {
	// Владелец уже имеет self-грант с момента создания канала (этап 55) —
	// второй грант через групповое членство избыточен, даже если владелец
	// технически состоит в собственной группе.
	if (pubkey === ownerPubkey) return;
	const channelIds = await findChannelIdsByVisibilityGroup(ownerPubkey, addedToGroupId);
	for (const channelId of channelIds) {
		const existingReader = await db.table("channelReaders").get([ownerPubkey, channelId, pubkey]);
		if (existingReader) continue; // уже виден (через эту же или другую группу/прямой грант)
		const raw = await db.table("channels").get([ownerPubkey, channelId]);
		if (!raw) continue; // defensive — не должно происходить (визибилити-группа без канала)
		const channelRow = fromEncryptedRow(raw, dbKey);
		if (channelRow.role !== "owner") continue; // то же требование, что addVisibilityGroup
		const meta = fromEncryptedRow(await db.table("channelKeyMeta").get([ownerPubkey, channelId]), dbKey);
		const keyRow = fromEncryptedRow(await db.table("channelKeys").get([ownerPubkey, channelId, meta.currentVersion]), dbKey);
		const channel = { channelId, channelTopic: channelRow.channelTopic, channelKey: keyRow.channelKey };
		await sendViewGrant(ownerPubkey, ownerPrivKey, channel, pubkey, meta.currentVersion, publish);
		await db.table("channelReaders").put({ ownerPubkey, channelId, readerPubkey: pubkey });
	}
}

// Этап 74 — найдено живой проверкой (не баг синхронизации, реальный пробел
// функциональности): группы видимости задавались ТОЛЬКО при createChannel —
// editChannel не умел их менять, UI редактирования канала не имел полей про
// группы вовсе. Читает текущие связки канала для UI-формы редактирования
// (checkbox-список, тот же паттерн, что CreateChannelForm, channels.jsx).
export async function listChannelVisibilityGroupIds(ownerPubkey, channelId) {
	const rows = await db.table("channelVisibilityGroups").where("[ownerPubkey+channelId]").equals([ownerPubkey, channelId]).toArray();
	return rows.map((r) => r.groupId);
}

// Привязывает уже СУЩЕСТВУЮЩИЙ канал к ДОПОЛНИТЕЛЬНОЙ группе (после создания).
// Симметрична циклу createChannel (channel.js), но БЕЗ ротации ключа — новые
// участники ПОЛУЧАЮТ доступ (не теряют), рассылка ТЕКУЩЕЙ версии ключа
// достаточна, ротация нужна только при ОТЗЫВЕ (revokeViewFromMember).
// Идемпотентна по читателям: уже видящий канал участник (через эту же или
// другую группу) не получает повторный грант.
export async function addVisibilityGroup(ownerPubkey, ownerPrivKey, dbKey, channelId, groupId, publish) {
	const channelRow = requireOwnerChannel(await db.table("channels").get([ownerPubkey, channelId]), dbKey);
	const meta = fromEncryptedRow(await db.table("channelKeyMeta").get([ownerPubkey, channelId]), dbKey);
	const keyRow = fromEncryptedRow(await db.table("channelKeys").get([ownerPubkey, channelId, meta.currentVersion]), dbKey);
	const channel = { channelId, channelTopic: channelRow.channelTopic, channelKey: keyRow.channelKey };

	const members = await db.table("groupMembers").where("groupId").equals(groupId).toArray();
	for (const { pubkey } of members) {
		const existingReader = await db.table("channelReaders").get([ownerPubkey, channelId, pubkey]);
		if (existingReader) continue;
		await sendViewGrant(ownerPubkey, ownerPrivKey, channel, pubkey, meta.currentVersion, publish);
		await db.table("channelReaders").put({ ownerPubkey, channelId, readerPubkey: pubkey });
	}

	await db.table("channelVisibilityGroups").put({ ownerPubkey, channelId, groupId });
	await publishChannelVisibilitySync(ownerPubkey, ownerPrivKey, dbKey, channelId, publish);
}

// Отвязывает группу от уже СУЩЕСТВУЮЩЕГО канала. Для каждого участника
// удаляемой группы — та же проверка "виден ли ещё через другую привязанную
// группу", что revokeIfNoLongerVisible, но СКОУПЛЕНА одним известным
// channelId (не идёт через findChannelIdsByVisibilityGroup — после удаления
// строки ниже она вернула бы пусто и для ЭТОГО канала тоже). Владелец
// (self-грант, этап 55) НИКОГДА не отзывается через этот путь — не зависит
// от группового членства, даже если технически состоит в удаляемой группе.
export async function removeVisibilityGroup(ownerPubkey, ownerPrivKey, dbKey, channelId, groupId, publish) {
	requireOwnerChannel(await db.table("channels").get([ownerPubkey, channelId]), dbKey);

	await db.table("channelVisibilityGroups").delete([ownerPubkey, channelId, groupId]);
	await publishChannelVisibilitySync(ownerPubkey, ownerPrivKey, dbKey, channelId, publish);

	const remainingGroupIds = (await listChannelVisibilityGroupIds(ownerPubkey, channelId));
	const removedGroupMembers = await db.table("groupMembers").where("groupId").equals(groupId).toArray();
	for (const { pubkey } of removedGroupMembers) {
		if (pubkey === ownerPubkey) continue;
		let stillVisible = false;
		for (const otherGroupId of remainingGroupIds) {
			const member = await db.table("groupMembers").get([otherGroupId, pubkey]);
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
