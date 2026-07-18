import { test } from "node:test";
import assert from "node:assert/strict";
import { bytesToHex } from "@noble/hashes/utils.js";
import { verify } from "../src/core/crypto/sign.js";
import { unwrap } from "../src/core/crypto/nip59.js";
import { decrypt as nip44Decrypt } from "../src/core/crypto/nip44.js";
import { getPublicKey } from "../src/core/crypto/keys.js";
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import {
	makeProfileEvent,
	makeGiftWrapEvent,
	makePermissionProxyEvent,
	makeChannelProxyEvent,
} from "../src/domain/events/synthetic-fixtures.js";

const alicePriv = crypto.getRandomValues(new Uint8Array(32));
const alicePubHex = bytesToHex(getPublicKey(alicePriv));
const bobPriv = crypto.getRandomValues(new Uint8Array(32));
const bobPubHex = bytesToHex(getPublicKey(bobPriv));

test("makeProfileEvent: валидная подпись, kind 0, content реалистичного размера", () => {
	const event = makeProfileEvent(alicePriv, 300);
	assert.equal(event.kind, 0);
	assert.equal(verify(event), true);
	const parsed = JSON.parse(event.content);
	assert.ok(typeof parsed.name === "string" && parsed.name.length > 0);
});

test("makeGiftWrapEvent: валидная подпись эфемерного ключа, разворачивается в исходный rumor", () => {
	const event = makeGiftWrapEvent(alicePriv, bobPubHex, 500);
	assert.equal(event.kind, 1059);
	assert.equal(verify(event), true);
	const rumor = unwrap(event, bobPriv);
	assert.equal(rumor.kind, 14);
});

test("makePermissionProxyEvent: валидная подпись, content реально расшифровывается (self-encrypt)", () => {
	const foldKey = "test-fold-key-1";
	const event = makePermissionProxyEvent(alicePriv, foldKey, 150);
	assert.equal(event.kind, 30051);
	assert.equal(verify(event), true);
	assert.deepEqual(event.tags, [["d", foldKey]]);
	const decrypted = nip44Decrypt(event.content, alicePriv, alicePubHex);
	const parsed = JSON.parse(decrypted);
	assert.equal(parsed.subject, foldKey);
});

test("makeChannelProxyEvent: валидная подпись, content реально расшифровывается (chacha20poly1305)", () => {
	const channelKey = crypto.getRandomValues(new Uint8Array(32));
	const foldKey = "test-channel-1";
	const event = makeChannelProxyEvent(alicePriv, channelKey, foldKey, 800);
	assert.equal(event.kind, 30061);
	assert.equal(verify(event), true);

	const [nonceB64, ciphertextB64] = event.content.split(":");
	const nonce = Uint8Array.from(Buffer.from(nonceB64, "base64"));
	const ciphertext = Uint8Array.from(Buffer.from(ciphertextB64, "base64"));
	const plaintext = chacha20poly1305(channelKey, nonce).decrypt(ciphertext);
	assert.ok(plaintext.length > 0);
});

test("makeChannelProxyEvent: неверный channelKey не расшифровывает (AEAD tag mismatch)", () => {
	const channelKey = crypto.getRandomValues(new Uint8Array(32));
	const wrongKey = crypto.getRandomValues(new Uint8Array(32));
	const event = makeChannelProxyEvent(alicePriv, channelKey, "k", 200);
	const [nonceB64, ciphertextB64] = event.content.split(":");
	const nonce = Uint8Array.from(Buffer.from(nonceB64, "base64"));
	const ciphertext = Uint8Array.from(Buffer.from(ciphertextB64, "base64"));
	assert.throws(() => chacha20poly1305(wrongKey, nonce).decrypt(ciphertext));
});

test("generateSyntheticEvents: правильное количество и пропорции по kindGroup", async () => {
	const { generateSyntheticEvents } = await import("../src/domain/events/synthetic-fixtures.js");
	const { fixtures } = await generateSyntheticEvents(1000);
	assert.equal(fixtures.length, 1000);
	const byGroup = {};
	for (const f of fixtures) byGroup[f.kindGroup] = (byGroup[f.kindGroup] ?? 0) + 1;
	assert.equal(byGroup["profile"], 100);
	assert.equal(byGroup["giftwrap"], 500);
	assert.equal(byGroup["permission-proxy"], 150);
	assert.equal(byGroup["channel-proxy"], 250);
});

test("generateSyntheticEvents: все события проходят verify()", async () => {
	const { generateSyntheticEvents } = await import("../src/domain/events/synthetic-fixtures.js");
	const { fixtures } = await generateSyntheticEvents(200);
	for (const { event } of fixtures) {
		assert.equal(verify(event), true, `событие kind ${event.kind} не прошло verify`);
	}
});

test("generateSyntheticEvents: foldKey реально повторяются для LWW-типов (иначе LWW не нагружен)", async () => {
	const { generateSyntheticEvents } = await import("../src/domain/events/synthetic-fixtures.js");
	const { fixtures } = await generateSyntheticEvents(1000);
	const foldable = fixtures.filter((f) => f.kindGroup !== "giftwrap");
	const uniqueFoldKeys = new Set(foldable.map((f) => f.foldKey));
	assert.ok(uniqueFoldKeys.size < foldable.length, "foldKey обязаны повторяться, иначе LWW всегда 'добавляет новое', не выбирает победителя");
});

test("generateSyntheticEvents: giftwrapRecipientPrivKey реально расшифровывает все giftwrap-события", async () => {
	const { generateSyntheticEvents } = await import("../src/domain/events/synthetic-fixtures.js");
	const { fixtures, giftwrapRecipientPrivKey } = await generateSyntheticEvents(200);
	const giftwraps = fixtures.filter((f) => f.kindGroup === "giftwrap");
	assert.ok(giftwraps.length > 0);
	for (const { event } of giftwraps) {
		const rumor = unwrap(event, giftwrapRecipientPrivKey);
		assert.equal(rumor.kind, 14);
	}
});

test("generateSyntheticEvents: все permission-proxy события расшифровываются ОДНИМ владельцем (self-encrypt), не случайными identity", async () => {
	const { generateSyntheticEvents } = await import("../src/domain/events/synthetic-fixtures.js");
	const { fixtures, giftwrapRecipientPrivKey } = await generateSyntheticEvents(500);
	const ownerPubHex = bytesToHex(getPublicKey(giftwrapRecipientPrivKey));
	const permissions = fixtures.filter((f) => f.kindGroup === "permission-proxy");
	assert.ok(permissions.length > 0);
	for (const { event } of permissions) {
		assert.equal(event.pubkey, ownerPubHex, "permission-proxy обязан быть подписан владельцем, не случайной identity");
		const decrypted = nip44Decrypt(event.content, giftwrapRecipientPrivKey, ownerPubHex);
		assert.ok(JSON.parse(decrypted).subject);
	}
});

test("generateSyntheticEvents: channel-proxy фикстура несёт свой channelKey, им реально расшифровывается", async () => {
	const { generateSyntheticEvents } = await import("../src/domain/events/synthetic-fixtures.js");
	const { fixtures } = await generateSyntheticEvents(500);
	const channelPosts = fixtures.filter((f) => f.kindGroup === "channel-proxy");
	assert.ok(channelPosts.length > 0);
	for (const { event, channelKey } of channelPosts) {
		assert.ok(channelKey instanceof Uint8Array);
		const [nonceB64, ciphertextB64] = event.content.split(":");
		const nonce = Uint8Array.from(Buffer.from(nonceB64, "base64"));
		const ciphertext = Uint8Array.from(Buffer.from(ciphertextB64, "base64"));
		const plaintext = chacha20poly1305(channelKey, nonce).decrypt(ciphertext);
		assert.ok(plaintext.length > 0);
	}
});
