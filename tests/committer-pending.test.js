import { test } from "node:test";
import assert from "node:assert/strict";
import { bytesToHex } from "@noble/hashes/utils.js";
import { computeGroupId, isCommitter } from "../src/domain/messaging/chat.js";

const a = "aa".repeat(32);
const b = "bb".repeat(32);

test("isCommitter: меньший hex — коммиттер, регистр не влияет", () => {
	assert.equal(isCommitter(a, b), true);
	assert.equal(isCommitter(b, a), false);
	assert.equal(isCommitter(a.toUpperCase(), b), true);
	assert.equal(isCommitter(b.toUpperCase(), a.toUpperCase()), false);
});

test("computeGroupId: каноничен по lower-hex, одинаков для обеих сторон", () => {
	const g1 = bytesToHex(computeGroupId(a, b));
	const g2 = bytesToHex(computeGroupId(b, a));
	const g3 = bytesToHex(computeGroupId(a.toUpperCase(), b.toUpperCase()));
	assert.equal(g1, g2);
	assert.equal(g1, g3);
	assert.equal(g1.length, 64);
});
