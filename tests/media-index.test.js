import "fake-indexeddb/auto";
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { db } from "../src/core/store/database.js";
import { toEncryptedRow } from "../src/core/store/encrypted-table.js";
import { POSTS_PLAINTEXT_FIELDS, COMMENTS_PLAINTEXT_FIELDS } from "../src/core/store/table-fields.js";
import { mediaClassesByPost } from "../src/domain/content/media-index.js";

const OWNER = "owner-pubkey";
const DB_KEY = crypto.getRandomValues(new Uint8Array(32));

before(async () => {
	await db.open();
});

beforeEach(async () => {
	await db.table("posts").clear();
	await db.table("comments").clear();
});

after(() => {
	db.close();
});

function putPost({ id, channelId = "chan-1", status = "published", deleted = false, attachments = [] }) {
	return db.table("posts").put(
		toEncryptedRow(
			{ ownerPubkey: OWNER, id, channelId, createdAt: 1, deleted, status, keyVersion: 1, lastEventCreatedAt: 1, lastEventId: "e", text: "", attachments },
			POSTS_PLAINTEXT_FIELDS,
			DB_KEY,
		),
	);
}

function putComment({ id, postId, parentId, deleted = false, attachments = [] }) {
	return db.table("comments").put(
		toEncryptedRow(
			{ ownerPubkey: OWNER, id, postId, parentId, deleted, channelId: "chan-1", authorPubkey: "a", text: "", attachments, keyVersion: 1, createdAt: 1 },
			COMMENTS_PLAINTEXT_FIELDS,
			DB_KEY,
		),
	);
}

function attachment(mime) {
	return { manifestDigest: "d", fileKey: "AA==", mime, size: 1, name: "x" };
}

test("mediaClassesByPost: пост с вложениями всех трёх классов даёт верный Int32Array", async () => {
	await putPost({ id: "p1", attachments: [attachment("audio/mpeg"), attachment("video/mp4"), attachment("image/png")] });
	const acc = await mediaClassesByPost(OWNER, DB_KEY);
	assert.deepEqual([...acc.get("p1")], [1, 1, 1, 0]);
});

test("mediaClassesByPost: пост без вложений — Int32Array из нулей, не отсутствие ключа", async () => {
	await putPost({ id: "p1", attachments: [] });
	const acc = await mediaClassesByPost(OWNER, DB_KEY);
	assert.deepEqual([...acc.get("p1")], [0, 0, 0, 0]);
});

test("mediaClassesByPost: черновик (status=draft) исключён из acc целиком", async () => {
	await putPost({ id: "p1", status: "draft", attachments: [attachment("audio/mpeg")] });
	const acc = await mediaClassesByPost(OWNER, DB_KEY);
	assert.equal(acc.has("p1"), false);
});

test("mediaClassesByPost: удалённый пост исключён из acc целиком", async () => {
	await putPost({ id: "p1", deleted: true, attachments: [attachment("audio/mpeg")] });
	const acc = await mediaClassesByPost(OWNER, DB_KEY);
	assert.equal(acc.has("p1"), false);
});

test("mediaClassesByPost: вложения комментариев верхнего уровня учитываются в счётчике своего поста", async () => {
	await putPost({ id: "p1", attachments: [] });
	await putComment({ id: "c1", postId: "p1", parentId: "p1", attachments: [attachment("image/jpeg")] });
	const acc = await mediaClassesByPost(OWNER, DB_KEY);
	assert.deepEqual([...acc.get("p1")], [0, 0, 1, 0]);
});

test("mediaClassesByPost: вложения ВЛОЖЕННОГО ответа (глубина 2) тоже учитываются", async () => {
	await putPost({ id: "p1", attachments: [] });
	await putComment({ id: "c1", postId: "p1", parentId: "p1", attachments: [] });
	await putComment({ id: "c2", postId: "p1", parentId: "c1", attachments: [attachment("video/webm")] });
	const acc = await mediaClassesByPost(OWNER, DB_KEY);
	assert.deepEqual([...acc.get("p1")], [0, 1, 0, 0]);
});

test("mediaClassesByPost: удалённый комментарий не учитывается", async () => {
	await putPost({ id: "p1", attachments: [] });
	await putComment({ id: "c1", postId: "p1", parentId: "p1", deleted: true, attachments: [attachment("audio/mpeg")] });
	const acc = await mediaClassesByPost(OWNER, DB_KEY);
	assert.deepEqual([...acc.get("p1")], [0, 0, 0, 0]);
});

// computeReachableCommentIds: цепочка parentId обязана дойти до postId через
// ДРУГИЕ неудалённые комментарии — "осиротевший" ответ (родитель удалён) не
// достижим и не должен считаться, даже если сам не помечен deleted.
test("mediaClassesByPost: вложения осиротевшего (недостижимого) комментария не считаются", async () => {
	await putPost({ id: "p1", attachments: [] });
	await putComment({ id: "c1", postId: "p1", parentId: "p1", deleted: true, attachments: [] }); // родитель удалён
	await putComment({ id: "c2", postId: "p1", parentId: "c1", attachments: [attachment("image/png")] }); // осиротел
	const acc = await mediaClassesByPost(OWNER, DB_KEY);
	assert.deepEqual([...acc.get("p1")], [0, 0, 0, 0]);
});

test("mediaClassesByPost: комментарий поста ЧУЖОГО скана (пост не в acc — черновик) не роняет функцию, тихо пропускается", async () => {
	await putPost({ id: "p-draft", status: "draft", attachments: [] });
	await putComment({ id: "c1", postId: "p-draft", parentId: "p-draft", attachments: [attachment("audio/mpeg")] });
	const acc = await mediaClassesByPost(OWNER, DB_KEY);
	assert.equal(acc.has("p-draft"), false);
});

test("mediaClassesByPost: неизвестный (не audio/video/image) mime считается в индекс 3 ('other')", async () => {
	await putPost({ id: "p1", attachments: [attachment("application/pdf")] });
	const acc = await mediaClassesByPost(OWNER, DB_KEY);
	assert.deepEqual([...acc.get("p1")], [0, 0, 0, 1]);
});

test("mediaClassesByPost: несколько постов — независимые счётчики, один общий скан", async () => {
	await putPost({ id: "p1", attachments: [attachment("audio/mpeg")] });
	await putPost({ id: "p2", attachments: [attachment("video/mp4")] });
	const acc = await mediaClassesByPost(OWNER, DB_KEY);
	assert.deepEqual([...acc.get("p1")], [1, 0, 0, 0]);
	assert.deepEqual([...acc.get("p2")], [0, 1, 0, 0]);
});

// Θ(k+m), не Θ(k·m) — DESIGN.md "Этап E, E2". node --test не мерит время
// надёжно на CI-масштабе, поэтому приёмка — число расшифровок (fromEncryptedRow
// вызывается ровно раз на строку, не раз на пару пост×комментарий).
test("mediaClassesByPost: один скан — расшифровка каждой строки поста/комментария происходит РОВНО один раз (не k проходов по m)", async () => {
	for (let i = 0; i < 5; i++) await putPost({ id: `p${i}`, attachments: [] });
	for (let i = 0; i < 5; i++) await putComment({ id: `c${i}`, postId: "p0", parentId: "p0", attachments: [attachment("audio/mpeg")] });

	// Не подменяем сам модуль (ESM — нельзя мокать импорт без loader'а) —
	// вместо этого проверяем итог: 5 постов + 5 комментариев одного поста,
	// каждое из 5 вложений комментария учтено РОВНО один раз (наивный
	// Θ(k·m) для k=5 постов дал бы 5-кратное завышение счётчика — 25
	// вместо 5 — если бы комментарии сканировались отдельно на каждый пост).
	const rows = await db.table("comments").toArray();
	assert.equal(rows.length, 5);
	const acc = await mediaClassesByPost(OWNER, DB_KEY);
	assert.equal(acc.size, 5, "все 5 постов в acc");
	assert.deepEqual([...acc.get("p0")], [5, 0, 0, 0], "все 5 вложений комментариев учтены у p0");
});
