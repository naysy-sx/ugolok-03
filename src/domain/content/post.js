import { db } from "../../core/store/database.js";
import { sign } from "../../core/crypto/sign.js";
import { encryptChannelContent, decryptChannelContent } from "../../core/crypto/channel-key.js";
import { buildAddressableDeletionEvent } from "../../domain/events/handlers.js";
import { transitionPost } from "./post-machine.js";
import { toEncryptedRow, fromEncryptedRow } from "../../core/store/encrypted-table.js";
import { POSTS_PLAINTEXT_FIELDS } from "../../core/store/table-fields.js";
import { isNewerVersion } from "../../core/sync/lww.js";
import { ChannelContentNotReadyError } from "./channel-content-errors.js";
import { DomainError } from "../errors.js";

async function requirePublishOk(publish, event) {
	const result = await publish(event);
	if (!result.ok) {
		if (result.reason) throw new Error(result.reason);
		throw new DomainError("relay отклонил публикацию", "errors.relayRejected");
	}
}

// DESIGN.md, "Этап 31", формализация 1 — draft НИКОГДА не публикуется, строго
// локальная запись до первого PUBLISH.
export async function createDraftPost(ownerPubkey, dbKey, channelId, { text, attachments = [] }) {
	const postId = crypto.randomUUID();
	await db.table("posts").put(
		toEncryptedRow(
			{
				ownerPubkey,
				id: postId,
				channelId,
				authorPubkey: ownerPubkey,
				text,
				attachments,
				status: "draft",
				keyVersion: null,
				createdAt: Math.floor(Date.now() / 1000),
				deleted: false,
			},
			POSTS_PLAINTEXT_FIELDS,
			dbKey,
		),
	);
	return { postId };
}

// Локальное редактирование — до первой публикации, ИЛИ после UNPUBLISH (снова draft).
// text/attachments — sensitive поля (CONTRACTS.md, Tier 1): decrypt-merge-encrypt,
// не partial .update() (тот же класс находки, что messages/edits.js).
export async function updateDraftPost(ownerPubkey, dbKey, postId, { text, attachments }) {
	const raw = await db.table("posts").get([ownerPubkey, postId]);
	if (!raw) throw new DomainError("пост не найден", "errors.postNotFound");
	if (raw.status !== "draft") {
		throw new DomainError("редактировать можно только черновик (unpublish уже опубликованный, затем редактировать)", "errors.onlyDraftEditable");
	}
	const merged = { ...fromEncryptedRow(raw, dbKey), text, attachments };
	await db.table("posts").put(toEncryptedRow(merged, POSTS_PLAINTEXT_FIELDS, dbKey));
}

// Общая часть publishPost/archivePost/unpublishPost — DESIGN.md формализация 1:
// статус — ЧАСТЬ синхронизируемого payload'а, republish того же d-tag (kind 30061
// параметризованно-replaceable, NIP-01) заменяет предыдущую версию у всех читателей.
async function republishWithStatus(ownerPubkey, ownerPrivKey, dbKey, postId, fsmEvent, publish) {
	const raw = await db.table("posts").get([ownerPubkey, postId]);
	if (!raw) throw new DomainError("пост не найден", "errors.postNotFound");
	const newStatus = transitionPost(raw.status, fsmEvent); // бросает на недопустимый переход
	const row = fromEncryptedRow(raw, dbKey); // text/attachments — sensitive, нужны для republish-контента

	const channelRow = await db.table("channels").get([ownerPubkey, row.channelId]);
	const meta = fromEncryptedRow(await db.table("channelKeyMeta").get([ownerPubkey, row.channelId]), dbKey);
	const keyRow = fromEncryptedRow(await db.table("channelKeys").get([ownerPubkey, row.channelId, meta.currentVersion]), dbKey);

	const content = encryptChannelContent(
		JSON.stringify({ text: row.text, attachments: row.attachments, status: newStatus }),
		keyRow.channelKey,
		meta.currentVersion,
	);
	const event = sign(
		{
			kind: 30061,
			content,
			tags: [
				["d", `${row.channelId}:${postId}`],
				["h", channelRow.channelTopic],
			],
			created_at: Math.floor(Date.now() / 1000),
		},
		ownerPrivKey,
	);
	await requirePublishOk(publish, event);
	// lastEventCreatedAt/lastEventId (Этап 74 — Часть C, C-2) — без них собственная
	// строка владельца оставалась бы БЕЗ версии, и старая redelivery (resubscribe-
	// backlog на своё же ПРОШЛОЕ событие) прошла бы isNewerVersion-гейт в receivePost
	// как "нет сохранённой версии", откатив status на этом же/сиблинг-устройстве.
	await db.table("posts").update([ownerPubkey, postId], { status: newStatus, keyVersion: meta.currentVersion, lastEventCreatedAt: event.created_at, lastEventId: event.id });
	return { eventId: event.id };
}

export async function publishPost(ownerPubkey, ownerPrivKey, dbKey, postId, publish) {
	return republishWithStatus(ownerPubkey, ownerPrivKey, dbKey, postId, "PUBLISH", publish);
}

export async function archivePost(ownerPubkey, ownerPrivKey, dbKey, postId, publish) {
	return republishWithStatus(ownerPubkey, ownerPrivKey, dbKey, postId, "ARCHIVE", publish);
}

export async function unpublishPost(ownerPubkey, ownerPrivKey, dbKey, postId, publish) {
	return republishWithStatus(ownerPubkey, ownerPrivKey, dbKey, postId, "UNPUBLISH", publish);
}

// F-CH-10 — kind 5 (NIP-09), АДРЕСУЕМОЕ удаление (тег "a": kind:pubkey:d-tag) —
// переживает republish/смену event.id при статусных переходах, в отличие от
// удаления по конкретному "e"-тегу. Черновик (никогда не публиковался) — нечего
// отзывать на relay, только локальная отметка.
export async function deletePost(ownerPubkey, ownerPrivKey, postId, publish) {
	const row = await db.table("posts").get([ownerPubkey, postId]);
	if (!row) throw new DomainError("пост не найден", "errors.postNotFound");
	if (row.status !== "draft") {
		const dTag = `${row.channelId}:${postId}`;
		const event = buildAddressableDeletionEvent(ownerPrivKey, 30061, dTag);
		await requirePublishOk(publish, event);
	}
	await db.table("posts").update([ownerPubkey, postId], { deleted: true });
}

// DESIGN.md, формализация 2 (найденная адверсарная угроза) — event.pubkey ОБЯЗАН
// совпадать с channelRow.creatorPubkey: ЛЮБОЙ VIEW-держатель технически способен
// зашифровать валидный kind 30061 тем же channelKey — владение ключом ≠ авторство.
export async function receivePost(ownerPubkey, dbKey, event) {
	const hTag = event.tags.find((t) => t[0] === "h");
	if (!hTag) return false;
	const channelRow = await db
		.table("channels")
		.where("channelTopic")
		.equals(hTag[1])
		.and((r) => r.ownerPubkey === ownerPubkey)
		.first();
	if (!channelRow) return false;
	if (event.pubkey !== channelRow.creatorPubkey) return false;

	// Этап 74 — найдено живой проверкой (CONTRACTS.md/DESIGN.md "Этап 74"): throw,
	// не silent no-op — тот же приём, что receiveChannelMetadata (М3-класс для каналов).
	const meta = fromEncryptedRow(await db.table("channelKeyMeta").get([ownerPubkey, channelRow.id]), dbKey);
	if (!meta) throw new ChannelContentNotReadyError();
	const keyRowRaw = await db.table("channelKeys").get([ownerPubkey, channelRow.id, meta.currentVersion]);
	if (!keyRowRaw) throw new ChannelContentNotReadyError();
	const keyRow = fromEncryptedRow(keyRowRaw, dbKey);

	const plaintext = decryptChannelContent(event.content, { [meta.currentVersion]: keyRow.channelKey });
	if (plaintext === null) throw new ChannelContentNotReadyError();
	const parsed = JSON.parse(plaintext);

	const dTag = event.tags.find((t) => t[0] === "d");
	if (!dTag) return false;
	const postId = dTag[1].slice(dTag[1].indexOf(":") + 1); // "{channelId}:{postId}" -> postId

	// createdAt сохраняется от ПЕРВОГО приёма — republish (archive/unpublish) не должен
	// прыгать местом в хронологии ленты.
	const existing = await db.table("posts").get([ownerPubkey, postId]);
	const createdAt = existing ? existing.createdAt : event.created_at;

	// Этап 74 — Часть C, C-2 (CONTRACTS.md/DESIGN.md "Этап 74"): archivePost/
	// unpublishPost/edit republish-ят ТОТ ЖЕ d-tag — старая версия (например,
	// "published"), доставленная ПОСЛЕ архивации, не должна откатывать status/
	// text. lastEventCreatedAt — версия ПОСЛЕДНЕЙ применённой ревизии, отдельно
	// от createdAt (хронологическая позиция, не трогается republish'ем).
	if (existing && !isNewerVersion({ createdAt: event.created_at, id: event.id }, { createdAt: existing.lastEventCreatedAt, id: existing.lastEventId })) {
		return false;
	}

	await db.table("posts").put(
		toEncryptedRow(
			{
				ownerPubkey,
				id: postId,
				channelId: channelRow.id,
				authorPubkey: event.pubkey,
				text: parsed.text,
				attachments: parsed.attachments,
				status: parsed.status,
				keyVersion: meta.currentVersion,
				createdAt,
				lastEventCreatedAt: event.created_at,
				lastEventId: event.id,
				deleted: false,
			},
			POSTS_PLAINTEXT_FIELDS,
			dbKey,
		),
	);
	return true;
}

export async function listChannelPosts(ownerPubkey, dbKey, channelId) {
	const raw = await db.table("posts").where("ownerPubkey").equals(ownerPubkey).toArray();
	return raw.filter((r) => r.channelId === channelId && !r.deleted).map((r) => fromEncryptedRow(r, dbKey));
}
