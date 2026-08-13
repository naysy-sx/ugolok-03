// Rooms, этап 1 — message-log.js. Тесты до кода (skill п.14). Контракт —
// PROCESS-DOCS/CONTRACTS.md "Rooms — Этап 1" (message-log.js), точный
// псевдокод там же. ROOMS-ALGO.md §5, ROOMS-SPEC.md §3.5 (порядок (createdAt, id),
// Lamport сознательно не используется).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createLog } from "../src/domain/rooms/message-log.js";

function msg(id, createdAt) {
	return { id, createdAt };
}

test("createLog: пустой лог -> toArray() пуст", () => {
	const log = createLog({});
	assert.deepEqual(log.toArray(), []);
});

test("insert: сообщения строго по порядку createdAt сохраняют порядок вставки (хвостовая вставка)", () => {
	const log = createLog({});
	assert.equal(log.insert(msg("a", 100)), true);
	assert.equal(log.insert(msg("b", 200)), true);
	assert.equal(log.insert(msg("c", 300)), true);
	assert.deepEqual(
		log.toArray().map((m) => m.id),
		["a", "b", "c"],
	);
});

test("insert: дубликат id -> false, лог не меняется", () => {
	const log = createLog({});
	log.insert(msg("a", 100));
	const before = log.toArray();
	const result = log.insert(msg("a", 999)); // тот же id, другой createdAt — всё равно дубликат по id
	assert.equal(result, false);
	assert.deepEqual(log.toArray(), before);
});

test("insert: запоздавшее на одну позицию сообщение вставляется на верное место", () => {
	const log = createLog({});
	log.insert(msg("a", 100));
	log.insert(msg("c", 300));
	log.insert(msg("b", 200)); // должно встать между a и c
	assert.deepEqual(
		log.toArray().map((m) => m.id),
		["a", "b", "c"],
	);
});

test("insert: несколько запоздавших восстанавливают полный порядок при достаточном maxBacktrack", () => {
	const log = createLog({ maxBacktrack: 200 });
	for (const [id, createdAt] of [
		["a", 100],
		["e", 500],
		["c", 300],
		["b", 200],
		["d", 400],
	]) {
		log.insert(msg(id, createdAt));
	}
	assert.deepEqual(
		log.toArray().map((m) => m.id),
		["a", "b", "c", "d", "e"],
	);
});

test("порядок при равном createdAt — tie-break по id (лексикографически)", () => {
	const log = createLog({});
	log.insert(msg("b", 100));
	log.insert(msg("a", 100)); // тот же createdAt, id меньше -> должен встать перед b
	assert.deepEqual(
		log.toArray().map((m) => m.id),
		["a", "b"],
	);
});

test("maxBacktrack: обрыв прохода — сообщение вставляется на позицию arr.length-maxBacktrack на момент вставки, не на формально верную", () => {
	const log = createLog({ maxBacktrack: 2 });
	for (const [id, createdAt] of [
		["a", 10],
		["b", 20],
		["c", 30],
		["d", 40],
		["e", 50],
	]) {
		log.insert(msg(id, createdAt));
	}
	// arr = [a,b,c,d,e] (5 элементов). Вставляем x(createdAt=5) — концептуально
	// должен встать перед a, но maxBacktrack=2 обрывает проход через 2 шага
	// назад от хвоста (позиция 5 -> 4 -> 3), вставка на позицию 3.
	const result = log.insert(msg("x", 5));
	assert.equal(result, true, "не дубликат — insert всегда true независимо от места вставки");
	assert.deepEqual(
		log.toArray().map((m) => m.id),
		["a", "b", "c", "x", "d", "e"],
		"x встал ровно в 2 шагах от хвоста, а не на формально верную (самую первую) позицию",
	);
});

test("maxBacktrack по умолчанию — 200 (ROOMS-ALGO §5.1 K_max)", () => {
	const log = createLog({});
	// 199 сообщений по порядку, затем одно, требующее сдвига на 150 (< 200) —
	// должно встать на формально верную позицию, обрыва не происходит.
	for (let i = 0; i < 199; i++) {
		log.insert(msg(`m${i}`, i * 10));
	}
	// Сообщение с createdAt между m48 (480) и m49 (490), т.е. сдвиг на 150 назад от хвоста (199-49=150).
	log.insert(msg("late", 485));
	const ids = log.toArray().map((m) => m.id);
	const idxLate = ids.indexOf("late");
	assert.equal(ids[idxLate - 1], "m48");
	assert.equal(ids[idxLate + 1], "m49");
});

test("insert: не мутирует переданный объект сообщения", () => {
	const log = createLog({});
	const m = msg("a", 100);
	const snapshot = { ...m };
	log.insert(m);
	assert.deepEqual(m, snapshot);
});

test("И14: m сообщений строго по порядку — вставка с хвоста амортизированно O(1), не деградирует до O(m) на большом логе", () => {
	// Прямой подсчёт сравнений недоступен (compare() не экспортируется — внутренняя
	// деталь). Косвенная, но детерминированная проверка адаптивности: если бы каждая
	// вставка "по порядку" уходила в полный обратный проход O(текущей длины лога),
	// 20000 вставок заняли бы секунды (квадратичная сумма). При корректной вставке
	// с хвоста (steps=0 на каждой) это заведомо быстро.
	const log = createLog({});
	const M = 20000;
	const start = performance.now();
	for (let i = 0; i < M; i++) {
		log.insert(msg(`m${i}`, i));
	}
	const elapsedMs = performance.now() - start;
	assert.equal(log.toArray().length, M);
	assert.ok(elapsedMs < 2000, `${M} вставок по порядку заняли ${elapsedMs}ms — подозрение на O(m) проход при каждой вставке вместо O(1)`);
});
