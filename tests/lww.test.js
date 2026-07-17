import { test } from "node:test";
import assert from "node:assert/strict";
import { lwwWinner, pickLatest } from "../src/core/sync/lww.js";

function ev(id, created_at) {
	return { id, created_at, pubkey: "pk", kind: 30000, tags: [], content: "", sig: "s" };
}

function randomEvent() {
	const created_at = Math.floor(Math.random() * 1000);
	const id = Math.random().toString(36).slice(2, 10);
	return ev(id, created_at);
}

test("L4: при равных created_at побеждает больший id (AC-18, обязательный тест из TECH.md §17.5)", () => {
	const a = ev("aaa", 500);
	const b = ev("bbb", 500);
	assert.equal(lwwWinner(a, b), b);
	assert.equal(lwwWinner(b, a), b);
});

test("разные created_at: побеждает больший created_at независимо от id", () => {
	const older = ev("zzz", 100);
	const newer = ev("aaa", 200);
	assert.equal(lwwWinner(older, newer), newer);
	assert.equal(lwwWinner(newer, older), newer);
});

test("L1 (идемпотентность): lwwWinner(a, a) === a", () => {
	for (let i = 0; i < 20; i++) {
		const a = randomEvent();
		assert.equal(lwwWinner(a, a), a);
	}
});

test("L2 (коммутативность): lwwWinner(a,b) === lwwWinner(b,a)", () => {
	for (let i = 0; i < 50; i++) {
		const a = randomEvent();
		const b = randomEvent();
		assert.equal(lwwWinner(a, b), lwwWinner(b, a));
	}
});

test("L3 (ассоциативность): lwwWinner(lwwWinner(a,b),c) === lwwWinner(a,lwwWinner(b,c))", () => {
	for (let i = 0; i < 50; i++) {
		const a = randomEvent();
		const b = randomEvent();
		const c = randomEvent();
		assert.equal(lwwWinner(lwwWinner(a, b), c), lwwWinner(a, lwwWinner(b, c)));
	}
});

test("pickLatest: побеждает событие с максимальным (created_at, id) среди массива", () => {
	const events = [ev("m", 100), ev("z", 300), ev("a", 300), ev("x", 50)];
	assert.equal(pickLatest(events), events[1]); // created_at=300, id "z" > "a"
});

test("pickLatest: массив из одного элемента возвращает его же", () => {
	const only = ev("solo", 1);
	assert.equal(pickLatest([only]), only);
});
