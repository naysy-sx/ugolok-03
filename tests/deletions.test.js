import "fake-indexeddb/auto";
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { db } from "../src/core/store/database.js";
import { getPublicKey } from "../src/core/crypto/keys.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { unwrap as nip59Unwrap } from "../src/core/crypto/nip59.js";
import { createOwnKeyPackage, joinFromWelcome, serializeState } from "../src/core/crypto/mls-session.js";
import { ensureChatEstablished, receiveGroupMessageEvent, sendMessage, computeGroupId } from "../src/domain/messaging/chat.js";
import {
	buildDeletionText,
	parseDeletionText,
	deleteMessage,
	applyIncomingDeletionIfMarker,
	deleteMessageForMe,
	clearChatHistory,
} from "../src/domain/messaging/deletions.js";
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
});

after(() => {
	db.close();
});

function toHex(bytes) {
	return bytesToHex(bytes);
}

async function establishAliceToBob() {
	const bobKeyPackage = await createOwnKeyPackage(BOB_PUB, "bob-device");
	const fetchKeyPackage = async () => bobKeyPackage.wireBytes;
	const publishedEvents = [];
	const publish = async (event) => {
		publishedEvents.push(event);
		return { ok: true };
	};
	await ensureChatEstablished(ALICE_PUB, ALICE_PRIV, DB_KEY, BOB_PUB, publish, fetchKeyPackage);

	const welcomeGiftWrap = publishedEvents.find((e) => e.kind === 1059);
	const rumor = nip59Unwrap(welcomeGiftWrap, BOB_PRIV);
	const welcomeWireBytes = Uint8Array.from(atob(rumor.content), (c) => c.charCodeAt(0));
	const bobState = await joinFromWelcome(bobKeyPackage, welcomeWireBytes);
	const groupId = computeGroupId(ALICE_PUB, BOB_PUB);

	return { groupId, bobSerializedState: serializeState(bobState) };
}

async function asBob(groupIdHex, bobSerializedState, fn) {
	await db.table("mlsGroups").put(toEncryptedRow({ ownerPubkey: BOB_PUB, groupId: groupIdHex, contactPubkey: ALICE_PUB, state: bobSerializedState }, MLS_GROUPS_PLAINTEXT_FIELDS, DB_KEY));
	const result = await fn();
	const updatedBobRow = fromEncryptedRow(await db.table("mlsGroups").get([BOB_PUB, groupIdHex]), DB_KEY);
	return { result, updatedBobSerializedState: updatedBobRow.state };
}

test("buildDeletionText/parseDeletionText: round-trip, обычный текст не распознаётся как маркер", () => {
	const text = buildDeletionText("abc123");
	assert.equal(parseDeletionText(text), "abc123");
	assert.equal(parseDeletionText("привет, это обычное сообщение"), null);
	assert.equal(parseDeletionText(""), null);
});

test("deleteMessage: помечает СВОЮ локальную строку удалённой сразу, без ожидания приёма контактом", async () => {
	const { groupId } = await establishAliceToBob();
	const publish = async () => ({ ok: true });
	const { eventId: firstMsgEventId } = await sendMessage(ALICE_PUB, ALICE_PRIV, DB_KEY, BOB_PUB, "привет", 1, publish);

	const row = await db.table("messages").where("id").equals(firstMsgEventId).first();
	const msgId = row.msgId;

	await deleteMessage(ALICE_PUB, ALICE_PRIV, DB_KEY, BOB_PUB, msgId, 2, publish);

	const updated = await db.table("messages").where("[ownerPubkey+chatId+msgId]").equals([ALICE_PUB, BOB_PUB, msgId]).first();
	assert.equal(updated.deleted, true);
	assert.equal(updated.text, "");
});

test("applyIncomingDeletionIfMarker: Bob получает delete-запрос от Алисы на ЕЁ ЖЕ сообщение — применяется", async () => {
	const { groupId, bobSerializedState } = await establishAliceToBob();
	const groupIdHex = toHex(groupId);
	const sentEvents = [];
	const publish = async (event) => {
		sentEvents.push(event);
		return { ok: true };
	};

	await sendMessage(ALICE_PUB, ALICE_PRIV, DB_KEY, BOB_PUB, "оригинал", 1, publish);
	const originalMsgId = (await db.table("messages").where("[ownerPubkey+chatId]").equals([ALICE_PUB, BOB_PUB]).first()).msgId;

	// Боб получает оригинал (материализует свою копию строки)
	const originalEvent = sentEvents.find((e) => e.kind === 445);
	const { updatedBobSerializedState: bobStateAfterOriginal } = await asBob(groupIdHex, bobSerializedState, () =>
		receiveGroupMessageEvent(BOB_PUB, BOB_PRIV, DB_KEY, originalEvent, async () => ({ ok: true })),
	);

	sentEvents.length = 0;
	await deleteMessage(ALICE_PUB, ALICE_PRIV, DB_KEY, BOB_PUB, originalMsgId, 2, publish);
	const deleteEvent = sentEvents.find((e) => e.kind === 445);

	const { result: bobReceiveResult, updatedBobSerializedState } = await asBob(groupIdHex, bobStateAfterOriginal, () =>
		receiveGroupMessageEvent(BOB_PUB, BOB_PRIV, DB_KEY, deleteEvent, async () => ({ ok: true })),
	);

	const applied = await applyIncomingDeletionIfMarker(BOB_PUB, DB_KEY, deleteEvent, bobReceiveResult);
	assert.equal(applied, true);

	await asBob(groupIdHex, updatedBobSerializedState, async () => {
		const bobRow = await db.table("messages").where("[ownerPubkey+chatId+msgId]").equals([BOB_PUB, ALICE_PUB, originalMsgId]).first();
		assert.equal(bobRow.deleted, true);
		assert.equal(bobRow.text, "");
	});
});

test("applyIncomingDeletionIfMarker: Алиса пытается удалить сообщение, которое написал БОБ — отклонено (F-EV-08 аналог)", async () => {
	const { groupId, bobSerializedState } = await establishAliceToBob();
	const groupIdHex = toHex(groupId);

	// Боб пишет сообщение — в реальности это ДВЕ РАЗНЫЕ строки в ДВУХ РАЗНЫХ БД (owner-scoping,
	// этап 27): у Алисы (ownerPubkey=ALICE_PUB, она получатель, chatId=BOB_PUB) и у самого Боба
	// (ownerPubkey=BOB_PUB, chatId=ALICE_PUB — с ЕГО стороны собеседник это Алиса).
	const bobMsgId = "b".repeat(32);
	await db.table("messages").add({
		ownerPubkey: ALICE_PUB,
		chatId: BOB_PUB,
		lamportTs: 1,
		senderPubkey: BOB_PUB,
		id: "bob-original-at-alice",
		text: "сообщение от Боба",
		status: "sent",
		msgId: bobMsgId,
	});
	await db.table("messages").add({
		ownerPubkey: BOB_PUB,
		chatId: ALICE_PUB,
		lamportTs: 1,
		senderPubkey: BOB_PUB,
		id: "bob-original-at-bob",
		text: "сообщение от Боба",
		status: "sent",
		msgId: bobMsgId,
	});

	// deleteMessage (легитимный путь) отказывается удалить чужое сообщение сразу:
	const publish = async () => ({ ok: true });
	await assert.rejects(() => deleteMessage(ALICE_PUB, ALICE_PRIV, DB_KEY, BOB_PUB, bobMsgId, 2, publish), /чужое/);

	// Адверсарный сценарий: враждебный/модифицированный клиент МОГ БЫ обойти deleteMessage
	// и напрямую воспользоваться sendMessage, чтобы сфабриковать delete-заявку — проверяем,
	// что ПРИЁМНАЯ сторона (Боб) отклоняет её независимо, не полагаясь на добросовестность отправителя.
	const sentEvents = [];
	const forgingPublish = async (event) => {
		sentEvents.push(event);
		return { ok: true };
	};
	await sendMessage(ALICE_PUB, ALICE_PRIV, DB_KEY, BOB_PUB, buildDeletionText(bobMsgId), 2, forgingPublish);
	const deleteEvent = sentEvents.find((e) => e.kind === 445);

	const { result: bobReceiveResult } = await asBob(groupIdHex, bobSerializedState, () =>
		receiveGroupMessageEvent(BOB_PUB, BOB_PRIV, DB_KEY, deleteEvent, async () => ({ ok: true })),
	);
	const applied = await applyIncomingDeletionIfMarker(BOB_PUB, DB_KEY, deleteEvent, bobReceiveResult);
	assert.equal(applied, false, "Алиса не автор этого сообщения — приёмная сторона отклоняет независимо");

	const stillThere = await db.table("messages").where("[ownerPubkey+chatId+msgId]").equals([BOB_PUB, ALICE_PUB, bobMsgId]).first();
	assert.equal(stillThere.deleted, undefined, "сообщение Боба (в ЕГО собственной БД) осталось нетронутым");
});

test("applyIncomingDeletionIfMarker: неизвестный msgId — false, не бросает", async () => {
	const fakeEvent = { tags: [["h", "00".repeat(32)]] };
	const applied = await applyIncomingDeletionIfMarker(BOB_PUB, DB_KEY, fakeEvent, { text: buildDeletionText("nope"), lamportTs: 1 });
	assert.equal(applied, false);
});

test("applyIncomingDeletionIfMarker: обычное (не-маркерное) сообщение — false, ничего не меняет", async () => {
	const applied = await applyIncomingDeletionIfMarker(BOB_PUB, DB_KEY, { tags: [] }, { text: "обычный текст", lamportTs: 1 });
	assert.equal(applied, false);
});

test("applyIncomingDeletionIfMarker: receivedResult===null (control-сообщение) — false", async () => {
	const applied = await applyIncomingDeletionIfMarker(BOB_PUB, DB_KEY, { tags: [] }, null);
	assert.equal(applied, false);
});

test("deleteMessageForMe: жёстко удаляет строку локально, без публикации (в отличие от deleteMessage/'у обоих')", async () => {
	await db.table("messages").add({
		ownerPubkey: ALICE_PUB,
		chatId: BOB_PUB,
		lamportTs: 1,
		senderPubkey: ALICE_PUB,
		id: "evt-1",
		text: "моё сообщение",
		status: "sent",
		msgId: "msg-1",
	});
	await deleteMessageForMe(ALICE_PUB, BOB_PUB, "msg-1");
	const row = await db.table("messages").where("[ownerPubkey+chatId+msgId]").equals([ALICE_PUB, BOB_PUB, "msg-1"]).first();
	assert.equal(row, undefined, "строка удалена целиком, не soft-delete с плейсхолдером");
});

test("deleteMessageForMe: работает и для ЧУЖОГО сообщения (локально скрыть у себя разрешено всем)", async () => {
	await db.table("messages").add({
		ownerPubkey: ALICE_PUB,
		chatId: BOB_PUB,
		lamportTs: 1,
		senderPubkey: BOB_PUB,
		id: "evt-2",
		text: "сообщение от Боба",
		status: "sent",
		msgId: "msg-2",
	});
	await deleteMessageForMe(ALICE_PUB, BOB_PUB, "msg-2");
	const row = await db.table("messages").where("[ownerPubkey+chatId+msgId]").equals([ALICE_PUB, BOB_PUB, "msg-2"]).first();
	assert.equal(row, undefined);
});

test("deleteMessageForMe: несуществующий msgId — no-op, не бросает", async () => {
	await assert.doesNotReject(() => deleteMessageForMe(ALICE_PUB, BOB_PUB, "нет-такого"));
});

test("clearChatHistory: удаляет ВСЕ сообщения чата owner+chatId, не трогает другой chatId и другого owner", async () => {
	await db.table("messages").bulkAdd([
		{ ownerPubkey: ALICE_PUB, chatId: BOB_PUB, lamportTs: 1, senderPubkey: ALICE_PUB, id: "a1", text: "1", status: "sent", msgId: "m1" },
		{ ownerPubkey: ALICE_PUB, chatId: BOB_PUB, lamportTs: 2, senderPubkey: BOB_PUB, id: "a2", text: "2", status: "sent", msgId: "m2" },
		// другой собеседник у той же Алисы — должен остаться нетронутым
		{ ownerPubkey: ALICE_PUB, chatId: "carol-pub", lamportTs: 1, senderPubkey: ALICE_PUB, id: "a3", text: "3", status: "sent", msgId: "m3" },
		// та же переписка, но с точки зрения Боба (другой owner) — должна остаться нетронутой
		{ ownerPubkey: BOB_PUB, chatId: ALICE_PUB, lamportTs: 1, senderPubkey: ALICE_PUB, id: "a4", text: "4", status: "sent", msgId: "m4" },
	]);

	await clearChatHistory(ALICE_PUB, BOB_PUB);

	const aliceBobRows = await db.table("messages").where("[ownerPubkey+chatId]").equals([ALICE_PUB, BOB_PUB]).toArray();
	assert.deepEqual(aliceBobRows, []);

	const aliceCarolRows = await db.table("messages").where("[ownerPubkey+chatId]").equals([ALICE_PUB, "carol-pub"]).toArray();
	assert.equal(aliceCarolRows.length, 1);

	const bobAliceRows = await db.table("messages").where("[ownerPubkey+chatId]").equals([BOB_PUB, ALICE_PUB]).toArray();
	assert.equal(bobAliceRows.length, 1);
});
