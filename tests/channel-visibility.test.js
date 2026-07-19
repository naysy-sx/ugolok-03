import "fake-indexeddb/auto";
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { db } from "../src/core/store/database.js";
import { getPublicKey } from "../src/core/crypto/keys.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { createChannel, receiveChannelKeyGrant, receiveAllowlistUpdate } from "../src/domain/content/channel.js";
import { handleIncomingSubscribeRequest } from "../src/domain/content/channel-access.js";
import { CHANNEL_BAN_KIND } from "../src/domain/content/moderation.js";
import { findChannelIdsByVisibilityGroup, revokeViewFromMember, revokeIfNoLongerVisible } from "../src/domain/content/channel-visibility.js";
import { groups, createGroupAction, addGroupMemberAction, removeGroupMemberAction } from "../src/ui/signals/contacts.js";
import { fromEncryptedRow } from "../src/core/store/encrypted-table.js";

const ALICE_PRIV = new Uint8Array(32).fill(1);
const BOB_PRIV = new Uint8Array(32).fill(2);
const MALLORY_PRIV = new Uint8Array(32).fill(3);
const CAROL_PRIV = new Uint8Array(32).fill(4);
const ALICE_PUB = bytesToHex(getPublicKey(ALICE_PRIV));
const BOB_PUB = bytesToHex(getPublicKey(BOB_PRIV));
const MALLORY_PUB = bytesToHex(getPublicKey(MALLORY_PRIV));
const CAROL_PUB = bytesToHex(getPublicKey(CAROL_PRIV));
const DB_KEY = crypto.getRandomValues(new Uint8Array(32));

before(async () => {
	await db.open();
});

beforeEach(async () => {
	await db.table("channels").clear();
	await db.table("channelKeys").clear();
	await db.table("channelKeyMeta").clear();
	await db.table("commentAllowlists").clear();
	await db.table("channelVisibilityGroups").clear();
	await db.table("groups").clear();
	await db.table("groupMembers").clear();
	await db.table("channelReaders").clear();
	await db.table("bannedMembers").clear();
	groups.value = [];
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

// Одна группа "friends" (Боб+Mallory) даёт видимость каналу — прямой прецедент
// moderation.test.js's setupChannelWithTwoReadersOneSubscribed, тот же фикстурный стиль.
async function setupChannelOneGroup() {
	await db.table("groups").add({ owner: ALICE_PUB, id: "friends", name: "Друзья" });
	await db.table("groupMembers").add({ groupId: "friends", pubkey: BOB_PUB });
	await db.table("groupMembers").add({ groupId: "friends", pubkey: MALLORY_PUB });
	const aliceOutbox = [];
	const { channelId } = await createChannel(ALICE_PUB, ALICE_PRIV, DB_KEY,
		{ name: "К", description: "d", rules: "" }, ["friends"], capturingPublish(aliceOutbox));
	return { channelId };
}

// ДВЕ группы дают видимость одному каналу — "friends" (Боб) и "family" (Боб И Кэрол).
// Боб виден через ОБЕ, Кэрол — только через "family".
async function setupChannelTwoGroups() {
	await db.table("groups").add({ owner: ALICE_PUB, id: "friends", name: "Друзья" });
	await db.table("groupMembers").add({ groupId: "friends", pubkey: BOB_PUB });
	await db.table("groups").add({ owner: ALICE_PUB, id: "family", name: "Семья" });
	await db.table("groupMembers").add({ groupId: "family", pubkey: BOB_PUB });
	await db.table("groupMembers").add({ groupId: "family", pubkey: CAROL_PUB });
	const aliceOutbox = [];
	const { channelId } = await createChannel(
		ALICE_PUB,
		ALICE_PRIV,
		DB_KEY,
		{ name: "К", description: "d", rules: "" },
		["friends", "family"],
		capturingPublish(aliceOutbox),
	);
	return { channelId };
}

test("createChannel: персистит channelVisibilityGroups — одна строка на каждый переданный groupId", async () => {
	const { channelId } = await setupChannelTwoGroups();
	const rows = await db.table("channelVisibilityGroups").where("[ownerPubkey+channelId]").equals([ALICE_PUB, channelId]).toArray();
	assert.deepEqual(
		rows.map((r) => r.groupId).sort(),
		["family", "friends"],
	);
});

test("createChannel: groupIds=[] (канал-заметочник) — channelVisibilityGroups остаётся пустой", async () => {
	const { channelId } = await createChannel(ALICE_PUB, ALICE_PRIV, DB_KEY,
		{ name: "Заметки", description: "d", rules: "" }, [], capturingPublish([]));
	const rows = await db.table("channelVisibilityGroups").where("[ownerPubkey+channelId]").equals([ALICE_PUB, channelId]).toArray();
	assert.deepEqual(rows, []);
});

test("findChannelIdsByVisibilityGroup: находит канал по связанной группе, пусто для несвязанной", async () => {
	const { channelId } = await setupChannelOneGroup();
	assert.deepEqual(await findChannelIdsByVisibilityGroup(ALICE_PUB, "friends"), [channelId]);
	assert.deepEqual(await findChannelIdsByVisibilityGroup(ALICE_PUB, "unrelated-group"), []);
});

test("revokeViewFromMember: ротирует channelKey, реиздаёт грант ОСТАВШЕМУСЯ читателю, удаляет target из channelReaders — БЕЗ бан-объявления", async () => {
	const { channelId } = await setupChannelOneGroup();
	const published = [];
	await revokeViewFromMember(ALICE_PUB, ALICE_PRIV, DB_KEY, channelId, BOB_PUB, capturingPublish(published));

	const grants = published.filter((e) => e.kind === 30053);
	assert.equal(grants.length, 1, "новый грант — только Mallory, не Бобу");
	assert.deepEqual(grants[0].tags.find((t) => t[0] === "p"), ["p", MALLORY_PUB]);

	const meta = await db.table("channelKeyMeta").get([ALICE_PUB, channelId]);
	assert.equal(meta.currentVersion, 2, "версия ключа увеличена");

	const readers = await db.table("channelReaders").where("[ownerPubkey+channelId]").equals([ALICE_PUB, channelId]).toArray();
	assert.deepEqual(readers.map((r) => r.readerPubkey), [MALLORY_PUB]);

	assert.ok(!published.some((e) => e.kind === CHANNEL_BAN_KIND), "это не бан — объявление о бане не публикуется");
	const banRow = await db.table("bannedMembers").get([ALICE_PUB, channelId, BOB_PUB]);
	assert.equal(banRow, undefined, "не должен появляться в bannedMembers — вышел из группы, не забанен");
});

test("revokeViewFromMember: переиздаёт allowlist БЕЗ target (если был подписчиком)", async () => {
	const { channelId } = await setupChannelOneGroup();
	// Боб подписывается (COMMENT) — попадает в commentAllowlists текущей версии.
	await handleIncomingSubscribeRequest(ALICE_PUB, ALICE_PRIV, DB_KEY, channelId, BOB_PUB, capturingPublish([]));

	const published = [];
	await revokeViewFromMember(ALICE_PUB, ALICE_PRIV, DB_KEY, channelId, BOB_PUB, capturingPublish(published));

	const meta = await db.table("channelKeyMeta").get([ALICE_PUB, channelId]);
	const allowlistRow = fromEncryptedRow(await db.table("commentAllowlists").get([ALICE_PUB, channelId, meta.currentVersion]), DB_KEY);
	assert.ok(allowlistRow);
	assert.ok(!allowlistRow.allowedAuthors.includes(BOB_PUB), "Боб исключён из нового allowlist");
});

test("revokeIfNoLongerVisible: pubkey состоял ТОЛЬКО в удаляемой группе — VIEW отзывается", async () => {
	const { channelId } = await setupChannelOneGroup();
	await db.table("groupMembers").where("[groupId+pubkey]").equals(["friends", BOB_PUB]).delete();

	const published = [];
	await revokeIfNoLongerVisible(ALICE_PUB, ALICE_PRIV, DB_KEY, BOB_PUB, "friends", capturingPublish(published));

	const readers = await db.table("channelReaders").where("[ownerPubkey+channelId]").equals([ALICE_PUB, channelId]).toArray();
	assert.deepEqual(readers.map((r) => r.readerPubkey), [MALLORY_PUB], "Боб отозван, Mallory остаётся");
	const meta = await db.table("channelKeyMeta").get([ALICE_PUB, channelId]);
	assert.equal(meta.currentVersion, 2, "ключ ротирован");
});

test("revokeIfNoLongerVisible: pubkey всё ещё виден через ДРУГУЮ привязанную группу — НЕ отзывается", async () => {
	const { channelId } = await setupChannelTwoGroups();
	// Боб выходит из "friends", но остаётся в "family" — видимость канала сохраняется.
	await db.table("groupMembers").where("[groupId+pubkey]").equals(["friends", BOB_PUB]).delete();

	const published = [];
	await revokeIfNoLongerVisible(ALICE_PUB, ALICE_PRIV, DB_KEY, BOB_PUB, "friends", capturingPublish(published));

	const readers = await db.table("channelReaders").where("[ownerPubkey+channelId]").equals([ALICE_PUB, channelId]).toArray();
	assert.deepEqual(
		readers.map((r) => r.readerPubkey).sort(),
		[BOB_PUB, CAROL_PUB].sort(),
		"Боб НЕ отозван — виден через family",
	);
	const meta = await db.table("channelKeyMeta").get([ALICE_PUB, channelId]);
	assert.equal(meta.currentVersion, 1, "ключ НЕ ротирован — отзыва не было");
	assert.deepEqual(published, [], "publish не должен вызываться, если отзыва не произошло");
});

test("revokeIfNoLongerVisible: группа не связана ни с одним каналом — no-op, не бросает", async () => {
	await setupChannelOneGroup();
	const published = [];
	await revokeIfNoLongerVisible(ALICE_PUB, ALICE_PRIV, DB_KEY, BOB_PUB, "unrelated-group", capturingPublish(published));
	assert.deepEqual(published, []);
});

test("revokeIfNoLongerVisible АДВЕРСАРНО: pubkey никогда не был читателем этого канала — no-op, не бросает", async () => {
	const { channelId } = await setupChannelOneGroup(); // friends = {Боб, Mallory}, Кэрол не входит
	const published = [];
	await revokeIfNoLongerVisible(ALICE_PUB, ALICE_PRIV, DB_KEY, CAROL_PUB, "friends", capturingPublish(published));
	assert.deepEqual(published, []);
	const readers = await db.table("channelReaders").where("[ownerPubkey+channelId]").equals([ALICE_PUB, channelId]).toArray();
	assert.equal(readers.length, 2, "существующие читатели не тронуты");
});

test("ИНТЕГРАЦИЯ: removeGroupMemberAction (signals/contacts.js) реально отзывает VIEW у того, кто состоял только в одной группе, и НЕ трогает того, кто виден ещё и через другую", async () => {
	await createGroupAction(ALICE_PUB, ALICE_PRIV, "Друзья", capturingPublish([]));
	const friendsId = groups.value.find((g) => g.name === "Друзья").id;
	await addGroupMemberAction(ALICE_PUB, ALICE_PRIV, friendsId, BOB_PUB, capturingPublish([]));

	await createGroupAction(ALICE_PUB, ALICE_PRIV, "Семья", capturingPublish([]));
	const familyId = groups.value.find((g) => g.name === "Семья").id;
	await addGroupMemberAction(ALICE_PUB, ALICE_PRIV, familyId, BOB_PUB, capturingPublish([]));
	await addGroupMemberAction(ALICE_PUB, ALICE_PRIV, familyId, CAROL_PUB, capturingPublish([]));

	const { channelId } = await createChannel(
		ALICE_PUB,
		ALICE_PRIV,
		DB_KEY,
		{ name: "К", description: "d", rules: "" },
		[friendsId, familyId],
		capturingPublish([]),
	);

	const published = [];
	// Боб выходит из "Друзья" — остаётся видим через "Семья", отзыва быть не должно.
	await removeGroupMemberAction(ALICE_PUB, ALICE_PRIV, DB_KEY, friendsId, BOB_PUB, capturingPublish(published));
	let readers = await db.table("channelReaders").where("[ownerPubkey+channelId]").equals([ALICE_PUB, channelId]).toArray();
	assert.deepEqual(readers.map((r) => r.readerPubkey).sort(), [BOB_PUB, CAROL_PUB].sort(), "Боб ещё виден через Семья");

	// Кэрол выходит из "Семья" — это была её ЕДИНСТВЕННАЯ видящая группа, VIEW отзывается.
	await removeGroupMemberAction(ALICE_PUB, ALICE_PRIV, DB_KEY, familyId, CAROL_PUB, capturingPublish(published));
	readers = await db.table("channelReaders").where("[ownerPubkey+channelId]").equals([ALICE_PUB, channelId]).toArray();
	assert.deepEqual(readers.map((r) => r.readerPubkey), [BOB_PUB], "Кэрол отозвана, Боб остаётся");
});
