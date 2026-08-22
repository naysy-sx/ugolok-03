import { test } from "node:test";
import assert from "node:assert/strict";
import { groupDueRecords } from "../src/domain/content/due-schedule.js";

// nowUnix зафиксирован на 2024-06-15 12:00:00 локального времени -
// вычисляем через Date, чтобы тест не зависел от часового пояса машины
// (тот же принцип, что journal.jsx's dayKey — локальное время).
const NOW = new Date(2024, 5, 15, 12, 0, 0);
const NOW_UNIX = Math.floor(NOW.getTime() / 1000);

const START_OF_TODAY = Math.floor(new Date(2024, 5, 15, 0, 0, 0).getTime() / 1000);
const END_OF_TODAY = Math.floor(new Date(2024, 5, 15, 23, 59, 59).getTime() / 1000);
const START_OF_TOMORROW = Math.floor(new Date(2024, 5, 16, 0, 0, 0).getTime() / 1000);
const YESTERDAY = Math.floor(new Date(2024, 5, 14, 23, 59, 59).getTime() / 1000);

function rec(id, dueAt) {
	return { id, dueAt };
}

test("groupDueRecords: пустой список -> три пустые корзины", () => {
	assert.deepEqual(groupDueRecords([], NOW_UNIX), { overdue: [], today: [], later: [] });
});

test("groupDueRecords: dueAt в прошлом -> overdue", () => {
	const result = groupDueRecords([rec("a", YESTERDAY)], NOW_UNIX);
	assert.deepEqual(result.overdue.map((r) => r.id), ["a"]);
	assert.deepEqual(result.today, []);
	assert.deepEqual(result.later, []);
});

test("groupDueRecords: граница 00:00:00 сегодня -> today, не overdue", () => {
	const result = groupDueRecords([rec("a", START_OF_TODAY)], NOW_UNIX);
	assert.deepEqual(result.today.map((r) => r.id), ["a"]);
});

test("groupDueRecords: граница 23:59:59 сегодня -> today, не later", () => {
	const result = groupDueRecords([rec("a", END_OF_TODAY)], NOW_UNIX);
	assert.deepEqual(result.today.map((r) => r.id), ["a"]);
});

test("groupDueRecords: граница 00:00:00 завтра -> later, не today", () => {
	const result = groupDueRecords([rec("a", START_OF_TOMORROW)], NOW_UNIX);
	assert.deepEqual(result.later.map((r) => r.id), ["a"]);
});

test("groupDueRecords: все три корзины сразу, порядок внутри корзины сохраняется", () => {
	const farFuture = START_OF_TOMORROW + 86400 * 10;
	const input = [rec("late1", YESTERDAY), rec("t1", START_OF_TODAY), rec("late2", YESTERDAY - 100), rec("far", farFuture), rec("t2", END_OF_TODAY)];
	const result = groupDueRecords(input, NOW_UNIX);
	assert.deepEqual(result.overdue.map((r) => r.id), ["late1", "late2"]);
	assert.deepEqual(result.today.map((r) => r.id), ["t1", "t2"]);
	assert.deepEqual(result.later.map((r) => r.id), ["far"]);
});

test("groupDueRecords: nowUnix по умолчанию — Math.floor(Date.now()/1000), функция вызывается без второго аргумента без ошибки", () => {
	assert.doesNotThrow(() => groupDueRecords([]));
});
