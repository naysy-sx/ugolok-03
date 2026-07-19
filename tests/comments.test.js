import "fake-indexeddb/auto";
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { db } from "../src/core/store/database.js";
import { getPublicKey } from "../src/core/crypto/keys.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { createChannel, receiveChannelKeyGrant } from "../src/domain/content/channel.js";
import { sendViewGrant, handleIncomingSubscribeRequest } from "../src/domain/content/channel-access.js";
import { decryptChannelKeyGrant } from "../src/core/crypto/channel-key.js";
import { addComment, receiveComment, getCommentsTree, countTopLevelCommentsByPost } from "../src/domain/content/comments.js";
import { fromEncryptedRow } from "../src/core/store/encrypted-table.js";

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
	const tree = await getCommentsTree(ALICE_PUB, postId);
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
	assert.equal((await getCommentsTree(ALICE_PUB, postId)).length, 0);
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

	const tree = await getCommentsTree(BOB_PUB, postId);
	assert.equal(tree.length, 1);
	assert.equal(tree[0].id, rootId);
	assert.equal(tree[0].replies.length, 1);
	assert.equal(tree[0].replies[0].id, replyId);
	assert.equal(tree[0].replies[0].text, "ответ владельца");
});

test("countTopLevelCommentsByPost: считает только верхнеуровневые (parentId===postId), совпадает с tree.length, один скан на несколько постов сразу", async () => {
	const { channelId } = await setupChannelWithBobSubscribed();
	const postA = "post-a";
	const postB = "post-b";
	await addComment(BOB_PUB, BOB_PRIV, DB_KEY, channelId, postA, postA, "корневой A1", [], capturingPublish([]));
	const { commentId: rootA2 } = await addComment(BOB_PUB, BOB_PRIV, DB_KEY, channelId, postA, postA, "корневой A2", [], capturingPublish([]));
	await addComment(BOB_PUB, BOB_PRIV, DB_KEY, channelId, postA, rootA2, "ответ на A2 (не должен считаться)", [], capturingPublish([]));
	await addComment(BOB_PUB, BOB_PRIV, DB_KEY, channelId, postB, postB, "корневой B1", [], capturingPublish([]));

	const counts = await countTopLevelCommentsByPost(BOB_PUB, [postA, postB, "post-без-комментариев"]);
	assert.equal(counts.get(postA), 2, "2 верхнеуровневых у post-a (ответ на A2 не считается)");
	assert.equal(counts.get(postB), 1);
	assert.equal(counts.get("post-без-комментариев"), 0);

	const treeA = await getCommentsTree(BOB_PUB, postA);
	assert.equal(treeA.length, counts.get(postA), "бейдж обязан совпадать с tree.length после раскрытия");
});
