// Этап 48, п.4 (VOICE.md §3) — Nostr in/out для сигналинга звонка. Написан Claude
// напрямую (короткий, тесно завязан на уже принятое решение по шифрованию —
// CONTRACTS.md "Этап 48": kind 20075 эфемерный, NIP-44 напрямую, без gift-wrap).

import { encrypt as nip44Encrypt, decrypt as nip44Decrypt } from "../../core/crypto/nip44.js";
import { sign } from "../../core/crypto/sign.js";

export const CALL_SIGNAL_KIND = 20075;

// Один kind на ВСЕ типы сигнальных сообщений — тип различается полем payload.type
// (тот же приём, что d-tag-подтипы/маркеры уже применяются в проекте), не плодим
// kind на каждый вариант.
export function buildCallSignalEvent(privKey, peerPubkey, payload, createdAt = Math.floor(Date.now() / 1000)) {
	const plaintext = JSON.stringify(payload);
	const content = nip44Encrypt(plaintext, privKey, peerPubkey);
	const eventTemplate = { kind: CALL_SIGNAL_KIND, tags: [["p", peerPubkey]], content, created_at: createdAt };
	return sign(eventTemplate, privKey);
}

export function parseCallSignalEvent(event, privKey) {
	const plaintext = nip44Decrypt(event.content, privKey, event.pubkey);
	return JSON.parse(plaintext);
}

// execute(command, ctx) — SEND_* команды (§1.4 VOICE.md) -> публикация kind 20075.
// Остальные команды (медиа/таймеры/EMIT) сюда не приходят — call-runtime.js их
// не пересылает (тот же принцип, что media-controller.js).
export async function execute(command, ctx) {
	const { privKey, peerPubkey, sessionId, publish } = ctx;
	let payload;
	switch (command.type) {
		case "SEND_OFFER":
			payload = { type: "offer", sessionId, sdp: command.sdp };
			break;
		case "SEND_ANSWER":
			payload = { type: "answer", sessionId, sdp: command.sdp };
			break;
		case "SEND_ICE":
			payload = { type: "ice", sessionId, candidate: command.candidate };
			break;
		case "SEND_HANGUP":
			payload = { type: "hangup", sessionId };
			break;
		default:
			return undefined;
	}
	const event = buildCallSignalEvent(privKey, peerPubkey, payload);
	return publish(event);
}

// toFsmEvent(payload, senderPubkey, myPubkey) — расшифрованный payload (после
// parseCallSignalEvent) -> событие Σ_in (§1.3-B VOICE.md) для reduce(). myPubkey
// нужен ТОЛЬКО для offer'а (может создать НОВУЮ сессию — IDLE->INCOMING_RINGING,
// или прийти как glare — в обоих случаях reduce вычисляет/сверяет polite через
// myPubkey, см. CONTRACTS.md "Этап 48", пробел про myPubkey в state).
export function toFsmEvent(payload, senderPubkey, myPubkey) {
	switch (payload.type) {
		case "offer":
			return { type: "REMOTE_OFFER", sdp: payload.sdp, sessionId: payload.sessionId, fromPubkey: senderPubkey, myPubkey };
		case "answer":
			return { type: "REMOTE_ANSWER", sdp: payload.sdp, sessionId: payload.sessionId };
		case "ice":
			return { type: "REMOTE_ICE", candidate: payload.candidate, sessionId: payload.sessionId };
		case "hangup":
			return { type: "REMOTE_HANGUP", sessionId: payload.sessionId };
		default:
			return null;
	}
}
