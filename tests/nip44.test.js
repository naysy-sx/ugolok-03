import { test } from "node:test";
import assert from "node:assert/strict";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { encrypt, decrypt } from "../src/core/crypto/nip44.js";

test("encrypt/decrypt: round-trip между двумя ключами", () => {
	const aliceSk = generateSecretKey();
	const bobSk = generateSecretKey();
	const bobPk = getPublicKey(bobSk);
	const alicePk = getPublicKey(aliceSk);

	const ct = encrypt("hello bob", aliceSk, bobPk);
	const pt = decrypt(ct, bobSk, alicePk);
	assert.equal(pt, "hello bob");
});

test("decrypt: чужим ключом не расшифровывается (бросает)", () => {
	const aliceSk = generateSecretKey();
	const bobSk = generateSecretKey();
	const eveSk = generateSecretKey();
	const bobPk = getPublicKey(bobSk);
	const alicePk = getPublicKey(aliceSk);

	const ct = encrypt("secret", aliceSk, bobPk);
	assert.throws(() => decrypt(ct, eveSk, alicePk));
});

test("encrypt: plaintext ровно 65535 байт — проходит (app-политика, не протокол)", () => {
	const aliceSk = generateSecretKey();
	const bobPk = getPublicKey(generateSecretKey());
	const exact = "a".repeat(65535);
	assert.doesNotThrow(() => encrypt(exact, aliceSk, bobPk));
});

test("encrypt: plaintext 65536 байт — бросает (app-политика проекта, решение пользователя, не лимит протокола NIP-44)", () => {
	const aliceSk = generateSecretKey();
	const bobPk = getPublicKey(generateSecretKey());
	const over = "a".repeat(65536);
	assert.throws(() => encrypt(over, aliceSk, bobPk), /65535/);
});
