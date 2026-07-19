import "fake-indexeddb/auto";
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { db } from "../src/core/store/database.js";
import { getPublicKey } from "../src/core/crypto/keys.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { createChannel, receiveChannelKeyGrant } from "../src/domain/content/channel.js";
import { decryptChannelContent } from "../src/core/crypto/channel-key.js";
import {
	createDraftPost,
	updateDraftPost,
	publishPost,
	archivePost,
	unpublishPost,
	deletePost,
	receivePost,
	listChannelPosts,
} from "../src/domain/content/post.js";
import { toEncryptedRow, fromEncryptedRow } from "../src/core/store/encrypted-table.js";
import { CHANNEL_KEYS_PLAINTEXT_FIELDS } from "../src/core/store/table-fields.js";

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
	await db.table("posts").clear();
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

async function setupChannelWithBobViewing() {
	await db.table("groups").add({ owner: ALICE_PUB, id: "friends", name: "Друзья" });
	await db.table("groupMembers").add({ groupId: "friends", pubkey: BOB_PUB });
	const published = [];
	const { channelId } = await createChannel(ALICE_PUB, ALICE_PRIV, DB_KEY, { name: "К", description: "d", rules: "" }, ["friends"], capturingPublish(published));
	const grantEvent = published.find((e) => e.kind === 30053);
	await receiveChannelKeyGrant(BOB_PUB, BOB_PRIV, DB_KEY, ALICE_PUB, grantEvent);
	return { channelId };
}

// AC-16 (найдено пользователем прямым осмотром IndexedDB, этап 39/40) — сырой дамп
// таблицы posts не должен выдавать текст поста в открытом виде.
test("AC-16: posts хранится зашифрованным — сырой дамп не содержит text/attachments", async () => {
	const { channelId } = await setupChannelWithBobViewing();
	const { postId } = await createDraftPost(ALICE_PUB, DB_KEY, channelId, { text: "секретный черновик", attachments: [] });
	const raw = await db.table("posts").get([ALICE_PUB, postId]);
	assert.equal(raw.id, postId);
	assert.equal("text" in raw, false);
	assert.equal("attachments" in raw, false);
	assert.ok(raw.nonce instanceof Uint8Array);
	assert.ok(raw.ciphertext instanceof Uint8Array);

	const decrypted = fromEncryptedRow(raw, DB_KEY);
	assert.equal(decrypted.text, "секретный черновик");
});

test("createDraftPost: локальная запись, НИЧЕГО не публикуется", async () => {
	const { channelId } = await setupChannelWithBobViewing();
	const { postId } = await createDraftPost(ALICE_PUB, DB_KEY, channelId, { text: "черновик", attachments: [] });
	const row = fromEncryptedRow(await db.table("posts").get([ALICE_PUB, postId]), DB_KEY);
	assert.equal(row.status, "draft");
	assert.equal(row.text, "черновик");
});

test("updateDraftPost: редактирует черновик до публикации", async () => {
	const { channelId } = await setupChannelWithBobViewing();
	const { postId } = await createDraftPost(ALICE_PUB, DB_KEY, channelId, { text: "v1", attachments: [] });
	await updateDraftPost(ALICE_PUB, DB_KEY, postId, { text: "v2", attachments: [] });
	const row = fromEncryptedRow(await db.table("posts").get([ALICE_PUB, postId]), DB_KEY);
	assert.equal(row.text, "v2");
});

test("publishPost: публикует kind 30061, Боб (VIEW-держатель) расшифровывает контент", async () => {
	const { channelId } = await setupChannelWithBobViewing();
	const { postId } = await createDraftPost(ALICE_PUB, DB_KEY, channelId, { text: "первая статья", attachments: [] });
	const published = [];
	await publishPost(ALICE_PUB, ALICE_PRIV, DB_KEY, postId, capturingPublish(published));

	const event = published.find((e) => e.kind === 30061);
	assert.ok(event);
	assert.deepEqual(event.tags.find((t) => t[0] === "d"), ["d", `${channelId}:${postId}`]);

	const bobKeyRow = fromEncryptedRow(await db.table("channelKeys").get([BOB_PUB, channelId, 1]), DB_KEY);
	const plaintext = decryptChannelContent(event.content, { 1: bobKeyRow.channelKey });
	assert.deepEqual(JSON.parse(plaintext), { text: "первая статья", attachments: [], status: "published" });

	const row = fromEncryptedRow(await db.table("posts").get([ALICE_PUB, postId]), DB_KEY);
	assert.equal(row.status, "published");
});

test("publishPost: недопустимый переход (публикация уже опубликованного без unpublish) -> throw", async () => {
	const { channelId } = await setupChannelWithBobViewing();
	const { postId } = await createDraftPost(ALICE_PUB, DB_KEY, channelId, { text: "x", attachments: [] });
	await publishPost(ALICE_PUB, ALICE_PRIV, DB_KEY, postId, capturingPublish([]));
	await assert.rejects(() => publishPost(ALICE_PUB, ALICE_PRIV, DB_KEY, postId, capturingPublish([])));
});

test("archivePost/unpublishPost: republish того же d-tag с обновлённым статусом", async () => {
	const { channelId } = await setupChannelWithBobViewing();
	const { postId } = await createDraftPost(ALICE_PUB, DB_KEY, channelId, { text: "x", attachments: [] });
	await publishPost(ALICE_PUB, ALICE_PRIV, DB_KEY, postId, capturingPublish([]));

	const archivePublished = [];
	await archivePost(ALICE_PUB, ALICE_PRIV, DB_KEY, postId, capturingPublish(archivePublished));
	const archiveEvent = archivePublished.find((e) => e.kind === 30061);
	assert.deepEqual(archiveEvent.tags.find((t) => t[0] === "d"), ["d", `${channelId}:${postId}`], "тот же d-tag — replaceable");
	let row = fromEncryptedRow(await db.table("posts").get([ALICE_PUB, postId]), DB_KEY);
	assert.equal(row.status, "archived");

	// archived — финальное, ARCHIVE/UNPUBLISH из него недопустимы
	await assert.rejects(() => unpublishPost(ALICE_PUB, ALICE_PRIV, DB_KEY, postId, capturingPublish([])));
});

test("unpublishPost: published -> draft, можно отредактировать и опубликовать заново", async () => {
	const { channelId } = await setupChannelWithBobViewing();
	const { postId } = await createDraftPost(ALICE_PUB, DB_KEY, channelId, { text: "v1", attachments: [] });
	await publishPost(ALICE_PUB, ALICE_PRIV, DB_KEY, postId, capturingPublish([]));
	await unpublishPost(ALICE_PUB, ALICE_PRIV, DB_KEY, postId, capturingPublish([]));

	let row = fromEncryptedRow(await db.table("posts").get([ALICE_PUB, postId]), DB_KEY);
	assert.equal(row.status, "draft");

	await updateDraftPost(ALICE_PUB, DB_KEY, postId, { text: "v2 отредактировано", attachments: [] });
	const republished = [];
	await publishPost(ALICE_PUB, ALICE_PRIV, DB_KEY, postId, capturingPublish(republished));
	const event = republished.find((e) => e.kind === 30061);
	const bobKeyRow = fromEncryptedRow(await db.table("channelKeys").get([BOB_PUB, channelId, 1]), DB_KEY);
	const plaintext = decryptChannelContent(event.content, { 1: bobKeyRow.channelKey });
	assert.equal(JSON.parse(plaintext).text, "v2 отредактировано");
});

test("deletePost: черновик (никогда не публиковался) — только локально, БЕЗ kind 5", async () => {
	const { channelId } = await setupChannelWithBobViewing();
	const { postId } = await createDraftPost(ALICE_PUB, DB_KEY, channelId, { text: "x", attachments: [] });
	const published = [];
	await deletePost(ALICE_PUB, ALICE_PRIV, postId, capturingPublish(published));
	assert.equal(published.length, 0, "черновик нечего отзывать на relay");
	const row = fromEncryptedRow(await db.table("posts").get([ALICE_PUB, postId]), DB_KEY);
	assert.equal(row.deleted, true);
});

test("deletePost: опубликованный пост -> kind 5 (NIP-09 addressable, F-CH-10)", async () => {
	const { channelId } = await setupChannelWithBobViewing();
	const { postId } = await createDraftPost(ALICE_PUB, DB_KEY, channelId, { text: "x", attachments: [] });
	await publishPost(ALICE_PUB, ALICE_PRIV, DB_KEY, postId, capturingPublish([]));
	const published = [];
	await deletePost(ALICE_PUB, ALICE_PRIV, postId, capturingPublish(published));
	const delEvent = published.find((e) => e.kind === 5);
	assert.ok(delEvent);
	assert.deepEqual(delEvent.tags.find((t) => t[0] === "a"), ["a", `30061:${ALICE_PUB}:${channelId}:${postId}`]);
});

test("receivePost: Боб получает и расшифровывает пост Алисы, попадает в locally listChannelPosts", async () => {
	const { channelId } = await setupChannelWithBobViewing();
	const { postId } = await createDraftPost(ALICE_PUB, DB_KEY, channelId, { text: "для всех подписчиков", attachments: [] });
	const published = [];
	await publishPost(ALICE_PUB, ALICE_PRIV, DB_KEY, postId, capturingPublish(published));
	const event = published.find((e) => e.kind === 30061);

	const applied = await receivePost(BOB_PUB, DB_KEY, event);
	assert.equal(applied, true);
	const bobPosts = await listChannelPosts(BOB_PUB, DB_KEY, channelId);
	assert.equal(bobPosts.length, 1);
	assert.equal(bobPosts[0].text, "для всех подписчиков");
});

test("АДВЕРСАРНЫЙ (DESIGN.md формализация 2): Mallory (VIEW-держатель, НЕ владелец) подделывает пост тем же channelKey — Боб отбрасывает", async () => {
	const { channelId } = await setupChannelWithBobViewing();
	// Дадим Mallory тоже VIEW (она честный подписчик, просто пытается выдать себя за владельца)
	await db.table("groupMembers").add({ groupId: "friends", pubkey: MALLORY_PUB });
	// (группа уже создана в setupChannelWithBobViewing с одним Бобом — добавим Mallory вручную
	// через тот же kind 30053 механизм, реиспользуя приватный доступ к ключу канала Алисы)
	const aliceKeyRow = fromEncryptedRow(await db.table("channelKeys").get([ALICE_PUB, channelId, 1]), DB_KEY);
	const aliceChannelRow = await db.table("channels").get([ALICE_PUB, channelId]);
	const { sendViewGrant } = await import("../src/domain/content/channel-access.js");
	const grantPublish = [];
	await sendViewGrant(
		ALICE_PUB,
		ALICE_PRIV,
		{ channelId, channelTopic: aliceChannelRow.channelTopic, channelKey: aliceKeyRow.channelKey },
		MALLORY_PUB,
		1,
		capturingPublish(grantPublish),
	);
	const { decryptChannelKeyGrant } = await import("../src/core/crypto/channel-key.js");
	const grant = decryptChannelKeyGrant(grantPublish[0].content, MALLORY_PRIV, ALICE_PUB);
	await db.table("channelKeys").put(toEncryptedRow({ ownerPubkey: MALLORY_PUB, channelId, keyVersion: 1, channelKey: grant.channelKey }, CHANNEL_KEYS_PLAINTEXT_FIELDS, DB_KEY));

	// Mallory теперь ИМЕЕТ channelKey (законно, как читатель) — но НЕ владелец канала.
	// Она шифрует "пост" тем же ключом и публикует его с тем же #h — расшифровывается
	// прекрасно, но она не создатель канала.
	const { encryptChannelContent } = await import("../src/core/crypto/channel-key.js");
	const { sign } = await import("../src/core/crypto/sign.js");
	const forgedContent = encryptChannelContent(
		JSON.stringify({ text: "поддельная статья от имени Алисы", attachments: [], status: "published" }),
		grant.channelKey,
		1,
	);
	const forgedEvent = sign(
		{
			kind: 30061,
			content: forgedContent,
			tags: [
				["d", `${channelId}:forged-post-id`],
				["h", aliceChannelRow.channelTopic],
			],
			created_at: Math.floor(Date.now() / 1000),
		},
		MALLORY_PRIV,
	);

	const applied = await receivePost(BOB_PUB, DB_KEY, forgedEvent);
	assert.equal(applied, false, "пост НЕ от создателя канала обязан быть отклонён");
	const bobPosts = await listChannelPosts(BOB_PUB, DB_KEY, channelId);
	assert.equal(bobPosts.length, 0);
});
