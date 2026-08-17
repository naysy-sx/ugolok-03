import { db } from "../../core/store/database.js";
import { fromEncryptedRow } from "../../core/store/encrypted-table.js";
import { computeReachableCommentIds } from "./comments.js";
import { classOf, CLASS_INDEX } from "../media/media-ref.js";

// Один скан db.posts + один скан db.comments владельца — Θ(k+m), НЕ Θ(k·m)
// (MEDIA-ALGO.md §2.2 Q1, прямой аналог countCommentsByPost). Область — ВСЕ
// каналы владельца разом (сигнатура без channelId — MEDIA-SPEC.md §3.10
// буквально), DESIGN.md "Этап E, E2".
export async function mediaClassesByPost(ownerPubkey, dbKey) {
	const postRows = await db.table("posts").where("ownerPubkey").equals(ownerPubkey).toArray();
	const acc = new Map();
	for (const row of postRows) {
		if (row.deleted || row.status === "draft") continue;
		const post = fromEncryptedRow(row, dbKey);
		const counts = new Int32Array(4);
		for (const a of post.attachments ?? []) counts[CLASS_INDEX[classOf(a.mime)]] += 1;
		acc.set(row.id, counts);
	}

	const commentRows = await db.table("comments").where("ownerPubkey").equals(ownerPubkey).toArray();
	const nonDeleted = commentRows.filter((r) => !r.deleted);
	const reachable = computeReachableCommentIds(nonDeleted);
	for (const row of nonDeleted) {
		if (!reachable.has(row.id)) continue;
		if (!acc.has(row.postId)) continue; // пост уже отфильтрован выше (draft/deleted/чужой скан) — не тратим расшифровку
		const comment = fromEncryptedRow(row, dbKey);
		const counts = acc.get(row.postId);
		for (const a of comment.attachments ?? []) counts[CLASS_INDEX[classOf(a.mime)]] += 1;
	}
	return acc;
}
