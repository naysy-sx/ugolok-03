import "fake-indexeddb/auto";
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { db } from "../src/core/store/database.js";
import { enqueue, listPending, markSent, markFailed } from "../src/core/store/outbox.js";

before(async () => {
	await db.open();
});

beforeEach(async () => {
	await db.table("outbox").clear();
});

after(() => {
	db.close();
});

test("enqueue: возвращает числовой seq, растущий с каждой вставкой", async () => {
	const seq1 = await enqueue("event-1");
	const seq2 = await enqueue("event-2");
	assert.equal(typeof seq1, "number");
	assert.ok(seq2 > seq1);
});

test("enqueue: создаёт запись со статусом pending и retryCount 0", async () => {
	const seq = await enqueue("event-1");
	const row = await db.table("outbox").get(seq);
	assert.equal(row.eventId, "event-1");
	assert.equal(row.status, "pending");
	assert.equal(row.retryCount, 0);
});

test("listPending: возвращает только pending, в порядке FIFO (по seq)", async () => {
	const s1 = await enqueue("a");
	const s2 = await enqueue("b");
	const s3 = await enqueue("c");
	await markSent(s2);
	const pending = await listPending();
	assert.deepEqual(pending.map((r) => r.eventId), ["a", "c"]);
	assert.deepEqual(pending.map((r) => r.seq), [s1, s3]);
});

test("markSent: переводит запись в статус sent, убирает из listPending", async () => {
	const seq = await enqueue("event-1");
	await markSent(seq);
	const row = await db.table("outbox").get(seq);
	assert.equal(row.status, "sent");
	assert.deepEqual(await listPending(), []);
});

test("markFailed: статус failed, retryCount увеличивается, убирает из listPending", async () => {
	const seq = await enqueue("event-1");
	await markFailed(seq);
	let row = await db.table("outbox").get(seq);
	assert.equal(row.status, "failed");
	assert.equal(row.retryCount, 1);
	assert.deepEqual(await listPending(), []);

	// повторный markFailed на уже failed записи (не должен упасть, retryCount растёт дальше)
	await markFailed(seq);
	row = await db.table("outbox").get(seq);
	assert.equal(row.retryCount, 2);
});
