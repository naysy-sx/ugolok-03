import { test } from "node:test";
import assert from "node:assert/strict";
import { createChunkCache } from "../src/domain/files/chunk-cache.js";

function bytes(n) {
	return new Uint8Array(n);
}

test("put/get: round-trip", () => {
	const cache = createChunkCache(1000);
	cache.put("a", bytes(10));
	assert.deepEqual(cache.get("a"), bytes(10));
});

test("get: промах -> undefined", () => {
	const cache = createChunkCache(1000);
	assert.equal(cache.get("нет-такого"), undefined);
});

test("LRU, не FIFO: get продлевает жизнь записи", () => {
	const cache = createChunkCache(20); // бюджет ровно на 2 записи по 10 байт
	cache.put("a", bytes(10));
	cache.put("b", bytes(10));
	cache.get("a"); // "a" стала MRU, "b" — LRU
	cache.put("c", bytes(10)); // вытесняется САМАЯ старая по обращению — "b", не "a"
	assert.notEqual(cache.get("a"), undefined, "a" + " прочитана недавно — не должна вытесниться");
	assert.equal(cache.get("b"), undefined, "b — LRU на момент put(c), должна вытесниться");
	assert.notEqual(cache.get("c"), undefined);
});

test("бюджет соблюдается после серии put", () => {
	const cache = createChunkCache(35);
	for (let i = 0; i < 10; i++) cache.put(`k${i}`, bytes(10));
	let total = 0;
	for (let i = 0; i < 10; i++) {
		const v = cache.get(`k${i}`);
		if (v) total += v.length;
	}
	assert.ok(total <= 35, `суммарный объём (${total}) не должен превышать бюджет`);
});

test("put того же ключа — перезапись (put, не add), не дублирует объём", () => {
	const cache = createChunkCache(1000);
	cache.put("a", bytes(10));
	cache.put("a", bytes(20));
	assert.equal(cache.get("a").length, 20);
});

test("put того же ключа переставляет его в MRU (не остаётся LRU из первой вставки)", () => {
	const cache = createChunkCache(20);
	cache.put("a", bytes(10));
	cache.put("b", bytes(10));
	cache.put("a", bytes(10)); // "a" переставлена в MRU-конец
	cache.put("c", bytes(10)); // вытесняется "b" (теперь LRU), не "a"
	assert.notEqual(cache.get("a"), undefined);
	assert.equal(cache.get("b"), undefined);
});

test("один элемент крупнее бюджета не зацикливает вытеснение", () => {
	const cache = createChunkCache(10);
	assert.doesNotThrow(() => cache.put("huge", bytes(100)));
	assert.notEqual(cache.get("huge"), undefined, "единственный элемент не вытесняет сам себя");
});

test("put элемента крупнее бюджета вытесняет ВСЕ остальные (общий объём минимизируется до одного)", () => {
	const cache = createChunkCache(15);
	cache.put("a", bytes(10));
	cache.put("huge", bytes(100));
	assert.equal(cache.get("a"), undefined);
	assert.notEqual(cache.get("huge"), undefined);
});

// Этап F, F3 — pin (DESIGN.md "Этап F, F3"): без pin поведение ИДЕНТИЧНО
// прежнему (регрессия выше подтверждает); с pin — новая семантика.
test("pin: закреплённый ключ переживает вытеснение, которое иначе снесло бы его", () => {
	const cache = createChunkCache(20); // бюджет ровно на 2 записи по 10 байт
	cache.put("pinned", bytes(10), { pin: true });
	cache.put("b", bytes(10));
	cache.put("c", bytes(10)); // без pin вытеснился бы "pinned" (LRU-самый старый)
	assert.notEqual(cache.get("pinned"), undefined, "закреплённая запись не вытесняется, даже будучи LRU-самой старой");
	assert.equal(cache.get("b"), undefined, "b — незакреплённая LRU-самая старая среди незакреплённых — вытесняется");
});

test("pin: незакреплённые продолжают вытесняться как раньше при наличии закреплённых записей", () => {
	const cache = createChunkCache(20);
	cache.put("pinned", bytes(10), { pin: true });
	cache.put("x", bytes(10));
	cache.put("y", bytes(10)); // "x" — незакреплённая LRU-самая старая, вытесняется
	assert.notEqual(cache.get("pinned"), undefined);
	assert.equal(cache.get("x"), undefined);
	assert.notEqual(cache.get("y"), undefined);
});

test("pin: несколько закреплённых записей все переживают вытеснение (даже с перерасходом бюджета)", () => {
	const cache = createChunkCache(15);
	cache.put("p1", bytes(10), { pin: true });
	cache.put("p2", bytes(10), { pin: true }); // суммарно уже 20 > 15, обе закреплены — вытеснять нечего
	assert.notEqual(cache.get("p1"), undefined);
	assert.notEqual(cache.get("p2"), undefined);
});

test("pin: put без третьего аргумента — pin=false по умолчанию, обычное вытеснение", () => {
	const cache = createChunkCache(20);
	cache.put("a", bytes(10));
	cache.put("b", bytes(10));
	cache.put("c", bytes(10));
	assert.equal(cache.get("a"), undefined, "без pin — обычное LRU-вытеснение, как раньше");
});
