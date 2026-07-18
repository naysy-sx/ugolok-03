import { test } from "node:test";
import assert from "node:assert/strict";
import {
	deriveMasterSecret,
	deriveDbKey,
	deriveMirrorKey,
	opaqueDTag,
} from "../src/core/crypto/derivation.js";

test("deriveMasterSecret: 32 байта, детерминирована для одного privKey", () => {
	const privKey = new Uint8Array(32).fill(1);
	const ms1 = deriveMasterSecret(privKey);
	const ms2 = deriveMasterSecret(privKey);
	assert.ok(ms1 instanceof Uint8Array);
	assert.equal(ms1.length, 32);
	assert.deepEqual(ms1, ms2);
});

test("deriveMasterSecret: разные privKey -> разные masterSecret", () => {
	const a = deriveMasterSecret(new Uint8Array(32).fill(1));
	const b = deriveMasterSecret(new Uint8Array(32).fill(2));
	assert.notDeepEqual(a, b);
});

test("deriveDbKey: 32 байта, детерминирован, отличается от masterSecret", () => {
	const ms = deriveMasterSecret(new Uint8Array(32).fill(1));
	const dbKey1 = deriveDbKey(ms);
	const dbKey2 = deriveDbKey(ms);
	assert.equal(dbKey1.length, 32);
	assert.deepEqual(dbKey1, dbKey2);
	assert.notDeepEqual(dbKey1, ms);
});

test("deriveMirrorKey: 32 байта, детерминирован, отличается от dbKey и masterSecret", () => {
	const ms = deriveMasterSecret(new Uint8Array(32).fill(1));
	const dbKey = deriveDbKey(ms);
	const mirrorKey1 = deriveMirrorKey(ms);
	const mirrorKey2 = deriveMirrorKey(ms);
	assert.equal(mirrorKey1.length, 32);
	assert.deepEqual(mirrorKey1, mirrorKey2);
	assert.notDeepEqual(mirrorKey1, dbKey);
	assert.notDeepEqual(mirrorKey1, ms);
});

test("deriveMirrorKey: та же цепочка (privKey -> masterSecret) на разных 'устройствах' даёт одинаковый ключ", () => {
	// Симуляция: два вызова deriveMasterSecret с ОДНИМ privKey (как если бы это
	// произошло на двух разных устройствах с одной мнемоникой) -> mirrorKey совпадает
	// без какого-либо обмена/согласования между ними.
	const privKey = new Uint8Array(32).fill(42);
	const msDeviceA = deriveMasterSecret(privKey);
	const msDeviceB = deriveMasterSecret(privKey);
	assert.deepEqual(deriveMirrorKey(msDeviceA), deriveMirrorKey(msDeviceB));
});

test("deriveMirrorKey: разные masterSecret -> разные mirrorKey", () => {
	const a = deriveMirrorKey(deriveMasterSecret(new Uint8Array(32).fill(1)));
	const b = deriveMirrorKey(deriveMasterSecret(new Uint8Array(32).fill(2)));
	assert.notDeepEqual(a, b);
});

test("opaqueDTag: смоук-тест §16.3 TECH.md (дословно)", () => {
	const ms = new Uint8Array(32).fill(7);
	const a = opaqueDTag(ms, 30051, "subjectA:resourceX");
	const b = opaqueDTag(ms, 30051, "subjectA:resourceX");
	const c = opaqueDTag(ms, 30051, "subjectB:resourceX");
	assert.equal(a, b, "детерминирован");
	assert.notEqual(a, c, "разный для разных входов");
	assert.equal(a.length, 64, "32 байта в hex");
});

test("opaqueDTag: разный kind при том же logicalKey -> разный тег", () => {
	const ms = new Uint8Array(32).fill(7);
	const a = opaqueDTag(ms, 30051, "subjectA:resourceX");
	const b = opaqueDTag(ms, 30053, "subjectA:resourceX");
	assert.notEqual(a, b);
});

test("opaqueDTag: разный masterSecret при тех же kind/logicalKey -> разный тег", () => {
	const a = opaqueDTag(new Uint8Array(32).fill(1), 30051, "subjectA:resourceX");
	const b = opaqueDTag(new Uint8Array(32).fill(2), 30051, "subjectA:resourceX");
	assert.notEqual(a, b);
});
