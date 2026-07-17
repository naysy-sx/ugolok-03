import { test } from "node:test";
import assert from "node:assert/strict";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
	generateMnemonic,
	validateMnemonic,
	mnemonicToPrivateKey,
} from "../src/core/crypto/mnemonic.js";

const VECTOR_MNEMONIC =
	"leader monkey parrot ring guide accident before fence cannon height naive bean";
const VECTOR_PRIVKEY_HEX =
	"7f7ff03d123792d6ac594bfa67bf6d0c0ab55b6b1fdb6249303fe861f1ccba9a";

test("смоук-тест NIP-06 (§16.1 TECH.md): точный вектор privKey", async () => {
	const privKey = await mnemonicToPrivateKey(VECTOR_MNEMONIC);
	assert.equal(bytesToHex(privKey), VECTOR_PRIVKEY_HEX);
});

test("validateMnemonic: true для валидного вектора из §16.1", () => {
	assert.equal(validateMnemonic(VECTOR_MNEMONIC), true);
});

test("validateMnemonic: false для мусора/неверной контрольной суммы", () => {
	assert.equal(validateMnemonic("not a valid mnemonic phrase at all here"), false);
	assert.equal(
		validateMnemonic(
			"leader monkey parrot ring guide accident before fence cannon height naive naive",
		),
		false,
	);
});

test("generateMnemonic: 12 слов, валидна по своей же проверке", () => {
	const m = generateMnemonic();
	assert.equal(m.split(" ").length, 12);
	assert.equal(validateMnemonic(m), true);
});

test("generateMnemonic: два вызова дают разные мнемоники (не константа)", () => {
	const a = generateMnemonic();
	const b = generateMnemonic();
	assert.notEqual(a, b);
});

test("mnemonicToPrivateKey: детерминирована (одна мнемоника -> один и тот же ключ)", async () => {
	const k1 = await mnemonicToPrivateKey(VECTOR_MNEMONIC);
	const k2 = await mnemonicToPrivateKey(VECTOR_MNEMONIC);
	assert.deepEqual(k1, k2);
});

test("mnemonicToPrivateKey: разные мнемоники -> разные ключи", async () => {
	const generated = generateMnemonic();
	const k1 = await mnemonicToPrivateKey(VECTOR_MNEMONIC);
	const k2 = await mnemonicToPrivateKey(generated);
	assert.notDeepEqual(k1, k2);
});

test("mnemonicToPrivateKey: возвращает Uint8Array длиной 32 байта", async () => {
	const k = await mnemonicToPrivateKey(VECTOR_MNEMONIC);
	assert.ok(k instanceof Uint8Array);
	assert.equal(k.length, 32);
});

test("mnemonicToPrivateKey: пустая строка бросает исключение (не наша валидация — библиотечная)", async () => {
	await assert.rejects(() => mnemonicToPrivateKey(""));
});

test("mnemonicToPrivateKey: НЕ валидирует контрольную сумму (контракт — забота вызывающего кода)", async () => {
	const badChecksum =
		"leader monkey parrot ring guide accident before fence cannon height naive naive";
	assert.equal(validateMnemonic(badChecksum), false);
	// mnemonicToPrivateKey тем не менее тихо деривирует ключ — так и задокументировано в CONTRACTS.md
	const k = await mnemonicToPrivateKey(badChecksum);
	assert.equal(k.length, 32);
});
