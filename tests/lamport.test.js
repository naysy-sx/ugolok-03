import "fake-indexeddb/auto";
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { db } from "../src/core/store/database.js";
import { createLamportClock, computeInitialLamportValue, persistLamportValue } from "../src/core/sync/lamport.js";

const OWNER_PUBKEY = "owner-pub";

before(async () => {
	await db.open();
});

beforeEach(async () => {
	await db.table("messages").clear();
	await db.table("clock").clear();
});

after(() => {
	db.close();
});

test("L1: tick() строго растёт, каждый вызов даёт новое значение", () => {
	const clock = createLamportClock(0);
	assert.equal(clock.tick(), 1);
	assert.equal(clock.tick(), 2);
	assert.equal(clock.tick(), 3);
	assert.equal(clock.getValue(), 3);
});

test("L1: receive(remote) даёт max(t, remote) + 1", () => {
	const clock = createLamportClock(5);
	assert.equal(clock.receive(2), 6, "remote меньше текущего -> t+1");
	assert.equal(clock.receive(10), 11, "remote больше текущего -> remote+1");
});

test("L1: receive строго больше и текущего t, и remote (happens-before)", () => {
	const clock = createLamportClock(0);
	for (let i = 0; i < 20; i++) {
		const before = clock.getValue();
		const remote = Math.floor(Math.random() * 100);
		const result = clock.receive(remote);
		assert.ok(result > before, "результат строго больше предыдущего t");
		assert.ok(result > remote, "результат строго больше remote");
	}
});

test("createLamportClock: initialValue по умолчанию 0", () => {
	const clock = createLamportClock();
	assert.equal(clock.getValue(), 0);
	assert.equal(clock.tick(), 1);
});

test("computeInitialLamportValue: DoD PLAN.md — 10 синтетических сообщений lamportTs 1..10 -> 11", async () => {
	for (let ts = 1; ts <= 10; ts++) {
		await db.table("messages").add({ ownerPubkey: OWNER_PUBKEY, chatId: "c1", lamportTs: ts, senderPubkey: "pk", id: `id-${ts}`, status: "sent", deleted: false });
	}
	const value = await computeInitialLamportValue(OWNER_PUBKEY);
	assert.equal(value, 11);
});

test("computeInitialLamportValue: пустая таблица messages -> 1 (max(0, -Infinity-подобное) + 1)", async () => {
	const value = await computeInitialLamportValue(OWNER_PUBKEY);
	assert.equal(value, 1);
});

test("computeInitialLamportValue: не зависит от порядка вставки, только от максимума", async () => {
	const values = [5, 1, 9, 3, 7];
	for (const ts of values) {
		await db.table("messages").add({ ownerPubkey: OWNER_PUBKEY, chatId: "c1", lamportTs: ts, senderPubkey: "pk", id: `id-${ts}`, status: "sent", deleted: false });
	}
	const value = await computeInitialLamportValue(OWNER_PUBKEY);
	assert.equal(value, 10);
});

// AC-16-довесок (найдено пользователем: мультиаккаунт в разных вкладках одного
// браузера/origin) — второй локальный аккаунт НЕ должен влиять на max(lamportTs)
// первого, иначе тики двух аккаунтов пересекаются и путают сортировку истории чата.
test("computeInitialLamportValue: owner-scoping — не путает сообщения РАЗНЫХ локальных аккаунтов на одном устройстве", async () => {
	await db.table("messages").add({ ownerPubkey: OWNER_PUBKEY, chatId: "c1", lamportTs: 3, senderPubkey: "pk", id: "id-1", status: "sent", deleted: false });
	await db.table("messages").add({ ownerPubkey: "other-owner-pub", chatId: "c1", lamportTs: 999, senderPubkey: "pk", id: "id-2", status: "sent", deleted: false });
	const value = await computeInitialLamportValue(OWNER_PUBKEY);
	assert.equal(value, 4, "чужие (other-owner-pub) сообщения не должны влиять на счётчик этого владельца");
});

test("persistLamportValue -> записывает {ownerPubkey, id:'lamport', value} в таблицу clock", async () => {
	await persistLamportValue(OWNER_PUBKEY, 42);
	const row = await db.table("clock").get([OWNER_PUBKEY, "lamport"]);
	assert.deepEqual(row, { ownerPubkey: OWNER_PUBKEY, id: "lamport", value: 42 });
});

test("persistLamportValue дважды подряд — обновляет, не дублирует запись", async () => {
	await persistLamportValue(OWNER_PUBKEY, 1);
	await persistLamportValue(OWNER_PUBKEY, 2);
	const rows = await db.table("clock").where("ownerPubkey").equals(OWNER_PUBKEY).toArray();
	assert.equal(rows.length, 1);
	assert.equal(rows[0].value, 2);
});

test("persistLamportValue: РАЗНЫЕ владельцы — независимые строки, не перезаписывают друг друга", async () => {
	await persistLamportValue(OWNER_PUBKEY, 7);
	await persistLamportValue("other-owner-pub", 100);
	assert.equal((await db.table("clock").get([OWNER_PUBKEY, "lamport"])).value, 7);
	assert.equal((await db.table("clock").get(["other-owner-pub", "lamport"])).value, 100);
});
