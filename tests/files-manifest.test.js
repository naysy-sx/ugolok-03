import { test } from "node:test";
import assert from "node:assert/strict";
import { planChunks, rangeToChunks } from "../src/domain/files/manifest.js";

test("planChunks: файл кратен размеру чанка — все чанки полные", () => {
	assert.deepEqual(planChunks(1024, 256), { count: 4, lastChunkSize: 256 });
});

test("planChunks: файл НЕ кратен — последний чанк короче", () => {
	assert.deepEqual(planChunks(1000, 256), { count: 4, lastChunkSize: 232 });
});

test("planChunks: файл меньше одного чанка — один короткий чанк", () => {
	assert.deepEqual(planChunks(100, 256), { count: 1, lastChunkSize: 100 });
});

test("planChunks: пустой файл — ноль чанков", () => {
	assert.deepEqual(planChunks(0, 256), { count: 0, lastChunkSize: 0 });
});

test("planChunks: размер РОВНО один чанк — count=1, lastChunkSize=chunkSize (не 0)", () => {
	assert.deepEqual(planChunks(256, 256), { count: 1, lastChunkSize: 256 });
});

test("rangeToChunks: диапазон целиком внутри ОДНОГО чанка", () => {
	const m = { ...planChunks(1000, 256), chunkSize: 256 };
	const r = rangeToChunks(10, 50, m); // байты [10, 60) — весь внутри чанка 0 [0,256)
	assert.equal(r.firstIdx, 0);
	assert.equal(r.lastIdx, 0);
	assert.equal(r.skipHead, 10);
	assert.equal(r.skipTail, 256 - 60);
});

test("rangeToChunks: диапазон пересекает ГРАНИЦУ двух чанков", () => {
	const m = { ...planChunks(1000, 256), chunkSize: 256 };
	const r = rangeToChunks(200, 100, m); // [200, 300) — чанк0 [0,256), чанк1 [256,512)
	assert.equal(r.firstIdx, 0);
	assert.equal(r.lastIdx, 1);
	assert.equal(r.skipHead, 200);
	assert.equal(r.skipTail, 512 - 300);
});

test("rangeToChunks: диапазон захватывает ПОСЛЕДНИЙ (короткий) чанк целиком", () => {
	const m = { ...planChunks(1000, 256), chunkSize: 256 }; // count=4, lastChunkSize=232, чанк3: [768, 1000)
	const r = rangeToChunks(768, 232, m);
	assert.equal(r.firstIdx, 3);
	assert.equal(r.lastIdx, 3);
	assert.equal(r.skipHead, 0);
	assert.equal(r.skipTail, 0);
});

test("rangeToChunks: первый байт файла (offset=0, length=1)", () => {
	const m = { ...planChunks(1000, 256), chunkSize: 256 };
	const r = rangeToChunks(0, 1, m);
	assert.equal(r.firstIdx, 0);
	assert.equal(r.lastIdx, 0);
	assert.equal(r.skipHead, 0);
	assert.equal(r.skipTail, 255);
});

test("rangeToChunks: последний байт файла", () => {
	const m = { ...planChunks(1000, 256), chunkSize: 256 }; // последний байт — индекс 999, чанк3 [768,1000)
	const r = rangeToChunks(999, 1, m);
	assert.equal(r.firstIdx, 3);
	assert.equal(r.lastIdx, 3);
	assert.equal(r.skipHead, 999 - 768);
	assert.equal(r.skipTail, 0);
});

test("rangeToChunks: диапазон через ВСЕ чанки (весь файл)", () => {
	const m = { ...planChunks(1000, 256), chunkSize: 256 };
	const r = rangeToChunks(0, 1000, m);
	assert.equal(r.firstIdx, 0);
	assert.equal(r.lastIdx, 3);
	assert.equal(r.skipHead, 0);
	assert.equal(r.skipTail, 0);
});

test("planChunks/rangeToChunks согласованы на 500 случайных (size, chunkSize, offset, length)", () => {
	function mulberry32(seed) {
		return function () {
			seed |= 0;
			seed = (seed + 0x6d2b79f5) | 0;
			let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
			t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
			return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
		};
	}
	const rng = mulberry32(42);
	for (let i = 0; i < 500; i++) {
		const chunkSize = 16 + Math.floor(rng() * 256);
		const size = 1 + Math.floor(rng() * 5000);
		const m = { ...planChunks(size, chunkSize), chunkSize };
		assert.equal(m.count, Math.ceil(size / chunkSize));
		// Реконструированный суммарный размер по чанкам обязан дать ровно size.
		const reconstructedSize = (m.count - 1) * chunkSize + m.lastChunkSize;
		assert.equal(reconstructedSize, size, `size=${size} chunkSize=${chunkSize}`);

		const offset = Math.floor(rng() * size);
		const length = 1 + Math.floor(rng() * (size - offset));
		const r = rangeToChunks(offset, length, m);
		assert.ok(r.firstIdx <= r.lastIdx);
		assert.ok(r.firstIdx >= 0 && r.lastIdx < m.count);
		// skipHead/skipTail обязаны укладываться в границы своих чанков.
		assert.ok(r.skipHead >= 0 && r.skipHead < chunkSize);
		const lastChunkActualSize = r.lastIdx === m.count - 1 ? m.lastChunkSize : chunkSize;
		assert.ok(r.skipTail >= 0 && r.skipTail < lastChunkActualSize, `skipTail=${r.skipTail} lastChunkActualSize=${lastChunkActualSize}`);
	}
});
