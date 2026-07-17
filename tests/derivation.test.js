import { test } from "node:test";
import assert from "node:assert/strict";
import {
	deriveMasterSecret,
	deriveDbKey,
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
