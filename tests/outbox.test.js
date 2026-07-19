import "fake-indexeddb/auto";
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { db } from "../src/core/store/database.js";
import { enqueue, listPending, markSent, markFailed, drain } from "../src/core/store/outbox.js";

function fakeEvent(id, extra = {}) {
	return { id, kind: 445, tags: [], content: "cipher-" + id, sig: "sig-" + id, pubkey: "pub", created_at: 0, ...extra };
}

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
	const seq1 = await enqueue(fakeEvent("event-1"));
	const seq2 = await enqueue(fakeEvent("event-2"));
	assert.equal(typeof seq1, "number");
	assert.ok(seq2 > seq1);
});

test("enqueue: создаёт запись со статусом pending, retryCount 0, eventId=event.id и сохраняет ВЕСЬ event целиком", async () => {
	const event = fakeEvent("event-1");
	const seq = await enqueue(event);
	const row = await db.table("outbox").get(seq);
	assert.equal(row.eventId, "event-1");
	assert.equal(row.status, "pending");
	assert.equal(row.retryCount, 0);
	assert.deepEqual(row.event, event, "весь подписанный event должен сохраняться буквально — MLS-ратчет уже продвинут, регенерировать нельзя");
});

test("listPending: возвращает только pending, в порядке FIFO (по seq)", async () => {
	const s1 = await enqueue(fakeEvent("a"));
	const s2 = await enqueue(fakeEvent("b"));
	const s3 = await enqueue(fakeEvent("c"));
	await markSent(s2);
	const pending = await listPending();
	assert.deepEqual(pending.map((r) => r.eventId), ["a", "c"]);
	assert.deepEqual(pending.map((r) => r.seq), [s1, s3]);
});

test("markSent: переводит запись в статус sent, убирает из listPending", async () => {
	const seq = await enqueue(fakeEvent("event-1"));
	await markSent(seq);
	const row = await db.table("outbox").get(seq);
	assert.equal(row.status, "sent");
	assert.deepEqual(await listPending(), []);
});

test("markFailed: статус failed, retryCount увеличивается, убирает из listPending", async () => {
	const seq = await enqueue(fakeEvent("event-1"));
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

test("drain: успешная публикация всех pending -> markSent для каждой, sentCount корректен; publishFn получает record с .event", async () => {
	const s1 = await enqueue(fakeEvent("a"));
	const s2 = await enqueue(fakeEvent("b"));

	const publishedEventIds = [];
	const result = await drain(async (record) => {
		assert.equal(record.event.id, record.eventId, "record.event должен соответствовать record.eventId");
		publishedEventIds.push(record.event.id);
		return { ok: true };
	});

	assert.deepEqual(publishedEventIds, ["a", "b"], "последовательно, в FIFO-порядке");
	assert.deepEqual(result, { sentCount: 2, failedCount: 0 });
	assert.equal((await db.table("outbox").get(s1)).status, "sent");
	assert.equal((await db.table("outbox").get(s2)).status, "sent");
});

test("drain: частичный отказ — неудачные помечаются failed (retryCount растёт), успешные — sent", async () => {
	const sGood = await enqueue(fakeEvent("good"));
	const sBad = await enqueue(fakeEvent("bad"));

	const result = await drain(async (record) => ({ ok: record.event.id !== "bad" }));

	assert.deepEqual(result, { sentCount: 1, failedCount: 1 });
	assert.equal((await db.table("outbox").get(sGood)).status, "sent");
	const badRow = await db.table("outbox").get(sBad);
	assert.equal(badRow.status, "failed");
	assert.equal(badRow.retryCount, 1);
});

test("drain: пустая очередь — не бросает, нулевые счётчики, publishFn не вызывается", async () => {
	let calls = 0;
	const result = await drain(async () => {
		calls++;
		return { ok: true };
	});
	assert.deepEqual(result, { sentCount: 0, failedCount: 0 });
	assert.equal(calls, 0);
});

test("drain: уже sent/failed записи не попадают в drain повторно", async () => {
	await enqueue(fakeEvent("once"));
	await drain(async () => ({ ok: true }));

	let calls = 0;
	await drain(async () => {
		calls++;
		return { ok: true };
	});
	assert.equal(calls, 0, "уже sent — drain не должен трогать повторно");
});

test("АДВЕРСАРНО: publishFn бросает исключение на одной записи — drain не должен рухнуть целиком, остальные записи обрабатываются", async () => {
	const s1 = await enqueue(fakeEvent("ok-1"));
	const sBad = await enqueue(fakeEvent("throws"));
	const s2 = await enqueue(fakeEvent("ok-2"));

	const result = await drain(async (record) => {
		if (record.event.id === "throws") throw new Error("сетевая ошибка на середине batch");
		return { ok: true };
	});

	assert.equal((await db.table("outbox").get(s1)).status, "sent", "запись до сбоя должна быть отправлена");
	assert.equal((await db.table("outbox").get(s2)).status, "sent", "запись после сбоя тоже должна быть обработана, drain не должен остановиться");
	const badRow = await db.table("outbox").get(sBad);
	assert.equal(badRow.status, "failed", "упавшая запись должна быть помечена failed, не оставлена в pending навсегда");
	assert.deepEqual(result, { sentCount: 2, failedCount: 1 });
});
