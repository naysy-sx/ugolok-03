import { db } from "../../core/store/database.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { sign } from "../../core/crypto/sign.js";
import {
	generateChannelKey,
	generateChannelTopic,
	encryptChannelContent,
	decryptChannelContent,
	decryptChannelKeyGrant,
} from "../../core/crypto/channel-key.js";
import { parseAndVerifyAllowlist } from "../../core/crypto/comment-allowlist.js";
import { sendViewGrant, sendSubscribeRequest } from "./channel-access.js";
import { buildAddressableDeletionEvent } from "../events/handlers.js";
import { deleteChannelLocally } from "./moderation.js";
import { toEncryptedRow, fromEncryptedRow } from "../../core/store/encrypted-table.js";
import { CHANNEL_KEYS_PLAINTEXT_FIELDS, COMMENT_ALLOWLISTS_PLAINTEXT_FIELDS, CHANNELS_PLAINTEXT_FIELDS, CHANNEL_KEY_META_PLAINTEXT_FIELDS } from "../../core/store/table-fields.js";

async function requirePublishOk(publish, event) {
	const result = await publish(event);
	if (!result.ok) {
		throw new Error(result.reason || "relay отклонил публикацию");
	}
}

export async function createChannel(ownerPubkey, ownerPrivKey, dbKey, { name, description, rules, avatarDescriptor, allowChatAttachments = true }, groupIds, publish) {
	const channelId = crypto.randomUUID();
	const channelKeyHex = bytesToHex(generateChannelKey());
	const channelTopicHex = bytesToHex(generateChannelTopic());
	const version = 1;

	const metaContent = encryptChannelContent(
		JSON.stringify({ name, description, rules, avatar: avatarDescriptor ?? null, allowChatAttachments }),
		channelKeyHex,
		version,
	);
	// d-tag = channelId буквально (TECH.md §4.8: kind 30060 "не несёт privacy-чувствительных
	// связок", opaque HMAC не нужен, в отличие от 30053/30054).
	const metaEvent = sign(
		{
			kind: 30060,
			content: metaContent,
			tags: [
				["d", channelId],
				// Найдено живым прогоном против strfry: NIP-12 индексирует только
				// однобуквенные теги — многобуквенный "channel" relay отклоняет запросом
				// как "unindexed tag filter". `h` — тот же routing-принцип, что уже даёт
				// MLS-группам kind 445 (см. transport.js, refreshChannelContentSubscription).
				["h", channelTopicHex],
			],
			created_at: Math.floor(Date.now() / 1000),
		},
		ownerPrivKey,
	);
	await requirePublishOk(publish, metaEvent);

	await db.table("channels").put(
		toEncryptedRow(
			{
				ownerPubkey,
				id: channelId,
				creatorPubkey: ownerPubkey,
				name,
				description,
				rules,
				avatar: avatarDescriptor ?? null,
				allowChatAttachments,
				channelTopic: channelTopicHex,
				role: "owner",
				createdAt: Math.floor(Date.now() / 1000),
			},
			CHANNELS_PLAINTEXT_FIELDS,
			dbKey,
		),
	);
	await db.table("channelKeys").put(toEncryptedRow({ ownerPubkey, channelId, keyVersion: version, channelKey: channelKeyHex }, CHANNEL_KEYS_PLAINTEXT_FIELDS, dbKey));
	await db.table("channelKeyMeta").put(toEncryptedRow({ ownerPubkey, channelId, currentVersion: version }, CHANNEL_KEY_META_PLAINTEXT_FIELDS, dbKey));

	// Группы -> pubkeys, объединение с дедупликацией (Set). Пустой groupIds -> пустой Set
	// -> ни одного гранта -> канал остаётся сугубо локальным "заметочником" (буквально по ТЗ).
	const readerPubkeys = new Set();
	for (const groupId of groupIds) {
		const members = await db.table("groupMembers").where("groupId").equals(groupId).toArray();
		for (const m of members) readerPubkeys.add(m.pubkey);
	}
	const channel = { channelId, channelTopic: channelTopicHex, channelKey: channelKeyHex };
	for (const readerPubkey of readerPubkeys) {
		await sendViewGrant(ownerPubkey, ownerPrivKey, channel, readerPubkey, version, publish);
		// Этап 33 — аддитивная правка контракта этапа 30 (DESIGN.md, "Этап 33", найденный
		// пробел): владелец нигде не хранил список реальных получателей VIEW, без чего
		// banMember не смог бы переиздать ротированный ключ ОСТАВШИМСЯ читателям.
		await db.table("channelReaders").put({ ownerPubkey, channelId, readerPubkey });
	}

	for (const groupId of groupIds) {
		await db.table("channelVisibilityGroups").put({ ownerPubkey, channelId, groupId });
	}

	return { channelId };
}

export async function listOwnedChannels(ownerPubkey, dbKey) {
	const rows = await db.table("channels").where("ownerPubkey").equals(ownerPubkey).toArray();
	return rows.filter((r) => r.role === "owner").map((r) => fromEncryptedRow(r, dbKey));
}

export async function listSubscribedChannels(ownerPubkey, dbKey) {
	const rows = await db.table("channels").where("ownerPubkey").equals(ownerPubkey).toArray();
	return rows.filter((r) => r.role === "subscriber").map((r) => fromEncryptedRow(r, dbKey));
}

export async function listAvailableChannels(ownerPubkey, dbKey) {
	const rows = await db.table("channels").where("ownerPubkey").equals(ownerPubkey).toArray();
	return rows.filter((r) => r.role === "available").map((r) => fromEncryptedRow(r, dbKey));
}

// kind 30053 — decryptChannelKeyGrant БРОСАЕТ на "не мой грант" (NIP-44 AEAD-проверка
// проваливается для чужого получателя) — вызывающий код (transport.js, этап 30 wiring)
// обязан перехватывать per-event, тот же принцип, что везде в диспетчере.
export async function receiveChannelKeyGrant(ownerPubkey, readerPrivKey, dbKey, channelOwnerPubkey, event) {
	const grant = decryptChannelKeyGrant(event.content, readerPrivKey, channelOwnerPubkey);
	// НАЙДено ЖИВЫМ АДВЕРСАРНЫМ ТЕСТОМ (этап 33) — версия теперь идёт В ПЕЙЛОАДЕ гранта
	// (channel-key.js, encryptChannelKeyGrant), а не хардкодится: захардкоженная "1" молча
	// затирала уже сохранённый v_old тем же номером версии при ротации ключа (banMember),
	// ломая исторический доступ читателя. currentVersion — максимум из уже известного и
	// пришедшего (защита от переупорядоченной доставки: старый грант, пришедший ПОСЛЕ
	// нового, не должен откатывать текущую версию назад).
	const version = grant.version;
	await db.table("channelKeys").put(toEncryptedRow({ ownerPubkey, channelId: grant.channelId, keyVersion: version, channelKey: grant.channelKey }, CHANNEL_KEYS_PLAINTEXT_FIELDS, dbKey));
	const existingMeta = fromEncryptedRow(await db.table("channelKeyMeta").get([ownerPubkey, grant.channelId]), dbKey);
	const currentVersion = Math.max(existingMeta?.currentVersion ?? 0, version);
	await db.table("channelKeyMeta").put(toEncryptedRow({ ownerPubkey, channelId: grant.channelId, currentVersion }, CHANNEL_KEY_META_PLAINTEXT_FIELDS, dbKey));

	const existing = await db.table("channels").get([ownerPubkey, grant.channelId]);
	if (!existing) {
		await db.table("channels").put(
			toEncryptedRow(
				{
					ownerPubkey,
					id: grant.channelId,
					creatorPubkey: channelOwnerPubkey,
					name: "",
					description: "",
					rules: "",
					avatar: null,
					allowChatAttachments: true,
					channelTopic: grant.channelTopic,
					role: "available",
					createdAt: Math.floor(Date.now() / 1000),
				},
				CHANNELS_PLAINTEXT_FIELDS,
				dbKey,
			),
		);
	}
}

// kind 30060 — обновляет локальные метаданные (имя/описание/правила/аватар). Неизвестный
// канал (нет VIEW ещё) ИЛИ неизвестная эпоха -> тихий no-op (рутинный случай в потоке
// relay-broadcast, не ошибка).
export async function receiveChannelMetadata(ownerPubkey, dbKey, event) {
	const dTag = event.tags.find((t) => t[0] === "d");
	if (!dTag) return;
	const channelId = dTag[1];

	const existing = await db.table("channels").get([ownerPubkey, channelId]);
	if (!existing) return;
	const meta = fromEncryptedRow(await db.table("channelKeyMeta").get([ownerPubkey, channelId]), dbKey);
	if (!meta) return;
	const keyRowRaw = await db.table("channelKeys").get([ownerPubkey, channelId, meta.currentVersion]);
	if (!keyRowRaw) return;
	const keyRow = fromEncryptedRow(keyRowRaw, dbKey);

	const plaintext = decryptChannelContent(event.content, { [meta.currentVersion]: keyRow.channelKey });
	if (plaintext === null) return;
	const parsed = JSON.parse(plaintext);
	// name/description/rules/avatar — sensitive поля (CONTRACTS.md, Tier 1): decrypt-
	// merge-encrypt через put(), не partial .update() (та же находка, что messages/posts).
	const merged = {
		...fromEncryptedRow(existing, dbKey),
		name: parsed.name,
		description: parsed.description,
		rules: parsed.rules,
		avatar: parsed.avatar,
		allowChatAttachments: parsed.allowChatAttachments ?? true,
	};
	await db.table("channels").put(toEncryptedRow(merged, CHANNELS_PLAINTEXT_FIELDS, dbKey));
}

// Этап 50-довесок-2 (найдено пользователем: канал нельзя было отредактировать
// после создания) — kind 30060 уже parameterized-replaceable (тот же d-tag =
// channelId, NIP-01), поэтому republish с новым содержимым обновляет канал у
// ВСЕХ читателей через уже существующий приёмный пайплайн (receiveChannelMetadata
// выше, transport.js подписан на этот topic+kind для собственных каналов тоже) —
// новой подписки/kind не требуется. Частичное обновление: непереданные (undefined)
// поля сохраняют текущее значение, а не затираются. Локальная строка обновляется
// СРАЗУ (тот же decrypt-merge-encrypt приём, что receiveChannelMetadata) — владелец
// не ждёт собственное relay-эхо для своего же UI.
export async function editChannel(ownerPubkey, ownerPrivKey, dbKey, channelId, { name, description, rules, avatarDescriptor, allowChatAttachments }, publish) {
	const raw = await db.table("channels").get([ownerPubkey, channelId]);
	if (!raw) throw new Error("канал не найден");
	const existing = fromEncryptedRow(raw, dbKey);
	if (existing.role !== "owner") throw new Error("редактировать канал может только владелец");

	const merged = {
		...existing,
		name: name ?? existing.name,
		description: description ?? existing.description,
		rules: rules ?? existing.rules,
		avatar: avatarDescriptor !== undefined ? avatarDescriptor : existing.avatar,
		allowChatAttachments: allowChatAttachments ?? existing.allowChatAttachments,
	};

	const meta = fromEncryptedRow(await db.table("channelKeyMeta").get([ownerPubkey, channelId]), dbKey);
	const keyRow = fromEncryptedRow(await db.table("channelKeys").get([ownerPubkey, channelId, meta.currentVersion]), dbKey);
	const metaContent = encryptChannelContent(
		JSON.stringify({
			name: merged.name,
			description: merged.description,
			rules: merged.rules,
			avatar: merged.avatar,
			allowChatAttachments: merged.allowChatAttachments,
		}),
		keyRow.channelKey,
		meta.currentVersion,
	);
	const metaEvent = sign(
		{
			kind: 30060,
			content: metaContent,
			tags: [
				["d", channelId],
				["h", existing.channelTopic],
			],
			created_at: Math.floor(Date.now() / 1000),
		},
		ownerPrivKey,
	);
	await requirePublishOk(publish, metaEvent);
	await db.table("channels").put(toEncryptedRow(merged, CHANNELS_PLAINTEXT_FIELDS, dbKey));
}

// Этап 50-довесок-2 (найдено пользователем: канал нельзя было удалить) — тот же
// приём, что deletePost (kind 5, NIP-09, АДРЕСУЕМОЕ удаление по a-тегу
// "30060:{ownerPubkey}:{channelId}") — переживает republish/смену event.id при
// правках метаданных, в отличие от удаления по конкретному "e"-тегу события.
// Владелец не ждёт собственное эхо — deleteChannelLocally применяется сразу же.
export async function deleteChannel(ownerPubkey, ownerPrivKey, dbKey, channelId, publish) {
	const raw = await db.table("channels").get([ownerPubkey, channelId]);
	if (!raw) throw new Error("канал не найден");
	const existing = fromEncryptedRow(raw, dbKey);
	if (existing.role !== "owner") throw new Error("удалить канал может только владелец");

	const event = buildAddressableDeletionEvent(ownerPrivKey, 30060, channelId, [["h", existing.channelTopic]]);
	await requirePublishOk(publish, event);
	await deleteChannelLocally(ownerPubkey, dbKey, channelId);
}

// Приём kind-5 удаления канала подписчиком (transport.js маршрутизирует сюда).
// ДВОЙНАЯ проверка авторства (тот же принцип, что receivePost/receiveBanAnnouncement
// не доверяют тегам напрямую): (1) event.pubkey (реальный подписант, из unwrap/
// verify, не подделываемый) обязан совпасть с pubkey, УКАЗАННЫМ в самом a-теге
// (защита от "подписал одним ключом, сослался на другой канал в теге"), И (2) с
// channelRow.creatorPubkey, уже известным ЛОКАЛЬНО из момента получения VIEW-гранта
// (защита от подделки самого тега целиком третьей стороной). channelName читается
// ДО deleteChannelLocally — нужен для текста уведомления (transport.js).
export async function receiveChannelDeletion(ownerPubkey, dbKey, event) {
	const aTag = event.tags.find((t) => t[0] === "a");
	if (!aTag) return { applied: false };
	const [kindStr, taggedPubkey, channelId] = aTag[1].split(":");
	if (kindStr !== "30060") return { applied: false };

	const raw = await db.table("channels").get([ownerPubkey, channelId]);
	if (!raw) return { applied: false };
	const channelRow = fromEncryptedRow(raw, dbKey);
	if (event.pubkey !== taggedPubkey || event.pubkey !== channelRow.creatorPubkey) return { applied: false };

	const channelName = channelRow.name;
	await deleteChannelLocally(ownerPubkey, dbKey, channelId);
	return { applied: true, channelId, channelName };
}

// kind 30054 — если МОЙ pubkey появился в allowedAuthors и я ещё не owner — апгрейд
// роли available -> subscriber (чисто локальный эффект, не отдельное сетевое событие).
export async function receiveAllowlistUpdate(ownerPubkey, dbKey, myPubkey, event) {
	const channelTag = event.tags.find((t) => t[0] === "h"); // routing-тег, см. createChannel
	if (!channelTag) return;
	const channelRow = await db
		.table("channels")
		.where("channelTopic")
		.equals(channelTag[1])
		.and((r) => r.ownerPubkey === ownerPubkey)
		.first();
	if (!channelRow) return;
	if (channelRow.role === "owner") return;

	const meta = fromEncryptedRow(await db.table("channelKeyMeta").get([ownerPubkey, channelRow.id]), dbKey);
	if (!meta) return;
	const keyRowRaw = await db.table("channelKeys").get([ownerPubkey, channelRow.id, meta.currentVersion]);
	if (!keyRowRaw) return;
	const keyRow = fromEncryptedRow(keyRowRaw, dbKey);

	const verified = parseAndVerifyAllowlist(event, keyRow.channelKey, channelRow.creatorPubkey);
	if (verified === null) return;

	await db.table("commentAllowlists").put(
		toEncryptedRow(
			{
				ownerPubkey,
				channelId: channelRow.id,
				keyVersion: verified.version,
				allowedAuthors: verified.allowedAuthors,
			},
			COMMENT_ALLOWLISTS_PLAINTEXT_FIELDS,
			dbKey,
		),
	);
	if (verified.allowedAuthors.includes(myPubkey)) {
		await db.table("channels").update([ownerPubkey, channelRow.id], { role: "subscriber" });
	}
}

export async function subscribeToChannelAction(ownerPubkey, ownerPrivKey, channelId, publish) {
	const channelRow = await db.table("channels").get([ownerPubkey, channelId]);
	if (!channelRow) throw new Error("канал не найден");
	await sendSubscribeRequest(ownerPrivKey, channelRow.creatorPubkey, channelId, publish);
}
