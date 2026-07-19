import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { concatBytes } from "@noble/ciphers/utils.js";

export const KIND_MESSAGE_MIRROR = 446;

function encodeBase64(bytes) {
	return btoa(String.fromCharCode.apply(null, bytes));
}

function decodeBase64(str) {
	return Uint8Array.from(atob(str), (c) => c.charCodeAt(0));
}

export function encryptMirrorPayload(payload, mirrorKey) {
	const plaintext = new TextEncoder().encode(JSON.stringify(payload));
	const nonce = crypto.getRandomValues(new Uint8Array(12));
	const ciphertext = chacha20poly1305(mirrorKey, nonce).encrypt(plaintext);
	return encodeBase64(concatBytes(nonce, ciphertext));
}

export function decryptMirrorPayload(base64Content, mirrorKey) {
	const blob = decodeBase64(base64Content);
	const nonce = blob.subarray(0, 12);
	const ciphertext = blob.subarray(12);
	const plaintext = chacha20poly1305(mirrorKey, nonce).decrypt(ciphertext);
	return JSON.parse(new TextDecoder().decode(plaintext));
}

export function buildMirrorEvent(payload, mirrorKey, groupIdHex, createdAt) {
	return {
		kind: KIND_MESSAGE_MIRROR,
		tags: [["h", groupIdHex]],
		content: encryptMirrorPayload(payload, mirrorKey),
		created_at: createdAt,
	};
}

// AC-AT-06 (TECH.md §15) — извлечено из transport.js's syncMirroredHistory (было
// инлайн внутри onBatch, непроверяемо юнит-тестом отдельно от WebSocket-обвязки).
// sentAt/attachment включаются, ТОЛЬКО если реально присутствуют в payload (этап 29
// — обратная совместимость со старыми зеркалами, не undefined-значения).
export function buildMirroredMessageRow(ownerPubkey, payload, eventId) {
	const extra = {};
	if (payload.sentAt !== undefined) extra.sentAt = payload.sentAt;
	if (payload.attachment !== undefined) extra.attachment = payload.attachment;
	return {
		ownerPubkey,
		chatId: payload.contactPubkey,
		lamportTs: payload.lamportTs,
		senderPubkey: payload.senderPubkey,
		id: eventId,
		text: payload.text,
		status: "sent",
		msgId: payload.msgId,
		...extra,
	};
}
