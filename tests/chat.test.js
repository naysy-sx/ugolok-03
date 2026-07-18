import "fake-indexeddb/auto";
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { db } from "../src/core/store/database.js";
import { getPublicKey } from "../src/core/crypto/keys.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { decrypt as nip44Decrypt } from "../src/core/crypto/nip44.js";
import { unwrap as nip59Unwrap } from "../src/core/crypto/nip59.js";
import { joinFromWelcome, createOwnKeyPackage, deserializeState, serializeState } from "../src/core/crypto/mls-session.js";
import {
	computeGroupId,
	ensureOwnKeyPackagePublished,
	ensureChatEstablished,
	acceptWelcome,
	sendMessage,
	receiveGroupMessageEvent,
	getChatHistory,
} from "../src/domain/messaging/chat.js";

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

test("computeGroupId: детерминирован и симметричен относительно порядка аргументов", () => {
	const g1 = computeGroupId(ALICE_PUB, BOB_PUB);
	const g2 = computeGroupId(BOB_PUB, ALICE_PUB);
	assert.deepEqual(g1, g2);
	assert.equal(g1.length, 32);
});

test("computeGroupId: разные пары дают разные groupId", () => {
	const carolPub = bytesToHex(getPublicKey(new Uint8Array(32).fill(3)));
	const g1 = computeGroupId(ALICE_PUB, BOB_PUB);
	const g2 = computeGroupId(ALICE_PUB, carolPub);
	assert.notDeepEqual(g1, g2);
});

test("ensureOwnKeyPackagePublished: публикует kind 443 и персистирует ownKeyPackage один раз", async () => {
	let publishCount = 0;
	const publish = async (event) => {
		publishCount++;
		assert.equal(event.kind, 443);
		return { ok: true };
	};
	await ensureOwnKeyPackagePublished(ALICE_PUB, ALICE_PRIV, publish);
	const row = await db.table("ownKeyPackage").get("self");
	assert.ok(row);
	assert.equal(publishCount, 1);

	await ensureOwnKeyPackagePublished(ALICE_PUB, ALICE_PRIV, publish);
	assert.equal(publishCount, 1, "повторный вызов не должен публиковать снова");
});

async function establishAliceToBob() {
	// Боб публикует свой KeyPackage (симулируем то, что реально произошло бы на его стороне)
	const bobKeyPackage = await createOwnKeyPackage(BOB_PUB);
	const fetchKeyPackage = async (pubkey) => {
		assert.equal(pubkey, BOB_PUB);
		return bobKeyPackage.wireBytes;
	};
	const publishedEvents = [];
	const publish = async (event) => {
		publishedEvents.push(event);
		return { ok: true };
	};

	await ensureChatEstablished(ALICE_PUB, ALICE_PRIV, BOB_PUB, publish, fetchKeyPackage);

	const welcomeGiftWrap = publishedEvents.find((e) => e.kind === 1059);
	assert.ok(welcomeGiftWrap, "должен опубликовать gift wrap с Welcome");

	// Боб получает и разворачивает Welcome (то, что сделает диспетчер входящих gift-wrap, этап 24 CONTRACTS.md п.6).
	// ВАЖНО: состояние Боба НЕ пишется в общую db.mlsGroups под тем же groupId — в реальности
	// у Алисы и Боба РАЗНЫЕ базы (каждый на своём устройстве); тут они делят один процесс/db
	// только ради теста, поэтому состояние Боба держим ОТДЕЛЬНО и явно "переключаем" db на
	// него там, где тест играет роль Боба (см. asBob ниже) — иначе строка Алисы затирается.
	const rumor = nip59Unwrap(welcomeGiftWrap, BOB_PRIV);
	assert.equal(rumor.kind, 444);
	const welcomeWireBytes = Uint8Array.from(atob(rumor.content), (c) => c.charCodeAt(0));
	const bobState = await joinFromWelcome(bobKeyPackage, welcomeWireBytes);
	const groupId = computeGroupId(ALICE_PUB, BOB_PUB);

	return { fetchKeyPackage, publish, groupId, bobSerializedState: serializeState(bobState) };
}

// Симулирует "теперь мы на устройстве Боба": подкладывает его копию состояния в
// db.mlsGroups (единственная база в этом тестовом процессе), не трогая копию Алисы,
// которую вызывающий тест обязан сохранить/восстановить сам при необходимости.
async function asBob(groupIdHex, bobSerializedState, fn) {
	await db.table("mlsGroups").put({ groupId: groupIdHex, contactPubkey: ALICE_PUB, state: bobSerializedState });
	const result = await fn();
	const updatedBobRow = await db.table("mlsGroups").get(groupIdHex);
	return { result, updatedBobSerializedState: updatedBobRow.state };
}

test("ensureChatEstablished: полный флоу — mlsGroups получает запись у A, Welcome доходит до B и применяется", async () => {
	const { groupId, bobSerializedState } = await establishAliceToBob();
	const aliceRow = await db.table("mlsGroups").get(toHex(groupId));
	assert.ok(aliceRow, "у Алисы есть своя запись");
	assert.ok(bobSerializedState, "Боб успешно применил Welcome и получил рабочее состояние");
});

test("ensureChatEstablished: повторный вызов — no-op, не публикует Welcome снова", async () => {
	const fetchKeyPackage = async () => {
		throw new Error("не должен вызываться повторно");
	};
	let publishCount = 0;
	const publish = async () => {
		publishCount++;
		return { ok: true };
	};
	await establishAliceToBob();
	await ensureChatEstablished(ALICE_PUB, ALICE_PRIV, BOB_PUB, publish, fetchKeyPackage);
	assert.equal(publishCount, 0);
});

test("ensureChatEstablished: fetchKeyPackage не находит адресата — понятная ошибка, не тихий сбой", async () => {
	const fetchKeyPackage = async () => {
		throw new Error("у контакта нет опубликованного ключа для сообщений");
	};
	await assert.rejects(
		() => ensureChatEstablished(ALICE_PUB, ALICE_PRIV, BOB_PUB, async () => ({ ok: true }), fetchKeyPackage),
		/ключ/,
	);
});

test("sendMessage: бросает, если чат ещё не установлен (нет mlsGroups записи)", async () => {
	await assert.rejects(() => sendMessage(ALICE_PUB, ALICE_PRIV, BOB_PUB, "привет", 1, async () => ({ ok: true })));
});

test("sendMessage/receiveGroupMessageEvent: полный цикл — B реально получает и расшифровывает сообщение от A", async () => {
	const { groupId, bobSerializedState } = await establishAliceToBob();
	const groupIdHex = toHex(groupId);

	let sentEvent;
	const publish = async (event) => {
		sentEvent = event;
		return { ok: true };
	};
	// db.mlsGroups сейчас содержит запись АЛИСЫ (establishAliceToBob оставил её последней)
	const { eventId } = await sendMessage(ALICE_PUB, ALICE_PRIV, BOB_PUB, "привет, Боб", 5, publish);
	assert.equal(sentEvent.kind, 445);
	assert.equal(eventId, sentEvent.id);
	assert.deepEqual(sentEvent.tags, [["h", groupIdHex]]);
	// эфемерный ключ — pubkey события НЕ равен identity-ключу отправителя
	assert.notEqual(sentEvent.pubkey, ALICE_PUB);

	// "Переключаемся" на Боба (его отдельная копия состояния, не запись Алисы) — см. asBob
	const { result: received } = await asBob(groupIdHex, bobSerializedState, () =>
		receiveGroupMessageEvent(BOB_PUB, sentEvent),
	);
	assert.deepEqual(received, { text: "привет, Боб", lamportTs: 5 });
});

test("receiveGroupMessageEvent: неизвестный groupId (h-тег) — discard, не бросает", async () => {
	const fakeEvent = { kind: 445, tags: [["h", "00".repeat(32)]], content: "irrelevant", pubkey: "x", id: "y" };
	const result = await receiveGroupMessageEvent(BOB_PUB, fakeEvent);
	assert.equal(result, null);
});

test("contactPubkey переживает put() из sendMessage — второй приём после второй отправки всё ещё резолвит нужного контакта", async () => {
	const { groupId, bobSerializedState } = await establishAliceToBob();
	const groupIdHex = toHex(groupId);
	const sentEvents = [];
	const publish = async (event) => {
		sentEvents.push(event);
		return { ok: true };
	};
	await sendMessage(ALICE_PUB, ALICE_PRIV, BOB_PUB, "первое", 1, publish);
	// contactPubkey должен пережить put() внутри sendMessage (это был реальный найденный баг)
	const rowAfterFirstSend = await db.table("mlsGroups").get(groupIdHex);
	assert.equal(rowAfterFirstSend.contactPubkey, BOB_PUB);

	await asBob(groupIdHex, bobSerializedState, () => receiveGroupMessageEvent(BOB_PUB, sentEvents[0]));
	const bobRowAfterReceive = await db.table("mlsGroups").get(groupIdHex);
	assert.equal(bobRowAfterReceive.contactPubkey, ALICE_PUB, "и после приёма (put в receiveGroupMessageEvent) тоже");
});

test("acceptWelcome: требует опубликованный собственный ownKeyPackage", async () => {
	await assert.rejects(() => acceptWelcome(BOB_PUB, ALICE_PUB, new Uint8Array(10)), /KeyPackage/);
});

test("sendMessage: каждое сообщение публикуется с НОВЫМ эфемерным ключом (не переиспользуется)", async () => {
	await establishAliceToBob();
	const events = [];
	const publish = async (event) => {
		events.push(event);
		return { ok: true };
	};
	await sendMessage(ALICE_PUB, ALICE_PRIV, BOB_PUB, "первое", 1, publish);
	await sendMessage(ALICE_PUB, ALICE_PRIV, BOB_PUB, "второе", 2, publish);
	assert.notEqual(events[0].pubkey, events[1].pubkey);
});

test("getChatHistory: сортировка по (lamportTs, senderPubkey, eventId) — F-MS-05/AC-05", async () => {
	await db.table("messages").bulkAdd([
		{ chatId: BOB_PUB, lamportTs: 2, senderPubkey: ALICE_PUB, id: "e2", text: "b", status: "sent" },
		{ chatId: BOB_PUB, lamportTs: 1, senderPubkey: BOB_PUB, id: "e1", text: "a", status: "sent" },
		{ chatId: BOB_PUB, lamportTs: 2, senderPubkey: ALICE_PUB, id: "e0", text: "c-tiebreak-by-id", status: "sent" },
	]);
	const history = await getChatHistory(BOB_PUB);
	assert.deepEqual(
		history.map((m) => m.id),
		["e1", "e0", "e2"],
	);
});

test("getChatHistory: не путает разные чаты (chatId изоляция)", async () => {
	const carolPub = bytesToHex(getPublicKey(new Uint8Array(32).fill(3)));
	await db.table("messages").bulkAdd([
		{ chatId: BOB_PUB, lamportTs: 1, senderPubkey: ALICE_PUB, id: "e1", text: "for bob", status: "sent" },
		{ chatId: carolPub, lamportTs: 1, senderPubkey: ALICE_PUB, id: "e2", text: "for carol", status: "sent" },
	]);
	const history = await getChatHistory(BOB_PUB);
	assert.deepEqual(history.map((m) => m.text), ["for bob"]);
});
