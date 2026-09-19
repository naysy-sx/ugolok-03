import "fake-indexeddb/auto";
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { db } from "../src/core/store/database.js";
import { enqueue, listPending, markSent, markFailed, drain, MAX_ATTEMPTS, publishDurably, purgeSent } from "../src/core/store/outbox.js";

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

// Этап 3 (MESSAGE-DELIVERY-TZ.md, З3.2) — ЭТОТ ТЕСТ РАНЬШЕ КОДИРОВАЛ БАГ:
// одна неудача выводила запись из listPending НАВСЕГДА (status:"failed" на
// первом же провале) — сообщение, для которого relay ОДИН РАЗ не ответил
// вовремя, теряло всякий шанс на автоматическую повторную доставку. ТЗ прямо
// называет это дырой (AUDIT-BRIEFING §4.6, "одна неудача = конец") — старое
// ожидание ниже удалено, не обойдено.
test("markFailed: до MAX_ATTEMPTS остаётся pending с растущим retryCount и nextAttemptAt в будущем — НЕ выпадает из listPending", async () => {
	const seq = await enqueue(fakeEvent("event-1"), DB_KEY);
	const before = Date.now();
	const { finalFailure } = await markFailed(seq);
	assert.equal(finalFailure, false);
	const row = await db.table("outbox").get(seq);
	assert.equal(row.status, "pending", "одна неудача не должна хоронить запись");
	assert.equal(row.retryCount, 1);
	assert.ok(row.nextAttemptAt > before, "backoff должен отодвинуть следующую попытку в будущее");
	// Пока backoff не истёк, listPending её не отдаёт (иначе экспоненциальный
	// backoff не имел бы смысла — drain бил бы по ней так же часто, как по свежим).
	assert.deepEqual(await listPending(DB_KEY), []);
});

test("markFailed: становится failed ТОЛЬКО на MAX_ATTEMPTS-й неудаче, не раньше", async () => {
	const seq = await enqueue(fakeEvent("event-1"), DB_KEY);
	for (let i = 1; i < MAX_ATTEMPTS; i++) {
		const { finalFailure } = await markFailed(seq);
		assert.equal(finalFailure, false, `попытка ${i} не должна быть финальной`);
		assert.equal((await db.table("outbox").get(seq)).status, "pending");
	}
	const { finalFailure, eventId } = await markFailed(seq);
	assert.equal(finalFailure, true, `MAX_ATTEMPTS-я (${MAX_ATTEMPTS}) неудача обязана быть финальной`);
	assert.equal(eventId, "event-1");
	const row = await db.table("outbox").get(seq);
	assert.equal(row.status, "failed");
	assert.equal(row.retryCount, MAX_ATTEMPTS);
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
	assert.deepEqual(result, { sentCount: 2, failedCount: 0, finallyFailedEventIds: [] });
	assert.equal((await db.table("outbox").get(s1)).status, "sent");
	assert.equal((await db.table("outbox").get(s2)).status, "sent");
});

// Этап 3 (приёмка) — "publish отклонён -> запись осталась pending, второй
// drain её поднял, третий после успеха — нет". nextAttemptAt отодвигается в
// прошлое между проходами теста напрямую (не ждём реальный backoff секундами).
test("drain: publish отклонён -> запись остаётся pending; следующий drain поднимает её снова; drain после успеха её больше не трогает", async () => {
	const seq = await enqueue(fakeEvent("retry-me"), DB_KEY);

	let calls = 0;
	const firstResult = await drain(async () => {
		calls++;
		return { ok: false };
	}, DB_KEY);
	assert.equal(calls, 1);
	assert.deepEqual(firstResult, { sentCount: 0, failedCount: 0, finallyFailedEventIds: [] });
	let row = await db.table("outbox").get(seq);
	assert.equal(row.status, "pending", "одна неудача не должна хоронить запись (см. markFailed выше)");

	// backoff ещё не истёк -> второй drain СРАЗУ её не поднимет (нет смысла
	// молотить relay чаще, чем позволяет экспонента).
	const duringBackoff = await drain(async () => {
		calls++;
		return { ok: true };
	}, DB_KEY);
	assert.deepEqual(duringBackoff, { sentCount: 0, failedCount: 0, finallyFailedEventIds: [] });
	assert.equal(calls, 1, "backoff ещё не истёк — publishFn не должен вызываться повторно");

	// Backoff истёк (симулируем истечение напрямую, не ждём секундами) —
	// "второй drain её поднял".
	await db.table("outbox").update(seq, { nextAttemptAt: Date.now() - 1 });
	const secondResult = await drain(async () => {
		calls++;
		return { ok: true };
	}, DB_KEY);
	assert.equal(calls, 2);
	assert.deepEqual(secondResult, { sentCount: 1, failedCount: 0, finallyFailedEventIds: [] });
	row = await db.table("outbox").get(seq);
	assert.equal(row.status, "sent");

	// "третий после успеха — нет": запись уже sent, drain её больше не видит.
	const thirdResult = await drain(async () => {
		calls++;
		return { ok: true };
	}, DB_KEY);
	assert.equal(calls, 2, "sent-запись не должна попадать в drain повторно");
	assert.deepEqual(thirdResult, { sentCount: 0, failedCount: 0, finallyFailedEventIds: [] });
});

test("drain: частичный отказ — неудачная остаётся pending (не failed — MAX_ATTEMPTS не исчерпан), успешная — sent", async () => {
	const sGood = await enqueue(fakeEvent("good"), DB_KEY);
	const sBad = await enqueue(fakeEvent("bad"), DB_KEY);

	const result = await drain(async (record) => ({ ok: record.event.id !== "bad" }), DB_KEY);

	assert.deepEqual(result, { sentCount: 1, failedCount: 0, finallyFailedEventIds: [] });
	assert.equal((await db.table("outbox").get(sGood)).status, "sent");
	const badRow = await db.table("outbox").get(sBad);
	assert.equal(badRow.status, "pending", "одна неудача — не MAX_ATTEMPTS, запись остаётся pending для повтора");
	assert.equal(badRow.retryCount, 1);
});

test("drain: пустая очередь — не бросает, нулевые счётчики, publishFn не вызывается", async () => {
	let calls = 0;
	const result = await drain(async () => {
		calls++;
		return { ok: true };
	}, DB_KEY);
	assert.deepEqual(result, { sentCount: 0, failedCount: 0, finallyFailedEventIds: [] });
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
	// Этап 3 (З3.2) — упавшая запись остаётся pending (не failed — один провал
	// не MAX_ATTEMPTS), но КЛЮЧЕВОЕ свойство теста сохранено: drain продолжил
	// работу после исключения, не рухнул на всём batch'е.
	assert.equal(badRow.status, "pending", "один throw — не MAX_ATTEMPTS, запись остаётся pending для повтора, не потеряна");
	assert.equal(badRow.retryCount, 1);
	assert.deepEqual(result, { sentCount: 2, failedCount: 0, finallyFailedEventIds: [] });
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

// Прежний контракт «неверный dbKey -> throw» держал ВЕСЬ дренаж заложником чужой
// записи (несколько аккаунтов на устройстве). Суть осталась: мусор вместо event
// не возвращается никогда — запись чужого аккаунта просто пропускается.
test("неверный dbKey -> запись пропускается, мусор вместо event не возвращается", async () => {
	await enqueue(fakeEvent("event-1"), DB_KEY);
	const wrongKey = crypto.getRandomValues(new Uint8Array(32));
	assert.deepEqual(await listPending(wrongKey), []);
	assert.equal((await listPending(DB_KEY)).length, 1, "владелец её по-прежнему видит");
});

// AUDIT-EGOROD: outbox не привязан к аккаунту — запись другого аккаунта не должна
// блокировать отправку текущего.
test("listPending/drain: неотправленная запись ДРУГОГО аккаунта (другой dbKey) не блокирует свои", async () => {
	const OTHER_KEY = crypto.getRandomValues(new Uint8Array(32));
	await enqueue(fakeEvent("foreign"), OTHER_KEY);
	await enqueue(fakeEvent("mine"), DB_KEY);
	const pending = await listPending(DB_KEY);
	assert.deepEqual(pending.map((r) => r.eventId), ["mine"]);
	const sent = [];
	const res = await drain(async (r) => (sent.push(r.eventId), { ok: true }), DB_KEY);
	assert.deepEqual(sent, ["mine"]);
	assert.equal(res.sentCount, 1);
	// чужая осталась pending и уйдёт, когда её владелец войдёт
	assert.deepEqual((await listPending(OTHER_KEY)).map((r) => r.eventId), ["foreign"]);
});

test("publishDurably: успех сразу помечает отправленным, отказ/исключение оставляют запись для drain", async () => {
	const ok = await publishDurably(fakeEvent("d1"), async () => ({ ok: true }), DB_KEY);
	assert.equal(ok.ok, true);
	assert.deepEqual(await listPending(DB_KEY), []);

	const rejected = await publishDurably(fakeEvent("d2"), async () => ({ ok: false, reason: "relay" }), DB_KEY);
	assert.equal(rejected.ok, false);
	const thrown = await publishDurably(fakeEvent("d3"), async () => { throw new Error("сеть"); }, DB_KEY);
	assert.deepEqual(thrown, { ok: false, reason: "сеть" });
	assert.deepEqual((await listPending(DB_KEY)).map((r) => r.eventId), ["d2", "d3"], "события не потеряны");

	const sent = [];
	await drain(async (r) => (sent.push(r.eventId), { ok: true }), DB_KEY);
	assert.deepEqual(sent, ["d2", "d3"], "drain доставляет позже те же события (тот же id)");
});

test("purgeSent: отправленные старше порога удаляются, свежие и pending остаются", async () => {
	const a = await enqueue(fakeEvent("old"), DB_KEY);
	const b = await enqueue(fakeEvent("fresh"), DB_KEY);
	await enqueue(fakeEvent("pending"), DB_KEY);
	await markSent(a);
	await markSent(b);
	await db.table("outbox").update(a, { sentAt: Date.now() - 2 * 24 * 3600 * 1000 });
	assert.equal(await purgeSent(), 1);
	const left = (await db.table("outbox").toArray()).map((r) => r.eventId).sort();
	assert.deepEqual(left, ["fresh", "pending"]);
});
