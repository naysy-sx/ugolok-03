import { db } from "../../core/store/database.js";
import { sign } from "../../core/crypto/sign.js";
import { encryptChannelContent, decryptChannelContent } from "../../core/crypto/channel-key.js";
import { canAuthorComment } from "../../core/crypto/comment-allowlist.js";
import { toEncryptedRow, fromEncryptedRow } from "../../core/store/encrypted-table.js";
import { COMMENTS_PLAINTEXT_FIELDS } from "../../core/store/table-fields.js";

async function requirePublishOk(publish, event) {
	const result = await publish(event);
	if (!result.ok) {
		throw new Error(result.reason || "relay отклонил публикацию");
	}
}

// parentId — postId (комментарий верхнего уровня) ИЛИ commentId другого комментария
// (ответ). Права на COMMENT НЕ проверяются здесь заранее (UI может подсказать, но
// источник истины — allowlist на приёмной стороне, см. receiveComment/F-EV-06):
// у автора либо получится (он в allowlist у получателей), либо его комментарий
// молча отбросят все честные клиенты — тот же принцип, что posts/deletions.
export async function addComment(ownerPubkey, ownerPrivKey, dbKey, channelId, postId, parentId, text, attachments, publish) {
	const channelRow = await db.table("channels").get([ownerPubkey, channelId]);
	if (!channelRow) throw new Error("канал не найден");
	const meta = fromEncryptedRow(await db.table("channelKeyMeta").get([ownerPubkey, channelId]), dbKey);
	const keyRow = fromEncryptedRow(await db.table("channelKeys").get([ownerPubkey, channelId, meta.currentVersion]), dbKey);

	const commentId = crypto.randomUUID();
	const content = encryptChannelContent(JSON.stringify({ postId, parentId, text, attachments }), keyRow.channelKey, meta.currentVersion);
	const event = sign(
		{
			kind: 30062,
			content,
			tags: [
				["d", `${postId}:${commentId}`],
				["h", channelRow.channelTopic],
			],
			created_at: Math.floor(Date.now() / 1000),
		},
		ownerPrivKey,
	);
	await requirePublishOk(publish, event);

	await db.table("comments").put(
		toEncryptedRow(
			{
				ownerPubkey,
				id: commentId,
				postId,
				parentId,
				channelId,
				authorPubkey: ownerPubkey,
				text,
				attachments,
				keyVersion: meta.currentVersion,
				createdAt: event.created_at,
				deleted: false,
			},
			COMMENTS_PLAINTEXT_FIELDS,
			dbKey,
		),
	);
	return { commentId };
}

// DESIGN.md, "Этап 31", формализация 3 (F-EV-06) — верификация через ЛОКАЛЬНО
// закэшированный allowlist (уже верифицирован при получении kind 30054, этап 30 —
// не парсится заново здесь). Владелец канала имплицитно ВСЕГДА может комментировать
// (найдено рассуждением: он никогда не проходит через handleIncomingSubscribeRequest
// сам на себя, поэтому его pubkey не попадает в allowlist естественным путём — без
// этого исключения его СОБСТВЕННЫЕ комментарии отбрасывались бы другими подписчиками).
export async function receiveComment(ownerPubkey, dbKey, event) {
	const hTag = event.tags.find((t) => t[0] === "h");
	if (!hTag) return false;
	const channelRow = await db
		.table("channels")
		.where("channelTopic")
		.equals(hTag[1])
		.and((r) => r.ownerPubkey === ownerPubkey)
		.first();
	if (!channelRow) return false;

	const meta = fromEncryptedRow(await db.table("channelKeyMeta").get([ownerPubkey, channelRow.id]), dbKey);
	if (!meta) return false;
	const keyRowRaw = await db.table("channelKeys").get([ownerPubkey, channelRow.id, meta.currentVersion]);
	if (!keyRowRaw) return false;
	const keyRow = fromEncryptedRow(keyRowRaw, dbKey);

	const plaintext = decryptChannelContent(event.content, { [meta.currentVersion]: keyRow.channelKey });
	if (plaintext === null) return false;

	if (event.pubkey !== channelRow.creatorPubkey) {
		const allowlistRow = fromEncryptedRow(await db.table("commentAllowlists").get([ownerPubkey, channelRow.id, meta.currentVersion]), dbKey);
		const verifiedAllowlist = allowlistRow ? { allowedAuthors: allowlistRow.allowedAuthors } : null;
		if (!canAuthorComment(event.pubkey, verifiedAllowlist)) return false;
	}

	const parsed = JSON.parse(plaintext);
	const dTag = event.tags.find((t) => t[0] === "d");
	if (!dTag) return false;
	const commentId = dTag[1].slice(dTag[1].indexOf(":") + 1);

	await db.table("comments").put(
		toEncryptedRow(
			{
				ownerPubkey,
				id: commentId,
				postId: parsed.postId,
				parentId: parsed.parentId,
				channelId: channelRow.id,
				authorPubkey: event.pubkey,
				text: parsed.text,
				attachments: parsed.attachments,
				keyVersion: meta.currentVersion,
				createdAt: event.created_at,
				deleted: false,
			},
			COMMENTS_PLAINTEXT_FIELDS,
			dbKey,
		),
	);
	return true;
}

function buildTree(comments, parentId) {
	return comments
		.filter((c) => c.parentId === parentId)
		.sort((a, b) => a.createdAt - b.createdAt)
		.map((c) => ({ ...c, replies: buildTree(comments, c.id) }));
}

export async function getCommentsTree(ownerPubkey, dbKey, postId) {
	const raw = await db.table("comments").where("ownerPubkey").equals(ownerPubkey).toArray();
	const forPost = raw.filter((r) => r.postId === postId && !r.deleted).map((r) => fromEncryptedRow(r, dbKey));
	return buildTree(forPost, postId);
}

// Найдено пользователем: счётчик "Комментарии (N)" на карточке поста показывал 0 до
// первого клика — раньше он брался из локального tree.length ВНУТРИ PostWithComments,
// который заполнялся только после раскрытия (getCommentsTree дорогой на одиночный
// пост, но неприемлемо гонять его на КАЖДЫЙ пост списка через N отдельных полных
// сканов таблицы). Здесь — ОДИН скан на весь список постов канала разом. Считает
// только верхнеуровневые комментарии (parentId === postId), тот же критерий, что
// buildTree(..., postId)'s корень — чтобы бейдж совпадал с tree.length после клика.
export async function countTopLevelCommentsByPost(ownerPubkey, postIds) {
	const rows = await db.table("comments").where("ownerPubkey").equals(ownerPubkey).toArray();
	const counts = new Map(postIds.map((id) => [id, 0]));
	for (const r of rows) {
		if (!r.deleted && r.parentId === r.postId && counts.has(r.postId)) {
			counts.set(r.postId, counts.get(r.postId) + 1);
		}
	}
	return counts;
}
