import { db } from "../store/database.js";
import { getIgnoredSet } from "../../domain/content/moderation.js";
import { fromEncryptedRow } from "../store/encrypted-table.js";

// F-CSC-01 — windowed-загрузка ленты канала, прямой аналог loadChatWindow (этап 25),
// только курсор по createdAt (не seq — посты/комментарии не имеют auto-increment
// поля, один автор на пост даёт простую хронологию без Lamport). Черновики ЧУЖИЕ не
// видны вовсе (upsert их не создаёт), СВОИ — listChannelPosts с фильтром status,
// не через это окно (CONTRACTS.md, этап 31).
export async function loadPostsWindow(ownerPubkey, dbKey, channelId, { limit = 10, beforeCreatedAt } = {}) {
	const raw = await db.table("posts").where("ownerPubkey").equals(ownerPubkey).toArray();
	let rows = raw.filter((r) => r.channelId === channelId && !r.deleted && r.status !== "draft").map((r) => fromEncryptedRow(r, dbKey));
	rows.sort((a, b) => a.createdAt - b.createdAt);

	let source = rows;
	if (beforeCreatedAt !== undefined) {
		source = source.filter((r) => r.createdAt < beforeCreatedAt);
	}

	const windowPosts = source.slice(-limit);
	const hasMore = source.length > limit;
	return { posts: windowPosts, hasMore };
}

// Пользовательское ТЗ — до 50 комментариев за раз. Этап 33: исключает контент забаненных
// (deleted:true, поставлено receiveBanAnnouncement) И игнорируемых ЭТИМ смотрящим
// (channelId берётся из самих строк — все комментарии одного поста принадлежат одному
// каналу, отдельного параметра не требуется).
export async function loadCommentsWindow(ownerPubkey, dbKey, postId, { limit = 50, beforeCreatedAt } = {}) {
	const raw = await db.table("comments").where("ownerPubkey").equals(ownerPubkey).toArray();
	let rows = raw.filter((r) => r.postId === postId && !r.deleted).map((r) => fromEncryptedRow(r, dbKey));
	if (rows.length > 0) {
		const ignored = await getIgnoredSet(ownerPubkey, rows[0].channelId);
		if (ignored.size > 0) rows = rows.filter((r) => !ignored.has(r.authorPubkey));
	}
	rows.sort((a, b) => a.createdAt - b.createdAt);

	let source = rows;
	if (beforeCreatedAt !== undefined) {
		source = source.filter((r) => r.createdAt < beforeCreatedAt);
	}

	const windowComments = source.slice(-limit);
	const hasMore = source.length > limit;
	return { comments: windowComments, hasMore };
}

// Общий чат канала (этап 32) — тот же паттерн, лимит 15 (пользовательское ТЗ). Этап 33:
// та же фильтрация deleted+ignored, что комментарии.
export async function loadChannelChatWindow(ownerPubkey, dbKey, channelId, { limit = 15, beforeCreatedAt } = {}) {
	let rows = await db.table("channelMessages").where("ownerPubkey").equals(ownerPubkey).toArray();
	rows = rows.filter((r) => r.channelId === channelId && !r.deleted);
	const ignored = await getIgnoredSet(ownerPubkey, channelId);
	if (ignored.size > 0) rows = rows.filter((r) => !ignored.has(r.authorPubkey));
	rows.sort((a, b) => a.createdAt - b.createdAt);

	let source = rows;
	if (beforeCreatedAt !== undefined) {
		source = source.filter((r) => r.createdAt < beforeCreatedAt);
	}

	const windowMessages = source.slice(-limit).map((r) => fromEncryptedRow(r, dbKey));
	const hasMore = source.length > limit;
	return { messages: windowMessages, hasMore };
}
