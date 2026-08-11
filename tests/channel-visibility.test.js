import "fake-indexeddb/auto";
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { db } from "../src/core/store/database.js";
import { getPublicKey } from "../src/core/crypto/keys.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { createChannel, receiveChannelKeyGrant, receiveAllowlistUpdate } from "../src/domain/content/channel.js";
import { handleIncomingSubscribeRequest } from "../src/domain/content/channel-access.js";
import { CHANNEL_BAN_KIND } from "../src/domain/content/moderation.js";
import { findChannelIdsByVisibilityGroup, revokeViewFromMember, revokeIfNoLongerVisible, addVisibilityGroup, removeVisibilityGroup, listChannelVisibilityGroupIds, applyChannelUnviewRumor } from "../src/domain/content/channel-visibility.js";
import { CHANNEL_UNVIEW_KIND } from "../src/domain/content/channel-access.js";
import { decryptChannelKeyGrant } from "../src/core/crypto/channel-key.js";
import { unwrap as nip59Unwrap, wrap as nip59Wrap } from "../src/core/crypto/nip59.js";
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

	// Этап 55 — владелец теперь ВСЕГДА в channelReaders (self-грант) — ротация
	// перевыдаёт ключ Mallory И владельцу, не только Mallory.
	const grants = published.filter((e) => e.kind === 30053);
	assert.equal(grants.length, 2, "новый грант — Mallory И владельцу (self), не Бобу");
	const grantTargets = grants.map((e) => e.tags.find((t) => t[0] === "p")[1]).sort();
	assert.deepEqual(grantTargets, [ALICE_PUB, MALLORY_PUB].sort());

	const meta = fromEncryptedRow(await db.table("channelKeyMeta").get([ALICE_PUB, channelId]), DB_KEY);
	assert.equal(meta.currentVersion, 2, "версия ключа увеличена");

	const readers = await db.table("channelReaders").where("[ownerPubkey+channelId]").equals([ALICE_PUB, channelId]).toArray();
	assert.deepEqual(readers.map((r) => r.readerPubkey).sort(), [ALICE_PUB, MALLORY_PUB].sort());

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

	const meta = fromEncryptedRow(await db.table("channelKeyMeta").get([ALICE_PUB, channelId]), DB_KEY);
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
	assert.deepEqual(readers.map((r) => r.readerPubkey).sort(), [ALICE_PUB, MALLORY_PUB].sort(), "Боб отозван, Mallory и владелец (self) остаются");
	const meta = fromEncryptedRow(await db.table("channelKeyMeta").get([ALICE_PUB, channelId]), DB_KEY);
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
		[ALICE_PUB, BOB_PUB, CAROL_PUB].sort(),
		"Боб НЕ отозван — виден через family; владелец (self) — постоянная строка",
	);
	const meta = fromEncryptedRow(await db.table("channelKeyMeta").get([ALICE_PUB, channelId]), DB_KEY);
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
	assert.equal(readers.length, 3, "существующие читатели не тронуты (Боб+Mallory+self владельца)");
});

test("ИНТЕГРАЦИЯ: removeGroupMemberAction (signals/contacts.js) реально отзывает VIEW у того, кто состоял только в одной группе, и НЕ трогает того, кто виден ещё и через другую", async () => {
	await createGroupAction(ALICE_PUB, ALICE_PRIV, DB_KEY, "Друзья", capturingPublish([]));
	const friendsId = groups.value.find((g) => g.name === "Друзья").id;
	await addGroupMemberAction(ALICE_PUB, ALICE_PRIV, DB_KEY, friendsId, BOB_PUB, capturingPublish([]));

	await createGroupAction(ALICE_PUB, ALICE_PRIV, DB_KEY, "Семья", capturingPublish([]));
	const familyId = groups.value.find((g) => g.name === "Семья").id;
	await addGroupMemberAction(ALICE_PUB, ALICE_PRIV, DB_KEY, familyId, BOB_PUB, capturingPublish([]));
	await addGroupMemberAction(ALICE_PUB, ALICE_PRIV, DB_KEY, familyId, CAROL_PUB, capturingPublish([]));

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
	assert.deepEqual(readers.map((r) => r.readerPubkey).sort(), [ALICE_PUB, BOB_PUB, CAROL_PUB].sort(), "Боб ещё виден через Семья; владелец (self) — постоянная строка");

	// Кэрол выходит из "Семья" — это была её ЕДИНСТВЕННАЯ видящая группа, VIEW отзывается.
	await removeGroupMemberAction(ALICE_PUB, ALICE_PRIV, DB_KEY, familyId, CAROL_PUB, capturingPublish(published));
	readers = await db.table("channelReaders").where("[ownerPubkey+channelId]").equals([ALICE_PUB, channelId]).toArray();
	assert.deepEqual(readers.map((r) => r.readerPubkey).sort(), [ALICE_PUB, BOB_PUB].sort(), "Кэрол отозвана, Боб и владелец (self) остаются");
});

// --- addVisibilityGroup/removeVisibilityGroup (этап 74, найдено живой проверкой:
// группы видимости задавались ТОЛЬКО при createChannel, editChannel не умел их
// менять — UI редактирования канала не имел полей про группы вовсе) ---

test("addVisibilityGroup: новая группа после создания канала (изначально groupIds=[]) -> её участники получают VIEW-грант", async () => {
	const { channelId } = await createChannel(ALICE_PUB, ALICE_PRIV, DB_KEY, { name: "К", description: "d", rules: "" }, [], capturingPublish([]));
	await db.table("groups").add({ owner: ALICE_PUB, id: "friends", name: "Друзья" });
	await db.table("groupMembers").add({ groupId: "friends", pubkey: BOB_PUB });

	const published = [];
	await addVisibilityGroup(ALICE_PUB, ALICE_PRIV, DB_KEY, channelId, "friends", capturingPublish(published));

	const grantEvent = published.find((e) => e.kind === 30053 && e.tags.find((t) => t[0] === "p")?.[1] === BOB_PUB);
	assert.ok(grantEvent, "Боб обязан получить VIEW-грант");
	const grant = decryptChannelKeyGrant(grantEvent.content, BOB_PRIV, ALICE_PUB);
	assert.equal(grant.channelId, channelId);

	const readerRow = await db.table("channelReaders").get([ALICE_PUB, channelId, BOB_PUB]);
	assert.ok(readerRow, "Боб обязан появиться в channelReaders");
});

test("addVisibilityGroup: записывает channelVisibilityGroups -> listChannelVisibilityGroupIds видит новую группу", async () => {
	const { channelId } = await createChannel(ALICE_PUB, ALICE_PRIV, DB_KEY, { name: "К", description: "d", rules: "" }, [], capturingPublish([]));
	await db.table("groups").add({ owner: ALICE_PUB, id: "friends", name: "Друзья" });

	await addVisibilityGroup(ALICE_PUB, ALICE_PRIV, DB_KEY, channelId, "friends", capturingPublish([]));

	assert.deepEqual(await listChannelVisibilityGroupIds(ALICE_PUB, channelId), ["friends"]);
});

test("addVisibilityGroup: участник, уже видящий канал через ДРУГУЮ группу, НЕ получает повторный грант", async () => {
	// Боб — в обеих группах ("friends" уже привязана, "family" — новая).
	const { channelId } = await setupChannelOneGroup(); // friends = {Боб, Mallory}
	await db.table("groups").add({ owner: ALICE_PUB, id: "family", name: "Семья" });
	await db.table("groupMembers").add({ groupId: "family", pubkey: BOB_PUB });

	const published = [];
	await addVisibilityGroup(ALICE_PUB, ALICE_PRIV, DB_KEY, channelId, "family", capturingPublish(published));

	const bobGrants = published.filter((e) => e.kind === 30053 && e.tags.find((t) => t[0] === "p")?.[1] === BOB_PUB);
	assert.equal(bobGrants.length, 0, "Боб уже читатель через friends — лишний грант не нужен");
});

test("addVisibilityGroup: НЕ владелец канала -> throw, ничего не публикует", async () => {
	const { channelId } = await createChannel(ALICE_PUB, ALICE_PRIV, DB_KEY, { name: "К", description: "d", rules: "" }, [], capturingPublish([]));
	// Боб получает self-грант через штатный путь (симулирует "у Боба уже есть
	// локальная строка этого канала с ролью available") — реальный сценарий:
	// он получил kind:30053 от Алисы для ДРУГОЙ причины (например, теста выше),
	// здесь просто напрямую сеет строку channels с ролью НЕ-owner.
	const { toEncryptedRow } = await import("../src/core/store/encrypted-table.js");
	const { CHANNELS_PLAINTEXT_FIELDS } = await import("../src/core/store/table-fields.js");
	await db.table("channels").put(
		toEncryptedRow(
			{ ownerPubkey: BOB_PUB, id: channelId, creatorPubkey: ALICE_PUB, name: "К", description: "d", rules: "", avatar: null, allowChatAttachments: true, channelTopic: "x", role: "available", createdAt: 1, updatedAt: 1 },
			CHANNELS_PLAINTEXT_FIELDS,
			DB_KEY,
		),
	);
	const published = [];
	await assert.rejects(() => addVisibilityGroup(BOB_PUB, BOB_PRIV, DB_KEY, channelId, "friends", capturingPublish(published)));
	assert.deepEqual(published, []);
});

test("addVisibilityGroup: несуществующий канал -> throw", async () => {
	await assert.rejects(() => addVisibilityGroup(ALICE_PUB, ALICE_PRIV, DB_KEY, "nonexistent", "friends", capturingPublish([])));
});

test("removeVisibilityGroup: участник, видимый ТОЛЬКО через удаляемую группу -> отзывается (ключ ротируется)", async () => {
	const { channelId } = await setupChannelOneGroup(); // friends = {Боб, Mallory}
	const metaBefore = fromEncryptedRow(await db.table("channelKeyMeta").get([ALICE_PUB, channelId]), DB_KEY);

	await removeVisibilityGroup(ALICE_PUB, ALICE_PRIV, DB_KEY, channelId, "friends", capturingPublish([]));

	const readers = await db.table("channelReaders").where("[ownerPubkey+channelId]").equals([ALICE_PUB, channelId]).toArray();
	assert.deepEqual(readers.map((r) => r.readerPubkey), [ALICE_PUB], "Боб и Mallory отозваны (видны были ТОЛЬКО через friends); владелец (self-грант, этап 55) — постоянная строка");
	const metaAfter = fromEncryptedRow(await db.table("channelKeyMeta").get([ALICE_PUB, channelId]), DB_KEY);
	assert.ok(metaAfter.currentVersion > metaBefore.currentVersion, "ключ обязан ротироваться");
});

test("removeVisibilityGroup: участник, видимый ЕЩЁ через другую группу -> НЕ отзывается", async () => {
	const { channelId } = await setupChannelTwoGroups(); // friends={Боб}, family={Боб,Кэрол}

	await removeVisibilityGroup(ALICE_PUB, ALICE_PRIV, DB_KEY, channelId, "friends", capturingPublish([]));

	const readers = await db.table("channelReaders").where("[ownerPubkey+channelId]").equals([ALICE_PUB, channelId]).toArray();
	assert.deepEqual(readers.map((r) => r.readerPubkey).sort(), [ALICE_PUB, BOB_PUB, CAROL_PUB].sort(), "Боб всё ещё виден через family — не отозван");
});

test("removeVisibilityGroup: удаляет запись channelVisibilityGroups (группа больше не привязана к каналу)", async () => {
	const { channelId } = await setupChannelOneGroup();

	await removeVisibilityGroup(ALICE_PUB, ALICE_PRIV, DB_KEY, channelId, "friends", capturingPublish([]));

	assert.deepEqual(await listChannelVisibilityGroupIds(ALICE_PUB, channelId), []);
});

test("removeVisibilityGroup: владелец НИКОГДА не отзывается, даже если технически состоит в удаляемой группе", async () => {
	const { channelId } = await createChannel(ALICE_PUB, ALICE_PRIV, DB_KEY, { name: "К", description: "d", rules: "" }, [], capturingPublish([]));
	await db.table("groups").add({ owner: ALICE_PUB, id: "friends", name: "Друзья" });
	// Необычный, но возможный случай: владелец сам добавлен в группу видимости.
	await db.table("groupMembers").add({ groupId: "friends", pubkey: ALICE_PUB });
	await addVisibilityGroup(ALICE_PUB, ALICE_PRIV, DB_KEY, channelId, "friends", capturingPublish([]));

	await removeVisibilityGroup(ALICE_PUB, ALICE_PRIV, DB_KEY, channelId, "friends", capturingPublish([]));

	const ownerReaderRow = await db.table("channelReaders").get([ALICE_PUB, channelId, ALICE_PUB]);
	assert.ok(ownerReaderRow, "владелец обязан остаться читателем собственного канала (self-грант, этап 55)");
});

test("removeVisibilityGroup: НЕ владелец -> throw", async () => {
	const { channelId } = await createChannel(ALICE_PUB, ALICE_PRIV, DB_KEY, { name: "К", description: "d", rules: "" }, [], capturingPublish([]));
	const { toEncryptedRow } = await import("../src/core/store/encrypted-table.js");
	const { CHANNELS_PLAINTEXT_FIELDS } = await import("../src/core/store/table-fields.js");
	await db.table("channels").put(
		toEncryptedRow(
			{ ownerPubkey: BOB_PUB, id: channelId, creatorPubkey: ALICE_PUB, name: "К", description: "d", rules: "", avatar: null, allowChatAttachments: true, channelTopic: "x", role: "available", createdAt: 1, updatedAt: 1 },
			CHANNELS_PLAINTEXT_FIELDS,
			DB_KEY,
		),
	);
	await assert.rejects(() => removeVisibilityGroup(BOB_PUB, BOB_PRIV, DB_KEY, channelId, "friends", capturingPublish([])));
});

test("listChannelVisibilityGroupIds: канал без групп (создан пустым) -> пустой массив", async () => {
	const { channelId } = await createChannel(ALICE_PUB, ALICE_PRIV, DB_KEY, { name: "К", description: "d", rules: "" }, [], capturingPublish([]));
	assert.deepEqual(await listChannelVisibilityGroupIds(ALICE_PUB, channelId), []);
});

// --- Уведомление отозванного читателя (этап 74, найдено живой проверкой) ---
// revokeViewFromMember раньше НЕ сообщал target'у о потере доступа вовсе (не
// бан — сознательно без публичного объявления) — его локальная строка channels
// оставалась НАВСЕГДА с устаревшими кэшированными данными, канал не исчезал
// из "Доступные", "Подписаться" оставалась кликабельной. Приватный (gift-wrap,
// НЕ публичный бан) сигнал — тот же уровень приватности, что CONTACT_REJECTED_KIND/
// ACQUAINT_CANCELLED_KIND, но адресован НЕПОСРЕДСТВЕННО отозванному, не всем
// участникам группы под #h.

test("revokeViewFromMember: отправляет ПРИВАТНОЕ (gift-wrap) уведомление отозванному, содержащее channelId", async () => {
	const { channelId } = await setupChannelOneGroup(); // friends = {Боб, Mallory}
	const published = [];
	await revokeViewFromMember(ALICE_PUB, ALICE_PRIV, DB_KEY, channelId, BOB_PUB, capturingPublish(published));

	const giftWraps = published.filter((e) => e.kind === 1059);
	const unviewWrap = giftWraps.find((e) => {
		try {
			return nip59Unwrap(e, BOB_PRIV).kind === CHANNEL_UNVIEW_KIND;
		} catch {
			return false;
		}
	});
	assert.ok(unviewWrap, "Боб обязан получить gift-wrapped уведомление об отзыве");
	const rumor = nip59Unwrap(unviewWrap, BOB_PRIV);
	assert.equal(rumor.pubkey, ALICE_PUB, "уведомление подписано реальным владельцем канала");
	assert.deepEqual(JSON.parse(rumor.content), { channelId });

	// Mallory (остаётся читателем) НЕ должна получить это уведомление.
	const mallorySeesIt = giftWraps.some((e) => {
		try {
			return nip59Unwrap(e, MALLORY_PRIV).kind === CHANNEL_UNVIEW_KIND;
		} catch {
			return false;
		}
	});
	assert.equal(mallorySeesIt, false, "уведомление адресовано ТОЛЬКО отозванному, не остальным читателям");
});

test("applyChannelUnviewRumor: полный сценарий — Боб уже видел канал локально, получает уведомление -> канал и связанные данные исчезают", async () => {
	const aliceOutbox = [];
	await db.table("groups").add({ owner: ALICE_PUB, id: "friends", name: "Друзья" });
	await db.table("groupMembers").add({ groupId: "friends", pubkey: BOB_PUB });
	const { channelId } = await createChannel(ALICE_PUB, ALICE_PRIV, DB_KEY, { name: "К", description: "d", rules: "" }, ["friends"], capturingPublish(aliceOutbox));
	const grantEvent = aliceOutbox.find((e) => e.kind === 30053 && e.tags.find((t) => t[0] === "p")?.[1] === BOB_PUB);
	await receiveChannelKeyGrant(BOB_PUB, BOB_PRIV, DB_KEY, ALICE_PUB, grantEvent);
	const bobRawBefore = await db.table("channels").get([BOB_PUB, channelId]);
	assert.ok(bobRawBefore, "предусловие: у Боба ЕСТЬ локальная строка канала");

	const revokePublished = [];
	await revokeViewFromMember(ALICE_PUB, ALICE_PRIV, DB_KEY, channelId, BOB_PUB, capturingPublish(revokePublished));
	const unviewWrap = revokePublished.find((e) => {
		try {
			return nip59Unwrap(e, BOB_PRIV).kind === CHANNEL_UNVIEW_KIND;
		} catch {
			return false;
		}
	});
	const rumor = nip59Unwrap(unviewWrap, BOB_PRIV);

	await applyChannelUnviewRumor(BOB_PUB, DB_KEY, rumor);

	const bobRawAfter = await db.table("channels").get([BOB_PUB, channelId]);
	assert.equal(bobRawAfter, undefined, "канал обязан исчезнуть у Боба локально");
});

test("applyChannelUnviewRumor: НЕ владелец канала может быть удалён, но СВОЙ (role='owner') канал — НИКОГДА, даже с совпадающим channelId", async () => {
	const { channelId } = await createChannel(ALICE_PUB, ALICE_PRIV, DB_KEY, { name: "Мой канал", description: "d", rules: "" }, [], capturingPublish([]));
	// Синтетический (поддельный/ошибочный) rumor, ссылающийся на СОБСТВЕННЫЙ канал Алисы.
	const forgedRumor = { pubkey: ALICE_PUB, content: JSON.stringify({ channelId }), kind: CHANNEL_UNVIEW_KIND };

	await applyChannelUnviewRumor(ALICE_PUB, DB_KEY, forgedRumor);

	const stillThere = await db.table("channels").get([ALICE_PUB, channelId]);
	assert.ok(stillThere, "собственный (role='owner') канал не должен удаляться через этот путь ни при каких условиях");
});

test("АДВЕРСАРНО: applyChannelUnviewRumor — поддельное уведомление (rumor.pubkey НЕ настоящий владелец канала) отклоняется", async () => {
	const aliceOutbox = [];
	await db.table("groups").add({ owner: ALICE_PUB, id: "friends", name: "Друзья" });
	await db.table("groupMembers").add({ groupId: "friends", pubkey: BOB_PUB });
	const { channelId } = await createChannel(ALICE_PUB, ALICE_PRIV, DB_KEY, { name: "К", description: "d", rules: "" }, ["friends"], capturingPublish(aliceOutbox));
	const grantEvent = aliceOutbox.find((e) => e.kind === 30053 && e.tags.find((t) => t[0] === "p")?.[1] === BOB_PUB);
	await receiveChannelKeyGrant(BOB_PUB, BOB_PRIV, DB_KEY, ALICE_PUB, grantEvent);

	// Mallory подделывает rumor.pubkey (притворяется Алисой, реальным владельцем не является).
	const forgedRumor = { pubkey: MALLORY_PUB, content: JSON.stringify({ channelId }), kind: CHANNEL_UNVIEW_KIND };
	await applyChannelUnviewRumor(BOB_PUB, DB_KEY, forgedRumor);

	const stillThere = await db.table("channels").get([BOB_PUB, channelId]);
	assert.ok(stillThere, "поддельное уведомление (не от реального владельца) не должно удалить канал");
});

test("applyChannelUnviewRumor: канал уже неизвестен локально (никогда не видели) -> no-op, не бросает", async () => {
	await assert.doesNotReject(() => applyChannelUnviewRumor(BOB_PUB, DB_KEY, { pubkey: ALICE_PUB, content: JSON.stringify({ channelId: "nonexistent" }), kind: CHANNEL_UNVIEW_KIND }));
});

test("applyChannelUnviewRumor: битый content (не JSON) -> no-op, не бросает", async () => {
	await assert.doesNotReject(() => applyChannelUnviewRumor(BOB_PUB, DB_KEY, { pubkey: ALICE_PUB, content: "не json{{{", kind: CHANNEL_UNVIEW_KIND }));
});
