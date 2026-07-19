import "fake-indexeddb/auto";
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { db } from "../src/core/store/database.js";
import { getPublicKey } from "../src/core/crypto/keys.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { unwrap as nip59Unwrap } from "../src/core/crypto/nip59.js";
import {
	createOwnKeyPackage,
	joinFromWelcome,
	serializeState,
	encryptApplicationMessage,
	deriveNostrEnvelopeKeys,
} from "../src/core/crypto/mls-session.js";
import { encrypt as nip44Encrypt } from "../src/core/crypto/nip44.js";
import { ensureChatEstablished, receiveGroupMessageEvent, computeGroupId } from "../src/domain/messaging/chat.js";
import { syncDeviceMembership } from "../src/domain/messaging/devices.js";
import { getOrCreateDeviceId } from "../src/domain/identity/device.js";

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
	await db.table("deviceIdentity").clear();
	await db.table("knownDevices").clear();
});

after(() => {
	db.close();
});

// Устанавливает реальный MLS-чат Alice<->Bob (как chat.test.js's establishAliceToBob),
// оставляя запись Алисы последней в db.mlsGroups (её "устройство А" будет sync'ить сиблингов).
// Возвращает bobKeyPackage/bobSerializedState — нужны, чтобы отдельно проверить, что Боб
// (уже существующий участник) реально получает и применяет коммит при добавлении сиблинга.
async function establishAliceToBob() {
	const bobKeyPackage = await createOwnKeyPackage(BOB_PUB, "alice-main-device");
	const fetchKeyPackage = async () => bobKeyPackage.wireBytes;
	let welcomeGiftWrap;
	const publish = async (event) => {
		if (event.kind === 1059) welcomeGiftWrap = event;
		return { ok: true };
	};
	await ensureChatEstablished(ALICE_PUB, ALICE_PRIV, BOB_PUB, publish, fetchKeyPackage);

	const rumor = nip59Unwrap(welcomeGiftWrap, BOB_PRIV);
	const welcomeWireBytes = Uint8Array.from(atob(rumor.content), (c) => c.charCodeAt(0));
	const bobState = await joinFromWelcome(bobKeyPackage, welcomeWireBytes);
	return { bobKeyPackage, bobSerializedState: serializeState(bobState) };
}

// Симулирует "теперь мы на устройстве Боба" — подкладывает его копию состояния в
// db.mlsGroups (единственная база в этом тестовом процессе), не трогая копию Алисы
// (тот же паттерн, что chat.test.js's asBob).
async function asBob(groupIdHex, bobSerializedState, fn) {
	await db.table("mlsGroups").put({ ownerPubkey: BOB_PUB, groupId: groupIdHex, contactPubkey: ALICE_PUB, state: bobSerializedState });
	const result = await fn();
	const updatedBobRow = await db.table("mlsGroups").get([BOB_PUB, groupIdHex]);
	return { result, updatedBobSerializedState: updatedBobRow.state };
}

test("syncDeviceMembership: существующий участник (Bob) получает КОММИТ и реально продвигает эпоху — не застревает молча", async () => {
	const { bobSerializedState: bobStateBeforeAdd } = await establishAliceToBob();
	const groupIdHex = bytesToHex(computeGroupId(ALICE_PUB, BOB_PUB));

	const siblingKeyPackage = await createOwnKeyPackage(ALICE_PUB, "sibling-device");
	const published = [];
	const publish = async (event) => {
		published.push(event);
		return { ok: true };
	};
	await syncDeviceMembership(ALICE_PUB, ALICE_PRIV, publish, async () => [
		{ wireBytes: siblingKeyPackage.wireBytes, deviceId: "sibling-1" },
	]);

	const commitEvents = published.filter((e) => e.kind === 445);
	assert.equal(commitEvents.length, 1, "должен опубликовать РОВНО один коммит для существующего участника (Bob)");
	assert.deepEqual(commitEvents[0].tags, [["h", groupIdHex]]);

	// Боб получает коммит через уже существующий receiveGroupMessageEvent (chat.js, этап 24) —
	// без правки chat.js: коммит — это просто ещё один kind 445, ветка result.kind==="control".
	const { result: commitResult, updatedBobSerializedState } = await asBob(groupIdHex, bobStateBeforeAdd, () =>
		receiveGroupMessageEvent(BOB_PUB, BOB_PRIV, commitEvents[0], async () => ({ ok: true })),
	);
	assert.equal(commitResult, null, "коммит — control-сообщение, не текст, UI ничего не показывает");

	// Доказательство, что эпоха РЕАЛЬНО продвинулась (не просто "не бросило исключение"):
	// сиблинг (уже член группы после Welcome) шлёт НОВОЕ сообщение в НОВОЙ эпохе,
	// и обновлённое состояние Боба обязано суметь его расшифровать.
	const welcomeEvent = published.find((e) => e.kind === 1059);
	const welcomeRumor = nip59Unwrap(welcomeEvent, ALICE_PRIV);
	const welcomeWireBytes = Uint8Array.from(atob(welcomeRumor.content), (c) => c.charCodeAt(0));
	let siblingState = await joinFromWelcome(siblingKeyPackage, welcomeWireBytes);

	function encodeBase64(bytes) {
		return btoa(String.fromCharCode.apply(null, bytes));
	}
	const plaintext = new TextEncoder().encode(JSON.stringify({ text: "после добавления сиблинга", lamportTs: 99, msgId: "x" }));
	const encResult = await encryptApplicationMessage(siblingState, plaintext);
	siblingState = encResult.newSessionState;
	const { privateKey, publicKey } = await deriveNostrEnvelopeKeys(siblingState);
	const content = nip44Encrypt(encodeBase64(encResult.wireBytes), privateKey, bytesToHex(publicKey));
	const siblingMessageEvent = { kind: 445, tags: [["h", groupIdHex]], content, id: "sibling-msg", pubkey: "irrelevant" };

	const { result: decryptedByBob } = await asBob(groupIdHex, updatedBobSerializedState, () =>
		receiveGroupMessageEvent(BOB_PUB, BOB_PRIV, siblingMessageEvent, async () => ({ ok: true })),
	);
	// contactPubkey (этап 34) — аддитивное поле, нужное transport.js для уведомлений.
	assert.deepEqual(decryptedByBob, { text: "после добавления сиблинга", lamportTs: 99, contactPubkey: ALICE_PUB });
});

test("syncDeviceMembership: нет анонсов — no-op, publish не вызывается", async () => {
	const publish = async () => {
		throw new Error("не должен вызываться");
	};
	await syncDeviceMembership(ALICE_PUB, ALICE_PRIV, publish, async () => []);
});

test("syncDeviceMembership: собственный deviceId в анонсах игнорируется", async () => {
	const myDeviceId = await getOrCreateDeviceId();
	const publish = async () => {
		throw new Error("не должен вызываться для собственного анонса");
	};
	await syncDeviceMembership(ALICE_PUB, ALICE_PRIV, publish, async () => [
		{ wireBytes: new Uint8Array(1), deviceId: myDeviceId },
	]);
	const known = await db.table("knownDevices").toArray();
	assert.equal(known.length, 0);
});

test("syncDeviceMembership: анонс без device-тега (легаси) игнорируется", async () => {
	const publish = async () => {
		throw new Error("не должен вызываться");
	};
	await syncDeviceMembership(ALICE_PUB, ALICE_PRIV, publish, async () => [
		{ wireBytes: new Uint8Array(1), deviceId: undefined },
	]);
	const known = await db.table("knownDevices").toArray();
	assert.equal(known.length, 0);
});

test("syncDeviceMembership: новый сиблинг без активных чатов — записан в knownDevices, ничего не публикуется", async () => {
	const siblingKeyPackage = await createOwnKeyPackage(ALICE_PUB, "sibling-device");
	const publish = async () => {
		throw new Error("не должен вызываться — нет активных групп");
	};
	await syncDeviceMembership(ALICE_PUB, ALICE_PRIV, publish, async () => [
		{ wireBytes: siblingKeyPackage.wireBytes, deviceId: "sibling-1" },
	]);
	const row = await db.table("knownDevices").get([ALICE_PUB, "sibling-1"]);
	assert.ok(row);
	assert.deepEqual(row.addedGroupIds, []);
});

test("syncDeviceMembership: новый сиблинг + один активный чат — добавлен в MLS-группу, Welcome опубликован", async () => {
	await establishAliceToBob();
	const rowsBefore = await db.table("mlsGroups").where("ownerPubkey").equals(ALICE_PUB).toArray();
	assert.equal(rowsBefore.length, 1);
	const groupIdHex = rowsBefore[0].groupId;

	const siblingKeyPackage = await createOwnKeyPackage(ALICE_PUB, "sibling-device");
	const published = [];
	const publish = async (event) => {
		published.push(event);
		return { ok: true };
	};
	await syncDeviceMembership(ALICE_PUB, ALICE_PRIV, publish, async () => [
		{ wireBytes: siblingKeyPackage.wireBytes, deviceId: "sibling-1" },
	]);

	assert.equal(published.length, 2, "коммит (kind 445, для Боба) + Welcome (kind 1059, для сиблинга)");
	assert.equal(
		published.filter((e) => e.kind === 445).length,
		1,
		"коммит для уже существующего участника (Боба) — обязателен, иначе он застрянет на старой эпохе",
	);
	const welcomeGiftWrap = published.find((e) => e.kind === 1059);
	assert.ok(welcomeGiftWrap, "Welcome доставляется как gift-wrap");
	const rumor = nip59Unwrap(welcomeGiftWrap, ALICE_PRIV);
	assert.equal(rumor.kind, 444);
	assert.equal(rumor.pubkey, ALICE_PUB, "sibling-Welcome отправлен от МОЕГО ЖЕ identity, не от Боба");
	assert.deepEqual(
		rumor.tags,
		[["contact", BOB_PUB]],
		"contactPubkey обязан быть тегом — rumor.pubkey===я не годится диспетчеру, чтобы понять, с кем этот чат (DESIGN.md, раздел 1b)",
	);
	const welcomeWireBytes = Uint8Array.from(atob(rumor.content), (c) => c.charCodeAt(0));
	const siblingState = await joinFromWelcome(siblingKeyPackage, welcomeWireBytes);
	assert.ok(siblingState, "сиблинг реально может применить Welcome и присоединиться к группе");

	const knownRow = await db.table("knownDevices").get([ALICE_PUB, "sibling-1"]);
	assert.deepEqual(knownRow.addedGroupIds, [groupIdHex]);

	const aliceGroupRow = await db.table("mlsGroups").get([ALICE_PUB, groupIdHex]);
	assert.equal(aliceGroupRow.contactPubkey, BOB_PUB, "contactPubkey Алисы не потерян после addMember");
});

test("syncDeviceMembership: повторный вызов с тем же сиблингом и той же группой — НЕ дублирует addMember/Welcome", async () => {
	await establishAliceToBob();
	const siblingKeyPackage = await createOwnKeyPackage(ALICE_PUB, "sibling-device");
	const fetch = async () => [{ wireBytes: siblingKeyPackage.wireBytes, deviceId: "sibling-1" }];
	let publishCount = 0;
	const publish = async () => {
		publishCount++;
		return { ok: true };
	};
	await syncDeviceMembership(ALICE_PUB, ALICE_PRIV, publish, fetch);
	assert.equal(publishCount, 2, "коммит + Welcome на первое добавление");
	await syncDeviceMembership(ALICE_PUB, ALICE_PRIV, publish, fetch);
	assert.equal(publishCount, 2, "второй заход не должен снова добавлять уже добавленного сиблинга в ту же группу");
});

test("syncDeviceMembership: сиблинг уже известен (без групп), позже появляется новая группа — добавляется при следующем заходе", async () => {
	const siblingKeyPackage = await createOwnKeyPackage(ALICE_PUB, "sibling-device");
	const fetch = async () => [{ wireBytes: siblingKeyPackage.wireBytes, deviceId: "sibling-1" }];
	const publish = async () => ({ ok: true });

	await syncDeviceMembership(ALICE_PUB, ALICE_PRIV, publish, fetch);
	let knownRow = await db.table("knownDevices").get([ALICE_PUB, "sibling-1"]);
	assert.deepEqual(knownRow.addedGroupIds, []);

	await establishAliceToBob();
	let publishCount = 0;
	await syncDeviceMembership(ALICE_PUB, ALICE_PRIV, async (e) => {
		publishCount++;
		return { ok: true };
	}, fetch);
	assert.equal(publishCount, 2, "новая группа должна быть подхвачена на следующем заходе (коммит + Welcome)");
	knownRow = await db.table("knownDevices").get([ALICE_PUB, "sibling-1"]);
	assert.equal(knownRow.addedGroupIds.length, 1);
});

test("syncDeviceMembership: повреждённое объявление одного сиблинга не блокирует обработку ДРУГОГО (изоляция по элементу, найдено адверсарным заходом)", async () => {
	await establishAliceToBob();
	const goodSibling = await createOwnKeyPackage(ALICE_PUB, "good-device");
	const published = [];
	const publish = async (event) => {
		published.push(event);
		return { ok: true };
	};

	await syncDeviceMembership(ALICE_PUB, ALICE_PRIV, publish, async () => [
		{ wireBytes: new Uint8Array([1, 2, 3, 4]), deviceId: "broken-device" }, // мусорные байты — addMember должен упасть
		{ wireBytes: goodSibling.wireBytes, deviceId: "good-device" },
	]);

	assert.equal(published.length, 2, "хороший сиблинг всё равно должен быть добавлен (коммит + Welcome)");
	const knownGood = await db.table("knownDevices").get([ALICE_PUB, "good-device"]);
	assert.equal(knownGood.addedGroupIds.length, 1, "хороший сиблинг добавлен, несмотря на сбой на сломанном");
	const knownBroken = await db.table("knownDevices").get([ALICE_PUB, "broken-device"]);
	assert.ok(knownBroken, "сломанный сиблинг всё равно записан как известный (сбой был в addMember, не раньше)");
	assert.deepEqual(knownBroken.addedGroupIds, [], "но НЕ отмечен как добавленный в группу — сбой не замаскирован");
});
