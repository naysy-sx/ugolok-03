// Rooms, этапы 1+3 — build/parse событий комнаты. Контракт:
// PROCESS-DOCS/CONTRACTS.md "Rooms — Этап 1"/"Этап 3" (kind-registry.js +
// room-events.js); ROOMS-SPEC.md §5.1/§5.2, ROOMS-MATH.md §1.2 (POINTER).
//
// ANNOUNCE/PROBE шифруются на kRv, PRESENCE/CHAT — на kSess, POINTER — на
// kPointer (encryptChannelContent/decryptChannelContent, core/crypto/channel-key.js
// — версия-в-заголовке AEAD на произвольный симметричный ключ; ROOM_CONTENT_VERSION
// фиксирована, в Rooms нет ротации ключей внутри рендеву/экземпляра). Тег h —
// hTopic на первых четырёх kind, hDisc на POINTER (см. ниже, почему).
//
// Единицы времени: nostr's created_at — секунды; весь остальной Rooms-домен
// (presence.js/room-machine.js/trickle.js) — миллисекунды. Эта точка конвертации
// единственная: build* делит на 1000, parse* умножает на 1000.
import { sign } from "../../core/crypto/sign.js";
import { encryptChannelContent, decryptChannelContent } from "../../core/crypto/channel-key.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { ROOM_ANNOUNCE_KIND, ROOM_PROBE_KIND, ROOM_PRESENCE_KIND, ROOM_CHAT_KIND, ROOM_POINTER_KIND } from "../events/kind-registry.js";

const ROOM_CONTENT_VERSION = 1;

function buildTags(hTopic) {
	return [["h", hTopic]];
}

function buildEvent(privKey, key, kind, hTopic, payload, createdAtMs) {
	const plaintext = JSON.stringify(payload);
	const content = encryptChannelContent(plaintext, bytesToHex(key), ROOM_CONTENT_VERSION);
	const eventTemplate = { kind, tags: buildTags(hTopic), content, created_at: Math.floor(createdAtMs / 1000) };
	return sign(eventTemplate, privKey);
}

function parseEvent(event, key) {
	try {
		const plaintext = decryptChannelContent(event.content, { [ROOM_CONTENT_VERSION]: bytesToHex(key) });
		if (plaintext === null) return null;
		return JSON.parse(plaintext);
	} catch {
		return null;
	}
}

export function buildRoomAnnounceEvent(privKey, kRv, hTopic, saltHex, createdAtMs) {
	return buildEvent(privKey, kRv, ROOM_ANNOUNCE_KIND, hTopic, { salt: saltHex }, createdAtMs);
}

export function parseRoomAnnounceEvent(event, kRv) {
	const payload = parseEvent(event, kRv);
	if (payload === null) return null;
	return { salt: payload.salt };
}

export function buildRoomProbeEvent(privKey, kRv, hTopic, createdAtMs) {
	return buildEvent(privKey, kRv, ROOM_PROBE_KIND, hTopic, {}, createdAtMs);
}

export function parseRoomProbeEvent(event, kRv) {
	const payload = parseEvent(event, kRv);
	if (payload === null) return null;
	return {};
}

export function buildRoomPresenceEvent(privKey, kSess, hTopic, { type, nick }, createdAtMs) {
	const payload = type === "heartbeat" ? { type, nick } : { type };
	return buildEvent(privKey, kSess, ROOM_PRESENCE_KIND, hTopic, payload, createdAtMs);
}

export function parseRoomPresenceEvent(event, kSess) {
	const payload = parseEvent(event, kSess);
	if (payload === null) return null;
	const at = event.created_at * 1000;
	if (payload.type === "heartbeat") return { pubkey: event.pubkey, type: "heartbeat", nick: payload.nick, at };
	if (payload.type === "exit") return { pubkey: event.pubkey, type: "exit", at };
	return null;
}

export function buildRoomChatEvent(privKey, kSess, hTopic, { nick, text }, createdAtMs) {
	return buildEvent(privKey, kSess, ROOM_CHAT_KIND, hTopic, { nick, text }, createdAtMs);
}

export function parseRoomChatEvent(event, kSess) {
	const payload = parseEvent(event, kSess);
	if (payload === null) return null;
	return { id: event.id, createdAt: event.created_at * 1000, pubkey: event.pubkey, nick: payload.nick, text: payload.text };
}

// Этап 3 — открытый режим (ROOMS-MATH §1.2): указатель на suffix, тег h=hDisc
// (НЕ hTopic — hTopic зависит от suffix, которого joiner в открытом режиме ещё
// не знает), шифрование на kPointer (room-keys.js), не на kRv/kSess.
export function buildRoomPointerEvent(privKey, kPointer, hDisc, suffix, createdAtMs) {
	return buildEvent(privKey, kPointer, ROOM_POINTER_KIND, hDisc, { suffix }, createdAtMs);
}

export function parseRoomPointerEvent(event, kPointer) {
	const payload = parseEvent(event, kPointer);
	if (payload === null) return null;
	return { id: event.id, suffix: payload.suffix };
}
