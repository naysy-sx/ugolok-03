import "fake-indexeddb/auto";
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { db } from "../src/core/store/database.js";
import { getPublicKey } from "../src/core/crypto/keys.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { createOwnKeyPackage, joinFromWelcome } from "../src/core/crypto/mls-session.js";
import {
	isKnownContact,
	storeInboxRequest,
	listInboxRequests,
	acceptInboxRequest,
	rejectInboxRequest,
} from "../src/domain/messaging/inbox-requests.js";
import { ensureChatEstablished, computeGroupId } from "../src/domain/messaging/chat.js";
import { unwrap as nip59Unwrap } from "../src/core/crypto/nip59.js";

const ALICE_PRIV = new Uint8Array(32).fill(1);
const STRANGER_PRIV = new Uint8Array(32).fill(9);
const ALICE_PUB = bytesToHex(getPublicKey(ALICE_PRIV));
const STRANGER_PUB = bytesToHex(getPublicKey(STRANGER_PRIV));

before(async () => {
	await db.open();
});

beforeEach(async () => {
	await db.table("contacts").clear();
	await db.table("inboxRequests").clear();
	await db.table("mlsGroups").clear();
	await db.table("ownKeyPackage").clear();
});

after(() => {
	db.close();
});

test("isKnownContact: false, если контакта нет в списке", async () => {
	assert.equal(await isKnownContact(ALICE_PUB, STRANGER_PUB), false);
});

test("isKnownContact: true, если контакт есть", async () => {
	await db.table("contacts").put({ owner: ALICE_PUB, pubkey: STRANGER_PUB });
	assert.equal(await isKnownContact(ALICE_PUB, STRANGER_PUB), true);
});

test("storeInboxRequest/listInboxRequests: owner-scoped — не путает разных владельцев на одном устройстве", async () => {
	const bobPub = bytesToHex(getPublicKey(new Uint8Array(32).fill(2)));
	await storeInboxRequest(ALICE_PUB, STRANGER_PUB, new Uint8Array([1, 2, 3]), 100);
	await storeInboxRequest(bobPub, STRANGER_PUB, new Uint8Array([4, 5, 6]), 200);

	const aliceRequests = await listInboxRequests(ALICE_PUB);
	assert.equal(aliceRequests.length, 1);
	assert.equal(aliceRequests[0].senderPubkey, STRANGER_PUB);
	assert.deepEqual(aliceRequests[0].welcomeWireBytes, new Uint8Array([1, 2, 3]));

	const bobRequests = await listInboxRequests(bobPub);
	assert.equal(bobRequests.length, 1);
	assert.deepEqual(bobRequests[0].welcomeWireBytes, new Uint8Array([4, 5, 6]));
});

test("rejectInboxRequest: удаляет запись, MLS-группа не создавалась (нечего откатывать)", async () => {
	await storeInboxRequest(ALICE_PUB, STRANGER_PUB, new Uint8Array([1]), 100);
	await rejectInboxRequest(ALICE_PUB, STRANGER_PUB);
	assert.equal((await listInboxRequests(ALICE_PUB)).length, 0);
	assert.equal(await db.table("mlsGroups").count(), 0);
});

test("acceptInboxRequest: реально присоединяет к MLS-группе (настоящий Welcome) и удаляет запись", async () => {
	// Симулируем: незнакомец установил бы чат с Алисой (как contactRequests-флоу, но это Welcome напрямую)
	const alicePub2 = ALICE_PUB;
	const aliceOwnKeyPackage = await createOwnKeyPackage(alicePub2, "alice-device");
	await db.table("ownKeyPackage").put({
		id: "self",
		publicPackage: aliceOwnKeyPackage.publicPackage,
		privatePackage: aliceOwnKeyPackage.privatePackage,
		wireBytes: aliceOwnKeyPackage.wireBytes,
	});

	let welcomeGiftWrap;
	const publish = async (event) => {
		if (event.kind === 1059) welcomeGiftWrap = event;
		return { ok: true };
	};
	// Незнакомец (условно) инициирует через тот же примитив ensureChatEstablished, адресуя Welcome Алисе
	await ensureChatEstablished(STRANGER_PUB, STRANGER_PRIV, alicePub2, publish, async () => aliceOwnKeyPackage.wireBytes);
	await db.table("mlsGroups").clear(); // у Алисы своей записи ещё нет — это ЕЁ первый приём

	const rumor = nip59Unwrap(welcomeGiftWrap, ALICE_PRIV);
	const welcomeWireBytes = Uint8Array.from(atob(rumor.content), (c) => c.charCodeAt(0));

	await storeInboxRequest(ALICE_PUB, STRANGER_PUB, welcomeWireBytes, rumor.created_at);
	assert.equal((await listInboxRequests(ALICE_PUB)).length, 1);

	await acceptInboxRequest(ALICE_PUB, STRANGER_PUB);

	assert.equal((await listInboxRequests(ALICE_PUB)).length, 0, "запись удалена после принятия");
	const groupIdHex = bytesToHex(computeGroupId(ALICE_PUB, STRANGER_PUB));
	const groupRow = await db.table("mlsGroups").get(groupIdHex);
	assert.ok(groupRow, "Алиса реально присоединилась к MLS-группе");
	assert.equal(groupRow.contactPubkey, STRANGER_PUB);
});

test("acceptInboxRequest: нет такой записи — понятная ошибка, не тихий сбой", async () => {
	await assert.rejects(() => acceptInboxRequest(ALICE_PUB, STRANGER_PUB), /входящ/);
});
