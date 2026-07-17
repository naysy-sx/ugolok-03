import "fake-indexeddb/auto";
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { db } from "../src/core/store/database.js";
import { encryptAndStore, decryptPrivateKey } from "../src/core/crypto/keystore.js";

before(async () => {
	await db.open();
});

beforeEach(async () => {
	await db.table("keystore").clear();
});

after(() => {
	db.close();
});

test("encryptAndStore -> decryptPrivateKey с верным паролем возвращает исходный privKey", async () => {
	const privKey = crypto.getRandomValues(new Uint8Array(32));
	await encryptAndStore(privKey, "correct horse battery staple");
	const decrypted = await decryptPrivateKey("correct horse battery staple");
	assert.deepEqual(new Uint8Array(decrypted), privKey);
});

test("decryptPrivateKey с неверным паролем — отклоняется (AES-GCM tag mismatch)", async () => {
	const privKey = crypto.getRandomValues(new Uint8Array(32));
	await encryptAndStore(privKey, "correct-password");
	await assert.rejects(() => decryptPrivateKey("wrong-password"));
});

test("decryptPrivateKey без сохранённого ключа — понятная ошибка, не крах", async () => {
	await assert.rejects(
		() => decryptPrivateKey("any-password"),
		/keystore/i,
	);
});

test("хранимая запись не содержит privKey в открытом виде (реально зашифровано)", async () => {
	const privKey = crypto.getRandomValues(new Uint8Array(32));
	await encryptAndStore(privKey, "some-password");
	const record = await db.table("keystore").get("privkey");
	const ciphertextBytes = new Uint8Array(record.ciphertext);
	assert.notDeepEqual(ciphertextBytes.slice(0, 32), privKey);
});

test("encryptAndStore дважды подряд — новые salt/iv каждый раз (не переиспользуются)", async () => {
	const privKey = crypto.getRandomValues(new Uint8Array(32));
	await encryptAndStore(privKey, "password-one");
	const first = await db.table("keystore").get("privkey");
	await encryptAndStore(privKey, "password-two");
	const second = await db.table("keystore").get("privkey");
	assert.notDeepEqual(new Uint8Array(first.salt), new Uint8Array(second.salt));
	assert.notDeepEqual(new Uint8Array(first.iv), new Uint8Array(second.iv));
	// новый пароль актуален, старый больше не подходит
	await assert.rejects(() => decryptPrivateKey("password-one"));
	const decrypted = await decryptPrivateKey("password-two");
	assert.deepEqual(new Uint8Array(decrypted), privKey);
});
