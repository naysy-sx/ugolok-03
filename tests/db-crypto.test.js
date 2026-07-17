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

test("AC-16 (частично, на уровне примитива): ciphertext не содержит plaintext как подстроку", () => {
	const secretMarker = "совершенно-секретный-маркер-12345";
	const encrypted = encryptRow({ content: secretMarker }, dbKey);
	const ciphertextAsLatin1 = Buffer.from(encrypted.ciphertext).toString("latin1");
	assert.equal(ciphertextAsLatin1.includes(secretMarker), false);
});
