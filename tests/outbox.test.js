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

test("drain: успешная публикация всех pending -> markSent для каждой, sentCount корректен", async () => {
	const { drain } = await import("../src/core/store/outbox.js");
	const s1 = await enqueue("a");
	const s2 = await enqueue("b");

	const published = [];
	const result = await drain(async (record) => {
		published.push(record.eventId);
		return { ok: true };
	});

	assert.deepEqual(published, ["a", "b"], "последовательно, в FIFO-порядке");
	assert.deepEqual(result, { sentCount: 2, failedCount: 0 });
	assert.equal((await db.table("outbox").get(s1)).status, "sent");
	assert.equal((await db.table("outbox").get(s2)).status, "sent");
});

test("drain: частичный отказ — неудачные помечаются failed (retryCount растёт), успешные — sent", async () => {
	const { drain } = await import("../src/core/store/outbox.js");
	const sGood = await enqueue("good");
	const sBad = await enqueue("bad");

	const result = await drain(async (record) => ({ ok: record.eventId !== "bad" }));

	assert.deepEqual(result, { sentCount: 1, failedCount: 1 });
	assert.equal((await db.table("outbox").get(sGood)).status, "sent");
	const badRow = await db.table("outbox").get(sBad);
	assert.equal(badRow.status, "failed");
	assert.equal(badRow.retryCount, 1);
});

test("drain: пустая очередь — не бросает, нулевые счётчики, publishFn не вызывается", async () => {
	const { drain } = await import("../src/core/store/outbox.js");
	let calls = 0;
	const result = await drain(async () => {
		calls++;
		return { ok: true };
	});
	assert.deepEqual(result, { sentCount: 0, failedCount: 0 });
	assert.equal(calls, 0);
});

test("drain: уже sent/failed записи не попадают в drain повторно", async () => {
	const { drain } = await import("../src/core/store/outbox.js");
	const seq = await enqueue("once");
	await drain(async () => ({ ok: true }));

	let calls = 0;
	await drain(async () => {
		calls++;
		return { ok: true };
	});
	assert.equal(calls, 0, "уже sent — drain не должен трогать повторно");
});

test("АДВЕРСАРНО: publishFn бросает исключение на одной записи — drain не должен рухнуть целиком, остальные записи обрабатываются", async () => {
	const { drain } = await import("../src/core/store/outbox.js");
	const s1 = await enqueue("ok-1");
	const sBad = await enqueue("throws");
	const s2 = await enqueue("ok-2");

	const result = await drain(async (record) => {
		if (record.eventId === "throws") throw new Error("сетевая ошибка на середине batch");
		return { ok: true };
	});

	assert.equal((await db.table("outbox").get(s1)).status, "sent", "запись до сбоя должна быть отправлена");
	assert.equal((await db.table("outbox").get(s2)).status, "sent", "запись после сбоя тоже должна быть обработана, drain не должен остановиться");
	const badRow = await db.table("outbox").get(sBad);
	assert.equal(badRow.status, "failed", "упавшая запись должна быть помечена failed, не оставлена в pending навсегда");
	assert.deepEqual(result, { sentCount: 2, failedCount: 1 });
});
