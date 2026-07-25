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
import { toEncryptedRow, fromEncryptedRow } from "../src/core/store/encrypted-table.js";
import { OWN_KEY_PACKAGE_PLAINTEXT_FIELDS } from "../src/core/store/table-fields.js";

const ALICE_PRIV = new Uint8Array(32).fill(1);
const STRANGER_PRIV = new Uint8Array(32).fill(9);
const ALICE_PUB = bytesToHex(getPublicKey(ALICE_PRIV));
const STRANGER_PUB = bytesToHex(getPublicKey(STRANGER_PRIV));
const DB_KEY = crypto.getRandomValues(new Uint8Array(32));

before(async () => {
	await db.open();
});

beforeEach(async () => {
	await db.table("contactRelationships").clear();
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

test("isKnownContact: true, если peer в состоянии CONTACT (contactRelationships, этап 49)", async () => {
	await db.table("contactRelationships").put({ owner: ALICE_PUB, peer: STRANGER_PUB, state: "CONTACT", resolvedAt: 1 });
	assert.equal(await isKnownContact(ALICE_PUB, STRANGER_PUB), true);
});

// Найдено живым E2E (этап 50) — старая isKnownContact спрашивала перманентно
// пустую после миграции таблицу contacts, из-за чего Welcome от УЖЕ принятого
// контакта всегда шёл в inbox незнакомца. Здесь же — peer есть в таблице, но
// НЕ в состоянии CONTACT (например ещё pending) — тоже не "known".
test("isKnownContact: false, если peer есть в contactRelationships, но НЕ в состоянии CONTACT", async () => {
	await db.table("contactRelationships").put({ owner: ALICE_PUB, peer: STRANGER_PUB, state: "INCOMING_PENDING", resolvedAt: 0, greeting: "x" });
	assert.equal(await isKnownContact(ALICE_PUB, STRANGER_PUB), false);
});

// AC-16 (найдено пользователем прямым осмотром IndexedDB) — welcomeWireBytes несёт
// MLS-протокольный материал незнакомца, до явного решения пользователя (accept/reject).
test("AC-16: inboxRequests хранится зашифрованным — сырой дамп не содержит welcomeWireBytes", async () => {
	await storeInboxRequest(ALICE_PUB, DB_KEY, STRANGER_PUB, new Uint8Array([9, 9, 9]), 100);
	const raw = await db.table("inboxRequests").get([ALICE_PUB, STRANGER_PUB]);
	assert.equal(raw.senderPubkey, STRANGER_PUB);
	assert.equal("welcomeWireBytes" in raw, false);
	assert.ok(raw.nonce instanceof Uint8Array);
	assert.ok(raw.ciphertext instanceof Uint8Array);

	const decrypted = fromEncryptedRow(raw, DB_KEY);
	assert.deepEqual(decrypted.welcomeWireBytes, new Uint8Array([9, 9, 9]));
});

test("storeInboxRequest/listInboxRequests: owner-scoped — не путает разных владельцев на одном устройстве", async () => {
	const bobPub = bytesToHex(getPublicKey(new Uint8Array(32).fill(2)));
	await storeInboxRequest(ALICE_PUB, DB_KEY, STRANGER_PUB, new Uint8Array([1, 2, 3]), 100);
	await storeInboxRequest(bobPub, DB_KEY, STRANGER_PUB, new Uint8Array([4, 5, 6]), 200);

	const aliceRequests = await listInboxRequests(ALICE_PUB, DB_KEY);
	assert.equal(aliceRequests.length, 1);
	assert.equal(aliceRequests[0].senderPubkey, STRANGER_PUB);
	assert.deepEqual(aliceRequests[0].welcomeWireBytes, new Uint8Array([1, 2, 3]));

	const bobRequests = await listInboxRequests(bobPub, DB_KEY);
	assert.equal(bobRequests.length, 1);
	assert.deepEqual(bobRequests[0].welcomeWireBytes, new Uint8Array([4, 5, 6]));
});

test("rejectInboxRequest: удаляет запись, MLS-группа не создавалась (нечего откатывать)", async () => {
	await storeInboxRequest(ALICE_PUB, DB_KEY, STRANGER_PUB, new Uint8Array([1]), 100);
	await rejectInboxRequest(ALICE_PUB, STRANGER_PUB);
	assert.equal((await listInboxRequests(ALICE_PUB, DB_KEY)).length, 0);
	assert.equal(await db.table("mlsGroups").count(), 0);
});

test("acceptInboxRequest: реально присоединяет к MLS-группе (настоящий Welcome) и удаляет запись", async () => {
	// Симулируем: незнакомец установил бы чат с Алисой (как contactRequests-флоу, но это Welcome напрямую)
	const alicePub2 = ALICE_PUB;
	const aliceOwnKeyPackage = await createOwnKeyPackage(alicePub2, "alice-device");
	await db.table("ownKeyPackage").put(toEncryptedRow({
		ownerPubkey: alicePub2,
		publicPackage: aliceOwnKeyPackage.publicPackage,
		privatePackage: aliceOwnKeyPackage.privatePackage,
		wireBytes: aliceOwnKeyPackage.wireBytes,
	}, OWN_KEY_PACKAGE_PLAINTEXT_FIELDS, DB_KEY));

	let welcomeGiftWrap;
	const publish = async (event) => {
		if (event.kind === 1059) welcomeGiftWrap = event;
		return { ok: true };
	};
	// Незнакомец (условно) инициирует через тот же примитив ensureChatEstablished, адресуя Welcome Алисе
	await ensureChatEstablished(STRANGER_PUB, STRANGER_PRIV, DB_KEY, alicePub2, publish, async () => aliceOwnKeyPackage.wireBytes);
	await db.table("mlsGroups").clear(); // у Алисы своей записи ещё нет — это ЕЁ первый приём

	const rumor = nip59Unwrap(welcomeGiftWrap, ALICE_PRIV);
	const welcomeWireBytes = Uint8Array.from(atob(rumor.content), (c) => c.charCodeAt(0));

	await storeInboxRequest(ALICE_PUB, DB_KEY, STRANGER_PUB, welcomeWireBytes, rumor.created_at);
	assert.equal((await listInboxRequests(ALICE_PUB, DB_KEY)).length, 1);

	await acceptInboxRequest(ALICE_PUB, DB_KEY, STRANGER_PUB);

	assert.equal((await listInboxRequests(ALICE_PUB, DB_KEY)).length, 0, "запись удалена после принятия");
	const groupIdHex = bytesToHex(computeGroupId(ALICE_PUB, STRANGER_PUB));
	const groupRow = fromEncryptedRow(await db.table("mlsGroups").get([ALICE_PUB, groupIdHex]), DB_KEY);
	assert.ok(groupRow, "Алиса реально присоединилась к MLS-группе");
	assert.equal(groupRow.contactPubkey, STRANGER_PUB);
});

test("acceptInboxRequest: нет такой записи — понятная ошибка, не тихий сбой", async () => {
	await assert.rejects(() => acceptInboxRequest(ALICE_PUB, DB_KEY, STRANGER_PUB), /входящ/);
});
