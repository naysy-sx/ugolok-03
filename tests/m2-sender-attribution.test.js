import "fake-indexeddb/auto";
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { db } from "../src/core/store/database.js";
import { getPublicKey } from "../src/core/crypto/keys.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { unwrap as nip59Unwrap } from "../src/core/crypto/nip59.js";
import { encrypt as nip44Encrypt } from "../src/core/crypto/nip44.js";
import {
	createOwnKeyPackage,
	joinFromWelcome,
	serializeState,
	deserializeState,
	encryptApplicationMessage,
	deriveNostrEnvelopeKeys,
} from "../src/core/crypto/mls-session.js";
import { deriveMasterSecret, deriveMirrorKey } from "../src/core/crypto/derivation.js";
import { decryptMirrorPayload } from "../src/domain/messaging/mirror.js";
import { toEncryptedRow, fromEncryptedRow } from "../src/core/store/encrypted-table.js";
import { MLS_GROUPS_PLAINTEXT_FIELDS } from "../src/core/store/table-fields.js";
import { computeGroupId, ensureChatEstablished, sendMessage, receiveGroupMessageEvent, getChatHistory } from "../src/domain/messaging/chat.js";
import { syncDeviceMembership } from "../src/domain/messaging/devices.js";

// Этап 74 — T1 (CONTRACTS.md/DESIGN.md "Этап 74"): RC-1 — receiveGroupMessageEvent/
// mirrorBestEffort жёстко приписывали КАЖДОЕ живое 445 контакту, даже если это
// было своё сообщение, пришедшее от sibling-устройства ТОЙ ЖЕ identity (с этапа 72
// все устройства ОБЕИХ identity состоят в одной MLS-группе). Тесты ниже — ровно
// 5 кейсов из TZ-MULTIDEVICE-FIX.md §T1.

const ALICE_PRIV = new Uint8Array(32).fill(1);
const BOB_PRIV = new Uint8Array(32).fill(2);
const STRANGER_PRIV = new Uint8Array(32).fill(3);
const ALICE_PUB = bytesToHex(getPublicKey(ALICE_PRIV));
const BOB_PUB = bytesToHex(getPublicKey(BOB_PRIV));
const STRANGER_PUB = bytesToHex(getPublicKey(STRANGER_PRIV));
const DB_KEY = crypto.getRandomValues(new Uint8Array(32));

function encodeBase64(bytes) {
	return btoa(String.fromCharCode.apply(null, bytes));
}

before(async () => {
	await db.open();
});

beforeEach(async () => {
	await db.table("ownKeyPackage").clear();
	await db.table("mlsGroups").clear();
	await db.table("messages").clear();
	await db.table("knownDevices").clear();
	await db.table("knownContactDevices").clear();
});

after(() => {
	db.close();
});

// Тот же паттерн, что chat.test.js/devices.test.js: единственная db в процессе,
// "переключение на другое устройство" — подмена строки mlsGroups под тем же
// составным ключом [ownerPubkey, groupIdHex] чужим сериализованным состоянием.
async function establishAliceToBob() {
	const bobKeyPackage = await createOwnKeyPackage(BOB_PUB, "bob-device");
	const fetchDeviceKeyPackages = async () => new Map([["bob-device", { wireBytes: bobKeyPackage.wireBytes, createdAt: 1000 }]]);
	let welcomeGiftWrap;
	const publish = async (event) => {
		if (event.kind === 1059) welcomeGiftWrap = event;
		return { ok: true };
	};
	await ensureChatEstablished(ALICE_PUB, ALICE_PRIV, DB_KEY, BOB_PUB, publish, fetchDeviceKeyPackages);
	const rumor = nip59Unwrap(welcomeGiftWrap, BOB_PRIV);
	const welcomeWireBytes = Uint8Array.from(atob(rumor.content), (c) => c.charCodeAt(0));
	const bobState = await joinFromWelcome(bobKeyPackage, welcomeWireBytes);
	return { groupIdHex: bytesToHex(computeGroupId(ALICE_PUB, BOB_PUB)), bobSerializedState: serializeState(bobState) };
}

async function asRow(ownerPubkey, contactPubkey, groupIdHex, serializedState, fn) {
	await db.table("mlsGroups").put(
		toEncryptedRow({ ownerPubkey, groupId: groupIdHex, contactPubkey, state: serializedState }, MLS_GROUPS_PLAINTEXT_FIELDS, DB_KEY),
	);
	const result = await fn();
	const updatedRaw = await db.table("mlsGroups").get([ownerPubkey, groupIdHex]);
	return { result, updatedSerializedState: fromEncryptedRow(updatedRaw, DB_KEY).state };
}

async function messageRow(ownerPubkey, chatId, msgId) {
	const rows = await getChatHistory(ownerPubkey, chatId, DB_KEY);
	return rows.find((r) => r.msgId === msgId);
}

// Строит "чужой" wire-event поверх произвольного MLS-состояния с payload, не
// прошедшим через sendMessage() — нужен для кейсов "старый формат"/"посторонний
// senderPubkey", которые sendMessage() (после T1.1) больше произвести не может.
async function sendRawPayload(state, groupIdHex, payloadOverride) {
	const plaintext = new TextEncoder().encode(JSON.stringify(payloadOverride));
	const { newSessionState, wireBytes } = await encryptApplicationMessage(state, plaintext);
	const { privateKey, publicKey } = await deriveNostrEnvelopeKeys(newSessionState);
	const content = nip44Encrypt(encodeBase64(wireBytes), privateKey, bytesToHex(publicKey));
	return { newSessionState, event: { kind: 445, tags: [["h", groupIdHex]], content, id: "raw-" + payloadOverride.msgId, pubkey: "irrelevant" } };
}

test("T1: отправка A1 (Алиса) -> приём A2 той же identity живым 445 -> senderPubkey === alice", async () => {
	const { groupIdHex } = await establishAliceToBob();

	const siblingKeyPackage = await createOwnKeyPackage(ALICE_PUB, "sibling-device");
	const published = [];
	const publish = async (event) => {
		published.push(event);
		return { ok: true };
	};
	await syncDeviceMembership(ALICE_PUB, ALICE_PRIV, DB_KEY, publish, async () => [
		{ wireBytes: siblingKeyPackage.wireBytes, deviceId: "sibling-1" },
	]);
	const welcomeGiftWrap = published.find((e) => e.kind === 1059);
	const welcomeRumor = nip59Unwrap(welcomeGiftWrap, ALICE_PRIV);
	const welcomeWireBytes = Uint8Array.from(atob(welcomeRumor.content), (c) => c.charCodeAt(0));
	const siblingState = await joinFromWelcome(siblingKeyPackage, welcomeWireBytes);

	// A1 (главное устройство Алисы, сейчас в слоте [ALICE_PUB, groupIdHex] —
	// syncDeviceMembership уже продвинул его состояние коммитом добавления A2) шлёт —
	// НЕ через sendMessage(): тот пишет СВОЮ локальную строку в messages ДО того, как
	// A2 вообще получит событие, и общий (для теста) ownerPubkey-namespace messages
	// маскировал бы RC-1 под RC-2 (первая, уже верная запись A1 "побеждает" по
	// unique-индексу [ownerPubkey+chatId+msgId] раньше, чем A2 успевает записать
	// НЕВЕРНУЮ — ложно-зелёный тест). В реальности A1 и A2 — РАЗНЫЕ устройства с
	// РАЗНЫМИ базами: у A2 нет и не может быть предсуществующей строки от A1.
	// sendRawPayload с senderPubkey уже в payload — то, что произведёт T1.1 на
	// стороне A1 (эта строка теста фиксирует ожидаемый КОНТРАКТ payload, не зависит
	// от порядка реализации T1.1/T1.2).
	const aliceRaw = await db.table("mlsGroups").get([ALICE_PUB, groupIdHex]);
	const aliceState = deserializeState(fromEncryptedRow(aliceRaw, DB_KEY).state);
	const { event: liveEvent } = await sendRawPayload(aliceState, groupIdHex, {
		text: "привет от A1",
		lamportTs: 10,
		msgId: "a1-live-1",
		sentAt: 1000,
		senderPubkey: ALICE_PUB,
	});

	// A2 (sibling) получает то же живое 445 — единственная запись, которую видит
	// его собственная (в реальности отдельная) messages-таблица для этого события.
	await asRow(ALICE_PUB, BOB_PUB, groupIdHex, serializeState(siblingState), () =>
		receiveGroupMessageEvent(ALICE_PUB, ALICE_PRIV, DB_KEY, liveEvent, async () => ({ ok: true })),
	);

	const row = await messageRow(ALICE_PUB, BOB_PUB, "a1-live-1");
	assert.equal(row.senderPubkey, ALICE_PUB, "своё сообщение от sibling-устройства обязано остаться исходящим, не входящим от контакта");
});

test("T1: отправка Бобом -> приём A1 -> senderPubkey === bob", async () => {
	const { groupIdHex, bobSerializedState } = await establishAliceToBob();
	const published = [];
	const publish = async (event) => {
		published.push(event);
		return { ok: true };
	};

	const { updatedSerializedState } = await asRow(BOB_PUB, ALICE_PUB, groupIdHex, bobSerializedState, () =>
		sendMessage(BOB_PUB, BOB_PRIV, DB_KEY, ALICE_PUB, "привет от Боба", 1, publish),
	);
	const liveEvent = published.find((e) => e.kind === 445);

	await receiveGroupMessageEvent(ALICE_PUB, ALICE_PRIV, DB_KEY, liveEvent, async () => ({ ok: true }));

	const rows = await getChatHistory(ALICE_PUB, BOB_PUB, DB_KEY);
	const row = rows.find((r) => r.text === "привет от Боба");
	assert.equal(row.senderPubkey, BOB_PUB);
});

test("T1: payload старого формата (без senderPubkey) -> senderPubkey === contact (обратная совместимость)", async () => {
	const { groupIdHex, bobSerializedState } = await establishAliceToBob();
	// Алиса — держатель group-state в слоте [ALICE_PUB, groupIdHex] после establish.
	const aliceRaw = await db.table("mlsGroups").get([ALICE_PUB, groupIdHex]);
	const aliceState = deserializeState(fromEncryptedRow(aliceRaw, DB_KEY).state);

	const { event } = await sendRawPayload(aliceState, groupIdHex, { text: "старый формат", lamportTs: 1, msgId: "old-1" });
	// sendRawPayload использует состояние Алисы напрямую (эквивалент "A1 отправил
	// старым клиентом, ещё без T1.1") — приём делаем на стороне Боба, у него
	// contactPubkey === ALICE_PUB.
	await asRow(BOB_PUB, ALICE_PUB, groupIdHex, bobSerializedState, () =>
		receiveGroupMessageEvent(BOB_PUB, BOB_PRIV, DB_KEY, event, async () => ({ ok: true })),
	);

	const rows = await getChatHistory(BOB_PUB, ALICE_PUB, DB_KEY);
	const row = rows.find((r) => r.msgId === "old-1");
	assert.equal(row.senderPubkey, ALICE_PUB, "payload без senderPubkey должен нормализоваться в contactPubkey (прежнее поведение)");
});

test("T1: payload с посторонним senderPubkey (не owner, не contact) -> нормализован в contactPubkey", async () => {
	const { groupIdHex, bobSerializedState } = await establishAliceToBob();
	const aliceRaw = await db.table("mlsGroups").get([ALICE_PUB, groupIdHex]);
	const aliceState = deserializeState(fromEncryptedRow(aliceRaw, DB_KEY).state);

	const { event } = await sendRawPayload(aliceState, groupIdHex, { text: "мусорный sender", lamportTs: 2, msgId: "spoof-1", senderPubkey: STRANGER_PUB });
	await asRow(BOB_PUB, ALICE_PUB, groupIdHex, bobSerializedState, () =>
		receiveGroupMessageEvent(BOB_PUB, BOB_PRIV, DB_KEY, event, async () => ({ ok: true })),
	);

	const rows = await getChatHistory(BOB_PUB, ALICE_PUB, DB_KEY);
	const row = rows.find((r) => r.msgId === "spoof-1");
	assert.equal(row.senderPubkey, ALICE_PUB, "постороннее значение в payload — мусор/спуфинг, сводится к contactPubkey");
});

test("T1: зеркало, порождённое приёмником, несёт тот же senderPubkey, что и строка", async () => {
	const { groupIdHex, bobSerializedState } = await establishAliceToBob();
	const published = [];
	const publish = async (event) => {
		published.push(event);
		return { ok: true };
	};
	await sendMessage(ALICE_PUB, ALICE_PRIV, DB_KEY, BOB_PUB, "проверка зеркала", 3, publish);
	const liveEvent = published.find((e) => e.kind === 445);

	published.length = 0;
	await asRow(BOB_PUB, ALICE_PUB, groupIdHex, bobSerializedState, () =>
		receiveGroupMessageEvent(BOB_PUB, BOB_PRIV, DB_KEY, liveEvent, publish),
	);

	const mirrorEvent = published.find((e) => e.kind === 446);
	assert.ok(mirrorEvent, "приёмник обязан best-effort зеркалировать принятое сообщение");
	const mirrorKey = deriveMirrorKey(deriveMasterSecret(BOB_PRIV));
	const mirrorPayload = decryptMirrorPayload(mirrorEvent.content, mirrorKey);

	const rows = await getChatHistory(BOB_PUB, ALICE_PUB, DB_KEY);
	const row = rows.find((r) => r.text === "проверка зеркала");
	assert.equal(mirrorPayload.senderPubkey, row.senderPubkey, "зеркало обязано нести ТОТ ЖЕ senderPubkey, что и уже сохранённая строка");
	assert.equal(mirrorPayload.senderPubkey, ALICE_PUB);
});
