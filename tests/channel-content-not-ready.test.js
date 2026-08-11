// Этап 74 — М3-класс для контента каналов (CONTRACTS.md/DESIGN.md "Этап 74"):
// receiveChannelMetadata/receiveAllowlistUpdate/receivePost/receiveComment/
// receiveChannelMessage теперь throw ChannelContentNotReadyError вместо тихого
// no-op, когда локальная версия ключа канала отстаёт от версии, которой
// зашифровано входящее событие (grant kind:30053 идёт ОТДЕЛЬНОЙ подпиской от
// #h-топика контента — relay не гарантирует порядок между ними). Этот файл
// проверяет ровно сигнал throw и его ретраебельность: одно и то же событие,
// отклонённое ДО применения гранта новой версии, успешно применяется ПОСЛЕ —
// именно на этом контракте строится буфер+retry в transport.js.
import "fake-indexeddb/auto";
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { db } from "../src/core/store/database.js";
import { getPublicKey } from "../src/core/crypto/keys.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { sign } from "../src/core/crypto/sign.js";
import { encryptChannelContent, decryptChannelKeyGrant } from "../src/core/crypto/channel-key.js";
import { buildAllowlistEvent } from "../src/core/crypto/comment-allowlist.js";
import { deriveMasterSecret } from "../src/core/crypto/derivation.js";
import { createChannel, receiveChannelKeyGrant, receiveChannelMetadata, receiveAllowlistUpdate } from "../src/domain/content/channel.js";
import { handleIncomingSubscribeRequest } from "../src/domain/content/channel-access.js";
import { banMember } from "../src/domain/content/moderation.js";
import { receivePost } from "../src/domain/content/post.js";
import { receiveComment } from "../src/domain/content/comments.js";
import { receiveChannelMessage } from "../src/domain/content/channel-chat.js";
import { fromEncryptedRow } from "../src/core/store/encrypted-table.js";
import { ChannelContentNotReadyError } from "../src/domain/content/channel-content-errors.js";

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
	await db.table("channelReaders").clear();
	await db.table("commentAllowlists").clear();
	await db.table("groups").clear();
	await db.table("groupMembers").clear();
	await db.table("posts").clear();
	await db.table("comments").clear();
	await db.table("channelMessages").clear();
	await db.table("bannedMembers").clear();
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

// Боб и Mallory оба во VIEW (Mallory нужна только как жертва бана — банMember
// ротирует ключ на v2 и переиздаёт грант ТОЛЬКО остающимся читателям, т.е. Бобу).
// Боб дополнительно подписан (COMMENT) — v1 allowlist существует, поэтому banMember
// переиздаёт allowlist и под v2 тоже (естественный побочный эффект бана).
async function setupRotatedChannel() {
	await db.table("groups").add({ owner: ALICE_PUB, id: "friends", name: "Друзья" });
	await db.table("groupMembers").add({ groupId: "friends", pubkey: BOB_PUB });
	await db.table("groupMembers").add({ groupId: "friends", pubkey: MALLORY_PUB });

	const created = [];
	const { channelId } = await createChannel(ALICE_PUB, ALICE_PRIV, DB_KEY, { name: "К", description: "d", rules: "" }, ["friends"], capturingPublish(created));
	const grantBob = created.filter((e) => e.kind === 30053).find((e) => e.tags.find((t) => t[0] === "p")[1] === BOB_PUB);
	const grantMallory = created.filter((e) => e.kind === 30053).find((e) => e.tags.find((t) => t[0] === "p")[1] === MALLORY_PUB);
	await receiveChannelKeyGrant(BOB_PUB, BOB_PRIV, DB_KEY, ALICE_PUB, grantBob);
	await receiveChannelKeyGrant(MALLORY_PUB, MALLORY_PRIV, DB_KEY, ALICE_PUB, grantMallory);
	await handleIncomingSubscribeRequest(ALICE_PUB, ALICE_PRIV, DB_KEY, channelId, BOB_PUB, capturingPublish([]));

	const channelRow = await db.table("channels").get([ALICE_PUB, channelId]);

	// Ротация: баним Mallory -> Боб (единственный остающийся читатель) получает
	// новый грант v2, но ЕЩЁ ЕГО НЕ ПРИМЕНИЛ (моделируем гонку доставки).
	const banOutbox = [];
	await banMember(ALICE_PUB, ALICE_PRIV, DB_KEY, channelId, MALLORY_PUB, capturingPublish(banOutbox));
	const newGrantForBob = banOutbox.filter((e) => e.kind === 30053).find((e) => e.tags.find((t) => t[0] === "p")[1] === BOB_PUB);
	const grant = decryptChannelKeyGrant(newGrantForBob.content, BOB_PRIV, ALICE_PUB);

	return { channelId, channelTopic: channelRow.channelTopic, newGrantForBob, v2ChannelKey: grant.channelKey, v2Version: grant.version };
}

async function applyBobsNewGrant(newGrantForBob) {
	await receiveChannelKeyGrant(BOB_PUB, BOB_PRIV, DB_KEY, ALICE_PUB, newGrantForBob);
}

test("receiveChannelMetadata: контент, зашифрованный версией ключа, которой у Боба ещё нет локально -> throw, после применения гранта -> успех", async () => {
	const { channelId, channelTopic, newGrantForBob, v2ChannelKey, v2Version } = await setupRotatedChannel();
	const event = sign(
		{
			kind: 30060,
			content: encryptChannelContent(JSON.stringify({ name: "Новое имя", description: "d2", rules: "", avatar: null, allowChatAttachments: true }), v2ChannelKey, v2Version),
			tags: [
				["d", channelId],
				["h", channelTopic],
			],
			created_at: Math.floor(Date.now() / 1000),
		},
		ALICE_PRIV,
	);

	await assert.rejects(() => receiveChannelMetadata(BOB_PUB, DB_KEY, event), ChannelContentNotReadyError);
	const before = fromEncryptedRow(await db.table("channels").get([BOB_PUB, channelId]), DB_KEY);
	assert.notEqual(before.name, "Новое имя", "метаданные не должны примениться до готовности ключа");

	await applyBobsNewGrant(newGrantForBob);
	await receiveChannelMetadata(BOB_PUB, DB_KEY, event);
	const after = fromEncryptedRow(await db.table("channels").get([BOB_PUB, channelId]), DB_KEY);
	assert.equal(after.name, "Новое имя", "повторная доставка ПОСЛЕ применения гранта обязана пройти");
});

test("receiveAllowlistUpdate: allowlist версии, которой у Боба ещё нет локально -> throw, после применения гранта -> успех", async () => {
	const { channelId, channelTopic, newGrantForBob, v2ChannelKey, v2Version } = await setupRotatedChannel();
	const event = buildAllowlistEvent(channelId, channelTopic, v2Version, [BOB_PUB], v2ChannelKey, ALICE_PRIV, deriveMasterSecret(ALICE_PRIV));

	await assert.rejects(() => receiveAllowlistUpdate(BOB_PUB, DB_KEY, BOB_PUB, event), ChannelContentNotReadyError);
	assert.equal(await db.table("commentAllowlists").get([BOB_PUB, channelId, v2Version]), undefined, "allowlist не должен примениться до готовности ключа");

	await applyBobsNewGrant(newGrantForBob);
	await receiveAllowlistUpdate(BOB_PUB, DB_KEY, BOB_PUB, event);
	const row = fromEncryptedRow(await db.table("commentAllowlists").get([BOB_PUB, channelId, v2Version]), DB_KEY);
	assert.deepEqual(row.allowedAuthors, [BOB_PUB], "повторная доставка ПОСЛЕ применения гранта обязана пройти");
});

test("receivePost: пост, зашифрованный версией ключа, которой у Боба ещё нет локально -> throw, после применения гранта -> успех", async () => {
	const { channelId, channelTopic, newGrantForBob, v2ChannelKey, v2Version } = await setupRotatedChannel();
	const postId = crypto.randomUUID();
	const event = sign(
		{
			kind: 30061,
			content: encryptChannelContent(JSON.stringify({ text: "новый пост", attachments: [], status: "published" }), v2ChannelKey, v2Version),
			tags: [
				["d", `${channelId}:${postId}`],
				["h", channelTopic],
			],
			created_at: Math.floor(Date.now() / 1000),
		},
		ALICE_PRIV,
	);

	await assert.rejects(() => receivePost(BOB_PUB, DB_KEY, event), ChannelContentNotReadyError);
	assert.equal(await db.table("posts").get([BOB_PUB, postId]), undefined, "пост не должен примениться до готовности ключа");

	await applyBobsNewGrant(newGrantForBob);
	await receivePost(BOB_PUB, DB_KEY, event);
	const row = fromEncryptedRow(await db.table("posts").get([BOB_PUB, postId]), DB_KEY);
	assert.equal(row.text, "новый пост", "повторная доставка ПОСЛЕ применения гранта обязана пройти");
});

test("receiveComment: комментарий владельца, зашифрованный версией ключа, которой у Боба ещё нет локально -> throw, после применения гранта -> успех", async () => {
	const { channelId, channelTopic, newGrantForBob, v2ChannelKey, v2Version } = await setupRotatedChannel();
	const commentId = crypto.randomUUID();
	const event = sign(
		{
			kind: 30062,
			content: encryptChannelContent(JSON.stringify({ postId: "post-1", parentId: "post-1", text: "коммент владельца", attachments: [] }), v2ChannelKey, v2Version),
			tags: [
				["d", `post-1:${commentId}`],
				["h", channelTopic],
			],
			created_at: Math.floor(Date.now() / 1000),
		},
		ALICE_PRIV,
	);

	await assert.rejects(() => receiveComment(BOB_PUB, DB_KEY, event), ChannelContentNotReadyError);
	assert.equal(await db.table("comments").get([BOB_PUB, commentId]), undefined, "комментарий не должен примениться до готовности ключа");

	await applyBobsNewGrant(newGrantForBob);
	await receiveComment(BOB_PUB, DB_KEY, event);
	const row = fromEncryptedRow(await db.table("comments").get([BOB_PUB, commentId]), DB_KEY);
	assert.equal(row.text, "коммент владельца", "повторная доставка ПОСЛЕ применения гранта обязана пройти");
});

test("receiveChannelMessage: сообщение владельца, зашифрованное версией ключа, которой у Боба ещё нет локально -> throw, после применения гранта -> успех", async () => {
	const { channelId, channelTopic, newGrantForBob, v2ChannelKey, v2Version } = await setupRotatedChannel();
	const messageId = crypto.randomUUID();
	const event = sign(
		{
			kind: 30063,
			content: encryptChannelContent(JSON.stringify({ text: "сообщение владельца", attachments: [] }), v2ChannelKey, v2Version),
			tags: [
				["d", `${channelId}:${messageId}`],
				["h", channelTopic],
			],
			created_at: Math.floor(Date.now() / 1000),
		},
		ALICE_PRIV,
	);

	await assert.rejects(() => receiveChannelMessage(BOB_PUB, DB_KEY, event), ChannelContentNotReadyError);
	assert.equal(await db.table("channelMessages").get([BOB_PUB, messageId]), undefined, "сообщение не должно примениться до готовности ключа");

	await applyBobsNewGrant(newGrantForBob);
	await receiveChannelMessage(BOB_PUB, DB_KEY, event);
	const row = fromEncryptedRow(await db.table("channelMessages").get([BOB_PUB, messageId]), DB_KEY);
	assert.equal(row.text, "сообщение владельца", "повторная доставка ПОСЛЕ применения гранта обязана пройти");
});

// Негативная сторона контракта: throw специфичен для "версия ключа не готова",
// НЕ для обычных no-op условий (неизвестный канал/топик) — те остаются тихими,
// не подлежат буферизации/retry (М3-прецедент: буферизуется только "может стать
// валидным позже", не "заведомо не моё").
test("receiveChannelMetadata: неизвестный #h-топик -> тихий no-op, НЕ throw", async () => {
	await setupRotatedChannel();
	const event = sign(
		{
			kind: 30060,
			content: "irrelevant",
			tags: [
				["d", "unknown-channel"],
				["h", "unknown-topic"],
			],
			created_at: Math.floor(Date.now() / 1000),
		},
		ALICE_PRIV,
	);
	await assert.doesNotReject(() => receiveChannelMetadata(BOB_PUB, DB_KEY, event));
});

test("receivePost: неизвестный #h-топик -> тихий no-op, НЕ throw", async () => {
	await setupRotatedChannel();
	const event = sign(
		{
			kind: 30061,
			content: "irrelevant",
			tags: [
				["d", "unknown-channel:post-x"],
				["h", "unknown-topic"],
			],
			created_at: Math.floor(Date.now() / 1000),
		},
		ALICE_PRIV,
	);
	await assert.doesNotReject(() => receivePost(BOB_PUB, DB_KEY, event));
});
