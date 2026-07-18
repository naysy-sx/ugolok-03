import "fake-indexeddb/auto";
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { db } from "../src/core/store/database.js";
import { getPublicKey } from "../src/core/crypto/keys.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { unwrap as nip59Unwrap } from "../src/core/crypto/nip59.js";
import { createOwnKeyPackage, joinFromWelcome, serializeState } from "../src/core/crypto/mls-session.js";
import { ensureChatEstablished, receiveGroupMessageEvent, sendMessage, computeGroupId } from "../src/domain/messaging/chat.js";
import { buildEditText, parseEditText, editMessage, applyIncomingEditIfMarker } from "../src/domain/messaging/edits.js";

const ALICE_PRIV = new Uint8Array(32).fill(1);
const BOB_PRIV = new Uint8Array(32).fill(2);
const ALICE_PUB = bytesToHex(getPublicKey(ALICE_PRIV));
const BOB_PUB = bytesToHex(getPublicKey(BOB_PRIV));

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
	await ensureChatEstablished(ALICE_PUB, ALICE_PRIV, BOB_PUB, publish, fetchKeyPackage);

	const welcomeGiftWrap = publishedEvents.find((e) => e.kind === 1059);
	const rumor = nip59Unwrap(welcomeGiftWrap, BOB_PRIV);
	const welcomeWireBytes = Uint8Array.from(atob(rumor.content), (c) => c.charCodeAt(0));
	const bobState = await joinFromWelcome(bobKeyPackage, welcomeWireBytes);
	const groupId = computeGroupId(ALICE_PUB, BOB_PUB);

	return { groupId, bobSerializedState: serializeState(bobState) };
}

async function asBob(groupIdHex, bobSerializedState, fn) {
	await db.table("mlsGroups").put({ ownerPubkey: BOB_PUB, groupId: groupIdHex, contactPubkey: ALICE_PUB, state: bobSerializedState });
	const result = await fn();
	const updatedBobRow = await db.table("mlsGroups").get([BOB_PUB, groupIdHex]);
	return { result, updatedBobSerializedState: updatedBobRow.state };
}

test("buildEditText/parseEditText: round-trip, обычный текст и повреждённый JSON не распознаются как маркер", () => {
	const text = buildEditText("abc123", "новый текст: с двоеточием");
	const parsed = parseEditText(text);
	assert.deepEqual(parsed, { msgId: "abc123", text: "новый текст: с двоеточием" });
	assert.equal(parseEditText("обычное сообщение"), null);
	assert.equal(parseEditText(""), null);
	assert.equal(parseEditText("__ugolok_edit__:{не валидный json"), null);
	assert.equal(parseEditText("__ugolok_edit__:" + JSON.stringify({ msgId: 5, text: "текст" })), null, "msgId не строка -> null");
});

test("editMessage: обновляет СВОЮ локальную строку сразу (оптимистично), без ожидания приёма контактом", async () => {
	await establishAliceToBob();
	const publish = async () => ({ ok: true });
	const { eventId } = await sendMessage(ALICE_PUB, ALICE_PRIV, BOB_PUB, "оригинал", 1, publish);
	const row = await db.table("messages").where("id").equals(eventId).first();

	await editMessage(ALICE_PUB, ALICE_PRIV, BOB_PUB, row.msgId, "исправленный текст", 2, publish);

	const updated = await db.table("messages").where("[ownerPubkey+chatId+msgId]").equals([ALICE_PUB, BOB_PUB, row.msgId]).first();
	assert.equal(updated.text, "исправленный текст");
	assert.equal(updated.edited, true);
	assert.equal(updated.editedAt, 2);
});

test("editMessage: чужое сообщение -> throw, ничего не публикует", async () => {
	await db.table("messages").add({
		ownerPubkey: ALICE_PUB,
		chatId: BOB_PUB,
		lamportTs: 1,
		senderPubkey: BOB_PUB,
		id: "bob-msg",
		text: "сообщение Боба",
		status: "sent",
		msgId: "bob-msgid",
	});
	const publish = async () => {
		throw new Error("publish не должен вызываться");
	};
	await assert.rejects(() => editMessage(ALICE_PUB, ALICE_PRIV, BOB_PUB, "bob-msgid", "подделка", 2, publish), /чужое/);
});

test("editMessage: уже удалённое сообщение -> throw", async () => {
	await db.table("messages").add({
		ownerPubkey: ALICE_PUB,
		chatId: BOB_PUB,
		lamportTs: 1,
		senderPubkey: ALICE_PUB,
		id: "evt-deleted",
		text: "",
		deleted: true,
		status: "sent",
		msgId: "deleted-msgid",
	});
	const publish = async () => ({ ok: true });
	await assert.rejects(() => editMessage(ALICE_PUB, ALICE_PRIV, BOB_PUB, "deleted-msgid", "правка удалённого", 2, publish), /удал/);
});

test("applyIncomingEditIfMarker: Bob получает правку от Алисы на ЕЁ сообщение — применяется", async () => {
	const { groupId, bobSerializedState } = await establishAliceToBob();
	const groupIdHex = toHex(groupId);
	const sentEvents = [];
	const publish = async (event) => {
		sentEvents.push(event);
		return { ok: true };
	};

	await sendMessage(ALICE_PUB, ALICE_PRIV, BOB_PUB, "оригинал", 1, publish);
	const originalMsgId = (await db.table("messages").where("[ownerPubkey+chatId]").equals([ALICE_PUB, BOB_PUB]).first()).msgId;

	const originalEvent = sentEvents.find((e) => e.kind === 445);
	const { updatedBobSerializedState: stateAfterOriginal } = await asBob(groupIdHex, bobSerializedState, () =>
		receiveGroupMessageEvent(BOB_PUB, BOB_PRIV, originalEvent, async () => ({ ok: true })),
	);

	sentEvents.length = 0;
	await editMessage(ALICE_PUB, ALICE_PRIV, BOB_PUB, originalMsgId, "исправлено Алисой", 2, publish);
	const editEvent = sentEvents.find((e) => e.kind === 445);

	const { result: bobReceiveResult, updatedBobSerializedState } = await asBob(groupIdHex, stateAfterOriginal, () =>
		receiveGroupMessageEvent(BOB_PUB, BOB_PRIV, editEvent, async () => ({ ok: true })),
	);

	const applied = await applyIncomingEditIfMarker(BOB_PUB, editEvent, bobReceiveResult);
	assert.equal(applied, true);

	await asBob(groupIdHex, updatedBobSerializedState, async () => {
		const bobRow = await db.table("messages").where("[ownerPubkey+chatId+msgId]").equals([BOB_PUB, ALICE_PUB, originalMsgId]).first();
		assert.equal(bobRow.text, "исправлено Алисой");
		assert.equal(bobRow.edited, true);
		assert.equal(bobRow.editedAt, 2);
	});
});

test("applyIncomingEditIfMarker: LWW — правка с БОЛЬШИМ editLamportTs, применённая ПЕРВОЙ, не откатывается более старой правкой, пришедшей ПОЗЖЕ", async () => {
	const hTag = ["h", "aa".repeat(32)];
	await db.table("mlsGroups").put({ ownerPubkey: BOB_PUB, groupId: hTag[1], contactPubkey: ALICE_PUB, state: "unused" });
	await db.table("messages").add({
		ownerPubkey: BOB_PUB,
		chatId: ALICE_PUB,
		lamportTs: 1,
		senderPubkey: ALICE_PUB,
		id: "orig-evt",
		text: "оригинал",
		status: "sent",
		msgId: "target-msgid",
	});

	// Правка с БОЛЬШИМ editLamportTs (10) применяется первой.
	const newerApplied = await applyIncomingEditIfMarker(
		BOB_PUB,
		{ tags: [hTag] },
		{ text: buildEditText("target-msgid", "новая версия (позже по editLamportTs)"), lamportTs: 10 },
	);
	assert.equal(newerApplied, true);

	// Правка со СТАРШИМ editLamportTs (5, пришла позже по времени доставки, но её editLamportTs
	// меньше уже применённого) — должна быть отклонена (LWW, не откатывает).
	const olderApplied = await applyIncomingEditIfMarker(
		BOB_PUB,
		{ tags: [hTag] },
		{ text: buildEditText("target-msgid", "устаревшая версия (editLamportTs=5)"), lamportTs: 5 },
	);
	assert.equal(olderApplied, false, "устаревшая правка (editLamportTs=5 < уже применённых 10) отклонена");

	const row = await db.table("messages").where("[ownerPubkey+chatId+msgId]").equals([BOB_PUB, ALICE_PUB, "target-msgid"]).first();
	assert.equal(row.text, "новая версия (позже по editLamportTs)", "текст остался от правки с большим editLamportTs");
	assert.equal(row.editedAt, 10);
});

test("applyIncomingEditIfMarker: правка на сообщение, написанное ДРУГИМ автором — отклонена (F-EV-08 аналог)", async () => {
	const hTag = ["h", "bb".repeat(32)];
	await db.table("mlsGroups").put({ ownerPubkey: BOB_PUB, groupId: hTag[1], contactPubkey: ALICE_PUB, state: "unused" });
	await db.table("messages").add({
		ownerPubkey: BOB_PUB,
		chatId: ALICE_PUB,
		lamportTs: 1,
		senderPubkey: BOB_PUB, // сообщение написал сам Боб (получатель этой БД), не Алиса
		id: "bob-own-evt",
		text: "сообщение Боба",
		status: "sent",
		msgId: "bob-own-msgid",
	});

	const applied = await applyIncomingEditIfMarker(
		BOB_PUB,
		{ tags: [hTag] },
		{ text: buildEditText("bob-own-msgid", "подделанная правка от имени Алисы"), lamportTs: 2 },
	);
	assert.equal(applied, false);

	const row = await db.table("messages").where("[ownerPubkey+chatId+msgId]").equals([BOB_PUB, ALICE_PUB, "bob-own-msgid"]).first();
	assert.equal(row.text, "сообщение Боба", "не изменилось — Алиса не автор этого сообщения");
});

test("applyIncomingEditIfMarker: правка на удалённое сообщение — отклонена", async () => {
	const hTag = ["h", "cc".repeat(32)];
	await db.table("mlsGroups").put({ ownerPubkey: BOB_PUB, groupId: hTag[1], contactPubkey: ALICE_PUB, state: "unused" });
	await db.table("messages").add({
		ownerPubkey: BOB_PUB,
		chatId: ALICE_PUB,
		lamportTs: 1,
		senderPubkey: ALICE_PUB,
		id: "deleted-evt",
		text: "",
		deleted: true,
		status: "sent",
		msgId: "deleted-msgid",
	});

	const applied = await applyIncomingEditIfMarker(
		BOB_PUB,
		{ tags: [hTag] },
		{ text: buildEditText("deleted-msgid", "правка удалённого"), lamportTs: 2 },
	);
	assert.equal(applied, false);
});

test("applyIncomingEditIfMarker: правка, прибывшая раньше оригинала (targetRow не найден) — false, не бросает", async () => {
	const hTag = ["h", "dd".repeat(32)];
	await db.table("mlsGroups").put({ ownerPubkey: BOB_PUB, groupId: hTag[1], contactPubkey: ALICE_PUB, state: "unused" });
	const applied = await applyIncomingEditIfMarker(BOB_PUB, { tags: [hTag] }, { text: buildEditText("нет-такого-msgid", "правка"), lamportTs: 2 });
	assert.equal(applied, false);
});

test("applyIncomingEditIfMarker: неизвестная группа (нет h-тега/mlsGroups) — false, не бросает", async () => {
	const applied = await applyIncomingEditIfMarker(BOB_PUB, { tags: [] }, { text: buildEditText("x", "y"), lamportTs: 1 });
	assert.equal(applied, false);
});

test("applyIncomingEditIfMarker: обычное (не-маркерное) сообщение — false, ничего не меняет", async () => {
	const applied = await applyIncomingEditIfMarker(BOB_PUB, { tags: [] }, { text: "обычный текст", lamportTs: 1 });
	assert.equal(applied, false);
});

test("applyIncomingEditIfMarker: receivedResult===null (control-сообщение) — false", async () => {
	const applied = await applyIncomingEditIfMarker(BOB_PUB, { tags: [] }, null);
	assert.equal(applied, false);
});
