import { test } from "node:test";
import assert from "node:assert/strict";
import { chunkSizeFor, orderUploads } from "../src/domain/media/upload-plan.js";

const KiB = 1024;
const MiB = 1024 * 1024;
const GiB = 1024 * 1024 * 1024;

test("chunkSizeFor: 100 МиБ -> 64 КиБ (MEDIA-MATH.md §8.2, таблица)", () => {
	assert.equal(chunkSizeFor(100 * MiB), 64 * KiB);
});

test("chunkSizeFor: 1 ГиБ -> 256 КиБ (нынешнее значение по умолчанию, оптимально именно здесь)", () => {
	assert.equal(chunkSizeFor(1 * GiB), 256 * KiB);
});

test("chunkSizeFor: 4 ГиБ -> 512 КиБ", () => {
	assert.equal(chunkSizeFor(4 * GiB), 512 * KiB);
});

test("chunkSizeFor: 10 ГиБ -> 1 МиБ", () => {
	assert.equal(chunkSizeFor(10 * GiB), 1 * MiB);
});

test("chunkSizeFor: очень маленький файл зажимается снизу в 64 КиБ", () => {
	assert.equal(chunkSizeFor(1 * KiB), 64 * KiB);
});

test("chunkSizeFor: 0 байт -> нижняя граница 64 КиБ, не NaN/Infinity", () => {
	const c = chunkSizeFor(0);
	assert.equal(c, 64 * KiB);
});

test("chunkSizeFor: очень большой файл зажимается сверху в 4 МиБ", () => {
	assert.equal(chunkSizeFor(300 * GiB), 4 * MiB);
});

test("chunkSizeFor: результат всегда степень двойки в [64КиБ, 4МиБ]", () => {
	for (const s of [1, KiB, MiB, 500 * MiB, 2 * GiB, 50 * GiB, 1000 * GiB]) {
		const c = chunkSizeFor(s);
		assert.ok(c >= 64 * KiB && c <= 4 * MiB, `${s} -> ${c} вне границ`);
		assert.equal(Math.log2(c) % 1, 0, `${c} не степень двойки`);
	}
});

test("orderUploads: сортирует по возрастанию size, сохраняя остальные поля (MATH §8.5)", () => {
	const files = [
		{ size: 300, name: "c" },
		{ size: 100, name: "a" },
		{ size: 200, name: "b" },
	];
	const ordered = orderUploads(files);
	assert.deepEqual(
		ordered.map((f) => f.name),
		["a", "b", "c"],
	);
});

test("orderUploads: не мутирует исходный массив", () => {
	const files = [{ size: 3 }, { size: 1 }, { size: 2 }];
	const copy = files.map((f) => ({ ...f }));
	orderUploads(files);
	assert.deepEqual(files, copy);
});

test("orderUploads: пустой и одноэлементный массив", () => {
	assert.deepEqual(orderUploads([]), []);
	const one = [{ size: 5 }];
	assert.deepEqual(orderUploads(one), one);
});
