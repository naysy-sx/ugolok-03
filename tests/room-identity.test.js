// Rooms, этап 2 — room-identity.js. Тесты до кода (skill п.14). Контракт —
// PROCESS-DOCS/CONTRACTS.md "Rooms — Этап 2" (room-identity.js), ROOMS-SPEC.md §4.1.
import { test } from "node:test";
import assert from "node:assert/strict";
import { getPublicKey } from "nostr-tools/pure";
import { createEphemeralIdentity } from "../src/domain/rooms/adapters/room-identity.js";

test("createEphemeralIdentity: возвращает {pubkeyHex, privKey, dbKey: null}", () => {
	const identity = createEphemeralIdentity();
	assert.equal(typeof identity.pubkeyHex, "string");
	assert.equal(identity.pubkeyHex.length, 64, "hex pubkey — 32 байта = 64 hex-символа");
	assert.ok(identity.privKey instanceof Uint8Array);
	assert.equal(identity.privKey.length, 32);
	assert.equal(identity.dbKey, null);
});

test("createEphemeralIdentity: pubkeyHex действительно соответствует privKey", () => {
	const identity = createEphemeralIdentity();
	assert.equal(identity.pubkeyHex, getPublicKey(identity.privKey));
});

test("createEphemeralIdentity: pubkeyHex — валидный нижнерегистровый hex", () => {
	const identity = createEphemeralIdentity();
	assert.equal(identity.pubkeyHex, identity.pubkeyHex.toLowerCase());
	assert.match(identity.pubkeyHex, /^[0-9a-f]{64}$/);
});

test("createEphemeralIdentity: каждый вызов даёт новый случайный ключ", () => {
	const a = createEphemeralIdentity();
	const b = createEphemeralIdentity();
	assert.notEqual(a.pubkeyHex, b.pubkeyHex);
	assert.notDeepEqual(a.privKey, b.privKey);
});
