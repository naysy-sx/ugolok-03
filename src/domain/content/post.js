import { db } from "../../core/store/database.js";
import { sign } from "../../core/crypto/sign.js";
import { encryptChannelContent, decryptChannelContent } from "../../core/crypto/channel-key.js";
import { buildAddressableDeletionEvent } from "../../domain/events/handlers.js";
import { transitionPost } from "./post-machine.js";

async function requirePublishOk(publish, event) {
	const result = await publish(event);
	if (!result.ok) {
		throw new Error(result.reason || "relay отклонил публикацию");
	}
}

// DESIGN.md, "Этап 31", формализация 1 — draft НИКОГДА не публикуется, строго
// локальная запись до первого PUBLISH.
export async function createDraftPost(ownerPubkey, channelId, { text, attachments = [] }) {
	const postId = crypto.randomUUID();
	await db.table("posts").put({
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
	});
	return { postId };
}

// Локальное редактирование — до первой публикации, ИЛИ после UNPUBLISH (снова draft).
export async function updateDraftPost(ownerPubkey, postId, { text, attachments }) {
	const row = await db.table("posts").get([ownerPubkey, postId]);
	if (!row) throw new Error("пост не найден");
	if (row.status !== "draft") {
		throw new Error("редактировать можно только черновик (unpublish уже опубликованный, затем редактировать)");
	}
	await db.table("posts").update([ownerPubkey, postId], { text, attachments });
}

// Общая часть publishPost/archivePost/unpublishPost — DESIGN.md формализация 1:
// статус — ЧАСТЬ синхронизируемого payload'а, republish того же d-tag (kind 30061
// параметризованно-replaceable, NIP-01) заменяет предыдущую версию у всех читателей.
async function republishWithStatus(ownerPubkey, ownerPrivKey, postId, fsmEvent, publish) {
	const row = await db.table("posts").get([ownerPubkey, postId]);
	if (!row) throw new Error("пост не найден");
	const newStatus = transitionPost(row.status, fsmEvent); // бросает на недопустимый переход

	const channelRow = await db.table("channels").get([ownerPubkey, row.channelId]);
	const meta = await db.table("channelKeyMeta").get([ownerPubkey, row.channelId]);
	const keyRow = await db.table("channelKeys").get([ownerPubkey, row.channelId, meta.currentVersion]);

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
	await db.table("posts").update([ownerPubkey, postId], { status: newStatus, keyVersion: meta.currentVersion });
	return { eventId: event.id };
}

export async function publishPost(ownerPubkey, ownerPrivKey, postId, publish) {
	return republishWithStatus(ownerPubkey, ownerPrivKey, postId, "PUBLISH", publish);
}

export async function archivePost(ownerPubkey, ownerPrivKey, postId, publish) {
	return republishWithStatus(ownerPubkey, ownerPrivKey, postId, "ARCHIVE", publish);
}

export async function unpublishPost(ownerPubkey, ownerPrivKey, postId, publish) {
	return republishWithStatus(ownerPubkey, ownerPrivKey, postId, "UNPUBLISH", publish);
}

// F-CH-10 — kind 5 (NIP-09), АДРЕСУЕМОЕ удаление (тег "a": kind:pubkey:d-tag) —
// переживает republish/смену event.id при статусных переходах, в отличие от
// удаления по конкретному "e"-тегу. Черновик (никогда не публиковался) — нечего
// отзывать на relay, только локальная отметка.
export async function deletePost(ownerPubkey, ownerPrivKey, postId, publish) {
	const row = await db.table("posts").get([ownerPubkey, postId]);
	if (!row) throw new Error("пост не найден");
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
export async function receivePost(ownerPubkey, event) {
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

	const meta = await db.table("channelKeyMeta").get([ownerPubkey, channelRow.id]);
	if (!meta) return false;
	const keyRow = await db.table("channelKeys").get([ownerPubkey, channelRow.id, meta.currentVersion]);
	if (!keyRow) return false;

	const plaintext = decryptChannelContent(event.content, { [meta.currentVersion]: keyRow.channelKey });
	if (plaintext === null) return false;
	const parsed = JSON.parse(plaintext);

	const dTag = event.tags.find((t) => t[0] === "d");
	if (!dTag) return false;
	const postId = dTag[1].slice(dTag[1].indexOf(":") + 1); // "{channelId}:{postId}" -> postId

	// createdAt сохраняется от ПЕРВОГО приёма — republish (archive/unpublish) не должен
	// прыгать местом в хронологии ленты.
	const existing = await db.table("posts").get([ownerPubkey, postId]);
	const createdAt = existing ? existing.createdAt : event.created_at;

	await db.table("posts").put({
		ownerPubkey,
		id: postId,
		channelId: channelRow.id,
		authorPubkey: event.pubkey,
		text: parsed.text,
		attachments: parsed.attachments,
		status: parsed.status,
		keyVersion: meta.currentVersion,
		createdAt,
		deleted: false,
	});
	return true;
}

export async function listChannelPosts(ownerPubkey, channelId) {
	const rows = await db.table("posts").where("ownerPubkey").equals(ownerPubkey).toArray();
	return rows.filter((r) => r.channelId === channelId && !r.deleted);
}
