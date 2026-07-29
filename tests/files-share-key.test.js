import { test } from "node:test";
import assert from "node:assert/strict";
import { bytesToHex } from "@noble/hashes/utils.js";
import { getPublicKey } from "../src/core/crypto/keys.js";
import {
	generateSubtreeKey,
	encryptShareGrant,
	decryptShareGrant,
	encryptSubtreeOp,
	decryptSubtreeOp,
	peekSubtreeOpVersion,
	deriveShareFileKey,
} from "../src/core/crypto/share-key.js";

const OWNER_PRIV = new Uint8Array(32).fill(1);
const READER_PRIV = new Uint8Array(32).fill(2);
const OWNER_PUB = bytesToHex(getPublicKey(OWNER_PRIV));
const READER_PUB = bytesToHex(getPublicKey(READER_PRIV));
const OTHER_PRIV = new Uint8Array(32).fill(3);

test("generateSubtreeKey: 32 случайных байта, разные при каждом вызове", () => {
	const a = generateSubtreeKey();
	const b = generateSubtreeKey();
	assert.equal(a.length, 32);
	assert.equal(b.length, 32);
	assert.notDeepEqual(a, b);
});

test("encryptShareGrant/decryptShareGrant: round-trip даёт исходные nodeId/subtreeKey/version", () => {
	const content = encryptShareGrant("node-uuid-1", "bb".repeat(32), 1, OWNER_PRIV, READER_PUB);
	const decrypted = decryptShareGrant(content, READER_PRIV, OWNER_PUB);
	assert.deepEqual(decrypted, { nodeId: "node-uuid-1", subtreeKey: "bb".repeat(32), version: 1 });
});

test("encryptShareGrant: версия — обязательная часть payload (перенесённый урок этапа 33 — без неё revoke не отличит эпохи)", () => {
	const content = encryptShareGrant("node-uuid-1", "bb".repeat(32), 2, OWNER_PRIV, READER_PUB);
	const decrypted = decryptShareGrant(content, READER_PRIV, OWNER_PUB);
	assert.equal(decrypted.version, 2);
});

test("decryptShareGrant: чужой приватный ключ (не reader) -> throw, не тихо возвращает мусор", () => {
	const content = encryptShareGrant("node-uuid-1", "bb".repeat(32), 1, OWNER_PRIV, READER_PUB);
	assert.throws(() => decryptShareGrant(content, OTHER_PRIV, OWNER_PUB));
});

test("encryptSubtreeOp/decryptSubtreeOp: round-trip даёт исходный JSON операции", () => {
	const keyHex = bytesToHex(generateSubtreeKey());
	const opJson = JSON.stringify({ type: "create", id: "n-1", kind: "dir", blob: null, parentId: "$root", name: "Заметки", origin: null });
	const content = encryptSubtreeOp(opJson, keyHex, 1);
	const result = decryptSubtreeOp(content, { 1: keyHex });
	assert.equal(result, opJson);
});

test("decryptSubtreeOp: неизвестная версия (никогда не было гранта на эту эпоху) -> null, не throw", () => {
	const keyHex = bytesToHex(generateSubtreeKey());
	const content = encryptSubtreeOp("{}", keyHex, 5);
	const result = decryptSubtreeOp(content, { 1: keyHex });
	assert.equal(result, null);
});

test("encryptSubtreeOp: версия попадает в заголовок конверта буквально (по образцу F-CH-03)", () => {
	const keyHex = bytesToHex(generateSubtreeKey());
	const v1 = encryptSubtreeOp("x", keyHex, 1);
	const v7 = encryptSubtreeOp("x", keyHex, 7);
	assert.equal(decryptSubtreeOp(v1, { 1: keyHex, 7: keyHex }), "x");
	assert.equal(decryptSubtreeOp(v7, { 1: keyHex, 7: keyHex }), "x");
	assert.notEqual(v1, v7);
});

test("decryptSubtreeOp: отозванный читатель (только эпоха 1 в карте) не расшифрует эпоху ПОСЛЕ revoke", () => {
	const keyV1 = bytesToHex(generateSubtreeKey());
	const keyV2 = bytesToHex(generateSubtreeKey());
	const contentV2 = encryptSubtreeOp("операция после revoke", keyV2, 2);
	assert.equal(decryptSubtreeOp(contentV2, { 1: keyV1 }), null);
});

test("peekSubtreeOpVersion: читает версию из заголовка БЕЗ расшифровки, даже с заведомо неверным ключом карты", () => {
	const keyHex = bytesToHex(generateSubtreeKey());
	const content = encryptSubtreeOp("x", keyHex, 42);
	assert.equal(peekSubtreeOpVersion(content), 42);
});

test("deriveShareFileKey: детерминирована — тот же (subtreeKey, plaintextDigest) даёт тот же fileKey", () => {
	const subtreeKeyHex = bytesToHex(generateSubtreeKey());
	const digest = "aa".repeat(32);
	const a = deriveShareFileKey(subtreeKeyHex, digest);
	const b = deriveShareFileKey(subtreeKeyHex, digest);
	assert.equal(a.length, 32);
	assert.deepEqual(a, b);
});

test("deriveShareFileKey: разный plaintextDigest -> разный fileKey (компрометация одного файла не раскрывает остальные)", () => {
	const subtreeKeyHex = bytesToHex(generateSubtreeKey());
	const a = deriveShareFileKey(subtreeKeyHex, "aa".repeat(32));
	const b = deriveShareFileKey(subtreeKeyHex, "bb".repeat(32));
	assert.notDeepEqual(a, b);
});

test("deriveShareFileKey: разный subtreeKey (другая доля/эпоха) -> разный fileKey при том же digest", () => {
	const digest = "aa".repeat(32);
	const a = deriveShareFileKey(bytesToHex(generateSubtreeKey()), digest);
	const b = deriveShareFileKey(bytesToHex(generateSubtreeKey()), digest);
	assert.notDeepEqual(a, b);
});
