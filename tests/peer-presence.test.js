import "fake-indexeddb/auto";
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { db } from "../src/core/store/database.js";
import { getPublicKey } from "../src/core/crypto/keys.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { notePeerActivity, getPeerLastSeenAt, clampLastSeenAt, LAST_SEEN_CLOCK_SKEW_SEC } from "../src/domain/messaging/peer-presence.js";

const ALICE_PUB = bytesToHex(getPublicKey(new Uint8Array(32).fill(1)));
const BOB_PUB = bytesToHex(getPublicKey(new Uint8Array(32).fill(2)));
const CAROL_PUB = bytesToHex(getPublicKey(new Uint8Array(32).fill(3)));

before(async () => {
	await db.open();
});

beforeEach(async () => {
	await db.table("peerPresence").clear();
});

after(() => {
	db.close();
});

test("notePeerActivity: растёт только вверх", async () => {
	await notePeerActivity(ALICE_PUB, BOB_PUB, 1000, 2000);
	await notePeerActivity(ALICE_PUB, BOB_PUB, 800, 2000);
	assert.equal(await getPeerLastSeenAt(ALICE_PUB, BOB_PUB), 1000);
	await notePeerActivity(ALICE_PUB, BOB_PUB, 1500, 2000);
	assert.equal(await getPeerLastSeenAt(ALICE_PUB, BOB_PUB), 1500);
});

test("notePeerActivity: created_at > now+900 не участвует", async () => {
	const now = 1_000_000;
	await notePeerActivity(ALICE_PUB, BOB_PUB, now + LAST_SEEN_CLOCK_SKEW_SEC + 1, now);
	assert.equal(await getPeerLastSeenAt(ALICE_PUB, BOB_PUB), undefined);
	await notePeerActivity(ALICE_PUB, BOB_PUB, now + LAST_SEEN_CLOCK_SKEW_SEC, now);
	assert.equal(await getPeerLastSeenAt(ALICE_PUB, BOB_PUB), now + LAST_SEEN_CLOCK_SKEW_SEC);
});

test("notePeerActivity: свой pubkey и пустые аргументы — no-op", async () => {
	await notePeerActivity(ALICE_PUB, ALICE_PUB, 1000, 2000);
	await notePeerActivity(ALICE_PUB, "", 1000, 2000);
	await notePeerActivity(ALICE_PUB, BOB_PUB, Number.NaN, 2000);
	assert.equal(await getPeerLastSeenAt(ALICE_PUB, BOB_PUB), undefined);
});

test("notePeerActivity: пары изолированы", async () => {
	await notePeerActivity(ALICE_PUB, BOB_PUB, 1000, 2000);
	await notePeerActivity(ALICE_PUB, CAROL_PUB, 3000, 4000);
	assert.equal(await getPeerLastSeenAt(ALICE_PUB, BOB_PUB), 1000);
	assert.equal(await getPeerLastSeenAt(ALICE_PUB, CAROL_PUB), 3000);
});

test("clampLastSeenAt: будущее зажимается к now, пустое — null", () => {
	assert.equal(clampLastSeenAt(5000, 1000), 1000);
	assert.equal(clampLastSeenAt(500, 1000), 500);
	assert.equal(clampLastSeenAt(null, 1000), null);
	assert.equal(clampLastSeenAt(0, 1000), null);
});
