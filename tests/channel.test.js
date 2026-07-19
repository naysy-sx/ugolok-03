import "fake-indexeddb/auto";
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { db } from "../src/core/store/database.js";
import { getPublicKey } from "../src/core/crypto/keys.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { unwrap as nip59Unwrap } from "../src/core/crypto/nip59.js";
import { decryptChannelContent, decryptChannelKeyGrant } from "../src/core/crypto/channel-key.js";
import { parseAndVerifyAllowlist } from "../src/core/crypto/comment-allowlist.js";
import {
	createChannel,
	listOwnedChannels,
	listAvailableChannels,
	listSubscribedChannels,
	receiveChannelKeyGrant,
	receiveChannelMetadata,
	receiveAllowlistUpdate,
	subscribeToChannelAction,
} from "../src/domain/content/channel.js";
import { CHANNEL_SUBSCRIBE_REQUEST_KIND, handleIncomingSubscribeRequest } from "../src/domain/content/channel-access.js";
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
	await db.table("channelReaders").clear();
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

async function seedGroupWithBob() {
	await db.table("groups").add({ owner: ALICE_PUB, id: "friends", name: "Друзья" });
	await db.table("groupMembers").add({ groupId: "friends", pubkey: BOB_PUB });
}

test("createChannel: без групп -> ни одного VIEW-гранта, канал сугубо локальный (заметочник)", async () => {
	const published = [];
	const { channelId } = await createChannel(
		ALICE_PUB,
		ALICE_PRIV,
		DB_KEY, { name: "Заметки", description: "личное", rules: "" },
		[],
		capturingPublish(published),
	);
	assert.ok(channelId);
	assert.equal(
		published.filter((e) => e.kind === 30053).length,
		0,
		"без групп ни один VIEW-грант не публикуется",
	);
	const owned = await listOwnedChannels(ALICE_PUB);
	assert.equal(owned.length, 1);
	assert.equal(owned[0].name, "Заметки");
});

test("НАЙДЕНО ЖИВЫМ E2E (этап 32): kind 30053 для РАЗНЫХ читателей одного канала несёт РАЗНЫЕ d-теги — без этого relay (NIP-01, d отсутствует = d='') схлопывает гранты разных читателей в один parameterized-replaceable слот, второй читатель замещает грант первого", async () => {
	await db.table("groups").add({ owner: ALICE_PUB, id: "friends", name: "Друзья" });
	await db.table("groupMembers").add({ groupId: "friends", pubkey: BOB_PUB });
	await db.table("groupMembers").add({ groupId: "friends", pubkey: MALLORY_PUB });
	const published = [];
	await createChannel(ALICE_PUB, ALICE_PRIV, DB_KEY, { name: "К", description: "d", rules: "" }, ["friends"], capturingPublish(published));

	const grants = published.filter((e) => e.kind === 30053);
	assert.equal(grants.length, 2, "по гранту на каждого читателя");
	const dTags = grants.map((e) => e.tags.find((t) => t[0] === "d")?.[1]);
	assert.ok(dTags.every(Boolean), "у каждого гранта обязан быть d-тег (не implicit d='')");
	assert.notEqual(dTags[0], dTags[1], "d-теги разных читателей ОБЯЗАНЫ различаться — иначе relay схлопывает их в один слот");
});

test("createChannel: группа с Бобом -> Боб получает kind 30053 (VIEW), метаданные — kind 30060 channelKey-зашифрованы", async () => {
	await seedGroupWithBob();
	const published = [];
	const { channelId } = await createChannel(
		ALICE_PUB,
		ALICE_PRIV,
		DB_KEY, { name: "Котики", description: "фото котиков", rules: "без спама" },
		["friends"],
		capturingPublish(published),
	);

	const grantEvent = published.find((e) => e.kind === 30053);
	assert.ok(grantEvent, "должен быть опубликован VIEW-грант");
	assert.deepEqual(
		grantEvent.tags.find((t) => t[0] === "p"),
		["p", BOB_PUB],
	);
	const grant = decryptChannelKeyGrant(grantEvent.content, BOB_PRIV, ALICE_PUB);
	assert.equal(grant.channelId, channelId);

	const metaEvent = published.find((e) => e.kind === 30060);
	assert.ok(metaEvent, "должны быть опубликованы метаданные канала");
	const metaPlain = decryptChannelContent(metaEvent.content, { 1: grant.channelKey });
	assert.deepEqual(JSON.parse(metaPlain), { name: "Котики", description: "фото котиков", rules: "без спама", avatar: null, allowChatAttachments: true });
});

test("createChannel (этап 33, аддитивная правка): персистит channelReaders для каждого реального получателя VIEW", async () => {
	await seedGroupWithBob();
	const { channelId } = await createChannel(ALICE_PUB, ALICE_PRIV, DB_KEY, { name: "К", description: "d", rules: "" }, ["friends"], capturingPublish([]));
	const readers = await db.table("channelReaders").where("[ownerPubkey+channelId]").equals([ALICE_PUB, channelId]).toArray();
	assert.equal(readers.length, 1);
	assert.equal(readers[0].readerPubkey, BOB_PUB);
});

test("Боб получает VIEW и метаданные -> канал появляется в 'Доступные', не в 'Подписки'", async () => {
	await seedGroupWithBob();
	const published = [];
	await createChannel(ALICE_PUB, ALICE_PRIV, DB_KEY, { name: "Котики", description: "d", rules: "" }, ["friends"], capturingPublish(published));

	const grantEvent = published.find((e) => e.kind === 30053);
	const metaEvent = published.find((e) => e.kind === 30060);

	await receiveChannelKeyGrant(BOB_PUB, BOB_PRIV, DB_KEY, ALICE_PUB, grantEvent);
	await receiveChannelMetadata(BOB_PUB, DB_KEY, metaEvent);

	const available = await listAvailableChannels(BOB_PUB);
	assert.equal(available.length, 1);
	assert.equal(available[0].name, "Котики");
	assert.equal((await listSubscribedChannels(BOB_PUB)).length, 0);
});

test("полный флоу подписки: Боб -> запрос -> Алиса auto-подтверждает -> allowlist -> Боб переезжает в 'Подписки'", async () => {
	await seedGroupWithBob();
	const aliceOutbox = [];
	const { channelId } = await createChannel(ALICE_PUB, ALICE_PRIV, DB_KEY, { name: "Котики", description: "d", rules: "" }, ["friends"], capturingPublish(aliceOutbox));
	const grantEvent = aliceOutbox.find((e) => e.kind === 30053);
	const metaEvent = aliceOutbox.find((e) => e.kind === 30060);
	await receiveChannelKeyGrant(BOB_PUB, BOB_PRIV, DB_KEY, ALICE_PUB, grantEvent);
	await receiveChannelMetadata(BOB_PUB, DB_KEY, metaEvent);

	// Боб отправляет запрос на подписку (gift-wrap, владелец узнаёт получателя через unwrap)
	const bobOutbox = [];
	await subscribeToChannelAction(BOB_PUB, BOB_PRIV, channelId, capturingPublish(bobOutbox));
	const giftWrap = bobOutbox.find((e) => e.kind === 1059);
	assert.ok(giftWrap, "запрос на подписку — gift-wrap, не открытым текстом");

	const rumor = nip59Unwrap(giftWrap, ALICE_PRIV);
	assert.equal(rumor.kind, CHANNEL_SUBSCRIBE_REQUEST_KIND);
	assert.equal(rumor.pubkey, BOB_PUB, "владелец узнаёт РЕАЛЬНОГО отправителя запроса");
	const requestedChannelId = rumor.tags.find((t) => t[0] === "channel_id")[1];
	assert.equal(requestedChannelId, channelId);

	// Алиса (владелец) автоматически подтверждает — без второго клика (group-видимость уже
	// была осознанным решением при создании канала).
	const aliceOutbox2 = [];
	await handleIncomingSubscribeRequest(ALICE_PUB, ALICE_PRIV, DB_KEY, requestedChannelId, rumor.pubkey, capturingPublish(aliceOutbox2));
	const allowlistEvent = aliceOutbox2.find((e) => e.kind === 30054);
	assert.ok(allowlistEvent, "владелец обязан переиздать allowlist (kind 30054)");

	// Боб получает обновлённый allowlist -> его роль повышается локально.
	await receiveAllowlistUpdate(BOB_PUB, DB_KEY, BOB_PUB, allowlistEvent);
	assert.equal((await listAvailableChannels(BOB_PUB)).length, 0, "канал уехал из 'Доступные'");
	const subscribed = await listSubscribedChannels(BOB_PUB);
	assert.equal(subscribed.length, 1);
	assert.equal(subscribed[0].name, "Котики");
});

test("handleIncomingSubscribeRequest: повторный запрос уже подписанного — идемпотентно, allowlist не дублирует pubkey", async () => {
	await seedGroupWithBob();
	const aliceOutbox = [];
	const { channelId } = await createChannel(ALICE_PUB, ALICE_PRIV, DB_KEY, { name: "К", description: "d", rules: "" }, ["friends"], capturingPublish(aliceOutbox));

	const outbox1 = [];
	await handleIncomingSubscribeRequest(ALICE_PUB, ALICE_PRIV, DB_KEY, channelId, BOB_PUB, capturingPublish(outbox1));
	const outbox2 = [];
	await handleIncomingSubscribeRequest(ALICE_PUB, ALICE_PRIV, DB_KEY, channelId, BOB_PUB, capturingPublish(outbox2));

	const meta = await db.table("channelKeyMeta").get([ALICE_PUB, channelId]);
	const allowlistRow = fromEncryptedRow(await db.table("commentAllowlists").get([ALICE_PUB, channelId, meta.currentVersion]), DB_KEY);
	const occurrences = allowlistRow.allowedAuthors.filter((p) => p === BOB_PUB).length;
	assert.equal(occurrences, 1, "повторный запрос не должен дублировать pubkey в allowlist");
});

test("АДВЕРСАРНЫЙ: receiveChannelKeyGrant для ЧУЖОГО получателя (не Mallory) -> throw, не тихо принимает", async () => {
	await seedGroupWithBob();
	const published = [];
	await createChannel(ALICE_PUB, ALICE_PRIV, DB_KEY, { name: "К", description: "d", rules: "" }, ["friends"], capturingPublish(published));
	const grantEvent = published.find((e) => e.kind === 30053); // предназначен Бобу, не Мэллори

	await assert.rejects(() => receiveChannelKeyGrant(MALLORY_PUB, MALLORY_PRIV, DB_KEY, ALICE_PUB, grantEvent));
});

test("АДВЕРСАРНЫЙ: receiveAllowlistUpdate — поддельный allowlist (не от владельца канала) отклоняется, роль не повышается", async () => {
	await seedGroupWithBob();
	const aliceOutbox = [];
	await createChannel(ALICE_PUB, ALICE_PRIV, DB_KEY, { name: "К", description: "d", rules: "" }, ["friends"], capturingPublish(aliceOutbox));
	const grantEvent = aliceOutbox.find((e) => e.kind === 30053);
	const metaEvent = aliceOutbox.find((e) => e.kind === 30060);
	await receiveChannelKeyGrant(BOB_PUB, BOB_PRIV, DB_KEY, ALICE_PUB, grantEvent);
	await receiveChannelMetadata(BOB_PUB, DB_KEY, metaEvent);

	// Mallory (не владелец) публикует "allowlist", включающий Боба — событие подписано ЕЁ
	// ключом, event.pubkey не совпадает с реальным владельцем канала (Алисой).
	const { buildAllowlistEvent } = await import("../src/core/crypto/comment-allowlist.js");
	const { deriveMasterSecret } = await import("../src/core/crypto/derivation.js");
	const grant = decryptChannelKeyGrant(grantEvent.content, BOB_PRIV, ALICE_PUB);
	const forged = buildAllowlistEvent(grant.channelId, grant.channelTopic, 1, [BOB_PUB], grant.channelKey, MALLORY_PRIV, deriveMasterSecret(MALLORY_PRIV));

	await receiveAllowlistUpdate(BOB_PUB, DB_KEY, BOB_PUB, forged);
	assert.equal((await listSubscribedChannels(BOB_PUB)).length, 0, "поддельный allowlist не должен повышать роль");
	assert.equal((await listAvailableChannels(BOB_PUB)).length, 1, "канал остаётся в 'Доступные'");
});
