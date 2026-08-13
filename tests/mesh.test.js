// Rooms, этап 1 — mesh.js. Тесты до кода (skill п.14). Контракт —
// PROCESS-DOCS/CONTRACTS.md "Rooms — Этап 1" (mesh.js), ROOMS-ALGO.md §6.
import { test } from "node:test";
import assert from "node:assert/strict";
import { edges, diffEdges } from "../src/domain/rooms/mesh.js";

test("edges: пустой список -> пустой массив", () => {
	assert.deepEqual(edges([]), []);
});

test("edges: один участник -> нет рёбер", () => {
	assert.deepEqual(edges(["alice"]), []);
});

test("edges: два участника -> одно ребро, ориентация по сортировке (i<j)", () => {
	assert.deepEqual(edges(["bob", "alice"]), [["alice", "bob"]]);
	assert.deepEqual(edges(["alice", "bob"]), [["alice", "bob"]], "порядок входа не важен — ориентация всегда по sort()");
});

test("edges: чистая функция от отсортированного списка — одинаковый вход у всех дают одинаковый результат", () => {
	const shuffled1 = ["carol", "alice", "bob"];
	const shuffled2 = ["bob", "carol", "alice"];
	assert.deepEqual(edges(shuffled1), edges(shuffled2));
});

test("edges: n=3 -> C(3,2)=3 ребра, все i<j по строковому сравнению", () => {
	const result = edges(["c", "a", "b"]);
	assert.deepEqual(result, [
		["a", "b"],
		["a", "c"],
		["b", "c"],
	]);
	for (const [i, j] of result) {
		assert.ok(i < j, `${i} < ${j} должно быть истинно (i — инициатор)`);
	}
});

test("edges: n=5 (MAX_VOICE_PARTICIPANTS) -> C(5,2)=10 рёбер", () => {
	const pubkeys = ["e", "d", "c", "b", "a"];
	const result = edges(pubkeys);
	assert.equal(result.length, 10);
	const asSet = new Set(result.map(([i, j]) => `${i}:${j}`));
	assert.equal(asSet.size, 10, "все рёбра уникальны");
});

test("edges: детерминизм — повторный вызов на том же входе даёт тот же результат", () => {
	const pubkeys = ["x", "y", "z"];
	assert.deepEqual(edges(pubkeys), edges(pubkeys));
});

test("И5: на каждой паре присутствующих ровно один инициатор — антисимметрия и полнота ориентации, n=2..6", () => {
	const alphabet = ["a", "b", "c", "d", "e", "f"];
	for (let n = 2; n <= 6; n++) {
		const pubkeys = alphabet.slice(0, n);
		const result = edges(pubkeys);
		const asPairs = new Set(result.map(([i, j]) => `${i}:${j}`));
		for (let a = 0; a < n; a++) {
			for (let b = a + 1; b < n; b++) {
				const [x, y] = pubkeys[a] < pubkeys[b] ? [pubkeys[a], pubkeys[b]] : [pubkeys[b], pubkeys[a]];
				assert.ok(asPairs.has(`${x}:${y}`), `пара (${x},${y}) должна присутствовать ровно один раз, n=${n}`);
				assert.ok(!asPairs.has(`${y}:${x}`), `обратная ориентация (${y},${x}) не должна присутствовать, n=${n}`);
			}
		}
		assert.equal(result.length, (n * (n - 1)) / 2, `полнота: C(${n},2) рёбер, n=${n}`);
	}
});

test("diffEdges: одинаковые множества -> ничего не открывать/закрывать", () => {
	const e = edges(["a", "b", "c"]);
	assert.deepEqual(diffEdges(e, e), { toOpen: [], toClose: [] });
});

test("diffEdges: пустое old, новое непустое -> всё открыть", () => {
	const newEdges = [["a", "b"]];
	assert.deepEqual(diffEdges([], newEdges), { toOpen: [["a", "b"]], toClose: [] });
});

test("diffEdges: старое непустое, новое пустое -> всё закрыть", () => {
	const oldEdges = [["a", "b"]];
	assert.deepEqual(diffEdges(oldEdges, []), { toOpen: [], toClose: [["a", "b"]] });
});

test("diffEdges: участник вышел (n=3 -> n=2) -> закрыть рёбра, затрагивающие ушедшего, остальные не трогать", () => {
	const oldEdges = edges(["a", "b", "c"]); // [a,b] [a,c] [b,c]
	const newEdges = edges(["a", "b"]); // [a,b] — c ушёл
	const result = diffEdges(oldEdges, newEdges);
	assert.deepEqual(result.toOpen, []);
	assert.deepEqual(
		result.toClose.sort(([i1], [i2]) => i1.localeCompare(i2)),
		[
			["a", "c"],
			["b", "c"],
		],
	);
});

test("diffEdges: участник зашёл (n=2 -> n=3) -> открыть новые рёбра к нему, старое ребро не трогать", () => {
	const oldEdges = edges(["a", "b"]);
	const newEdges = edges(["a", "b", "c"]);
	const result = diffEdges(oldEdges, newEdges);
	assert.deepEqual(
		result.toOpen.sort(([i1], [i2]) => i1.localeCompare(i2)),
		[
			["a", "c"],
			["b", "c"],
		],
	);
	assert.deepEqual(result.toClose, []);
});

test("diffEdges: сравнение по значению, не по ссылке — новый массив с теми же парами считается 'тем же' ребром", () => {
	const oldEdges = [["a", "b"]];
	const newEdges = [["a", "b"]]; // другой объект массива, то же содержимое
	assert.notEqual(oldEdges[0], newEdges[0], "проверка сетапа: это разные объекты");
	assert.deepEqual(diffEdges(oldEdges, newEdges), { toOpen: [], toClose: [] });
});

test("diffEdges: не мутирует входные массивы", () => {
	const oldEdges = edges(["a", "b"]);
	const newEdges = edges(["a", "b", "c"]);
	const oldCopy = oldEdges.map((pair) => [...pair]);
	const newCopy = newEdges.map((pair) => [...pair]);
	diffEdges(oldEdges, newEdges);
	assert.deepEqual(oldEdges, oldCopy);
	assert.deepEqual(newEdges, newCopy);
});
