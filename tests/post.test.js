import "fake-indexeddb/auto";
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { db } from "../src/core/store/database.js";
import { getPublicKey } from "../src/core/crypto/keys.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { createChannel, receiveChannelKeyGrant } from "../src/domain/content/channel.js";
import { decryptChannelContent, encryptChannelKeyGrant } from "../src/core/crypto/channel-key.js";
import {
	createDraftPost,
	updateDraftPost,
	publishPost,
	archivePost,
	unpublishPost,
	deletePost,
	receivePost,
	listChannelPosts,
	republishAllPostsUnderCurrentKey,
	setPostDue,
	clearPostDue,
	setPostDone,
	makePostTask,
	unmakePostTask,
	setPostTags,
} from "../src/domain/content/post.js";
import { toEncryptedRow, fromEncryptedRow } from "../src/core/store/encrypted-table.js";
import { CHANNEL_KEYS_PLAINTEXT_FIELDS, CHANNEL_KEY_META_PLAINTEXT_FIELDS } from "../src/core/store/table-fields.js";

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
	assert.deepEqual(JSON.parse(plaintext), { text: "первая статья", attachments: [], status: "published", dueAt: null, done: null, title: null, linkUrl: null, tags: [] });

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

// Этап 74 — Часть C, C-2 (CONTRACTS.md/DESIGN.md "Этап 74"): receivePost применял
// ЛЮБОЕ входящее 30061 безусловно — archivePost/unpublishPost republish-ят ТОТ ЖЕ
// d-tag с новым status; старая версия ("published"), доставленная ПОСЛЕ архивации,
// откатывала бы пост обратно к видимому статусу вопреки явному действию владельца.
test("АДВЕРСАРНО (C-2): старая версия поста (status='published'), доставленная ПОСЛЕ archivePost, не откатывает статус у подписчика", async () => {
	const { channelId } = await setupChannelWithBobViewing();
	const { postId } = await createDraftPost(ALICE_PUB, DB_KEY, channelId, { text: "текст", attachments: [] });

	const publishedEvents = [];
	await publishPost(ALICE_PUB, ALICE_PRIV, DB_KEY, postId, capturingPublish(publishedEvents));
	const publishedEvent = { ...publishedEvents.find((e) => e.kind === 30061), created_at: 1000, id: "post-published" };

	const archivedEvents = [];
	await archivePost(ALICE_PUB, ALICE_PRIV, DB_KEY, postId, capturingPublish(archivedEvents));
	const archivedEvent = { ...archivedEvents.find((e) => e.kind === 30061), created_at: 2000, id: "post-archived" };

	// Боб получает архивацию первой, затем УСТАРЕВШУЮ "опубликован" (переупорядоченная доставка).
	await receivePost(BOB_PUB, DB_KEY, archivedEvent);
	await receivePost(BOB_PUB, DB_KEY, publishedEvent);

	const row = fromEncryptedRow(await db.table("posts").get([BOB_PUB, postId]), DB_KEY);
	assert.equal(row.status, "archived", "устаревшая версия не должна откатить архивацию");
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

// --- republishAllPostsUnderCurrentKey (этап 74, найдено живой проверкой:
// revokeViewFromMember ротирует channelKey, но посты на relay оставались
// зашифрованы СТАРОЙ версией — повторно добавленный читатель никогда не
// расшифровывал историю). Симулируем ротацию напрямую (без revokeViewFromMember/
// channel-visibility.js — изолированный тест доменной функции).

async function rotateChannelKeyManually(channelId, newVersion) {
	const newKeyHex = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
	await db.table("channelKeys").put(toEncryptedRow({ ownerPubkey: ALICE_PUB, channelId, keyVersion: newVersion, channelKey: newKeyHex }, CHANNEL_KEYS_PLAINTEXT_FIELDS, DB_KEY));
	await db.table("channelKeyMeta").put(toEncryptedRow({ ownerPubkey: ALICE_PUB, channelId, currentVersion: newVersion }, CHANNEL_KEY_META_PLAINTEXT_FIELDS, DB_KEY));
	return newKeyHex;
}

test("republishAllPostsUnderCurrentKey: переиздаёт published-пост под НОВОЙ версией ключа — читатель, получивший её ПОСЛЕ ротации, расшифровывает", async () => {
	const { channelId } = await setupChannelWithBobViewing();
	const { postId } = await createDraftPost(ALICE_PUB, DB_KEY, channelId, { text: "старый пост", attachments: [] });
	await publishPost(ALICE_PUB, ALICE_PRIV, DB_KEY, postId, capturingPublish([]));

	const newKeyHex = await rotateChannelKeyManually(channelId, 2);

	const published = [];
	await republishAllPostsUnderCurrentKey(ALICE_PUB, ALICE_PRIV, DB_KEY, channelId, capturingPublish(published));
	const republishedEvent = published.find((e) => e.kind === 30061);
	assert.ok(republishedEvent, "обязан переиздать пост");
	assert.deepEqual(republishedEvent.tags.find((t) => t[0] === "d"), ["d", `${channelId}:${postId}`], "тот же d-tag — replaceable замена на relay");

	const plaintext = decryptChannelContent(republishedEvent.content, { 2: newKeyHex });
	assert.deepEqual(JSON.parse(plaintext), { text: "старый пост", attachments: [], status: "published", dueAt: null, done: null, title: null, linkUrl: null, tags: [] });

	// Читатель, получивший грант именно ЭТОЙ (новой) версии, расшифровывает.
	const aliceChannelRow = fromEncryptedRow(await db.table("channels").get([ALICE_PUB, channelId]), DB_KEY);
	const newGrantContent = encryptChannelKeyGrant(channelId, aliceChannelRow.channelTopic, newKeyHex, 2, ALICE_PRIV, BOB_PUB);
	await receiveChannelKeyGrant(BOB_PUB, BOB_PRIV, DB_KEY, ALICE_PUB, { content: newGrantContent });
	await receivePost(BOB_PUB, DB_KEY, republishedEvent);
	const bobPosts = await listChannelPosts(BOB_PUB, DB_KEY, channelId);
	assert.equal(bobPosts.find((p) => p.id === postId)?.text, "старый пост");
});

test("republishAllPostsUnderCurrentKey: НЕ переиздаёт draft (никогда не публиковался — нечего переиздавать)", async () => {
	const { channelId } = await setupChannelWithBobViewing();
	await createDraftPost(ALICE_PUB, DB_KEY, channelId, { text: "черновик", attachments: [] });
	await rotateChannelKeyManually(channelId, 2);

	const published = [];
	await republishAllPostsUnderCurrentKey(ALICE_PUB, ALICE_PRIV, DB_KEY, channelId, capturingPublish(published));
	assert.deepEqual(published, []);
});

test("republishAllPostsUnderCurrentKey: НЕ переиздаёт удалённый пост", async () => {
	const { channelId } = await setupChannelWithBobViewing();
	const { postId } = await createDraftPost(ALICE_PUB, DB_KEY, channelId, { text: "будет удалён", attachments: [] });
	await publishPost(ALICE_PUB, ALICE_PRIV, DB_KEY, postId, capturingPublish([]));
	await deletePost(ALICE_PUB, ALICE_PRIV, postId, capturingPublish([]));
	await rotateChannelKeyManually(channelId, 2);

	const published = [];
	await republishAllPostsUnderCurrentKey(ALICE_PUB, ALICE_PRIV, DB_KEY, channelId, capturingPublish(published));
	assert.deepEqual(published, []);
});

test("АДВЕРСАРНО: republishAllPostsUnderCurrentKey — публикация ОДНОГО поста падает, остальные всё равно переиздаются (best-effort)", async () => {
	const { channelId } = await setupChannelWithBobViewing();
	const { postId: failId } = await createDraftPost(ALICE_PUB, DB_KEY, channelId, { text: "упадёт", attachments: [] });
	await publishPost(ALICE_PUB, ALICE_PRIV, DB_KEY, failId, capturingPublish([]));
	const { postId: okId } = await createDraftPost(ALICE_PUB, DB_KEY, channelId, { text: "пройдёт", attachments: [] });
	await publishPost(ALICE_PUB, ALICE_PRIV, DB_KEY, okId, capturingPublish([]));
	await rotateChannelKeyManually(channelId, 2);

	const published = [];
	const flakyPublish = async (event) => {
		const dTag = event.tags.find((t) => t[0] === "d")?.[1];
		if (dTag?.endsWith(failId)) return { ok: false, reason: "симулированный сбой relay" };
		published.push(event);
		return { ok: true };
	};
	await assert.doesNotReject(() => republishAllPostsUnderCurrentKey(ALICE_PUB, ALICE_PRIV, DB_KEY, channelId, flakyPublish));
	assert.equal(published.length, 1, "упавший пост пропущен, остальные переизданы");
	assert.deepEqual(published[0].tags.find((t) => t[0] === "d"), ["d", `${channelId}:${okId}`]);
});

// --- Этап 1 (REDESIGN-SPEC.md) — признаки записи: dueAt/done (plaintext) + title/linkUrl (зашифровано)

test("createDraftPost: title/linkUrl принимаются при создании, dueAt/done всегда стартуют null", async () => {
	const { channelId } = await setupChannelWithBobViewing();
	const { postId } = await createDraftPost(ALICE_PUB, DB_KEY, channelId, {
		text: "текст",
		attachments: [],
		title: "Заголовок",
		linkUrl: "https://example.com",
	});
	const row = fromEncryptedRow(await db.table("posts").get([ALICE_PUB, postId]), DB_KEY);
	assert.equal(row.title, "Заголовок");
	assert.equal(row.linkUrl, "https://example.com");
	assert.equal(row.dueAt, null);
	assert.equal(row.done, null);
});

test("createDraftPost: без title/linkUrl — оба null по умолчанию", async () => {
	const { channelId } = await setupChannelWithBobViewing();
	const { postId } = await createDraftPost(ALICE_PUB, DB_KEY, channelId, { text: "текст", attachments: [] });
	const row = fromEncryptedRow(await db.table("posts").get([ALICE_PUB, postId]), DB_KEY);
	assert.equal(row.title, null);
	assert.equal(row.linkUrl, null);
});

test("AC-16 продолжение: dueAt/done лежат в БД открытым текстом (индексируемые), title/linkUrl — нет", async () => {
	const { channelId } = await setupChannelWithBobViewing();
	const { postId } = await createDraftPost(ALICE_PUB, DB_KEY, channelId, {
		text: "x",
		attachments: [],
		title: "секретный заголовок",
		linkUrl: "https://secret.example",
	});
	await setPostDue(ALICE_PUB, postId, 1700000000);
	const raw = await db.table("posts").get([ALICE_PUB, postId]);
	assert.equal(raw.dueAt, 1700000000, "dueAt читается без расшифровки");
	assert.equal("title" in raw, false, "title не лежит plaintext-полем");
	assert.equal("linkUrl" in raw, false, "linkUrl не лежит plaintext-полем");
	assert.equal(JSON.stringify(raw).includes("секретный заголовок"), false, "сырой дамп не содержит title");
});

test("setPostDue/clearPostDue: устанавливает и снимает срок, не трогая done/title/linkUrl", async () => {
	const { channelId } = await setupChannelWithBobViewing();
	const { postId } = await createDraftPost(ALICE_PUB, DB_KEY, channelId, {
		text: "x",
		attachments: [],
		title: "T",
		linkUrl: "https://l",
	});
	await makePostTask(ALICE_PUB, postId);

	await setPostDue(ALICE_PUB, postId, 1700000000);
	let row = fromEncryptedRow(await db.table("posts").get([ALICE_PUB, postId]), DB_KEY);
	assert.equal(row.dueAt, 1700000000);
	assert.equal(row.done, false, "done не тронут установкой срока");
	assert.equal(row.title, "T");
	assert.equal(row.linkUrl, "https://l");

	await clearPostDue(ALICE_PUB, postId);
	row = fromEncryptedRow(await db.table("posts").get([ALICE_PUB, postId]), DB_KEY);
	assert.equal(row.dueAt, null);
	assert.equal(row.done, false, "снятие срока не стирает отметку дела");
	assert.equal(row.title, "T");
	assert.equal(row.linkUrl, "https://l");
});

test("makePostTask/unmakePostTask/setPostDone: три состояния done, срок не трогают", async () => {
	const { channelId } = await setupChannelWithBobViewing();
	const { postId } = await createDraftPost(ALICE_PUB, DB_KEY, channelId, { text: "x", attachments: [] });
	await setPostDue(ALICE_PUB, postId, 1700000000);

	await makePostTask(ALICE_PUB, postId);
	let row = fromEncryptedRow(await db.table("posts").get([ALICE_PUB, postId]), DB_KEY);
	assert.equal(row.done, false, "makePostTask ставит done=false, не true");
	assert.equal(row.dueAt, 1700000000);

	await setPostDone(ALICE_PUB, postId, true);
	row = fromEncryptedRow(await db.table("posts").get([ALICE_PUB, postId]), DB_KEY);
	assert.equal(row.done, true);
	assert.equal(row.dueAt, 1700000000, "отметка выполнения не стирает срок");

	await unmakePostTask(ALICE_PUB, postId);
	row = fromEncryptedRow(await db.table("posts").get([ALICE_PUB, postId]), DB_KEY);
	assert.equal(row.done, null, "unmakePostTask возвращает done в null (не false)");
	assert.equal(row.dueAt, 1700000000, "unmakePostTask срок НЕ трогает (REDESIGN-SPEC.md, этап 1)");
});

test("АДВЕРСАРНО: setPostDue/setPostDone/makePostTask/unmakePostTask на несуществующий пост -> DomainError", async () => {
	await assert.rejects(() => setPostDue(ALICE_PUB, "нет-такого", 1700000000));
	await assert.rejects(() => clearPostDue(ALICE_PUB, "нет-такого"));
	await assert.rejects(() => setPostDone(ALICE_PUB, "нет-такого", true));
	await assert.rejects(() => makePostTask(ALICE_PUB, "нет-такого"));
	await assert.rejects(() => unmakePostTask(ALICE_PUB, "нет-такого"));
});

// Изоляция по владельцу — составной ключ [ownerPubkey, postId], тот же класс
// пробела, что database.js многократно документирует как реальный найденный
// класс бага (мультиаккаунт на одном устройстве видел чужие данные, этапы
// 25/30/31/36/72). postId существует, но принадлежит ДРУГОМУ владельцу —
// строки [BOB_PUB, postId] в базе нет вообще, обязана бросить, а не молча
// создать чужую запись под чужим postId.
test("АДВЕРСАРНО: чужой postId под своим ownerPubkey -> DomainError, не создаёт и не трогает чужую запись", async () => {
	const { channelId } = await setupChannelWithBobViewing();
	const { postId } = await createDraftPost(ALICE_PUB, DB_KEY, channelId, { text: "алисин пост", attachments: [] });

	await assert.rejects(() => setPostDue(BOB_PUB, postId, 1700000000), /пост не найден/);
	await assert.rejects(() => makePostTask(BOB_PUB, postId), /пост не найден/);

	const bobRow = await db.table("posts").get([BOB_PUB, postId]);
	assert.equal(bobRow, undefined, "чужая запись под тем же postId не создана");
	const aliceRow = fromEncryptedRow(await db.table("posts").get([ALICE_PUB, postId]), DB_KEY);
	assert.equal(aliceRow.dueAt, null, "запись владельца не задета попыткой чужого ownerPubkey");
	assert.equal(aliceRow.done, null);
});

test("setPostDue/setPostDone — локальные, ничего не публикуют", async () => {
	const { channelId } = await setupChannelWithBobViewing();
	const { postId } = await createDraftPost(ALICE_PUB, DB_KEY, channelId, { text: "x", attachments: [] });
	await publishPost(ALICE_PUB, ALICE_PRIV, DB_KEY, postId, capturingPublish([]));

	const published = [];
	await setPostDue(ALICE_PUB, postId, 1700000000);
	await makePostTask(ALICE_PUB, postId);
	assert.deepEqual(published, [], "setPostDue/makePostTask не публикуют события");
});

test("updateDraftPost: правка text/attachments не стирает title/linkUrl/dueAt/done", async () => {
	const { channelId } = await setupChannelWithBobViewing();
	const { postId } = await createDraftPost(ALICE_PUB, DB_KEY, channelId, {
		text: "v1",
		attachments: [],
		title: "T",
		linkUrl: "https://l",
	});
	await setPostDue(ALICE_PUB, postId, 1700000000);
	await makePostTask(ALICE_PUB, postId);

	await updateDraftPost(ALICE_PUB, DB_KEY, postId, { text: "v2", attachments: [] });
	const row = fromEncryptedRow(await db.table("posts").get([ALICE_PUB, postId]), DB_KEY);
	assert.equal(row.text, "v2");
	assert.equal(row.title, "T");
	assert.equal(row.linkUrl, "https://l");
	assert.equal(row.dueAt, 1700000000);
	assert.equal(row.done, false);
});

test("publishPost: relay-payload несёт dueAt/done/title/linkUrl вместе с text/attachments/status", async () => {
	const { channelId } = await setupChannelWithBobViewing();
	const { postId } = await createDraftPost(ALICE_PUB, DB_KEY, channelId, {
		text: "текст",
		attachments: [],
		title: "Заголовок",
		linkUrl: "https://example.com",
	});
	await setPostDue(ALICE_PUB, postId, 1700000000);
	await makePostTask(ALICE_PUB, postId);

	const published = [];
	await publishPost(ALICE_PUB, ALICE_PRIV, DB_KEY, postId, capturingPublish(published));
	const event = published.find((e) => e.kind === 30061);
	const bobKeyRow = fromEncryptedRow(await db.table("channelKeys").get([BOB_PUB, channelId, 1]), DB_KEY);
	const plaintext = decryptChannelContent(event.content, { 1: bobKeyRow.channelKey });
	assert.deepEqual(JSON.parse(plaintext), {
		text: "текст",
		attachments: [],
		status: "published",
		dueAt: 1700000000,
		done: false,
		title: "Заголовок",
		linkUrl: "https://example.com",
		tags: [],
	});
});

test("receivePost: старое событие БЕЗ новых полей -> подставляются null, приём не падает", async () => {
	const { channelId } = await setupChannelWithBobViewing();
	const aliceChannelRow = await db.table("channels").get([ALICE_PUB, channelId]);
	const aliceKeyRow = fromEncryptedRow(await db.table("channelKeys").get([ALICE_PUB, channelId, 1]), DB_KEY);
	const { sign } = await import("../src/core/crypto/sign.js");
	const { encryptChannelContent } = await import("../src/core/crypto/channel-key.js");

	// Событие в СТАРОМ формате (до этапа 1) — payload без dueAt/done/title/linkUrl.
	const oldFormatContent = encryptChannelContent(
		JSON.stringify({ text: "старый пост", attachments: [], status: "published" }),
		aliceKeyRow.channelKey,
		1,
	);
	const oldEvent = sign(
		{
			kind: 30061,
			content: oldFormatContent,
			tags: [
				["d", `${channelId}:old-format-post`],
				["h", aliceChannelRow.channelTopic],
			],
			created_at: Math.floor(Date.now() / 1000),
		},
		ALICE_PRIV,
	);

	const applied = await receivePost(BOB_PUB, DB_KEY, oldEvent);
	assert.equal(applied, true);
	const row = fromEncryptedRow(await db.table("posts").get([BOB_PUB, "old-format-post"]), DB_KEY);
	assert.equal(row.text, "старый пост");
	assert.equal(row.dueAt, null);
	assert.equal(row.done, null);
	assert.equal(row.title, null);
	assert.equal(row.linkUrl, null);
});

test("receivePost: новое событие с полными признаками -> все четыре поля применяются у читателя", async () => {
	const { channelId } = await setupChannelWithBobViewing();
	const { postId } = await createDraftPost(ALICE_PUB, DB_KEY, channelId, {
		text: "с признаками",
		attachments: [],
		title: "Заголовок",
		linkUrl: "https://example.com",
	});
	await setPostDue(ALICE_PUB, postId, 1700000000);
	await makePostTask(ALICE_PUB, postId);

	const published = [];
	await publishPost(ALICE_PUB, ALICE_PRIV, DB_KEY, postId, capturingPublish(published));
	const event = published.find((e) => e.kind === 30061);

	await receivePost(BOB_PUB, DB_KEY, event);
	const row = fromEncryptedRow(await db.table("posts").get([BOB_PUB, postId]), DB_KEY);
	assert.equal(row.dueAt, 1700000000);
	assert.equal(row.done, false);
	assert.equal(row.title, "Заголовок");
	assert.equal(row.linkUrl, "https://example.com");
});

test("republishAllPostsUnderCurrentKey: переносит текущие локальные dueAt/done/title/linkUrl в переизданный payload", async () => {
	const { channelId } = await setupChannelWithBobViewing();
	const { postId } = await createDraftPost(ALICE_PUB, DB_KEY, channelId, {
		text: "старый пост",
		attachments: [],
		title: "Заголовок",
		linkUrl: "https://example.com",
	});
	await publishPost(ALICE_PUB, ALICE_PRIV, DB_KEY, postId, capturingPublish([]));
	await setPostDue(ALICE_PUB, postId, 1700000000);
	await makePostTask(ALICE_PUB, postId);

	const newKeyHex = await rotateChannelKeyManually(channelId, 2);
	const published = [];
	await republishAllPostsUnderCurrentKey(ALICE_PUB, ALICE_PRIV, DB_KEY, channelId, capturingPublish(published));
	const event = published.find((e) => e.kind === 30061);
	const plaintext = decryptChannelContent(event.content, { 2: newKeyHex });
	const parsed = JSON.parse(plaintext);
	assert.equal(parsed.dueAt, 1700000000);
	assert.equal(parsed.done, false);
	assert.equal(parsed.title, "Заголовок");
	assert.equal(parsed.linkUrl, "https://example.com");
});

// --- Этап 1-довесок (CONTRACTS.md) — tags: string[], зашифровано, дефолт []

test("createDraftPost: tags принимаются при создании, по умолчанию []", async () => {
	const { channelId } = await setupChannelWithBobViewing();
	const { postId: withTags } = await createDraftPost(ALICE_PUB, DB_KEY, channelId, { text: "x", attachments: [], tags: ["mls", "разобраться"] });
	const row = fromEncryptedRow(await db.table("posts").get([ALICE_PUB, withTags]), DB_KEY);
	assert.deepEqual(row.tags, ["mls", "разобраться"]);

	const { postId: noTags } = await createDraftPost(ALICE_PUB, DB_KEY, channelId, { text: "y", attachments: [] });
	const row2 = fromEncryptedRow(await db.table("posts").get([ALICE_PUB, noTags]), DB_KEY);
	assert.deepEqual(row2.tags, []);
});

test("AC-16 продолжение: tags лежит зашифрованным — сырой дамп не содержит значений тегов", async () => {
	const { channelId } = await setupChannelWithBobViewing();
	const { postId } = await createDraftPost(ALICE_PUB, DB_KEY, channelId, { text: "x", attachments: [], tags: ["секретный-тег"] });
	const raw = await db.table("posts").get([ALICE_PUB, postId]);
	assert.equal("tags" in raw, false);
	assert.equal(JSON.stringify(raw).includes("секретный-тег"), false);
});

test("setPostTags: работает при любом статусе, не публикует, не трогает остальные признаки", async () => {
	const { channelId } = await setupChannelWithBobViewing();
	const { postId } = await createDraftPost(ALICE_PUB, DB_KEY, channelId, { text: "x", attachments: [] });
	await setPostDue(ALICE_PUB, postId, 1700000000);

	const published = [];
	await setPostTags(ALICE_PUB, DB_KEY, postId, ["грант"]);
	assert.deepEqual(published, [], "setPostTags не публикует на черновике");
	let row = fromEncryptedRow(await db.table("posts").get([ALICE_PUB, postId]), DB_KEY);
	assert.deepEqual(row.tags, ["грант"]);
	assert.equal(row.dueAt, 1700000000, "теги не стирают срок");

	await publishPost(ALICE_PUB, ALICE_PRIV, DB_KEY, postId, capturingPublish(published));
	const afterPublish = published.length;
	await setPostTags(ALICE_PUB, DB_KEY, postId, ["грант", "второй"]);
	assert.equal(published.length, afterPublish, "setPostTags после публикации тоже локальна");
	row = fromEncryptedRow(await db.table("posts").get([ALICE_PUB, postId]), DB_KEY);
	assert.deepEqual(row.tags, ["грант", "второй"]);
});

test("АДВЕРСАРНО: setPostTags на несуществующий пост -> DomainError", async () => {
	await assert.rejects(() => setPostTags(ALICE_PUB, DB_KEY, "нет-такого", ["x"]));
});

test("updateDraftPost: правка text/attachments не стирает tags", async () => {
	const { channelId } = await setupChannelWithBobViewing();
	const { postId } = await createDraftPost(ALICE_PUB, DB_KEY, channelId, { text: "v1", attachments: [], tags: ["a", "b"] });
	await updateDraftPost(ALICE_PUB, DB_KEY, postId, { text: "v2", attachments: [] });
	const row = fromEncryptedRow(await db.table("posts").get([ALICE_PUB, postId]), DB_KEY);
	assert.deepEqual(row.tags, ["a", "b"]);
});

test("publishPost/receivePost: tags едет в relay-payload, старые события без tags -> []", async () => {
	const { channelId } = await setupChannelWithBobViewing();
	const { postId } = await createDraftPost(ALICE_PUB, DB_KEY, channelId, { text: "x", attachments: [], tags: ["mls"] });
	const published = [];
	await publishPost(ALICE_PUB, ALICE_PRIV, DB_KEY, postId, capturingPublish(published));
	const event = published.find((e) => e.kind === 30061);
	const bobKeyRow = fromEncryptedRow(await db.table("channelKeys").get([BOB_PUB, channelId, 1]), DB_KEY);
	assert.deepEqual(JSON.parse(decryptChannelContent(event.content, { 1: bobKeyRow.channelKey })).tags, ["mls"]);

	await receivePost(BOB_PUB, DB_KEY, event);
	const bobRow = fromEncryptedRow(await db.table("posts").get([BOB_PUB, postId]), DB_KEY);
	assert.deepEqual(bobRow.tags, ["mls"]);

	// Старое событие (до довеска) без поля tags вовсе.
	const { encryptChannelContent } = await import("../src/core/crypto/channel-key.js");
	const { sign } = await import("../src/core/crypto/sign.js");
	const aliceChannelRow = await db.table("channels").get([ALICE_PUB, channelId]);
	const aliceKeyRow = fromEncryptedRow(await db.table("channelKeys").get([ALICE_PUB, channelId, 1]), DB_KEY);
	const oldEvent = sign(
		{
			kind: 30061,
			content: encryptChannelContent(JSON.stringify({ text: "старый", attachments: [], status: "published" }), aliceKeyRow.channelKey, 1),
			tags: [["d", `${channelId}:old-no-tags`], ["h", aliceChannelRow.channelTopic]],
			created_at: Math.floor(Date.now() / 1000),
		},
		ALICE_PRIV,
	);
	await receivePost(BOB_PUB, DB_KEY, oldEvent);
	const oldRow = fromEncryptedRow(await db.table("posts").get([BOB_PUB, "old-no-tags"]), DB_KEY);
	assert.deepEqual(oldRow.tags, []);
});
