import { test } from "node:test";
import assert from "node:assert/strict";
import { bytesToHex } from "@noble/hashes/utils.js";
import { getPublicKey } from "../src/core/crypto/keys.js";
import {
	generateChannelKey,
	generateChannelTopic,
	encryptChannelKeyGrant,
	decryptChannelKeyGrant,
	encryptChannelContent,
	decryptChannelContent,
} from "../src/core/crypto/channel-key.js";

const OWNER_PRIV = new Uint8Array(32).fill(1);
const READER_PRIV = new Uint8Array(32).fill(2);
const OWNER_PUB = bytesToHex(getPublicKey(OWNER_PRIV));
const READER_PUB = bytesToHex(getPublicKey(READER_PRIV));
const OTHER_PRIV = new Uint8Array(32).fill(3);

test("generateChannelKey: 32 случайных байта, разные при каждом вызове", () => {
	const a = generateChannelKey();
	const b = generateChannelKey();
	assert.equal(a.length, 32);
	assert.equal(b.length, 32);
	assert.notDeepEqual(a, b);
});

test("generateChannelTopic: 16 случайных байт, разные при каждом вызове", () => {
	const a = generateChannelTopic();
	const b = generateChannelTopic();
	assert.equal(a.length, 16);
	assert.equal(b.length, 16);
	assert.notDeepEqual(a, b);
});

test("encryptChannelKeyGrant/decryptChannelKeyGrant: round-trip даёт исходные channelId/channelTopic/channelKey/version", () => {
	const content = encryptChannelKeyGrant("channel-uuid-1", "aa".repeat(16), "bb".repeat(32), 1, OWNER_PRIV, READER_PUB);
	const decrypted = decryptChannelKeyGrant(content, READER_PRIV, OWNER_PUB);
	assert.deepEqual(decrypted, { channelId: "channel-uuid-1", channelTopic: "aa".repeat(16), channelKey: "bb".repeat(32), version: 1 });
});

test("encryptChannelKeyGrant: версия — обязательная часть payload (найдено адверсарным тестом этапа 33 — без неё receiveChannelKeyGrant не может отличить эпохи при ротации)", () => {
	const content = encryptChannelKeyGrant("channel-uuid-1", "aa".repeat(16), "bb".repeat(32), 2, OWNER_PRIV, READER_PUB);
	const decrypted = decryptChannelKeyGrant(content, READER_PRIV, OWNER_PUB);
	assert.equal(decrypted.version, 2);
});

test("decryptChannelKeyGrant: чужой приватный ключ (не reader) -> throw, не тихо возвращает мусор", () => {
	const content = encryptChannelKeyGrant("channel-uuid-1", "aa".repeat(16), "bb".repeat(32), 1, OWNER_PRIV, READER_PUB);
	assert.throws(() => decryptChannelKeyGrant(content, OTHER_PRIV, OWNER_PUB));
});

test("encryptChannelContent/decryptChannelContent: round-trip даёт исходный plaintext", () => {
	const keyHex = bytesToHex(generateChannelKey());
	const content = encryptChannelContent("привет, канал!", keyHex, 1);
	const result = decryptChannelContent(content, { 1: keyHex });
	assert.equal(result, "привет, канал!");
});

test("decryptChannelContent: неизвестная версия (никогда не было VIEW на эту эпоху) -> null, не throw", () => {
	const keyHex = bytesToHex(generateChannelKey());
	const content = encryptChannelContent("текст", keyHex, 5);
	const result = decryptChannelContent(content, { 1: keyHex }); // версии 5 в карте нет
	assert.equal(result, null);
});

test("encryptChannelContent: версия попадает в заголовок конверта буквально (F-CH-03)", () => {
	const keyHex = bytesToHex(generateChannelKey());
	const v1 = encryptChannelContent("x", keyHex, 1);
	const v7 = encryptChannelContent("x", keyHex, 7);
	assert.equal(decryptChannelContent(v1, { 1: keyHex, 7: keyHex }), "x");
	assert.equal(decryptChannelContent(v7, { 1: keyHex, 7: keyHex }), "x");
	// разные версии -> разные конверты даже с тем же ключом/plaintext (разный заголовок+nonce)
	assert.notEqual(v1, v7);
});

test("decryptChannelContent: разные читатели с эпохой ПОСЛЕ revoke не расшифруют новую эпоху (L-07 наоборот — они просто не в карте ключей)", () => {
	const keyV1 = bytesToHex(generateChannelKey());
	const keyV2 = bytesToHex(generateChannelKey());
	const contentV2 = encryptChannelContent("новый пост после revoke", keyV2, 2);
	// у отозванного читателя в карте только эпоха 1 — эпохи 2 нет
	assert.equal(decryptChannelContent(contentV2, { 1: keyV1 }), null);
});
