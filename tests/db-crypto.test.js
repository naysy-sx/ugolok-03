import { test } from "node:test";
import assert from "node:assert/strict";
import { encryptRow, decryptRow } from "../src/core/crypto/db-crypto.js";

const dbKey = crypto.getRandomValues(new Uint8Array(32));

test("encryptRow -> decryptRow: round-trip произвольного JSON-сериализуемого значения", () => {
	const value = { chatId: "abc", lamportTs: 42, tags: ["a", "b"], nested: { x: 1 } };
	const encrypted = encryptRow(value, dbKey);
	assert.deepEqual(decryptRow(encrypted, dbKey), value);
});

test("encryptRow -> decryptRow: строки, числа, массивы, null, вложенные объекты", () => {
	for (const value of ["plain string", 12345, [1, 2, 3], null, { a: { b: { c: [] } } }]) {
		const encrypted = encryptRow(value, dbKey);
		assert.deepEqual(decryptRow(encrypted, dbKey), value);
	}
});

test("encryptRow: возвращает {nonce, ciphertext}, nonce 12 байт", () => {
	const encrypted = encryptRow({ x: 1 }, dbKey);
	assert.ok(encrypted.nonce instanceof Uint8Array);
	assert.equal(encrypted.nonce.length, 12);
	assert.ok(encrypted.ciphertext instanceof Uint8Array);
});

test("encryptRow дважды подряд на то же значение — разные nonce и ciphertext (не переиспользует nonce)", () => {
	const a = encryptRow({ x: 1 }, dbKey);
	const b = encryptRow({ x: 1 }, dbKey);
	assert.notDeepEqual(a.nonce, b.nonce);
	assert.notDeepEqual(a.ciphertext, b.ciphertext);
});

test("decryptRow с неверным dbKey — отклоняется (AEAD tag mismatch), не возвращает мусор молча", () => {
	const encrypted = encryptRow({ secret: "значение" }, dbKey);
	const wrongKey = crypto.getRandomValues(new Uint8Array(32));
	assert.throws(() => decryptRow(encrypted, wrongKey));
});

// Найдено реальным использованием (этап 39): mlsGroups.state/ownKeyPackage's
// privatePackage/wireBytes — Uint8Array (иногда вложенный внутри объекта, не
// только top-level). Голый JSON.stringify/parse ТЕРЯЕТ Uint8Array-тип (превращает
// в {"0":1,"1":2,...}) — deserializeState() падал с "First argument to DataView
// constructor must be an ArrayBuffer" при попытке использовать результат.
test("encryptRow -> decryptRow: Uint8Array на top-level переживает round-trip КАК Uint8Array, не как объект с числовыми ключами", () => {
	const value = { state: new Uint8Array([1, 2, 3, 255, 0, 128]) };
	const encrypted = encryptRow(value, dbKey);
	const decrypted = decryptRow(encrypted, dbKey);
	assert.ok(decrypted.state instanceof Uint8Array, "обязан остаться Uint8Array, не превратиться в {0:1,1:2,...}");
	assert.deepEqual(decrypted.state, value.state);
});

test("encryptRow -> decryptRow: Uint8Array ВЛОЖЕННЫЙ внутри объекта (как ts-mls's KeyPackage) тоже переживает round-trip", () => {
	const value = { publicPackage: { leafNode: { encryptionKey: new Uint8Array([9, 8, 7]) }, meta: "x" }, wireBytes: new Uint8Array(64).fill(42) };
	const encrypted = encryptRow(value, dbKey);
	const decrypted = decryptRow(encrypted, dbKey);
	assert.ok(decrypted.publicPackage.leafNode.encryptionKey instanceof Uint8Array);
	assert.deepEqual(decrypted.publicPackage.leafNode.encryptionKey, value.publicPackage.leafNode.encryptionKey);
	assert.ok(decrypted.wireBytes instanceof Uint8Array);
	assert.deepEqual(decrypted.wireBytes, value.wireBytes);
});

// Найдено реальным использованием (этап 39, следом за Uint8Array-находкой):
// ts-mls's KeyPackage (createOwnKeyPackage's publicPackage/privatePackage)
// содержит BigInt (протокольные поля MLS) — JSON.stringify БЕЗ спецобработки
// бросает "Do not know how to serialize a BigInt".
test("encryptRow -> decryptRow: BigInt (top-level и вложенный) переживает round-trip КАК BigInt", () => {
	const value = { epoch: 9007199254740993n, nested: { leafIndex: 42n } };
	const encrypted = encryptRow(value, dbKey);
	const decrypted = decryptRow(encrypted, dbKey);
	assert.equal(typeof decrypted.epoch, "bigint");
	assert.equal(decrypted.epoch, 9007199254740993n);
	assert.equal(typeof decrypted.nested.leafIndex, "bigint");
	assert.equal(decrypted.nested.leafIndex, 42n);
});

test("AC-16 (частично, на уровне примитива): ciphertext не содержит plaintext как подстроку", () => {
	const secretMarker = "совершенно-секретный-маркер-12345";
	const encrypted = encryptRow({ content: secretMarker }, dbKey);
	const ciphertextAsLatin1 = Buffer.from(encrypted.ciphertext).toString("latin1");
	assert.equal(ciphertextAsLatin1.includes(secretMarker), false);
});
