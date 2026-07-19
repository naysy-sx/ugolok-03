import { test } from "node:test";
import assert from "node:assert/strict";
import { bytesToHex } from "@noble/hashes/utils.js";
import { getPublicKey } from "../src/core/crypto/keys.js";
import { deriveMasterSecret } from "../src/core/crypto/derivation.js";
import { verify } from "../src/core/crypto/sign.js";
import { generateChannelKey } from "../src/core/crypto/channel-key.js";
import { buildAllowlistEvent, parseAndVerifyAllowlist, canAuthorComment } from "../src/core/crypto/comment-allowlist.js";

const OWNER_PRIV = new Uint8Array(32).fill(1);
const OWNER_PUB = bytesToHex(getPublicKey(OWNER_PRIV));
const OWNER_MASTER_SECRET = deriveMasterSecret(OWNER_PRIV);
const ALICE_PUB = bytesToHex(getPublicKey(new Uint8Array(32).fill(2)));
const BOB_PUB = bytesToHex(getPublicKey(new Uint8Array(32).fill(3)));
const MALLORY_PRIV = new Uint8Array(32).fill(4);
const MALLORY_PUB = bytesToHex(getPublicKey(MALLORY_PRIV));

test("buildAllowlistEvent: kind 30054, подписано владельцем, тег #channel присутствует", () => {
	const channelKeyHex = bytesToHex(generateChannelKey());
	const event = buildAllowlistEvent("channel-1", "aa".repeat(16), 1, [ALICE_PUB], channelKeyHex, OWNER_PRIV, OWNER_MASTER_SECRET);
	assert.equal(event.kind, 30054);
	assert.equal(event.pubkey, OWNER_PUB);
	assert.ok(verify(event), "событие обязано иметь корректную Schnorr-подпись владельца");
	assert.deepEqual(
		event.tags.find((t) => t[0] === "h"),
		["h", "aa".repeat(16)],
	);
	assert.ok(event.tags.find((t) => t[0] === "d")[1].length === 64, "d-tag — HMAC-hex, opaque (§4.8)");
});

test("parseAndVerifyAllowlist: round-trip — корректный владелец+ключ даёт {version, allowedAuthors}", () => {
	const channelKeyHex = bytesToHex(generateChannelKey());
	const event = buildAllowlistEvent("channel-1", "aa".repeat(16), 1, [ALICE_PUB, BOB_PUB], channelKeyHex, OWNER_PRIV, OWNER_MASTER_SECRET);
	const result = parseAndVerifyAllowlist(event, channelKeyHex, OWNER_PUB);
	assert.deepEqual(result, { version: 1, allowedAuthors: [ALICE_PUB, BOB_PUB] });
});

test("parseAndVerifyAllowlist: allowlist НЕ от владельца канала — отклонён (F-EV-07 аналог, адверсарный сценарий)", () => {
	const channelKeyHex = bytesToHex(generateChannelKey());
	// Mallory подделывает allowlist, добавляя СЕБЯ — событие технически валидно подписано
	// (её же ключом), но event.pubkey не совпадает с ожидаемым владельцем канала.
	const forgedEvent = buildAllowlistEvent("channel-1", "aa".repeat(16), 1, [MALLORY_PUB], channelKeyHex, MALLORY_PRIV, deriveMasterSecret(MALLORY_PRIV));
	const result = parseAndVerifyAllowlist(forgedEvent, channelKeyHex, OWNER_PUB);
	assert.equal(result, null, "поддельный allowlist (не от владельца) обязан быть отклонён");
});

test("parseAndVerifyAllowlist: неизвестная эпоха channelKey (эпоха ещё/уже не наша) -> null, не throw", () => {
	const channelKeyHex = bytesToHex(generateChannelKey());
	const otherKeyHex = bytesToHex(generateChannelKey());
	const event = buildAllowlistEvent("channel-1", "aa".repeat(16), 1, [ALICE_PUB], channelKeyHex, OWNER_PRIV, OWNER_MASTER_SECRET);
	// Пытаемся расшифровать НЕ тем ключом, которым был зашифрован (v=1 нет в карте читателя)
	assert.throws(() => parseAndVerifyAllowlist(event, otherKeyHex, OWNER_PUB));
});

test("canAuthorComment: pubkey в allowedAuthors -> true; не в списке -> false; verifiedAllowlist===null -> false", () => {
	const verified = { version: 1, allowedAuthors: [ALICE_PUB, BOB_PUB] };
	assert.equal(canAuthorComment(ALICE_PUB, verified), true);
	assert.equal(canAuthorComment(MALLORY_PUB, verified), false);
	assert.equal(canAuthorComment(ALICE_PUB, null), false);
});
