// Rooms, этап 5 — ring-column-blit.js. Тесты до кода (skill п.14). Контракт и
// design-записка — PROCESS-DOCS/CONTRACTS.md/DESIGN.md "Rooms — Этап 5".
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeBlitRegions, nextWriteIndex } from "../src/domain/rooms/ring-column-blit.js";

test("computeBlitRegions: writeIndex=0 -> один регион, покрывающий весь буфер без сдвига", () => {
	const regions = computeBlitRegions(0, 10);
	assert.deepEqual(regions, [{ srcX: 0, width: 10, destX: 0 }]);
});

test("computeBlitRegions: writeIndex в середине -> два региона (старый хвост + новая голова)", () => {
	const regions = computeBlitRegions(3, 10);
	assert.deepEqual(regions, [
		{ srcX: 3, width: 7, destX: 0 },
		{ srcX: 0, width: 3, destX: 7 },
	]);
});

test("computeBlitRegions: writeIndex=width-1 -> хвост длины 1, голова длины width-1", () => {
	const regions = computeBlitRegions(9, 10);
	assert.deepEqual(regions, [
		{ srcX: 9, width: 1, destX: 0 },
		{ srcX: 0, width: 9, destX: 1 },
	]);
});

test("computeBlitRegions: width=1 -> единственный регион, writeIndex всегда 0 после mod 1", () => {
	assert.deepEqual(computeBlitRegions(0, 1), [{ srcX: 0, width: 1, destX: 0 }]);
});

test("computeBlitRegions: сумма ширин регионов всегда равна width (нет дыр/наложений), для нескольких (width, writeIndex)", () => {
	for (const width of [1, 2, 5, 17, 100]) {
		for (let writeIndex = 0; writeIndex < width; writeIndex++) {
			const regions = computeBlitRegions(writeIndex, width);
			const totalWidth = regions.reduce((sum, r) => sum + r.width, 0);
			assert.equal(totalWidth, width, `width=${width}, writeIndex=${writeIndex}`);
			// destX регионов не пересекаются и вместе покрывают [0, width) без дыр
			const sorted = [...regions].sort((a, b) => a.destX - b.destX);
			let cursor = 0;
			for (const r of sorted) {
				assert.equal(r.destX, cursor, `width=${width}, writeIndex=${writeIndex}`);
				cursor += r.width;
			}
			assert.equal(cursor, width);
		}
	}
});

test("nextWriteIndex: полный цикл из width вызовов возвращает writeIndex к исходному значению", () => {
	for (const width of [1, 2, 5, 17]) {
		let writeIndex = 0;
		for (let i = 0; i < width; i++) writeIndex = nextWriteIndex(writeIndex, width);
		assert.equal(writeIndex, 0);
	}
});

test("nextWriteIndex: width=1 -> всегда 0 (единственная позиция)", () => {
	assert.equal(nextWriteIndex(0, 1), 0);
});

test("живая находка (design-записка): отрисовка ДО продвижения индекса ставит новый столбец не на правый край — регрессия зафиксирована как явный порядок вызовов", () => {
	// Симуляция одного кадра: пишем в текущий writeIndex, продвигаем, ТОЛЬКО ПОТОМ считаем регионы.
	let writeIndex = 0;
	const width = 5;
	const written = []; // порядковый номер столбца, записанного на каждую позицию буфера
	function pushColumn(seq) {
		written[writeIndex] = seq;
		writeIndex = nextWriteIndex(writeIndex, width);
	}
	for (let seq = 0; seq < width; seq++) pushColumn(seq);
	// После width кадров буфер заполнен 0..width-1 по порядку позиций (полный круг).
	// Регионы для ТЕКУЩЕГО writeIndex (снова 0) дают один регион [0,width) -> самый
	// новый столбец (seq=width-1) должен оказаться на destX+width-1 = правом крае.
	const regions = computeBlitRegions(writeIndex, width);
	assert.equal(regions.length, 1);
	assert.equal(regions[0].srcX, 0);
	assert.equal(regions[0].width, width);
	// Столбец на visible[width-1] соответствует buffer[(writeIndex + width - 1) mod width] = buffer[width-1]
	assert.equal(written[width - 1], width - 1, "самый новый столбец лежит на позиции, которая рисуется последней (правый край)");
});
