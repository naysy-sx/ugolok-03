import "fake-indexeddb/auto";
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { db } from "../src/core/store/database.js";
import { getPublicKey } from "../src/core/crypto/keys.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
	applyPeerCursor,
	getPeerCursor,
	buildCursorText,
	parseCursorText,
	extractCursorFromPayload,
	cursorGrewSinceLastSend,
	markCursorSent,
	scheduleCursorFlush,
	bindCursorFlush,
	flushCursorNow,
	resetCursorRuntime,
	cursorClock,
	CURSOR_COALESCE_MS,
	CURSOR_MIN_INTERVAL_MS,
} from "../src/domain/messaging/peer-cursors.js";

const ALICE_PUB = bytesToHex(getPublicKey(new Uint8Array(32).fill(1)));
const BOB_PUB = bytesToHex(getPublicKey(new Uint8Array(32).fill(2)));

before(async () => {
	await db.open();
});

beforeEach(async () => {
	await db.table("peerCursors").clear();
	resetCursorRuntime();
});

after(() => {
	db.close();
});

test("applyPeerCursor: растёт только вверх, меньшее значение игнорируется", async () => {
	await applyPeerCursor(ALICE_PUB, BOB_PUB, { d: 5, r: 3 });
	await applyPeerCursor(ALICE_PUB, BOB_PUB, { d: 2, r: 1 });
	const row = await getPeerCursor(ALICE_PUB, BOB_PUB);
	assert.equal(row.deliveredUpTo, 5);
	assert.equal(row.readUpTo, 3);
});

test("applyPeerCursor: readUpTo не обгоняет deliveredUpTo", async () => {
	await applyPeerCursor(ALICE_PUB, BOB_PUB, { d: 4, r: 10 });
	const row = await getPeerCursor(ALICE_PUB, BOB_PUB);
	assert.equal(row.deliveredUpTo, 4);
	assert.equal(row.readUpTo, 4);
});

test("applyPeerCursor: два устройства — max", async () => {
	await applyPeerCursor(ALICE_PUB, BOB_PUB, { d: 3, r: 1 });
	await applyPeerCursor(ALICE_PUB, BOB_PUB, { d: 2, r: 5 });
	const row = await getPeerCursor(ALICE_PUB, BOB_PUB);
	assert.equal(row.deliveredUpTo, 3);
	assert.equal(row.readUpTo, 3);
});

test("parseCursorText/buildCursorText: round-trip и мусор", () => {
	const text = buildCursorText({ d: 7, r: 4 });
	assert.equal(text.startsWith("__ugolok_cursor__:"), true);
	assert.deepEqual(parseCursorText(text), { d: 7, r: 4 });
	assert.equal(parseCursorText("hello"), null);
	assert.equal(parseCursorText("__ugolok_cursor__:{nope"), null);
	assert.equal(parseCursorText("__ugolok_delete__:abc"), null);
});

test("extractCursorFromPayload: пиггибэк d/r, ackUpTo как d, маркер в text", () => {
	assert.deepEqual(extractCursorFromPayload({ d: 3, r: 2, text: "hi" }), { d: 3, r: 2 });
	assert.deepEqual(extractCursorFromPayload({ ackUpTo: 9, text: "hi" }), { d: 9 });
	assert.deepEqual(extractCursorFromPayload({ text: buildCursorText({ d: 1, r: 1 }), ackOnly: true }), { d: 1, r: 1 });
	assert.equal(extractCursorFromPayload({ text: "hi" }), null);
});

test("потеря курсора: следующее обновление восстанавливает max", async () => {
	await applyPeerCursor(ALICE_PUB, BOB_PUB, { d: 10, r: 8 });
	await applyPeerCursor(ALICE_PUB, BOB_PUB, { d: 4, r: 2 });
	const row = await getPeerCursor(ALICE_PUB, BOB_PUB);
	assert.equal(row.deliveredUpTo, 10);
	assert.equal(row.readUpTo, 8);
});

test("дебаунс: десять schedule подряд дают один flush после окна склейки", async () => {
	const timeouts = [];
	let now = 1_000_000;
	const orig = { ...cursorClock };
	cursorClock.now = () => now;
	cursorClock.setTimeout = (fn, ms) => {
		const id = timeouts.length + 1;
		timeouts.push({ id, fn, fireAt: now + ms });
		return id;
	};
	cursorClock.clearTimeout = (id) => {
		const i = timeouts.findIndex((t) => t.id === id);
		if (i >= 0) timeouts.splice(i, 1);
	};
	try {
		let flushes = 0;
		bindCursorFlush(ALICE_PUB, BOB_PUB, async () => {
			flushes++;
		});
		for (let i = 0; i < 10; i++) scheduleCursorFlush(ALICE_PUB, BOB_PUB);
		assert.equal(timeouts.length, 1, "окно склейки одно");
		now += CURSOR_COALESCE_MS;
		const due = timeouts.splice(0);
		for (const t of due) await t.fn();
		assert.equal(flushes, 1);
	} finally {
		Object.assign(cursorClock, orig);
	}
});

test("min interval: повторный flush раньше 10 с переносится", async () => {
	assert.equal(CURSOR_MIN_INTERVAL_MS, 10_000);
	markCursorSent(ALICE_PUB, BOB_PUB, 1, 1);
	assert.equal(cursorGrewSinceLastSend(ALICE_PUB, BOB_PUB, 1, 1), false);
	assert.equal(cursorGrewSinceLastSend(ALICE_PUB, BOB_PUB, 2, 1), true);
});

test("flushCursorNow снимает таймер и вызывает flush", async () => {
	let flushes = 0;
	bindCursorFlush(ALICE_PUB, BOB_PUB, async () => {
		flushes++;
	});
	scheduleCursorFlush(ALICE_PUB, BOB_PUB);
	await flushCursorNow(ALICE_PUB, BOB_PUB);
	assert.equal(flushes, 1);
});
