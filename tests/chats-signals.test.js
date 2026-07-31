import "fake-indexeddb/auto";
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { db } from "../src/core/store/database.js";
import { getPublicKey } from "../src/core/crypto/keys.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { createOwnKeyPackage } from "../src/core/crypto/mls-session.js";
import { ensureChatEstablished } from "../src/domain/messaging/chat.js";
import {
	messagingActivity,
	bumpMessagingActivity,
	listChatPartners,
	sendChatMessageAction,
	deleteChatMessageAction,
	deleteMessageForMeAction,
	clearChatHistoryAction,
	markChatReadAction,
	saveChatDraftAction,
} from "../src/ui/signals/chats.js";
import { toEncryptedRow, fromEncryptedRow } from "../src/core/store/encrypted-table.js";
import { MLS_GROUPS_PLAINTEXT_FIELDS } from "../src/core/store/table-fields.js";

const ALICE_PRIV = new Uint8Array(32).fill(1);
const BOB_PRIV = new Uint8Array(32).fill(2);
const ALICE_PUB = bytesToHex(getPublicKey(ALICE_PRIV));
const BOB_PUB = bytesToHex(getPublicKey(BOB_PRIV));
const DB_KEY = crypto.getRandomValues(new Uint8Array(32));

before(async () => {
	await db.open();
});

beforeEach(async () => {
	await db.table("ownKeyPackage").clear();
	await db.table("mlsGroups").clear();
	await db.table("messages").clear();
	await db.table("chatSyncState").clear();
});

after(() => {
	db.close();
});

test("bumpMessagingActivity: инкрементирует сигнал", () => {
	const before = messagingActivity.value;
	bumpMessagingActivity();
	assert.equal(messagingActivity.value, before + 1);
});

test("listChatPartners: возвращает уникальные contactPubkey активных MLS-групп", async () => {
	await db.table("mlsGroups").bulkAdd([
		toEncryptedRow({ ownerPubkey: ALICE_PUB, groupId: "g1", contactPubkey: BOB_PUB, state: new Uint8Array([1]) }, MLS_GROUPS_PLAINTEXT_FIELDS, DB_KEY),
		toEncryptedRow({ ownerPubkey: ALICE_PUB, groupId: "g2", contactPubkey: "carol-pub", state: new Uint8Array([2]) }, MLS_GROUPS_PLAINTEXT_FIELDS, DB_KEY),
	]);
	const partners = await listChatPartners(ALICE_PUB, DB_KEY);
	assert.deepEqual(partners.sort(), [BOB_PUB, "carol-pub"].sort());
});

test("listChatPartners: owner-scoping — не путает чаты РАЗНЫХ локальных аккаунтов на одном устройстве (критическая находка)", async () => {
	await db.table("mlsGroups").bulkAdd([
		toEncryptedRow({ ownerPubkey: ALICE_PUB, groupId: "g1", contactPubkey: BOB_PUB, state: new Uint8Array([1]) }, MLS_GROUPS_PLAINTEXT_FIELDS, DB_KEY),
		toEncryptedRow({ ownerPubkey: "matero-pub", groupId: "g2", contactPubkey: "someone-else", state: new Uint8Array([2]) }, MLS_GROUPS_PLAINTEXT_FIELDS, DB_KEY),
	]);
	const alicePartners = await listChatPartners(ALICE_PUB, DB_KEY);
	assert.deepEqual(alicePartners, [BOB_PUB], "Алиса не должна видеть чаты аккаунта matero");
});

test("listChatPartners: без активных чатов -> пустой массив", async () => {
	assert.deepEqual(await listChatPartners(ALICE_PUB, DB_KEY), []);
});

// Этап 56 (найдено живой проверкой, реальный аккаунт в Safari) — переписка,
// полученная ТОЛЬКО через зеркалирование с другого устройства (syncMirroredHistory,
// этап 25), пишет напрямую в messages, НЕ создавая mlsGroups на этом устройстве —
// та появляется лишь при первой ОТПРАВКЕ (ensureChatEstablished). Список "Сообщения"
// смотрел только на mlsGroups — пассивно прочитанная зеркалом переписка была
// невидима в списке, хотя открывалась и полностью работала через "Контакты".
test("listChatPartners: партнёр без mlsGroups, но с историей в messages (зеркалирование) — тоже попадает в список", async () => {
	await db.table("messages").bulkAdd([
		{ ownerPubkey: ALICE_PUB, chatId: BOB_PUB, msgId: "m1", id: "m1", lamportTs: 1, senderPubkey: BOB_PUB, status: "sent", deleted: false },
		{ ownerPubkey: ALICE_PUB, chatId: BOB_PUB, msgId: "m2", id: "m2", lamportTs: 2, senderPubkey: ALICE_PUB, status: "sent", deleted: false },
	]);
	const partners = await listChatPartners(ALICE_PUB, DB_KEY);
	assert.deepEqual(partners, [BOB_PUB], "чат виден по messages, даже когда mlsGroups для этого владельца пуста");
});

test("listChatPartners: партнёр из mlsGroups И messages — не дублируется", async () => {
	await db.table("mlsGroups").add(toEncryptedRow({ ownerPubkey: ALICE_PUB, groupId: "g1", contactPubkey: BOB_PUB, state: new Uint8Array([1]) }, MLS_GROUPS_PLAINTEXT_FIELDS, DB_KEY));
	await db.table("messages").add({ ownerPubkey: ALICE_PUB, chatId: BOB_PUB, msgId: "m1", id: "m1", lamportTs: 1, senderPubkey: BOB_PUB, status: "sent", deleted: false });
	const partners = await listChatPartners(ALICE_PUB, DB_KEY);
	assert.deepEqual(partners, [BOB_PUB]);
});

test("listChatPartners: messages-источник тоже owner-scoped — не путает чаты разных локальных аккаунтов", async () => {
	await db.table("messages").bulkAdd([
		{ ownerPubkey: ALICE_PUB, chatId: BOB_PUB, msgId: "m1", id: "m1", lamportTs: 1, senderPubkey: BOB_PUB, status: "sent", deleted: false },
		{ ownerPubkey: "matero-pub", chatId: "someone-else", msgId: "m2", id: "m2", lamportTs: 1, senderPubkey: "someone-else", status: "sent", deleted: false },
	]);
	assert.deepEqual(await listChatPartners(ALICE_PUB, DB_KEY), [BOB_PUB], "Алиса не должна видеть чаты аккаунта matero через messages");
});

test("sendChatMessageAction: устанавливает чат при первой отправке (ensureChatEstablished no-op при повторе) и вызывает refresh-подписку", async () => {
	const bobKeyPackage = await createOwnKeyPackage(BOB_PUB, "bob-device");
	const fetchKeyPackage = async () => bobKeyPackage.wireBytes;
	let refreshCalls = 0;
	const refreshGroupMessageSubscription = async () => {
		refreshCalls++;
	};
	const publish = async () => ({ ok: true });

	const { eventId } = await sendChatMessageAction(
		ALICE_PUB,
		ALICE_PRIV,
		DB_KEY,
		BOB_PUB,
		"привет",
		1,
		publish,
		fetchKeyPackage,
		refreshGroupMessageSubscription,
	);
	assert.ok(eventId);
	assert.equal(refreshCalls, 1, "refreshGroupMessageSubscription обязана вызываться (находка 3)");
	assert.equal((await db.table("mlsGroups").toArray()).length, 1);

	// повторная отправка — чат уже установлен (ensureChatEstablished no-op), fetchKeyPackage
	// не должен вызываться повторно
	const fetchKeyPackageShouldNotBeCalled = async () => {
		throw new Error("не должен вызываться повторно");
	};
	await sendChatMessageAction(
		ALICE_PUB,
		ALICE_PRIV,
		DB_KEY,
		BOB_PUB,
		"второе",
		2,
		publish,
		fetchKeyPackageShouldNotBeCalled,
		refreshGroupMessageSubscription,
	);
	assert.equal(refreshCalls, 2, "refresh всё равно вызывается на каждую отправку (безусловно, идемпотентно)");
});

test("этап 29: sendChatMessageAction — attachment пробрасывается в sendMessage как есть", async () => {
	const bobKeyPackage = await createOwnKeyPackage(BOB_PUB, "bob-device");
	const attachment = { type: "file", sha256: "b".repeat(64), blossomUrl: "http://127.0.0.1:8080", encryptionKey: "key==", mime: "application/pdf", size: 999, name: "doc.pdf" };
	const { eventId } = await sendChatMessageAction(
		ALICE_PUB,
		ALICE_PRIV,
		DB_KEY,
		BOB_PUB,
		"",
		1,
		async () => ({ ok: true }),
		async () => bobKeyPackage.wireBytes,
		async () => {},
		attachment,
	);
	const row = fromEncryptedRow(await db.table("messages").where("id").equals(eventId).first(), DB_KEY);
	assert.deepEqual(row.attachment, attachment);
});

test("sendChatMessageAction: fetchKeyPackage не находит адресата -> понятная ошибка всплывает как есть", async () => {
	const fetchKeyPackage = async () => {
		throw new Error("у контакта нет опубликованного ключа для сообщений");
	};
	await assert.rejects(
		() => sendChatMessageAction(ALICE_PUB, ALICE_PRIV, DB_KEY,
		BOB_PUB, "привет", 1, async () => ({ ok: true }), fetchKeyPackage, async () => {}),
		/ключ/,
	);
});

test("deleteChatMessageAction/markChatReadAction/saveChatDraftAction: делегируют в domain-модули этапов 25-26", async () => {
	const bobKeyPackage = await createOwnKeyPackage(BOB_PUB, "bob-device");
	const publish = async () => ({ ok: true });
	const { eventId } = await sendChatMessageAction(
		ALICE_PUB,
		ALICE_PRIV,
		DB_KEY,
		BOB_PUB,
		"привет",
		1,
		publish,
		async () => bobKeyPackage.wireBytes,
		async () => {},
	);
	const row = await db.table("messages").where("id").equals(eventId).first();

	await markChatReadAction(ALICE_PUB, ALICE_PRIV, DB_KEY, BOB_PUB, 1, publish);
	// своё же сообщение не переводится в read этим механизмом (F-MS-07, этап 26) — просто
	// проверяем, что вызов не бросает и chatSyncState обновился
	assert.equal((await db.table("chatSyncState").get([ALICE_PUB, BOB_PUB])).lastReadLamportTs, 1);

	await saveChatDraftAction(ALICE_PUB, ALICE_PRIV, DB_KEY, BOB_PUB, "черновик", publish);
	assert.equal(fromEncryptedRow(await db.table("chatSyncState").get([ALICE_PUB, BOB_PUB]), DB_KEY).draftText, "черновик");

	await deleteChatMessageAction(ALICE_PUB, ALICE_PRIV, DB_KEY, BOB_PUB, row.msgId, 3, publish);
	const updated = await db.table("messages").where("id").equals(eventId).first();
	assert.equal(updated.deleted, true);
});

test("deleteMessageForMeAction/clearChatHistoryAction: делегируют в deletions.js (этап 27-довесок-5)", async () => {
	const bobKeyPackage = await createOwnKeyPackage(BOB_PUB, "bob-device");
	const publish = async () => ({ ok: true });
	const { eventId } = await sendChatMessageAction(
		ALICE_PUB,
		ALICE_PRIV,
		DB_KEY,
		BOB_PUB,
		"привет",
		1,
		publish,
		async () => bobKeyPackage.wireBytes,
		async () => {},
	);
	const row = await db.table("messages").where("id").equals(eventId).first();

	await deleteMessageForMeAction(ALICE_PUB, BOB_PUB, row.msgId);
	assert.equal(await db.table("messages").where("id").equals(eventId).first(), undefined);

	await sendChatMessageAction(ALICE_PUB, ALICE_PRIV, DB_KEY,
		BOB_PUB, "ещё одно", 2, publish, async () => bobKeyPackage.wireBytes, async () => {});
	await clearChatHistoryAction(ALICE_PUB, BOB_PUB);
	const remaining = await db.table("messages").where("[ownerPubkey+chatId]").equals([ALICE_PUB, BOB_PUB]).toArray();
	assert.deepEqual(remaining, []);
});
