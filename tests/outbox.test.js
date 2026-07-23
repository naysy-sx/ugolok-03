import "fake-indexeddb/auto";
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { db } from "../src/core/store/database.js";
import { enqueue, listPending, markSent, markFailed, drain } from "../src/core/store/outbox.js";

const DB_KEY = crypto.getRandomValues(new Uint8Array(32));

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
	const seq1 = await enqueue(fakeEvent("event-1"), DB_KEY);
	const seq2 = await enqueue(fakeEvent("event-2"), DB_KEY);
	assert.equal(typeof seq1, "number");
	assert.ok(seq2 > seq1);
});

test("enqueue: создаёт запись со статусом pending, retryCount 0, eventId=event.id и сохраняет ВЕСЬ event целиком", async () => {
	const event = fakeEvent("event-1");
	const seq = await enqueue(event, DB_KEY);
	const row = await db.table("outbox").get(seq);
	assert.equal(row.eventId, "event-1");
	assert.equal(row.status, "pending");
	assert.equal(row.retryCount, 0);
	const decrypted = await listPending(DB_KEY);
	assert.deepEqual(decrypted.find((r) => r.seq === seq).event, event, "весь подписанный event должен сохраняться буквально — MLS-ратчет уже продвинут, регенерировать нельзя");
});

test("listPending: возвращает только pending, в порядке FIFO (по seq)", async () => {
	const s1 = await enqueue(fakeEvent("a"), DB_KEY);
	const s2 = await enqueue(fakeEvent("b"), DB_KEY);
	const s3 = await enqueue(fakeEvent("c"), DB_KEY);
	await markSent(s2);
	const pending = await listPending(DB_KEY);
	assert.deepEqual(pending.map((r) => r.eventId), ["a", "c"]);
	assert.deepEqual(pending.map((r) => r.seq), [s1, s3]);
});

test("markSent: переводит запись в статус sent, убирает из listPending", async () => {
	const seq = await enqueue(fakeEvent("event-1"), DB_KEY);
	await markSent(seq);
	const row = await db.table("outbox").get(seq);
	assert.equal(row.status, "sent");
	assert.deepEqual(await listPending(DB_KEY), []);
});

test("markFailed: статус failed, retryCount увеличивается, убирает из listPending", async () => {
	const seq = await enqueue(fakeEvent("event-1"), DB_KEY);
	await markFailed(seq);
	let row = await db.table("outbox").get(seq);
	assert.equal(row.status, "failed");
	assert.equal(row.retryCount, 1);
	assert.deepEqual(await listPending(DB_KEY), []);

	// повторный markFailed на уже failed записи (не должен упасть, retryCount растёт дальше)
	await markFailed(seq);
	row = await db.table("outbox").get(seq);
	assert.equal(row.retryCount, 2);
});

test("drain: успешная публикация всех pending -> markSent для каждой, sentCount корректен; publishFn получает record с .event", async () => {
	const s1 = await enqueue(fakeEvent("a"), DB_KEY);
	const s2 = await enqueue(fakeEvent("b"), DB_KEY);

	const publishedEventIds = [];
	const result = await drain(async (record) => {
		assert.equal(record.event.id, record.eventId, "record.event должен соответствовать record.eventId");
		publishedEventIds.push(record.event.id);
		return { ok: true };
	}, DB_KEY);

	assert.deepEqual(publishedEventIds, ["a", "b"], "последовательно, в FIFO-порядке");
	assert.deepEqual(result, { sentCount: 2, failedCount: 0 });
	assert.equal((await db.table("outbox").get(s1)).status, "sent");
	assert.equal((await db.table("outbox").get(s2)).status, "sent");
});

test("drain: частичный отказ — неудачные помечаются failed (retryCount растёт), успешные — sent", async () => {
	const sGood = await enqueue(fakeEvent("good"), DB_KEY);
	const sBad = await enqueue(fakeEvent("bad"), DB_KEY);

	const result = await drain(async (record) => ({ ok: record.event.id !== "bad" }), DB_KEY);

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
	}, DB_KEY);
	assert.deepEqual(result, { sentCount: 0, failedCount: 0 });
	assert.equal(calls, 0);
});

test("drain: уже sent/failed записи не попадают в drain повторно", async () => {
	await enqueue(fakeEvent("once"), DB_KEY);
	await drain(async () => ({ ok: true }), DB_KEY);

	let calls = 0;
	await drain(async () => {
		calls++;
		return { ok: true };
	}, DB_KEY);
	assert.equal(calls, 0, "уже sent — drain не должен трогать повторно");
});

test("АДВЕРСАРНО: publishFn бросает исключение на одной записи — drain не должен рухнуть целиком, остальные записи обрабатываются", async () => {
	const s1 = await enqueue(fakeEvent("ok-1"), DB_KEY);
	const sBad = await enqueue(fakeEvent("throws"), DB_KEY);
	const s2 = await enqueue(fakeEvent("ok-2"), DB_KEY);

	const result = await drain(async (record) => {
		if (record.event.id === "throws") throw new Error("сетевая ошибка на середине batch");
		return { ok: true };
	}, DB_KEY);

	assert.equal((await db.table("outbox").get(s1)).status, "sent", "запись до сбоя должна быть отправлена");
	assert.equal((await db.table("outbox").get(s2)).status, "sent", "запись после сбоя тоже должна быть обработана, drain не должен остановиться");
	const badRow = await db.table("outbox").get(sBad);
	assert.equal(badRow.status, "failed", "упавшая запись должна быть помечена failed, не оставлена в pending навсегда");
	assert.deepEqual(result, { sentCount: 2, failedCount: 1 });
});

// AC-16, Tier 4 (этап 45) — сырой дамп очереди не должен содержать событие
// (в т.ч. его content) в открытом виде; eventId/status/retryCount остаются
// plaintext (нужны для .where("status").equals(...) и т.п.).
test("AC-16: сырая запись outbox не содержит event в открытом виде", async () => {
	const event = fakeEvent("secret-event-payload");
	const seq = await enqueue(event, DB_KEY);
	const row = await db.table("outbox").get(seq);
	assert.equal(row.eventId, "secret-event-payload");
	assert.equal(row.event, undefined, "event не должен лежать top-level в открытом виде");
	assert.ok(!JSON.stringify(row).includes("cipher-secret-event-payload"), "content события не должен встречаться в сырой записи");
	assert.ok(row.nonce && row.ciphertext);
});

test("неверный dbKey -> listPending бросает, не молча возвращает мусор вместо event", async () => {
	await enqueue(fakeEvent("event-1"), DB_KEY);
	const wrongKey = crypto.getRandomValues(new Uint8Array(32));
	await assert.rejects(() => listPending(wrongKey));
});
