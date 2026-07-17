import "fake-indexeddb/auto";
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import Dexie from "dexie";
import { wrapEncryptedTable } from "../src/core/store/encrypted-table.js";

const dbKey = crypto.getRandomValues(new Uint8Array(32));

const testDb = new Dexie("ugolok-encrypted-table-test");
testDb.version(1).stores({
	widgets: "id, ownerPubkey",
});

before(async () => {
	await testDb.open();
});

beforeEach(async () => {
	await testDb.table("widgets").clear();
});

after(() => {
	testDb.close();
});

test("put -> get: round-trip полной записи (plaintext + зашифрованные поля) прозрачен для вызывающего кода", async () => {
	const wrapped = wrapEncryptedTable(testDb.table("widgets"), ["id", "ownerPubkey"], dbKey);
	const record = { id: "w1", ownerPubkey: "abc123", label: "секретная метка", count: 7 };
	await wrapped.put(record);
	assert.deepEqual(await wrapped.get("w1"), record);
});

test("get: несуществующий ключ -> undefined, не throw", async () => {
	const wrapped = wrapEncryptedTable(testDb.table("widgets"), ["id", "ownerPubkey"], dbKey);
	assert.equal(await wrapped.get("no-such-id"), undefined);
});

test("AC-16: сырой дамп таблицы (в обход обёртки) — plaintext-поля видны, остальное только {nonce, ciphertext}", async () => {
	const wrapped = wrapEncryptedTable(testDb.table("widgets"), ["id", "ownerPubkey"], dbKey);
	const secretLabel = "совершенно-секретная-метка-виджета";
	await wrapped.put({ id: "w1", ownerPubkey: "abc123", label: secretLabel, count: 7 });

	const raw = await testDb.table("widgets").get("w1");
	assert.equal(raw.id, "w1");
	assert.equal(raw.ownerPubkey, "abc123");
	assert.equal("label" in raw, false, "зашифрованное поле не должно существовать в открытом виде в сыром дампе");
	assert.equal("count" in raw, false);
	assert.ok(raw.nonce instanceof Uint8Array);
	assert.ok(raw.ciphertext instanceof Uint8Array);

	const ciphertextAsLatin1 = Buffer.from(raw.ciphertext).toString("latin1");
	assert.equal(ciphertextAsLatin1.includes(secretLabel), false);
});

test("E1 (allowlist/default-deny): поле, НЕ объявленное в plaintextFields, шифруется, даже если выглядит как индекс", async () => {
	// "count" не в allowlist, хотя мог бы выглядеть как потенциальный индекс — должен уйти в зашифрованный блок
	const wrapped = wrapEncryptedTable(testDb.table("widgets"), ["id"], dbKey);
	await wrapped.put({ id: "w2", ownerPubkey: "should-be-encrypted", label: "x", count: 1 });

	const raw = await testDb.table("widgets").get("w2");
	assert.equal(raw.id, "w2");
	assert.equal("ownerPubkey" in raw, false, "поле вне allowlist обязано быть зашифровано, а не остаться plaintext по умолчанию");
});

test("get с неверным dbKey — отклоняется (AEAD tag mismatch), не отдаёт мусор", async () => {
	const wrapped = wrapEncryptedTable(testDb.table("widgets"), ["id", "ownerPubkey"], dbKey);
	await wrapped.put({ id: "w3", ownerPubkey: "abc", label: "секрет" });

	const wrongKey = crypto.getRandomValues(new Uint8Array(32));
	const wrappedWrongKey = wrapEncryptedTable(testDb.table("widgets"), ["id", "ownerPubkey"], wrongKey);
	await assert.rejects(() => wrappedWrongKey.get("w3"));
});

test("прямая порча сырых байт ciphertext (в обход обёртки) — get() отклоняет, не отдаёт испорченные данные молча", async () => {
	const wrapped = wrapEncryptedTable(testDb.table("widgets"), ["id"], dbKey);
	await wrapped.put({ id: "w4", secret: "нетронутое значение" });

	const raw = await testDb.table("widgets").get("w4");
	raw.ciphertext[0] ^= 0xff;
	await testDb.table("widgets").put(raw);

	await assert.rejects(() => wrapped.get("w4"));
});

test("два разных dbKey (напр. два аккаунта) дают несовместимые данные — изоляция", async () => {
	const keyA = crypto.getRandomValues(new Uint8Array(32));
	const keyB = crypto.getRandomValues(new Uint8Array(32));
	const wrappedA = wrapEncryptedTable(testDb.table("widgets"), ["id"], keyA);
	const wrappedB = wrapEncryptedTable(testDb.table("widgets"), ["id"], keyB);

	await wrappedA.put({ id: "shared-id", secret: "принадлежит A" });
	await assert.rejects(() => wrappedB.get("shared-id"));
});
