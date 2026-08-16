import { test } from "node:test";
import assert from "node:assert/strict";
import {
	KIND_MESSAGE_MIRROR,
	encryptMirrorPayload,
	decryptMirrorPayload,
	buildMirrorEvent,
	buildMirroredMessageRow,
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

// AC-AT-06 (TECH.md §15) — вложение обязано пережить cross-device sync через
// зеркало. Вынесено из transport.js's syncMirroredHistory (было инлайн в onBatch,
// непроверяемо юнит-тестом) — та же логика, но теперь отдельная чистая функция.
const OWNER_PUB = "d".repeat(64);

test("buildMirroredMessageRow: вложения из mirror-payload попадают в строку сообщения (AC-AT-06)", () => {
	const attachments = [{ type: "image", sha256: "abc123", blossomUrl: "https://blossom.test", encryptionKey: "base64key==", mime: "image/png", size: 1234, name: "photo.png" }];
	const payload = { ...SAMPLE_PAYLOAD, sentAt: 1700000000, attachments };
	const row = buildMirroredMessageRow(OWNER_PUB, payload, "event-id-1");

	assert.deepEqual(row.attachments, attachments, "дескрипторы вложений должны дойти до второго устройства БЕЗ потерь");
	assert.equal(row.ownerPubkey, OWNER_PUB);
	assert.equal(row.chatId, payload.contactPubkey);
	assert.equal(row.id, "event-id-1");
	assert.equal(row.status, "sent");
});

test("buildMirroredMessageRow: payload БЕЗ вложений — поле attachments отсутствует (не undefined-значение, обратная совместимость со старыми зеркалами)", () => {
	const row = buildMirroredMessageRow(OWNER_PUB, SAMPLE_PAYLOAD, "event-id-2");
	assert.equal("attachments" in row, false);
	assert.equal("sentAt" in row, false);
});

test("buildMirroredMessageRow: старый формат payload (attachment, единственное число) нормализуется в attachments-массив", () => {
	const legacyAttachment = { type: "image", sha256: "def456", blossomUrl: "https://blossom.test", encryptionKey: "key==", mime: "image/png", size: 5678, name: "old.png" };
	const payload = { ...SAMPLE_PAYLOAD, attachment: legacyAttachment };
	const row = buildMirroredMessageRow(OWNER_PUB, payload, "event-id-legacy");
	assert.deepEqual(row.attachments, [legacyAttachment], "историческое зеркало со старым форматом читается корректно");
});

test("buildMirroredMessageRow: sentAt из payload переносится, если присутствует", () => {
	const payload = { ...SAMPLE_PAYLOAD, sentAt: 1700000000 };
	const row = buildMirroredMessageRow(OWNER_PUB, payload, "event-id-3");
	assert.equal(row.sentAt, 1700000000);
});
