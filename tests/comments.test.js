import "fake-indexeddb/auto";
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { db } from "../src/core/store/database.js";
import { getPublicKey } from "../src/core/crypto/keys.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { createChannel, receiveChannelKeyGrant } from "../src/domain/content/channel.js";
import { sendViewGrant, handleIncomingSubscribeRequest } from "../src/domain/content/channel-access.js";
import { decryptChannelKeyGrant } from "../src/core/crypto/channel-key.js";
import { addComment, receiveComment, getCommentsTree, countCommentsByPost, computeReachableCommentIds } from "../src/domain/content/comments.js";
import { toEncryptedRow, fromEncryptedRow } from "../src/core/store/encrypted-table.js";
import { COMMENTS_PLAINTEXT_FIELDS } from "../src/core/store/table-fields.js";

const ALICE_PRIV = new Uint8Array(32).fill(1);
const BOB_PRIV = new Uint8Array(32).fill(2);
const MALLORY_PRIV = new Uint8Array(32).fill(3);
const ALICE_PUB = bytesToHex(getPublicKey(ALICE_PRIV));
const BOB_PUB = bytesToHex(getPublicKey(BOB_PRIV));
const MALLORY_PUB = bytesToHex(getPublicKey(MALLORY_PRIV));
const DB_KEY = crypto.getRandomValues(new Uint8Array(32));

before(async () => {
	await db.open();
});

beforeEach(async () => {
	await db.table("channels").clear();
	await db.table("channelKeys").clear();
	await db.table("channelKeyMeta").clear();
	await db.table("commentAllowlists").clear();
	await db.table("groups").clear();
	await db.table("groupMembers").clear();
	await db.table("comments").clear();
});

after(() => {
	db.close();
});

function capturingPublish(bucket) {
	return async (event) => {
		bucket.push(event);
		return { ok: true };
	};
}

async function setupChannelWithBobSubscribed() {
	await db.table("groups").add({ owner: ALICE_PUB, id: "friends", name: "Друзья" });
	await db.table("groupMembers").add({ groupId: "friends", pubkey: BOB_PUB });
	const published = [];
	const { channelId } = await createChannel(ALICE_PUB, ALICE_PRIV, DB_KEY, { name: "К", description: "d", rules: "" }, ["friends"], capturingPublish(published));
	const grantEvent = published.find((e) => e.kind === 30053);
	await receiveChannelKeyGrant(BOB_PUB, BOB_PRIV, DB_KEY, ALICE_PUB, grantEvent);

	// Боб подписывается (получает COMMENT) — напрямую через владельца, минуя транспорт
	// gift-wrap (уже покрыто тестами этапа 30), здесь важен только итоговый allowlist.
	await handleIncomingSubscribeRequest(ALICE_PUB, ALICE_PRIV, DB_KEY, channelId, BOB_PUB, capturingPublish([]));
	return { channelId };
}

async function grantViewTo(channelId, targetPubkey) {
	const aliceKeyRow = fromEncryptedRow(await db.table("channelKeys").get([ALICE_PUB, channelId, 1]), DB_KEY);
	const aliceChannelRow = await db.table("channels").get([ALICE_PUB, channelId]);
	const grantPublish = [];
	await sendViewGrant(
		ALICE_PUB,
		ALICE_PRIV,
		{ channelId, channelTopic: aliceChannelRow.channelTopic, channelKey: aliceKeyRow.channelKey },
		targetPubkey,
		1,
		capturingPublish(grantPublish),
	);
	return grantPublish[0];
}

// AC-16 (найдено пользователем прямым осмотром IndexedDB) — пользователь буквально
// увидел комментарий "Куси" открытым текстом в этой таблице.
test("AC-16: comments хранится зашифрованным — сырой дамп не содержит text/authorPubkey", async () => {
	const { channelId } = await setupChannelWithBobSubscribed();
	const postId = "post-1";
	const { commentId } = await addComment(BOB_PUB, BOB_PRIV, DB_KEY, channelId, postId, postId, "секретный комментарий", [], capturingPublish([]));
	const raw = await db.table("comments").get([BOB_PUB, commentId]);
	assert.equal(raw.id, commentId);
	assert.equal("text" in raw, false);
	assert.equal("authorPubkey" in raw, false);
	assert.ok(raw.nonce instanceof Uint8Array);
	assert.ok(raw.ciphertext instanceof Uint8Array);

	const decrypted = fromEncryptedRow(raw, DB_KEY);
	assert.equal(decrypted.text, "секретный комментарий");
});

test("addComment/receiveComment: Боб (подписчик с COMMENT) комментирует пост, Алиса получает и верифицирует", async () => {
	const { channelId } = await setupChannelWithBobSubscribed();
	const postId = "post-1";
	const published = [];
	const { commentId } = await addComment(BOB_PUB, BOB_PRIV, DB_KEY, channelId, postId, postId, "отличная статья!", [], capturingPublish(published));

	const event = published.find((e) => e.kind === 30062);
	assert.ok(event);
	assert.deepEqual(event.tags.find((t) => t[0] === "d"), ["d", `${postId}:${commentId}`]);

	const applied = await receiveComment(ALICE_PUB, DB_KEY, event);
	assert.equal(applied, true);
	const tree = await getCommentsTree(ALICE_PUB, DB_KEY, postId);
	assert.equal(tree.length, 1);
	assert.equal(tree[0].text, "отличная статья!");
});

test("АДВЕРСАРНЫЙ (F-EV-06/AC-08b): VIEW-держатель БЕЗ COMMENT публикует комментарий — отклонён", async () => {
	const { channelId } = await setupChannelWithBobSubscribed();
	// Mallory получает VIEW, но НЕ подписывается (не в commentAllowlists)
	const grantEvent = await grantViewTo(channelId, MALLORY_PUB);
	await receiveChannelKeyGrant(MALLORY_PUB, MALLORY_PRIV, DB_KEY, ALICE_PUB, grantEvent);

	const postId = "post-1";
	const published = [];
	await addComment(MALLORY_PUB, MALLORY_PRIV, DB_KEY, channelId, postId, postId, "спам без права", [], capturingPublish(published));
	const event = published.find((e) => e.kind === 30062);

	const applied = await receiveComment(ALICE_PUB, DB_KEY, event);
	assert.equal(applied, false, "комментарий без COMMENT-права обязан быть отклонён (AC-08b)");
	assert.equal((await getCommentsTree(ALICE_PUB, DB_KEY, postId)).length, 0);
});

test("Владелец канала может комментировать СВОЙ канал, даже не будучи в commentAllowlists (он туда никогда не подписывается на себя)", async () => {
	const { channelId } = await setupChannelWithBobSubscribed();
	const postId = "post-1";
	const published = [];
	await addComment(ALICE_PUB, ALICE_PRIV, DB_KEY, channelId, postId, postId, "комментарий от владельца", [], capturingPublish(published));
	const event = published.find((e) => e.kind === 30062);

	// Боб (подписчик) получает комментарий ВЛАДЕЛЬЦА — обязан принять его без исключений.
	const applied = await receiveComment(BOB_PUB, DB_KEY, event);
	assert.equal(applied, true, "владелец канала имплицитно всегда имеет право комментировать");
});

test("getCommentsTree: строит вложенность по parentId (ответ на комментарий)", async () => {
	const { channelId } = await setupChannelWithBobSubscribed();
	const postId = "post-1";
	const { commentId: rootId } = await addComment(BOB_PUB, BOB_PRIV, DB_KEY, channelId, postId, postId, "корневой комментарий", [], capturingPublish([]));
	const replyPublished = [];
	const { commentId: replyId } = await addComment(ALICE_PUB, ALICE_PRIV, DB_KEY, channelId, postId, rootId, "ответ владельца", [], capturingPublish(replyPublished));

	// Алиса и так знает свой комментарий локально (оптимистично), Боб должен получить его через receiveComment
	const replyEvent = replyPublished.find((e) => e.kind === 30062);
	await receiveComment(BOB_PUB, DB_KEY, replyEvent);

	const tree = await getCommentsTree(BOB_PUB, DB_KEY, postId);
	assert.equal(tree.length, 1);
	assert.equal(tree[0].id, rootId);
	assert.equal(tree[0].replies.length, 1);
	assert.equal(tree[0].replies[0].id, replyId);
	assert.equal(tree[0].replies[0].text, "ответ владельца");
});

// Найденный пользователем баг (живая проверка после этапа 50): счётчик считал
// только верхнеуровневые комментарии, ответы на комментарии не учитывались.
test("countCommentsByPost: считает ВСЕ комментарии поста, включая вложенные ответы, один скан на несколько постов сразу", async () => {
	const { channelId } = await setupChannelWithBobSubscribed();
	const postA = "post-a";
	const postB = "post-b";
	await addComment(BOB_PUB, BOB_PRIV, DB_KEY, channelId, postA, postA, "корневой A1", [], capturingPublish([]));
	const { commentId: rootA2 } = await addComment(BOB_PUB, BOB_PRIV, DB_KEY, channelId, postA, postA, "корневой A2", [], capturingPublish([]));
	await addComment(BOB_PUB, BOB_PRIV, DB_KEY, channelId, postA, rootA2, "ответ на A2 (ОБЯЗАН считаться)", [], capturingPublish([]));
	await addComment(BOB_PUB, BOB_PRIV, DB_KEY, channelId, postB, postB, "корневой B1", [], capturingPublish([]));

	const counts = await countCommentsByPost(BOB_PUB, [postA, postB, "post-без-комментариев"]);
	assert.equal(counts.get(postA), 3, "2 верхнеуровневых + 1 ответ у post-a");
	assert.equal(counts.get(postB), 1);
	assert.equal(counts.get("post-без-комментариев"), 0);
});

// Этап 56 (найдено живой проверкой, реальный аккаунт в Safari) — "осиротевший"
// ответ, чей родитель отсутствует локально (не получен, либо отброшен крипто-
// барьером receiveComment на устаревшей версии ключа — F-EV-06, штатное поведение
// безопасности), никогда не попадает в buildTree (не рендерится НИГДЕ), но старый
// countCommentsByPost считал его наравне с обычными — счётчик "Комментарии (N)"
// навсегда показывал бы лишнюю единицу, которую невозможно "прочитать".
test("countCommentsByPost: НЕ считает 'осиротевший' ответ (родитель отсутствует локально)", async () => {
	const { channelId } = await setupChannelWithBobSubscribed();
	const postId = "post-1";
	await addComment(BOB_PUB, BOB_PRIV, DB_KEY, channelId, postId, postId, "обычный верхнеуровневый", [], capturingPublish([]));
	await db.table("comments").add(
		toEncryptedRow(
			{ ownerPubkey: BOB_PUB, id: "orphan-reply", postId, parentId: "missing-parent-never-received", deleted: false, authorPubkey: ALICE_PUB, text: "осиротевший ответ" },
			COMMENTS_PLAINTEXT_FIELDS,
			DB_KEY,
		),
	);
	const counts = await countCommentsByPost(BOB_PUB, [postId]);
	assert.equal(counts.get(postId), 1, "осиротевший ответ не считается — он никогда не отобразится в дереве, буквально недостижим");
	const tree = await getCommentsTree(BOB_PUB, DB_KEY, postId);
	assert.equal(tree.length, 1, "дерево тоже не содержит осиротевший ответ — счётчик теперь согласован с деревом");
});

test("computeReachableCommentIds: цепочка ответов любой глубины с известными родителями — все достижимы", () => {
	const comments = [
		{ id: "root", postId: "p1", parentId: "p1" },
		{ id: "reply1", postId: "p1", parentId: "root" },
		{ id: "reply2", postId: "p1", parentId: "reply1" },
	];
	const reachable = computeReachableCommentIds(comments);
	assert.deepEqual([...reachable].sort(), ["reply1", "reply2", "root"].sort());
});

test("computeReachableCommentIds: обрыв цепочки (родитель отсутствует) -> недостижим ТОЛЬКО для этой ветки, соседние не затронуты", () => {
	const comments = [
		{ id: "root", postId: "p1", parentId: "p1" },
		{ id: "orphan", postId: "p1", parentId: "missing" },
		{ id: "reply-to-orphan", postId: "p1", parentId: "orphan" },
	];
	const reachable = computeReachableCommentIds(comments);
	assert.deepEqual([...reachable], ["root"], "orphan и всё, что от него зависит, недостижимо; root — не затронут");
});
