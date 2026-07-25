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
	editChannel,
	deleteChannel,
	receiveChannelDeletion,
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

// AC-16 (найдено пользователем прямым осмотром IndexedDB) — пользователь буквально
// увидел название группы "Друзья" (а для channels — name/description/rules) открытым текстом.
test("AC-16: channels хранится зашифрованным — сырой дамп не содержит name/description/rules", async () => {
	const { channelId } = await createChannel(
		ALICE_PUB,
		ALICE_PRIV,
		DB_KEY,
		{ name: "Секретный канал", description: "секретное описание", rules: "секретные правила" },
		[],
		capturingPublish([]),
	);
	const raw = await db.table("channels").get([ALICE_PUB, channelId]);
	assert.equal(raw.id, channelId);
	assert.equal("name" in raw, false);
	assert.equal("description" in raw, false);
	assert.equal("rules" in raw, false);
	assert.ok(raw.nonce instanceof Uint8Array);
	assert.ok(raw.ciphertext instanceof Uint8Array);

	const decrypted = fromEncryptedRow(raw, DB_KEY);
	assert.equal(decrypted.name, "Секретный канал");
});

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
	const owned = await listOwnedChannels(ALICE_PUB, DB_KEY);
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

	const available = await listAvailableChannels(BOB_PUB, DB_KEY);
	assert.equal(available.length, 1);
	assert.equal(available[0].name, "Котики");
	assert.equal((await listSubscribedChannels(BOB_PUB, DB_KEY)).length, 0);
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
	assert.equal((await listAvailableChannels(BOB_PUB, DB_KEY)).length, 0, "канал уехал из 'Доступные'");
	const subscribed = await listSubscribedChannels(BOB_PUB, DB_KEY);
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

	const meta = fromEncryptedRow(await db.table("channelKeyMeta").get([ALICE_PUB, channelId]), DB_KEY);
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

// AC-16, Tier 4 (этап 45) — сырой дамп channelKeyMeta не должен содержать
// currentVersion в открытом виде; только ownerPubkey/channelId (составной PK) plaintext.
test("AC-16: сырая запись channelKeyMeta не содержит currentVersion в открытом виде", async () => {
	const { channelId } = await createChannel(ALICE_PUB, ALICE_PRIV, DB_KEY, { name: "К", description: "d", rules: "" }, [], capturingPublish([]));
	const row = await db.table("channelKeyMeta").get([ALICE_PUB, channelId]);
	assert.equal(row.ownerPubkey, ALICE_PUB);
	assert.equal(row.channelId, channelId);
	assert.equal(row.currentVersion, undefined, "currentVersion не должен лежать top-level в открытом виде");
	assert.ok(row.nonce && row.ciphertext);
	const decrypted = fromEncryptedRow(row, DB_KEY);
	assert.equal(decrypted.currentVersion, 1);
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
	assert.equal((await listSubscribedChannels(BOB_PUB, DB_KEY)).length, 0, "поддельный allowlist не должен повышать роль");
	assert.equal((await listAvailableChannels(BOB_PUB, DB_KEY)).length, 1, "канал остаётся в 'Доступные'");
});

// --- editChannel/deleteChannel (этап 50-довесок-2, найдено пользователем: нельзя
// было отредактировать/удалить канал после создания) ---

async function setupOwnedChannelAndBobSubscriber() {
	await seedGroupWithBob();
	const aliceOutbox = [];
	const { channelId } = await createChannel(
		ALICE_PUB, ALICE_PRIV, DB_KEY,
		{ name: "Котики", description: "старое описание", rules: "старые правила" },
		["friends"], capturingPublish(aliceOutbox),
	);
	const grantEvent = aliceOutbox.find((e) => e.kind === 30053);
	const metaEvent = aliceOutbox.find((e) => e.kind === 30060);
	await receiveChannelKeyGrant(BOB_PUB, BOB_PRIV, DB_KEY, ALICE_PUB, grantEvent);
	await receiveChannelMetadata(BOB_PUB, DB_KEY, metaEvent);
	return { channelId };
}

test("editChannel: republish kind-30060 (тот же d-tag), локальная строка владельца обновляется СРАЗУ", async () => {
	const { channelId } = await setupOwnedChannelAndBobSubscriber();
	const published = [];
	await editChannel(ALICE_PUB, ALICE_PRIV, DB_KEY, channelId, { name: "Новое имя", description: "новое описание" }, capturingPublish(published));

	const metaEvent = published.find((e) => e.kind === 30060);
	assert.ok(metaEvent, "обязан republish-нуть kind-30060");
	assert.deepEqual(metaEvent.tags.find((t) => t[0] === "d"), ["d", channelId], "тот же d-tag — parameterized-replaceable заменяет предыдущую версию");

	const owned = await listOwnedChannels(ALICE_PUB, DB_KEY);
	assert.equal(owned[0].name, "Новое имя");
	assert.equal(owned[0].description, "новое описание");
});

test("editChannel: обновляет updatedAt владельца (для \"даты последнего обновления\" в списке каналов)", async () => {
	const { channelId } = await setupOwnedChannelAndBobSubscriber();
	const before = (await listOwnedChannels(ALICE_PUB, DB_KEY))[0];

	await new Promise((resolve) => setTimeout(resolve, 1100)); // updatedAt — секундная точность (Unix ts)
	await editChannel(ALICE_PUB, ALICE_PRIV, DB_KEY, channelId, { name: "Новое имя" }, capturingPublish([]));

	const after = (await listOwnedChannels(ALICE_PUB, DB_KEY))[0];
	assert.ok(after.updatedAt > before.updatedAt, "updatedAt обязан увеличиться после редактирования");
	assert.equal(before.updatedAt, before.createdAt, "сразу после создания updatedAt === createdAt");
});

test("editChannel: подписчик получает ТУ ЖЕ updatedAt через event.created_at (не свой локальный Date.now())", async () => {
	const { channelId } = await setupOwnedChannelAndBobSubscriber();
	const published = [];
	await editChannel(ALICE_PUB, ALICE_PRIV, DB_KEY, channelId, { name: "x" }, capturingPublish(published));
	const metaEvent = published.find((e) => e.kind === 30060);

	await receiveChannelMetadata(BOB_PUB, DB_KEY, metaEvent);

	const owned = (await listOwnedChannels(ALICE_PUB, DB_KEY))[0];
	const available = (await listAvailableChannels(BOB_PUB, DB_KEY))[0];
	assert.equal(available.updatedAt, owned.updatedAt);
	assert.equal(available.updatedAt, metaEvent.created_at);
});

test("editChannel: частичное обновление — непереданные поля СОХРАНЯЮТ текущее значение", async () => {
	const { channelId } = await setupOwnedChannelAndBobSubscriber();
	await editChannel(ALICE_PUB, ALICE_PRIV, DB_KEY, channelId, { name: "Только имя поменялось" }, capturingPublish([]));

	const owned = await listOwnedChannels(ALICE_PUB, DB_KEY);
	assert.equal(owned[0].name, "Только имя поменялось");
	assert.equal(owned[0].description, "старое описание", "description не передан -> не затёрт");
	assert.equal(owned[0].rules, "старые правила", "rules не передан -> не затёрт");
});

test("editChannel: подписчик (Боб) получает обновление через уже существующий receiveChannelMetadata", async () => {
	const { channelId } = await setupOwnedChannelAndBobSubscriber();
	const published = [];
	await editChannel(ALICE_PUB, ALICE_PRIV, DB_KEY, channelId, { name: "Обновлено для всех" }, capturingPublish(published));

	const metaEvent = published.find((e) => e.kind === 30060);
	await receiveChannelMetadata(BOB_PUB, DB_KEY, metaEvent);

	const available = await listAvailableChannels(BOB_PUB, DB_KEY);
	assert.equal(available[0].name, "Обновлено для всех");
});

test("editChannel: НЕ владелец (Боб) не может редактировать -> throw", async () => {
	const { channelId } = await setupOwnedChannelAndBobSubscriber();
	await assert.rejects(() => editChannel(BOB_PUB, BOB_PRIV, DB_KEY, channelId, { name: "x" }, capturingPublish([])));
});

test("deleteChannel: публикует kind-5 адресуемое удаление (a-тег 30060:owner:channelId), локально канал исчезает у владельца", async () => {
	const { channelId } = await setupOwnedChannelAndBobSubscriber();
	const published = [];
	await deleteChannel(ALICE_PUB, ALICE_PRIV, DB_KEY, channelId, capturingPublish(published));

	const delEvent = published.find((e) => e.kind === 5);
	assert.ok(delEvent);
	assert.deepEqual(delEvent.tags.find((t) => t[0] === "a"), ["a", `30060:${ALICE_PUB}:${channelId}`]);

	assert.equal((await listOwnedChannels(ALICE_PUB, DB_KEY)).length, 0);
});

test("deleteChannel: НЕ владелец (Боб) не может удалить -> throw", async () => {
	const { channelId } = await setupOwnedChannelAndBobSubscriber();
	await assert.rejects(() => deleteChannel(BOB_PUB, BOB_PRIV, DB_KEY, channelId, capturingPublish([])));
});

test("receiveChannelDeletion: подписчик (Боб) получает kind-5 от владельца -> канал каскадно исчезает локально", async () => {
	const { channelId } = await setupOwnedChannelAndBobSubscriber();
	const published = [];
	await deleteChannel(ALICE_PUB, ALICE_PRIV, DB_KEY, channelId, capturingPublish(published));
	const delEvent = published.find((e) => e.kind === 5);

	const result = await receiveChannelDeletion(BOB_PUB, DB_KEY, delEvent);
	assert.equal(result.applied, true);
	assert.equal(result.channelName, "Котики", "имя нужно прочитать ДО удаления — для текста уведомления");
	assert.equal((await listAvailableChannels(BOB_PUB, DB_KEY)).length, 0, "канал исчез у подписчика");
});

test("АДВЕРСАРНЫЙ: receiveChannelDeletion — поддельное удаление (не от реального владельца канала) отклоняется", async () => {
	const { channelId } = await setupOwnedChannelAndBobSubscriber();
	// Mallory подписывает kind-5 СВОИМ ключом, но с a-тегом, ссылающимся на канал Алисы
	// (подделывает pubkey ВНУТРИ тега тоже, не только подпись, — двойная проверка обязана
	// поймать обе попытки: event.pubkey реальный подписант ≠ то, что в теге; и ≠ настоящий владелец).
	const { buildAddressableDeletionEvent } = await import("../src/domain/events/handlers.js");
	const forged = buildAddressableDeletionEvent(MALLORY_PRIV, 30060, channelId);

	const result = await receiveChannelDeletion(BOB_PUB, DB_KEY, forged);
	assert.equal(result.applied, false);
	assert.equal((await listAvailableChannels(BOB_PUB, DB_KEY)).length, 1, "канал НЕ должен исчезнуть от поддельного удаления");
});

test("receiveChannelDeletion: неизвестный канал (нет локальной строки) -> no-op, не бросает", async () => {
	const result = await receiveChannelDeletion(BOB_PUB, DB_KEY, {
		kind: 5,
		pubkey: ALICE_PUB,
		tags: [["a", `30060:${ALICE_PUB}:no-such-channel`]],
	});
	assert.equal(result.applied, false);
});
