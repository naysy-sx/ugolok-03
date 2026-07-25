import { sign } from "../../core/crypto/sign.js";
import { getPublicKey } from "../../core/crypto/keys.js";
import { encrypt as nip44Encrypt, decrypt as nip44Decrypt } from "../../core/crypto/nip44.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { db } from "../../core/store/database.js";
import { fromEncryptedRow } from "../../core/store/encrypted-table.js";
import { pickLatest } from "../../core/sync/lww.js";

export const CHANNEL_READ_STATUS_KIND = 30074;

export function buildChannelReadStatusEvent(privKey, { channelId, lastReadAt }, createdAt = Math.floor(Date.now() / 1000)) {
	const ownPubHex = bytesToHex(getPublicKey(privKey));
	const plaintext = JSON.stringify({ lastReadAt });
	const content = nip44Encrypt(plaintext, privKey, ownPubHex);
	const eventTemplate = { kind: CHANNEL_READ_STATUS_KIND, tags: [["d", channelId]], content, created_at: createdAt };
	return sign(eventTemplate, privKey);
}

export function parseChannelReadStatusEvent(event, privKey) {
	const ownPubHex = bytesToHex(getPublicKey(privKey));
	const plaintext = nip44Decrypt(event.content, privKey, event.pubkey || ownPubHex);
	const parsed = JSON.parse(plaintext);
	const channelId = event.tags.find((tag) => tag[0] === "d")[1];
	return { channelId, lastReadAt: parsed.lastReadAt };
}

// ownerPubkey берётся из event.pubkey — read-status ВСЕГДА self-signed ("я прочитал"),
// тот же принцип, что foldReadStatus (messaging/read-status.js). Таблица
// channelSyncState целиком plaintext — БЕЗ toEncryptedRow/fromEncryptedRow.
export async function foldChannelReadStatus(event, privKey) {
	const ownerPubkey = event.pubkey;
	const { channelId, lastReadAt } = parseChannelReadStatusEvent(event, privKey);
	const raw = await db.table("channelSyncState").get([ownerPubkey, channelId]);
	if (raw && raw.lastReadAt >= lastReadAt) return;
	await db.table("channelSyncState").put({ ownerPubkey, channelId, lastReadAt });
}

// НАЙДЕНО ЖИВЫМ E2E (этап 47-довесок-3) — kind 30074 replaceable (NIP-01): strfry
// отклоняет новое событие с тем же (pubkey, kind, d=channelId) как "replaced: have
// newer event", если created_at НЕ строго больше уже принятого. С клика по
// уведомлению о комментарии два независимых вызова markChannelAsRead (ChannelDetail
// на посты, PostWithComments на комментарии) почти всегда попадают в ОДНУ и ту же
// секунду wall-clock — второй публикующийся отклоняется, а его catch(()=>{}) в
// вызывающем коде это молча проглатывает, из-за чего локальный курсор навсегда
// застревал на более старом значении, и бейдж "Каналы [N]" не пропадал. Карта здесь
// держит "последний использованный created_at" на канал — гарантирует строго
// возрастающую последовательность для ЭТОЙ сессии независимо от того, сколько
// вызовов пришло в одну и ту же секунду.
const lastPublishedCreatedAt = new Map();

// Найденный пользователем баг (живая проверка после этапа 50): "Каналы [N]" не
// пропадал сразу после прочтения. Корень — локальный курсор (channelSyncState,
// источник getChannelUnreadCount/бейджа) применялся ТОЛЬКО ПОСЛЕ успешной
// публикации kind 30074, а вызывающий UI-код (channel.jsx/channel-chat.jsx)
// глотал ЛЮБОЙ сбой publish через .catch(()=>{}) без ретрая — при малейшей
// задержке/сбое relay локальное состояние (и бейдж) застревали устаревшими
// НЕОГРАНИЧЕННО долго. Разворачиваем порядок: локальный fold — СРАЗУ и
// безусловно (то, что пользователь реально увидел, не должно ждать сеть);
// публикация — best-effort для синхронизации МЕЖДУ устройствами, её сбой
// молча проглатывается (другие устройства узнают через rebuildChannelReadStatus
// при следующем connect() либо при следующей успешной публикации).
export async function markChannelAsRead(ownerPubkey, privKey, channelId, lastReadAt, publish) {
	const now = Math.floor(Date.now() / 1000);
	const createdAt = Math.max(now, (lastPublishedCreatedAt.get(channelId) ?? 0) + 1);
	const event = buildChannelReadStatusEvent(privKey, { channelId, lastReadAt }, createdAt);
	lastPublishedCreatedAt.set(channelId, createdAt);
	await foldChannelReadStatus(event, privKey);
	try {
		await publish(event);
	} catch {
		// best-effort — см. пояснение выше
	}
}

// Тот же паттерн, что rebuildReadStatus — группировка по d-tag (channelId) обязательна,
// read-status разных каналов независим; pickLatest (LWW по created_at) на группу, не
// голый цикл по всем событиям подряд.
export async function rebuildChannelReadStatus(ownerPubkey, privKey) {
	const events = await db.table("events").where("[pubkey+kind]").equals([ownerPubkey, CHANNEL_READ_STATUS_KIND]).toArray();
	const byChannelId = new Map();
	for (const event of events) {
		const dTag = event.tags.find((t) => t[0] === "d")?.[1];
		if (!dTag) continue;
		const group = byChannelId.get(dTag) ?? [];
		group.push(event);
		byChannelId.set(dTag, group);
	}
	for (const group of byChannelId.values()) {
		await foldChannelReadStatus(pickLatest(group), privKey);
	}
}

// Один общий курсор на канал (posts+comments+chat вместе, DESIGN.md этап 47) —
// три таблицы с РАЗНОЙ доступностью полей без расшифровки (CONTRACTS.md, Tier 0-1).
export async function getChannelUnreadCount(ownerPubkey, channelId, dbKey) {
	const cursor = await db.table("channelSyncState").get([ownerPubkey, channelId]);
	const lastReadAt = cursor?.lastReadAt ?? 0;
	let count = 0;

	// channelMessages: ownerPubkey/channelId/authorPubkey/createdAt/deleted все plaintext.
	const chatRows = await db.table("channelMessages").where("[ownerPubkey+channelId]").equals([ownerPubkey, channelId]).toArray();
	count += chatRows.filter((r) => !r.deleted && r.createdAt > lastReadAt && r.authorPubkey !== ownerPubkey).length;

	// posts: channelId/createdAt/deleted plaintext, authorPubkey sensitive — расшифровка
	// ТОЛЬКО кандидатов, уже прошедших фильтр по каналу+времени.
	const postRows = await db.table("posts").where("[ownerPubkey+channelId]").equals([ownerPubkey, channelId]).toArray();
	const postCandidates = postRows.filter((r) => !r.deleted && r.createdAt > lastReadAt);
	count += postCandidates.filter((r) => fromEncryptedRow(r, dbKey).authorPubkey !== ownerPubkey).length;

	// comments: НИ channelId, НИ authorPubkey, НИ createdAt не plaintext (Tier 1) —
	// расшифровка ВСЕХ комментариев владельца, фильтр в памяти (тот же паттерн, что
	// moderation.js's deleteChannelLocally).
	const commentRows = await db.table("comments").where("ownerPubkey").equals(ownerPubkey).toArray();
	const decryptedComments = commentRows.map((r) => fromEncryptedRow(r, dbKey));
	count += decryptedComments.filter((c) => !c.deleted && c.channelId === channelId && c.createdAt > lastReadAt && c.authorPubkey !== ownerPubkey).length;

	return count;
}

// Этап 50 (CONTACTS-FSM.md §6, приложение А — инвариант N1) — тот же принцип,
// что isChatContentRead (messaging/read-status.js): rebuildChannelReadStatus
// подтягивает курсор с других устройств/сессий ДО подписок на контент
// (transport.js, connect()), поэтому сравнение с НИМ гасит уведомление о
// контенте, уже прочитанном где угодно — не только в текущей сессии.
export async function isChannelContentRead(ownerPubkey, channelId, createdAt) {
	const row = await db.table("channelSyncState").get([ownerPubkey, channelId]);
	return createdAt <= (row?.lastReadAt ?? 0);
}
