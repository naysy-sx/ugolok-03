import { db } from "../store/database.js";

// F-CSC-01 — windowed-загрузка ленты канала, прямой аналог loadChatWindow (этап 25),
// только курсор по createdAt (не seq — посты/комментарии не имеют auto-increment
// поля, один автор на пост даёт простую хронологию без Lamport). Черновики ЧУЖИЕ не
// видны вовсе (upsert их не создаёт), СВОИ — listChannelPosts с фильтром status,
// не через это окно (CONTRACTS.md, этап 31).
export async function loadPostsWindow(ownerPubkey, channelId, { limit = 10, beforeCreatedAt } = {}) {
	let rows = await db.table("posts").where("ownerPubkey").equals(ownerPubkey).toArray();
	rows = rows.filter((r) => r.channelId === channelId && !r.deleted && r.status !== "draft");
	rows.sort((a, b) => a.createdAt - b.createdAt);

	let source = rows;
	if (beforeCreatedAt !== undefined) {
		source = source.filter((r) => r.createdAt < beforeCreatedAt);
	}

	const windowPosts = source.slice(-limit);
	const hasMore = source.length > limit;
	return { posts: windowPosts, hasMore };
}

// Пользовательское ТЗ — до 50 комментариев за раз.
export async function loadCommentsWindow(ownerPubkey, postId, { limit = 50, beforeCreatedAt } = {}) {
	let rows = await db.table("comments").where("ownerPubkey").equals(ownerPubkey).toArray();
	rows = rows.filter((r) => r.postId === postId && !r.deleted);
	rows.sort((a, b) => a.createdAt - b.createdAt);

	let source = rows;
	if (beforeCreatedAt !== undefined) {
		source = source.filter((r) => r.createdAt < beforeCreatedAt);
	}

	const windowComments = source.slice(-limit);
	const hasMore = source.length > limit;
	return { comments: windowComments, hasMore };
}
