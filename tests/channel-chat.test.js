import "fake-indexeddb/auto";
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { db } from "../src/core/store/database.js";
import { getPublicKey } from "../src/core/crypto/keys.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { createChannel, receiveChannelKeyGrant } from "../src/domain/content/channel.js";
import { sendViewGrant, handleIncomingSubscribeRequest } from "../src/domain/content/channel-access.js";
import { sendChannelMessage, receiveChannelMessage } from "../src/domain/content/channel-chat.js";
import { loadChannelChatWindow } from "../src/core/sync/lazy-channel.js";
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
	await db.table("channelMessages").clear();
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

async function setupChannelWithBobSubscribed(options = {}) {
	await db.table("groups").add({ owner: ALICE_PUB, id: "friends", name: "Друзья" });
	await db.table("groupMembers").add({ groupId: "friends", pubkey: BOB_PUB });
	const published = [];
	const { channelId } = await createChannel(ALICE_PUB, ALICE_PRIV, DB_KEY, { name: "К", description: "d", rules: "", ...options }, ["friends"], capturingPublish(published));
	const grantEvent = published.find((e) => e.kind === 30053);
	await receiveChannelKeyGrant(BOB_PUB, BOB_PRIV, DB_KEY, ALICE_PUB, grantEvent);
	await handleIncomingSubscribeRequest(ALICE_PUB, ALICE_PRIV, DB_KEY, channelId, BOB_PUB, capturingPublish([]));
	// Бобу тоже нужна строка channels с правильным allowChatAttachments — обычно это
	// приходит через receiveChannelMetadata (этап 30), здесь проставляем напрямую, раз
	// это не предмет теста channel-chat.js.
	if (options.allowChatAttachments !== undefined) {
		await db.table("channels").update([BOB_PUB, channelId], { allowChatAttachments: options.allowChatAttachments });
	}
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
// увидел "Добро пожаловать в общий чат!" открытым текстом в этой таблице.
test("AC-16: channelMessages хранится зашифрованным — сырой дамп не содержит text/attachments", async () => {
	const { channelId } = await setupChannelWithBobSubscribed();
	const { messageId } = await sendChannelMessage(BOB_PUB, BOB_PRIV, DB_KEY, channelId, "секретное сообщение", [], capturingPublish([]));
	const raw = await db.table("channelMessages").get([BOB_PUB, messageId]);
	assert.equal(raw.id, messageId);
	assert.equal("text" in raw, false);
	assert.equal("attachments" in raw, false);
	assert.ok(raw.nonce instanceof Uint8Array);
	assert.ok(raw.ciphertext instanceof Uint8Array);

	const decrypted = fromEncryptedRow(raw, DB_KEY);
	assert.equal(decrypted.text, "секретное сообщение");
});

test("sendChannelMessage/receiveChannelMessage: Боб (подписчик с COMMENT) пишет в чат, Алиса получает", async () => {
	const { channelId } = await setupChannelWithBobSubscribed();
	const published = [];
	const { messageId } = await sendChannelMessage(BOB_PUB, BOB_PRIV, DB_KEY, channelId, "привет всем", [], capturingPublish(published));

	const event = published.find((e) => e.kind === 30063);
	assert.ok(event);
	assert.deepEqual(event.tags.find((t) => t[0] === "d"), ["d", `${channelId}:${messageId}`]);

	const applied = await receiveChannelMessage(ALICE_PUB, DB_KEY, event);
	assert.equal(applied, true);
	const { messages } = await loadChannelChatWindow(ALICE_PUB, DB_KEY, channelId, { limit: 15 });
	assert.equal(messages.length, 1);
	assert.equal(messages[0].text, "привет всем");
});

test("Владелец канала может писать в чат СВОЕГО канала, даже не будучи в commentAllowlists", async () => {
	const { channelId } = await setupChannelWithBobSubscribed();
	const published = [];
	await sendChannelMessage(ALICE_PUB, ALICE_PRIV, DB_KEY, channelId, "сообщение от владельца", [], capturingPublish(published));
	const event = published.find((e) => e.kind === 30063);

	const applied = await receiveChannelMessage(BOB_PUB, DB_KEY, event);
	assert.equal(applied, true, "владелец канала имплицитно всегда имеет право писать в чат");
});

test("АДВЕРСАРНЫЙ: VIEW-держатель БЕЗ COMMENT пишет в чат — отклонено (тот же allowlist, что комментарии)", async () => {
	const { channelId } = await setupChannelWithBobSubscribed();
	const grantEvent = await grantViewTo(channelId, MALLORY_PUB);
	await receiveChannelKeyGrant(MALLORY_PUB, MALLORY_PRIV, DB_KEY, ALICE_PUB, grantEvent);

	const published = [];
	await sendChannelMessage(MALLORY_PUB, MALLORY_PRIV, DB_KEY, channelId, "спам без права", [], capturingPublish(published));
	const event = published.find((e) => e.kind === 30063);

	const applied = await receiveChannelMessage(ALICE_PUB, DB_KEY, event);
	assert.equal(applied, false, "сообщение без COMMENT-права обязано быть отклонено");
	assert.equal((await loadChannelChatWindow(ALICE_PUB, DB_KEY, channelId, { limit: 15 })).messages.length, 0);
});

test("allowChatAttachments=false: вложение обрезается на приёме, текст сообщения остаётся", async () => {
	const { channelId } = await setupChannelWithBobSubscribed({ allowChatAttachments: false });
	const published = [];
	await sendChannelMessage(BOB_PUB, BOB_PRIV, DB_KEY, channelId, "вот файл", [{ sha256: "abc", mime: "image/png" }], capturingPublish(published));
	const event = published.find((e) => e.kind === 30063);

	const applied = await receiveChannelMessage(ALICE_PUB, DB_KEY, event);
	assert.equal(applied, true);
	const { messages } = await loadChannelChatWindow(ALICE_PUB, DB_KEY, channelId, { limit: 15 });
	assert.equal(messages[0].text, "вот файл", "текст сохраняется");
	assert.deepEqual(messages[0].attachments, [], "вложение обрезано политикой канала, не отброшено всё сообщение");
});

test("allowChatAttachments=true (default): вложение сохраняется на приёме", async () => {
	const { channelId } = await setupChannelWithBobSubscribed();
	const published = [];
	await sendChannelMessage(BOB_PUB, BOB_PRIV, DB_KEY, channelId, "вот файл", [{ sha256: "abc", mime: "image/png" }], capturingPublish(published));
	const event = published.find((e) => e.kind === 30063);

	await receiveChannelMessage(ALICE_PUB, DB_KEY, event);
	const { messages } = await loadChannelChatWindow(ALICE_PUB, DB_KEY, channelId, { limit: 15 });
	assert.equal(messages[0].attachments.length, 1);
});
