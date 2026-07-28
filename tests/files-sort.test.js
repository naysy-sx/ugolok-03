import { test } from "node:test";
import assert from "node:assert/strict";
import { sortEntries } from "../src/domain/files/sort.js";

function file(id, name, size = 0) {
	return { id, displayName: name, kind: "file", blob: { size } };
}
function dir(id, name) {
	return { id, displayName: name, kind: "dir", blob: null };
}

test("сортировка по имени: естественный порядок (file2 перед file10), не лексикографический", () => {
	const entries = [file("a", "file10.txt"), file("b", "file2.txt"), file("c", "file1.txt")];
	const sorted = sortEntries(entries, "name");
	assert.deepEqual(
		sorted.map((e) => e.displayName),
		["file1.txt", "file2.txt", "file10.txt"],
	);
});

test("папки ВСЕГДА перед файлами, независимо от критерия сортировки", () => {
	const entries = [file("a", "Аня"), dir("b", "Яша"), file("c", "Боря")];
	const sorted = sortEntries(entries, "name");
	assert.equal(sorted[0].kind, "dir");
});

test("папки перед файлами даже при сортировке по РАЗМЕРУ и направлении desc", () => {
	const entries = [file("a", "big.bin", 5000), dir("b", "папка"), file("c", "small.bin", 1)];
	const sorted = sortEntries(entries, "size", "desc");
	assert.equal(sorted[0].kind, "dir");
});

test("разрыв связей по id: одинаковое имя -> тотальный порядок, не зависит от исходного порядка массива", () => {
	const a = file("bbb", "дубль.txt");
	const b = file("aaa", "дубль.txt");
	const sorted1 = sortEntries([a, b], "name");
	const sorted2 = sortEntries([b, a], "name");
	assert.deepEqual(
		sorted1.map((e) => e.id),
		sorted2.map((e) => e.id),
		"результат не должен зависеть от порядка на входе",
	);
	assert.deepEqual(
		sorted1.map((e) => e.id),
		["aaa", "bbb"],
	);
});

test("direction=desc: порядок имён обратный, но разрыв связей по id ОСТАЁТСЯ тотальным (не переворачивается сам)", () => {
	const entries = [file("z", "одинаковое"), file("a", "одинаковое")];
	const asc = sortEntries(entries, "name", "asc");
	const desc = sortEntries(entries, "name", "desc");
	// Оба одинаковы по имени -> порядок между ними решается ТОЛЬКО id, а не
	// direction (иначе список "дрожал" бы при смене направления сортировки
	// для полностью одинаковых по критерию записей).
	assert.deepEqual(asc.map((e) => e.id), desc.map((e) => e.id));
});

test("сортировка по размеру", () => {
	const entries = [file("a", "big", 300), file("b", "small", 1), file("c", "mid", 50)];
	const sorted = sortEntries(entries, "size");
	assert.deepEqual(
		sorted.map((e) => e.id),
		["b", "c", "a"],
	);
});

test("устойчивость при 10^4 записях с одинаковым именем: стабильный порядок между двумя вызовами", () => {
	const entries = [];
	for (let i = 0; i < 10000; i++) {
		entries.push(file(`id-${String(i).padStart(5, "0")}`, "same-name.txt"));
	}
	const shuffled = entries.slice().reverse();
	const sorted1 = sortEntries(entries, "name");
	const sorted2 = sortEntries(shuffled, "name");
	assert.deepEqual(
		sorted1.map((e) => e.id),
		sorted2.map((e) => e.id),
	);
});
