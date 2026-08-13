// Rooms, этап 1 — room-machine.js. Тесты до кода (skill п.14). Контракт —
// PROCESS-DOCS/CONTRACTS.md "Rooms — Этап 1" (room-machine.js), формализация —
// ROOMS-MATH-v2.md §5.1.
import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyRoomState, create, join, leave, checkTimeout } from "../src/domain/rooms/room-machine.js";

const TAU = 45000;

test("emptyRoomState: {name: 'empty', k: 0}", () => {
	assert.deepEqual(emptyRoomState(), { name: "empty", k: 0 });
});

test("create: empty -> alive(1)", () => {
	assert.deepEqual(create(emptyRoomState()), { name: "alive", k: 1 });
});

test("create: недопустимо из alive/draining/dead — transition() бросает", () => {
	assert.throws(() => create({ name: "alive", k: 1 }));
	assert.throws(() => create({ name: "draining", k: 0, drainedAt: 0 }));
	assert.throws(() => create({ name: "dead", k: 0 }));
});

test("join: alive(k) -> alive(k+1)", () => {
	const alive2 = join({ name: "alive", k: 1 });
	assert.deepEqual(alive2, { name: "alive", k: 2 });
	const alive3 = join(alive2);
	assert.deepEqual(alive3, { name: "alive", k: 3 });
});

test("join: draining(k=0) -> alive(1) — заход отменяет затухание", () => {
	const draining = { name: "draining", k: 0, drainedAt: 12345 };
	const result = join(draining);
	assert.deepEqual(result, { name: "alive", k: 1 });
	assert.equal("drainedAt" in result, false, "join() возвращает состояние без drainedAt — таймер затухания снят");
});

test("join: недопустимо из empty (нет входящего в пустую комнату без create) и dead", () => {
	assert.throws(() => join(emptyRoomState()));
	assert.throws(() => join({ name: "dead", k: 0 }));
});

test("leave: alive(k>1) -> alive(k-1), остаётся живой", () => {
	const result = leave({ name: "alive", k: 3 }, 1000);
	assert.deepEqual(result, { name: "alive", k: 2 });
});

test("leave: alive(k=1) -> draining(0), фиксирует drainedAt=now", () => {
	const result = leave({ name: "alive", k: 1 }, 5000);
	assert.deepEqual(result, { name: "draining", k: 0, drainedAt: 5000 });
});

test("leave: недопустимо из empty/dead/draining — transition() бросает", () => {
	assert.throws(() => leave(emptyRoomState(), 0));
	assert.throws(() => leave({ name: "dead", k: 0 }, 0));
	assert.throws(() => leave({ name: "draining", k: 0, drainedAt: 0 }, 100));
});

test("checkTimeout: draining, now-drainedAt < tau -> состояние без изменений", () => {
	const state = { name: "draining", k: 0, drainedAt: 1000 };
	const result = checkTimeout(state, 1000 + TAU - 1, TAU);
	assert.deepEqual(result, state);
});

test("checkTimeout: draining, ровно на границе (now-drainedAt === tau) -> dead (нестрогое >=)", () => {
	const state = { name: "draining", k: 0, drainedAt: 1000 };
	const result = checkTimeout(state, 1000 + TAU, TAU);
	assert.deepEqual(result, { name: "dead", k: 0 });
});

test("checkTimeout: draining, now-drainedAt > tau -> dead", () => {
	const state = { name: "draining", k: 0, drainedAt: 1000 };
	const result = checkTimeout(state, 1000 + TAU + 1, TAU);
	assert.deepEqual(result, { name: "dead", k: 0 });
});

test("checkTimeout: idempotent — повторный вызов на dead ничего не меняет", () => {
	const dead = { name: "dead", k: 0 };
	assert.deepEqual(checkTimeout(dead, 999999, TAU), dead);
});

test("checkTimeout: не-draining состояния (empty/alive) возвращаются как есть, без обращения к TRANSITIONS.TIMEOUT", () => {
	const empty = emptyRoomState();
	const alive = { name: "alive", k: 2 };
	assert.deepEqual(checkTimeout(empty, 999999, TAU), empty);
	assert.deepEqual(checkTimeout(alive, 999999, TAU), alive);
});

test("dead — поглощающее состояние: новый экземпляр требует emptyRoomState(), не переход из dead", () => {
	assert.throws(() => create({ name: "dead", k: 0 }));
	assert.throws(() => join({ name: "dead", k: 0 }));
	assert.throws(() => leave({ name: "dead", k: 0 }, 0));
});

test("полный жизненный цикл: empty -> alive(1) -> alive(2) -> alive(1) -> draining -> (не истёк) -> dead", () => {
	let state = emptyRoomState();
	state = create(state);
	assert.deepEqual(state, { name: "alive", k: 1 });
	state = join(state);
	assert.deepEqual(state, { name: "alive", k: 2 });
	state = leave(state, 10000);
	assert.deepEqual(state, { name: "alive", k: 1 });
	state = leave(state, 20000);
	assert.deepEqual(state, { name: "draining", k: 0, drainedAt: 20000 });
	state = checkTimeout(state, 20000 + TAU - 1, TAU);
	assert.equal(state.name, "draining", "ещё не истекло");
	state = checkTimeout(state, 20000 + TAU, TAU);
	assert.deepEqual(state, { name: "dead", k: 0 });
});

test("реинкарнация: draining возвращается в alive через join до истечения таймаута", () => {
	let state = emptyRoomState();
	state = create(state);
	state = leave(state, 1000);
	assert.equal(state.name, "draining");
	state = join(state);
	assert.deepEqual(state, { name: "alive", k: 1 }, "новый участник зашёл до истечения tau — комната снова жива");
});

test("исходное состояние не мутируется", () => {
	const original = { name: "alive", k: 2 };
	const snapshot = { ...original };
	join(original);
	leave(original, 100);
	assert.deepEqual(original, snapshot);
});
