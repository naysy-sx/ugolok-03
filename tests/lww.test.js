import { test } from "node:test";
import assert from "node:assert/strict";
import { lwwWinner, pickLatest, isNewerVersion } from "../src/core/sync/lww.js";

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

// Этап 74 — T7 (CONTRACTS.md/DESIGN.md "Этап 74"): адаптер lwwWinner для
// {createdAt,id}-строк кэша (camelCase — отличие от nostr-событий), НЕ
// вторая реализация сравнения версий.

function row(id, createdAt) {
	return { createdAt, id };
}

test("isNewerVersion: stored отсутствует (null/undefined) -> true безусловно", () => {
	assert.equal(isNewerVersion(row("a", 100), null), true);
	assert.equal(isNewerVersion(row("a", 100), undefined), true);
});

test("isNewerVersion: incoming.createdAt больше -> true", () => {
	assert.equal(isNewerVersion(row("new", 200), row("old", 100)), true);
});

test("isNewerVersion: incoming.createdAt меньше -> false (не откатывает более новое)", () => {
	assert.equal(isNewerVersion(row("old", 100), row("new", 200)), false);
});

test("isNewerVersion: равный createdAt, больший id -> true (тайбрейк, тот же порядок, что lwwWinner)", () => {
	assert.equal(isNewerVersion(row("zzz", 500), row("aaa", 500)), true);
	assert.equal(isNewerVersion(row("aaa", 500), row("zzz", 500)), false);
});

test("isNewerVersion: identical (тот же createdAt и id) -> true (идемпотентный повторный приём — безопасно применить снова)", () => {
	assert.equal(isNewerVersion(row("same", 300), row("same", 300)), true);
});

test("isNewerVersion: у stored нет createdAt (доверсионная/руками поставленная запись) -> true (число НЕ побеждает undefined через >, без явной проверки версия никогда не применилась бы)", () => {
	assert.equal(isNewerVersion(row("new", 100), { name: "Алиса" }), true);
	assert.equal(isNewerVersion(row("new", 100), { name: "Алиса", createdAt: undefined }), true);
});

// Этап 74 — Часть C, C-2: найдено при адверсарном тестировании receiveChannelMetadata —
// receiveChannelKeyGrant заводит updatedAt (createdAt-половину пары) СРАЗУ при создании
// строки, а lastEventId (id-половину) — только при первом реальном приёме метаданных.
// Полуверсионная запись (createdAt есть, id нет) обязана трактоваться так же, как
// полное отсутствие версии — иначе тайбрейк по id (undefined) ломается молча.
test("isNewerVersion: у stored ЕСТЬ createdAt, но НЕТ id (полуверсионная запись) -> true", () => {
	assert.equal(isNewerVersion(row("new", 100), { createdAt: 100 }), true, "тот же created_at, id отсутствует — incoming обязан победить");
	assert.equal(isNewerVersion(row("new", 50), { createdAt: 100 }), true, "даже меньший created_at — без id сравнивать не с чем, incoming побеждает");
});
