import { test } from "node:test";
import assert from "node:assert/strict";
import { bytesToHex } from "@noble/hashes/utils.js";
import { mnemonicToPrivateKey } from "../src/core/crypto/mnemonic.js";
import { getPublicKey } from "../src/core/crypto/keys.js";

const VECTOR_MNEMONIC =
	"leader monkey parrot ring guide accident before fence cannon height naive bean";
const VECTOR_PUBKEY_HEX =
	"17162c921dc4d2518f9a101db33695df1afb56ab82f5ff3e5da6eec3ca5cd917";

test("смоук-тест NIP-06 (§16.1 TECH.md): точный вектор pubKey", async () => {
	const privKey = await mnemonicToPrivateKey(VECTOR_MNEMONIC);
	const pubKey = getPublicKey(privKey);
	assert.equal(bytesToHex(pubKey), VECTOR_PUBKEY_HEX);
});

test("getPublicKey: возвращает Uint8Array длиной 32 байта (x-only)", async () => {
	const privKey = await mnemonicToPrivateKey(VECTOR_MNEMONIC);
	const pubKey = getPublicKey(privKey);
	assert.ok(pubKey instanceof Uint8Array);
	assert.equal(pubKey.length, 32);
});

test("getPublicKey: детерминирована для одного и того же privKey", async () => {
	const privKey = await mnemonicToPrivateKey(VECTOR_MNEMONIC);
	assert.deepEqual(getPublicKey(privKey), getPublicKey(privKey));
});
