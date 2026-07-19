import "fake-indexeddb/auto";
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import Dexie from "dexie";
import { toEncryptedRow, fromEncryptedRow } from "../src/core/store/encrypted-table.js";

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

test("toEncryptedRow -> put -> get -> fromEncryptedRow: round-trip полной записи прозрачен для вызывающего кода", async () => {
	const record = { id: "w1", ownerPubkey: "abc123", label: "секретная метка", count: 7 };
	await testDb.table("widgets").put(toEncryptedRow(record, ["id", "ownerPubkey"], dbKey));
	const raw = await testDb.table("widgets").get("w1");
	assert.deepEqual(fromEncryptedRow(raw, dbKey), record);
});

test("fromEncryptedRow: несуществующая строка (undefined) -> undefined, не throw", () => {
	assert.equal(fromEncryptedRow(undefined, dbKey), undefined);
});

test("AC-16: сырой дамп таблицы (в обход toEncryptedRow/fromEncryptedRow) — plaintext-поля видны, остальное только {nonce, ciphertext}", async () => {
	const secretLabel = "совершенно-секретная-метка-виджета";
	await testDb.table("widgets").put(toEncryptedRow({ id: "w1", ownerPubkey: "abc123", label: secretLabel, count: 7 }, ["id", "ownerPubkey"], dbKey));

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
	// "ownerPubkey" не в allowlist в этом вызове, хотя мог бы выглядеть как потенциальный
	// индекс — должен уйти в зашифрованный блок, а не остаться plaintext по умолчанию.
	await testDb.table("widgets").put(toEncryptedRow({ id: "w2", ownerPubkey: "should-be-encrypted", label: "x", count: 1 }, ["id"], dbKey));

	const raw = await testDb.table("widgets").get("w2");
	assert.equal(raw.id, "w2");
	assert.equal("ownerPubkey" in raw, false, "поле вне allowlist обязано быть зашифровано, а не остаться plaintext по умолчанию");
});

test("fromEncryptedRow с неверным dbKey — отклоняется (AEAD tag mismatch), не отдаёт мусор", async () => {
	await testDb.table("widgets").put(toEncryptedRow({ id: "w3", ownerPubkey: "abc", label: "секрет" }, ["id", "ownerPubkey"], dbKey));
	const raw = await testDb.table("widgets").get("w3");

	const wrongKey = crypto.getRandomValues(new Uint8Array(32));
	assert.throws(() => fromEncryptedRow(raw, wrongKey));
});

test("прямая порча сырых байт ciphertext (в обход обёртки) — fromEncryptedRow отклоняет, не отдаёт испорченные данные молча", async () => {
	await testDb.table("widgets").put(toEncryptedRow({ id: "w4", secret: "нетронутое значение" }, ["id"], dbKey));

	const raw = await testDb.table("widgets").get("w4");
	raw.ciphertext[0] ^= 0xff;
	await testDb.table("widgets").put(raw);

	const corrupted = await testDb.table("widgets").get("w4");
	assert.throws(() => fromEncryptedRow(corrupted, dbKey));
});

test("два разных dbKey (напр. два аккаунта) дают несовместимые данные — изоляция", async () => {
	const keyA = crypto.getRandomValues(new Uint8Array(32));
	const keyB = crypto.getRandomValues(new Uint8Array(32));

	await testDb.table("widgets").put(toEncryptedRow({ id: "shared-id", secret: "принадлежит A" }, ["id"], keyA));
	const raw = await testDb.table("widgets").get("shared-id");
	assert.throws(() => fromEncryptedRow(raw, keyB));
});

test("toEncryptedRow: sensitive-поля шифруются ОДНИМ вызовом encryptRow (не по одному) — один nonce на всю строку", async () => {
	const record = { id: "w5", a: 1, b: 2, c: 3 };
	const row = toEncryptedRow(record, ["id"], dbKey);
	// один nonce/ciphertext на все sensitive-поля вместе, не массив по числу полей
	assert.equal(row.nonce.length, 12);
	assert.deepEqual(fromEncryptedRow(row, dbKey), record);
});
