import { test } from "node:test";
import assert from "node:assert/strict";
import {
	KIND_MESSAGE_MIRROR,
	encryptMirrorPayload,
	decryptMirrorPayload,
	buildMirrorEvent,
} from "../src/domain/messaging/mirror.js";

const MIRROR_KEY = crypto.getRandomValues(new Uint8Array(32));

const SAMPLE_PAYLOAD = {
	text: "привет",
	lamportTs: 5,
	senderPubkey: "a".repeat(64),
	contactPubkey: "b".repeat(64),
	msgId: "c".repeat(32),
};

test("encryptMirrorPayload/decryptMirrorPayload: round-trip сохраняет все поля", () => {
	const content = encryptMirrorPayload(SAMPLE_PAYLOAD, MIRROR_KEY);
	assert.equal(typeof content, "string");
	const decrypted = decryptMirrorPayload(content, MIRROR_KEY);
	assert.deepEqual(decrypted, SAMPLE_PAYLOAD);
});

test("decryptMirrorPayload: неверный ключ -> throw (AEAD tag mismatch)", () => {
	const content = encryptMirrorPayload(SAMPLE_PAYLOAD, MIRROR_KEY);
	const wrongKey = crypto.getRandomValues(new Uint8Array(32));
	assert.throws(() => decryptMirrorPayload(content, wrongKey));
});

test("decryptMirrorPayload: испорченный блоб -> throw", () => {
	const content = encryptMirrorPayload(SAMPLE_PAYLOAD, MIRROR_KEY);
	const tampered = content.slice(0, -4) + (content.slice(-4) === "AAAA" ? "BBBB" : "AAAA");
	assert.throws(() => decryptMirrorPayload(tampered, MIRROR_KEY));
});

test("encryptMirrorPayload: разный nonce на каждый вызов (не детерминирован)", () => {
	const a = encryptMirrorPayload(SAMPLE_PAYLOAD, MIRROR_KEY);
	const b = encryptMirrorPayload(SAMPLE_PAYLOAD, MIRROR_KEY);
	assert.notEqual(a, b, "два вызова с тем же payload/ключом должны дать разный ciphertext (случайный nonce)");
	assert.deepEqual(decryptMirrorPayload(a, MIRROR_KEY), decryptMirrorPayload(b, MIRROR_KEY));
});

test("buildMirrorEvent: собирает kind/tags/content/created_at, не подписывает", () => {
	const event = buildMirrorEvent(SAMPLE_PAYLOAD, MIRROR_KEY, "deadbeef", 12345);
	assert.equal(event.kind, KIND_MESSAGE_MIRROR);
	assert.equal(event.kind, 446);
	assert.deepEqual(event.tags, [["h", "deadbeef"]]);
	assert.equal(event.created_at, 12345);
	assert.equal(event.sig, undefined, "не подписывает — ответственность вызывающего кода (sign())");
	assert.deepEqual(decryptMirrorPayload(event.content, MIRROR_KEY), SAMPLE_PAYLOAD);
});
