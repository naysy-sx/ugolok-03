import { test } from "node:test";
import assert from "node:assert/strict";
import { encryptFile, decryptFile } from "../src/core/crypto/file-crypto.js";

test("decryptFile(encryptFile(file)) побайтно идентичен (критерий приёмки TECH.md §13.3.4)", () => {
	const file = crypto.getRandomValues(new Uint8Array(50000));
	const { key, blob } = encryptFile(file);
	const decrypted = decryptFile(blob, key);
	assert.deepEqual(decrypted, file);
});

test("encryptFile: key — 32 байта, blob = nonce(12) + ciphertext+tag(16)", () => {
	const file = new Uint8Array(1000);
	const { key, blob } = encryptFile(file);
	assert.equal(key.length, 32);
	assert.equal(blob.length, 12 + 1000 + 16);
});

test("encryptFile: два вызова на одном файле дают разные key/nonce (случайность каждый раз)", () => {
	const file = new Uint8Array(100).fill(5);
	const a = encryptFile(file);
	const b = encryptFile(file);
	assert.notDeepEqual(a.key, b.key);
	assert.notDeepEqual(a.blob.slice(0, 12), b.blob.slice(0, 12));
});

test("decryptFile: неверный key -> бросает (не тихо отдаёт мусор)", () => {
	const file = crypto.getRandomValues(new Uint8Array(100));
	const { blob } = encryptFile(file);
	const wrongKey = crypto.getRandomValues(new Uint8Array(32));
	assert.throws(() => decryptFile(blob, wrongKey));
});

test("decryptFile: подмена байта в blob -> бросает (AEAD целостность)", () => {
	const file = crypto.getRandomValues(new Uint8Array(100));
	const { key, blob } = encryptFile(file);
	const tampered = new Uint8Array(blob);
	tampered[20] ^= 0xff;
	assert.throws(() => decryptFile(tampered, key));
});

test("decryptFile(encryptFile(file)) на пустом файле (0 байт) — граничный случай", () => {
	const file = new Uint8Array(0);
	const { key, blob } = encryptFile(file);
	const decrypted = decryptFile(blob, key);
	assert.equal(decrypted.length, 0);
});
