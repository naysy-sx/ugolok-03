// Rooms, этап 1 — room-events.js + kind-registry.js. Тесты до кода (skill п.14).
// Контракт — PROCESS-DOCS/CONTRACTS.md "Rooms — Этап 1" (kind-registry.js +
// room-events.js), ROOMS-SPEC.md §5.1/§5.2.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { bytesToHex } from "@noble/hashes/utils.js";
import { verify } from "../src/core/crypto/sign.js";
import {
	ROOM_ANNOUNCE_KIND,
	ROOM_PROBE_KIND,
	ROOM_PRESENCE_KIND,
	ROOM_CHAT_KIND,
	ROOM_POINTER_KIND,
} from "../src/domain/events/kind-registry.js";
import {
	buildRoomAnnounceEvent,
	parseRoomAnnounceEvent,
	buildRoomProbeEvent,
	parseRoomProbeEvent,
	buildRoomPresenceEvent,
	parseRoomPresenceEvent,
	buildRoomChatEvent,
	parseRoomChatEvent,
	buildRoomPointerEvent,
	parseRoomPointerEvent,
} from "../src/domain/rooms/room-events.js";

const privKey = generateSecretKey();
const pubkey = getPublicKey(privKey);
const kRv = crypto.getRandomValues(new Uint8Array(32));
const kSess = crypto.getRandomValues(new Uint8Array(32));
const kPointer = crypto.getRandomValues(new Uint8Array(32));
const wrongKey = crypto.getRandomValues(new Uint8Array(32));
const hTopic = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
const hDisc = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
const AT_MS = 1700000000000; // ровное число секунд*1000 — без потери точности на round-trip

test("kind-registry: пять room-kind (Этап 1 + POINTER Этапа 3), эфемерный диапазон, без коллизий друг с другом", () => {
	const kinds = [ROOM_ANNOUNCE_KIND, ROOM_PROBE_KIND, ROOM_PRESENCE_KIND, ROOM_CHAT_KIND, ROOM_POINTER_KIND];
	for (const k of kinds) {
		assert.ok(k >= 20000 && k < 30000, `${k} должен быть в эфемерном диапазоне`);
	}
	assert.equal(new Set(kinds).size, 5, "все 5 kind различны");
});

test("ANNOUNCE: build/parse round-trip несёт salt, kind верный, тег h=hTopic, событие подписано", () => {
	const saltHex = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
	const event = buildRoomAnnounceEvent(privKey, kRv, hTopic, saltHex, AT_MS);
	assert.equal(event.kind, ROOM_ANNOUNCE_KIND);
	assert.deepEqual(event.tags, [["h", hTopic]]);
	assert.equal(event.pubkey, pubkey);
	assert.equal(verify(event), true, "событие должно быть валидно подписано");
	const parsed = parseRoomAnnounceEvent(event, kRv);
	assert.deepEqual(parsed, { salt: saltHex });
});

test("ANNOUNCE: parse с чужим kRv -> null (AEAD-провал), не throw", () => {
	const saltHex = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
	const event = buildRoomAnnounceEvent(privKey, kRv, hTopic, saltHex, AT_MS);
	assert.equal(parseRoomAnnounceEvent(event, wrongKey), null);
});

test("PROBE: build/parse round-trip, пустой payload, kind верный", () => {
	const event = buildRoomProbeEvent(privKey, kRv, hTopic, AT_MS);
	assert.equal(event.kind, ROOM_PROBE_KIND);
	assert.deepEqual(event.tags, [["h", hTopic]]);
	assert.equal(verify(event), true);
	assert.deepEqual(parseRoomProbeEvent(event, kRv), {});
});

test("PROBE: parse с чужим kRv -> null", () => {
	const event = buildRoomProbeEvent(privKey, kRv, hTopic, AT_MS);
	assert.equal(parseRoomProbeEvent(event, wrongKey), null);
});

test("PRESENCE heartbeat: build/parse round-trip -> готовый вход для presence.js's mergeHeartbeat", () => {
	const event = buildRoomPresenceEvent(privKey, kSess, hTopic, { type: "heartbeat", nick: "Гость" }, AT_MS);
	assert.equal(event.kind, ROOM_PRESENCE_KIND);
	assert.deepEqual(event.tags, [["h", hTopic]]);
	const parsed = parseRoomPresenceEvent(event, kSess);
	assert.deepEqual(parsed, { pubkey, type: "heartbeat", nick: "Гость", at: AT_MS });
});

test("PRESENCE exit: build/parse round-trip -> готовый вход для presence.js's mergeExit (без nick)", () => {
	const event = buildRoomPresenceEvent(privKey, kSess, hTopic, { type: "exit" }, AT_MS);
	const parsed = parseRoomPresenceEvent(event, kSess);
	assert.deepEqual(parsed, { pubkey, type: "exit", at: AT_MS });
});

test("PRESENCE: parse с чужим kSess -> null", () => {
	const event = buildRoomPresenceEvent(privKey, kSess, hTopic, { type: "heartbeat", nick: "Гость" }, AT_MS);
	assert.equal(parseRoomPresenceEvent(event, wrongKey), null);
});

test("CHAT: build/parse round-trip -> id/createdAt/pubkey из события, nick/text из payload", () => {
	const event = buildRoomChatEvent(privKey, kSess, hTopic, { nick: "Гость", text: "привет" }, AT_MS);
	assert.equal(event.kind, ROOM_CHAT_KIND);
	assert.deepEqual(event.tags, [["h", hTopic]]);
	const parsed = parseRoomChatEvent(event, kSess);
	assert.deepEqual(parsed, { id: event.id, createdAt: AT_MS, pubkey, nick: "Гость", text: "привет" });
});

test("CHAT: parse с чужим kSess -> null", () => {
	const event = buildRoomChatEvent(privKey, kSess, hTopic, { nick: "Гость", text: "привет" }, AT_MS);
	assert.equal(parseRoomChatEvent(event, wrongKey), null);
});

test("CHAT: подделанный content (испорченный AEAD-тег) -> null, не throw", () => {
	const event = buildRoomChatEvent(privKey, kSess, hTopic, { nick: "Гость", text: "привет" }, AT_MS);
	const tampered = { ...event, content: event.content.slice(0, -4) + "AAAA" };
	assert.doesNotThrow(() => parseRoomChatEvent(tampered, kSess));
	assert.equal(parseRoomChatEvent(tampered, kSess), null);
});

test("все 5 build*: created_at в секундах (nostr-конвенция), не в миллисекундах", () => {
	const events = [
		buildRoomAnnounceEvent(privKey, kRv, hTopic, "salt", AT_MS),
		buildRoomProbeEvent(privKey, kRv, hTopic, AT_MS),
		buildRoomPresenceEvent(privKey, kSess, hTopic, { type: "exit" }, AT_MS),
		buildRoomChatEvent(privKey, kSess, hTopic, { nick: "n", text: "t" }, AT_MS),
		buildRoomPointerEvent(privKey, kPointer, hDisc, "suffix-1", AT_MS),
	];
	for (const event of events) {
		assert.equal(event.created_at, AT_MS / 1000, "created_at = миллисекунды/1000");
	}
});

test("POINTER (Этап 3, открытый режим): build/parse round-trip несёт suffix и id, kind верный, тег h=hDisc", () => {
	const event = buildRoomPointerEvent(privKey, kPointer, hDisc, "котики-7fk2-mq91", AT_MS);
	assert.equal(event.kind, ROOM_POINTER_KIND);
	assert.deepEqual(event.tags, [["h", hDisc]], "тег h = hDisc, НЕ hTopic (suffix ещё неизвестен joiner'у)");
	assert.equal(verify(event), true);
	const parsed = parseRoomPointerEvent(event, kPointer);
	assert.deepEqual(parsed, { id: event.id, suffix: "котики-7fk2-mq91" });
});

test("POINTER: parse с чужим kPointer -> null (AEAD-провал), не throw", () => {
	const event = buildRoomPointerEvent(privKey, kPointer, hDisc, "s", AT_MS);
	assert.equal(parseRoomPointerEvent(event, wrongKey), null);
});

test("POINTER: id разных событий-указателей различим и сравним лексикографически (основа И9-тайбрейка)", () => {
	const eventA = buildRoomPointerEvent(generateSecretKey(), kPointer, hDisc, "suffix-a", AT_MS);
	const eventB = buildRoomPointerEvent(generateSecretKey(), kPointer, hDisc, "suffix-b", AT_MS + 1);
	const parsedA = parseRoomPointerEvent(eventA, kPointer);
	const parsedB = parseRoomPointerEvent(eventB, kPointer);
	assert.notEqual(parsedA.id, parsedB.id);
	assert.equal(typeof parsedA.id, "string");
	assert.equal(parsedA.id.length, 64, "nostr event id — 64 hex-символа");
});
