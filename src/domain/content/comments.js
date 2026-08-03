import { db } from "../../core/store/database.js";
import { sign } from "../../core/crypto/sign.js";
import { encryptChannelContent, decryptChannelContent } from "../../core/crypto/channel-key.js";
import { canAuthorComment } from "../../core/crypto/comment-allowlist.js";
import { toEncryptedRow, fromEncryptedRow } from "../../core/store/encrypted-table.js";
import { COMMENTS_PLAINTEXT_FIELDS } from "../../core/store/table-fields.js";
import { DomainError } from "../errors.js";

async function requirePublishOk(publish, event) {
	const result = await publish(event);
	if (!result.ok) {
		if (result.reason) throw new Error(result.reason);
		throw new DomainError("relay отклонил публикацию", "errors.relayRejected");
	}
}

// parentId — postId (комментарий верхнего уровня) ИЛИ commentId другого комментария
// (ответ). Права на COMMENT НЕ проверяются здесь заранее (UI может подсказать, но
// источник истины — allowlist на приёмной стороне, см. receiveComment/F-EV-06):
// у автора либо получится (он в allowlist у получателей), либо его комментарий
// молча отбросят все честные клиенты — тот же принцип, что posts/deletions.
export async function addComment(ownerPubkey, ownerPrivKey, dbKey, channelId, postId, parentId, text, attachments, publish) {
	const channelRow = await db.table("channels").get([ownerPubkey, channelId]);
	if (!channelRow) throw new DomainError("канал не найден", "errors.channelNotFound");
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
// сканов таблицы). Здесь — ОДИН скан на весь список постов канала разом.
//
// Найден и исправлен ВТОРОЙ баг (пользователь, живая проверка после этапа 50):
// счётчик считал ТОЛЬКО верхнеуровневые комментарии (parentId === postId),
// вложенные ответы не учитывались вовсе — "Комментарии (N)" занижал число.
// postId у ЛЮБОГО комментария (и верхнеуровневого, и вложенного ответа —
// addComment принимает postId явным аргументом независимо от глубины, см. выше)
// указывает на пост целиком, а не на непосредственного родителя — parentId
// нужен ТОЛЬКО buildTree для построения дерева, не для подсчёта общего числа.
// Этап 56 (найдено живой проверкой, реальный аккаунт в Safari) — "осиротевший"
// ответ (parentId указывает на комментарий, отсутствующий локально — не получен,
// либо отброшен receiveComment'ом крипто-барьером на устаревшей версии ключа,
// F-EV-06, штатное поведение безопасности, не баг) никогда не попадает в
// buildTree — не рендерится НИГДЕ. Комментарий "достижим", если цепочка parentId
// (через ДРУГИЕ неудалённые комментарии — postId один и тот же на всех уровнях
// вложенности по построению addComment, глубина не важна) упирается ровно в
// postId (дошли до настоящего верхнеуровневого комментария). Guard от цикла —
// предел шагов nonDeletedComments.length + 1.
export function computeReachableCommentIds(nonDeletedComments) {
	const byId = new Map(nonDeletedComments.map((c) => [c.id, c]));
	const reachable = new Set();
	for (const comment of nonDeletedComments) {
		let cur = comment;
		let steps = 0;
		while (steps++ < nonDeletedComments.length + 1) {
			if (cur.parentId === cur.postId) {
				reachable.add(comment.id);
				break;
			}
			const parent = byId.get(cur.parentId);
			if (!parent) break;
			cur = parent;
		}
	}
	return reachable;
}

export async function countCommentsByPost(ownerPubkey, postIds) {
	const rows = await db.table("comments").where("ownerPubkey").equals(ownerPubkey).toArray();
	const nonDeleted = rows.filter((r) => !r.deleted);
	const reachable = computeReachableCommentIds(nonDeleted);
	const counts = new Map(postIds.map((id) => [id, 0]));
	for (const r of nonDeleted) {
		if (reachable.has(r.id) && counts.has(r.postId)) {
			counts.set(r.postId, counts.get(r.postId) + 1);
		}
	}
	return counts;
}
