import "fake-indexeddb/auto";
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { db } from "../src/core/store/database.js";
import { getPublicKey } from "../src/core/crypto/keys.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { sign } from "../src/core/crypto/sign.js";
import { encryptChannelContent } from "../src/core/crypto/channel-key.js";
import { createChannel, receiveChannelKeyGrant } from "../src/domain/content/channel.js";
import { sendViewGrant, handleIncomingSubscribeRequest } from "../src/domain/content/channel-access.js";
import { createDraftPost, publishPost, receivePost, getPost } from "../src/domain/content/post.js";
import { addComment } from "../src/domain/content/comments.js";
import { toEncryptedRow, fromEncryptedRow } from "../src/core/store/encrypted-table.js";
import { DomainError } from "../src/domain/errors.js";
import {
	CHANNEL_REACTION_KIND,
	CHANNEL_REACTION_SET,
	setReaction,
	receiveReaction,
	listReactionsForPost,
	listReactionsForTargets,
	aggregateReactions,
} from "../src/domain/content/reactions.js";

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
	await db.table("posts").clear();
	await db.table("channelReactions").clear();
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
	await handleIncomingSubscribeRequest(ALICE_PUB, ALICE_PRIV, DB_KEY, channelId, BOB_PUB, capturingPublish([]));
	return { channelId };
}

async function publishAlicePost(channelId, text = "пост") {
	const { postId } = await createDraftPost(ALICE_PUB, DB_KEY, channelId, { text, attachments: [] });
	await publishPost(ALICE_PUB, ALICE_PRIV, DB_KEY, postId, capturingPublish([]));
	return postId;
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

async function channelCrypto(ownerPubkey, channelId) {
	const channelRow = fromEncryptedRow(await db.table("channels").get([ownerPubkey, channelId]), DB_KEY);
	const meta = fromEncryptedRow(await db.table("channelKeyMeta").get([ownerPubkey, channelId]), DB_KEY);
	const keyRow = fromEncryptedRow(await db.table("channelKeys").get([ownerPubkey, channelId, meta.currentVersion]), DB_KEY);
	return { channelRow, meta, keyRow };
}

function reactionEvent(privKey, channelTopic, channelId, targetType, targetId, postId, emoji, createdAt, keyHex, version) {
	const content = encryptChannelContent(JSON.stringify({ targetType, targetId, postId, channelId, emoji }), keyHex, version);
	return sign(
		{
			kind: CHANNEL_REACTION_KIND,
			content,
			tags: [
				["d", `${channelId}:${targetType}:${targetId}`],
				["h", channelTopic],
			],
			created_at: createdAt,
		},
		privKey,
	);
}

test("kind 30067 свободен и алфавит закрыт из пяти в заданном порядке", () => {
	assert.equal(CHANNEL_REACTION_KIND, 30067);
	assert.deepEqual(CHANNEL_REACTION_SET, ["👍", "❤️", "😂", "🔥", "👀"]);
});

test("Owner ставит 👍 на пост → локальная строка есть, aggregate { counts: { 👍: 1 }, mine: 👍 }", async () => {
	const { channelId } = await setupChannelWithBobSubscribed();
	const postId = await publishAlicePost(channelId);
	const published = [];
	await setReaction(ALICE_PUB, ALICE_PRIV, DB_KEY, channelId, "post", postId, postId, "👍", capturingPublish(published));

	const event = published.find((e) => e.kind === CHANNEL_REACTION_KIND);
	assert.ok(event);
	assert.deepEqual(event.tags.find((t) => t[0] === "d"), ["d", `${channelId}:post:${postId}`]);

	const rows = await listReactionsForPost(ALICE_PUB, DB_KEY, postId);
	assert.equal(rows.length, 1);
	assert.equal(rows[0].emoji, "👍");
	assert.equal(rows[0].reactorPubkey, ALICE_PUB);
	assert.deepEqual(aggregateReactions(rows, ALICE_PUB), { counts: { "👍": 1 }, mine: "👍" });
});

test("Owner меняет на ❤️ → одна строка, не две; counts только ❤️", async () => {
	const { channelId } = await setupChannelWithBobSubscribed();
	const postId = await publishAlicePost(channelId);
	await setReaction(ALICE_PUB, ALICE_PRIV, DB_KEY, channelId, "post", postId, postId, "👍", capturingPublish([]));
	await setReaction(ALICE_PUB, ALICE_PRIV, DB_KEY, channelId, "post", postId, postId, "❤️", capturingPublish([]));

	const rows = await listReactionsForPost(ALICE_PUB, DB_KEY, postId);
	assert.equal(rows.length, 1, "replaceable: смена эмодзи не плодит вторую строку");
	assert.equal(rows[0].emoji, "❤️");
	assert.deepEqual(aggregateReactions(rows, ALICE_PUB), { counts: { "❤️": 1 }, mine: "❤️" });
});

test("Owner снимает (emoji: null) → counts пустой, mine null", async () => {
	const { channelId } = await setupChannelWithBobSubscribed();
	const postId = await publishAlicePost(channelId);
	await setReaction(ALICE_PUB, ALICE_PRIV, DB_KEY, channelId, "post", postId, postId, "👍", capturingPublish([]));
	await setReaction(ALICE_PUB, ALICE_PRIV, DB_KEY, channelId, "post", postId, postId, null, capturingPublish([]));

	const rows = await listReactionsForPost(ALICE_PUB, DB_KEY, postId);
	assert.equal(rows.length, 1, "снятие хранит строку с emoji:null для LWW");
	assert.equal(rows[0].emoji, null);
	assert.deepEqual(aggregateReactions(rows, ALICE_PUB), { counts: {}, mine: null });
});

test("Subscriber (COMMENT) ставит реакцию → owner receiveReaction принимает", async () => {
	const { channelId } = await setupChannelWithBobSubscribed();
	const postId = await publishAlicePost(channelId);
	const published = [];
	await setReaction(BOB_PUB, BOB_PRIV, DB_KEY, channelId, "post", postId, postId, "🔥", capturingPublish(published));
	const event = published.find((e) => e.kind === CHANNEL_REACTION_KIND);
	assert.ok(event);

	const applied = await receiveReaction(ALICE_PUB, DB_KEY, event);
	assert.equal(applied, true);
	const rows = await listReactionsForPost(ALICE_PUB, DB_KEY, postId);
	assert.equal(rows.length, 1);
	assert.equal(rows[0].reactorPubkey, BOB_PUB);
	assert.equal(rows[0].emoji, "🔥");
	assert.deepEqual(aggregateReactions(rows, ALICE_PUB), { counts: { "🔥": 1 }, mine: null });
	assert.deepEqual(aggregateReactions(rows, BOB_PUB), { counts: { "🔥": 1 }, mine: "🔥" });
});

test("АДВЕРСАРНЫЙ: VIEW без COMMENT — receiveReaction false, строки нет", async () => {
	const { channelId } = await setupChannelWithBobSubscribed();
	const postId = await publishAlicePost(channelId);
	const grantEvent = await grantViewTo(channelId, MALLORY_PUB);
	await receiveChannelKeyGrant(MALLORY_PUB, MALLORY_PRIV, DB_KEY, ALICE_PUB, grantEvent);

	const published = [];
	await setReaction(MALLORY_PUB, MALLORY_PRIV, DB_KEY, channelId, "post", postId, postId, "👍", capturingPublish(published));
	const event = published.find((e) => e.kind === CHANNEL_REACTION_KIND);

	const applied = await receiveReaction(ALICE_PUB, DB_KEY, event);
	assert.equal(applied, false);
	assert.equal((await listReactionsForPost(ALICE_PUB, DB_KEY, postId)).length, 0);
});

test("Эмодзи вне алфавита → setReaction бросает DomainError; на приёме false", async () => {
	const { channelId } = await setupChannelWithBobSubscribed();
	const postId = await publishAlicePost(channelId);
	await assert.rejects(
		() => setReaction(ALICE_PUB, ALICE_PRIV, DB_KEY, channelId, "post", postId, postId, "🍕", capturingPublish([])),
		(err) => err instanceof DomainError,
	);

	const { channelRow, meta, keyRow } = await channelCrypto(ALICE_PUB, channelId);
	const event = reactionEvent(ALICE_PRIV, channelRow.channelTopic, channelId, "post", postId, postId, "🍕", Math.floor(Date.now() / 1000), keyRow.channelKey, meta.currentVersion);
	const applied = await receiveReaction(ALICE_PUB, DB_KEY, event);
	assert.equal(applied, false);
	assert.equal((await listReactionsForPost(ALICE_PUB, DB_KEY, postId)).length, 0);
});

test("Старое событие с меньшим created_at не откатывает более новое", async () => {
	const { channelId } = await setupChannelWithBobSubscribed();
	const postId = await publishAlicePost(channelId);
	const { channelRow, meta, keyRow } = await channelCrypto(ALICE_PUB, channelId);
	const newer = reactionEvent(ALICE_PRIV, channelRow.channelTopic, channelId, "post", postId, postId, "❤️", 200, keyRow.channelKey, meta.currentVersion);
	const older = reactionEvent(ALICE_PRIV, channelRow.channelTopic, channelId, "post", postId, postId, "👍", 100, keyRow.channelKey, meta.currentVersion);

	assert.equal(await receiveReaction(ALICE_PUB, DB_KEY, newer), true);
	assert.equal(await receiveReaction(ALICE_PUB, DB_KEY, older), false);
	const rows = await listReactionsForPost(ALICE_PUB, DB_KEY, postId);
	assert.equal(rows.length, 1);
	assert.equal(rows[0].emoji, "❤️");
});

test("listReactionsForTargets по двум postId не тащит реакции другого поста", async () => {
	const { channelId } = await setupChannelWithBobSubscribed();
	const postA = await publishAlicePost(channelId, "A");
	const postB = await publishAlicePost(channelId, "B");
	const postC = await publishAlicePost(channelId, "C");
	await setReaction(ALICE_PUB, ALICE_PRIV, DB_KEY, channelId, "post", postA, postA, "👍", capturingPublish([]));
	await setReaction(ALICE_PUB, ALICE_PRIV, DB_KEY, channelId, "post", postB, postB, "🔥", capturingPublish([]));
	await setReaction(ALICE_PUB, ALICE_PRIV, DB_KEY, channelId, "post", postC, postC, "👀", capturingPublish([]));
	const { commentId } = await addComment(ALICE_PUB, ALICE_PRIV, DB_KEY, channelId, postA, postA, "к", [], capturingPublish([]));
	await setReaction(ALICE_PUB, ALICE_PRIV, DB_KEY, channelId, "comment", commentId, postA, "😂", capturingPublish([]));

	const rows = await listReactionsForTargets(ALICE_PUB, DB_KEY, [postA, postB]);
	assert.equal(rows.length, 2);
	const byTarget = new Map(rows.map((r) => [r.targetId, r.emoji]));
	assert.equal(byTarget.get(postA), "👍");
	assert.equal(byTarget.get(postB), "🔥");
	assert.equal(byTarget.has(postC), false);
	assert.equal(
		rows.every((r) => r.targetType === "post"),
		true,
		"батч ленты не тащит реакции на комментарии",
	);
});

test("цели нет локально → receiveReaction false, не пишет", async () => {
	const { channelId } = await setupChannelWithBobSubscribed();
	const { channelRow, meta, keyRow } = await channelCrypto(ALICE_PUB, channelId);
	const missingPostId = "missing-post-id";
	const event = reactionEvent(ALICE_PRIV, channelRow.channelTopic, channelId, "post", missingPostId, missingPostId, "👍", Math.floor(Date.now() / 1000), keyRow.channelKey, meta.currentVersion);
	assert.equal(await receiveReaction(ALICE_PUB, DB_KEY, event), false);
	assert.equal((await listReactionsForPost(ALICE_PUB, DB_KEY, missingPostId)).length, 0);
});

test("getPost: возвращает пост; null если нет или deleted", async () => {
	const { channelId } = await setupChannelWithBobSubscribed();
	const postId = await publishAlicePost(channelId, "тело");
	const found = await getPost(ALICE_PUB, DB_KEY, postId);
	assert.ok(found);
	assert.equal(found.id, postId);
	assert.equal(found.text, "тело");
	assert.equal(await getPost(ALICE_PUB, DB_KEY, "no-such"), null);

	await db.table("posts").update([ALICE_PUB, postId], { deleted: true });
	assert.equal(await getPost(ALICE_PUB, DB_KEY, postId), null);
});

test("aggregateReactions: игнорирует null и чужой эмодзи, mine только зрителя", () => {
	const rows = [
		{ emoji: "👍", reactorPubkey: ALICE_PUB },
		{ emoji: "👍", reactorPubkey: BOB_PUB },
		{ emoji: "❤️", reactorPubkey: MALLORY_PUB },
		{ emoji: null, reactorPubkey: "x" },
		{ emoji: "🍕", reactorPubkey: "y" },
	];
	assert.deepEqual(aggregateReactions(rows, ALICE_PUB), { counts: { "👍": 2, "❤️": 1 }, mine: "👍" });
	assert.deepEqual(aggregateReactions(rows, "nobody"), { counts: { "👍": 2, "❤️": 1 }, mine: null });
});
