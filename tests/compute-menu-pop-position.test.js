import { test } from "node:test";
import assert from "node:assert/strict";
import { computeMenuPopPosition } from "../src/ui/hooks/compute-menu-pop-position.js";

const VIEW = { width: 800, height: 600 };
const POP = { width: 180, height: 160 };
const GAP = 4;

function trigger(x, y, w = 32, h = 32) {
	return { top: y, left: x, right: x + w, bottom: y + h, width: w, height: h };
}

test("под триггером, выравнивание по концу, когда места хватает", () => {
	const t = trigger(600, 80);
	const pos = computeMenuPopPosition(t, POP, VIEW, { gap: GAP, align: "end" });
	assert.equal(pos.top, t.bottom + GAP);
	assert.equal(pos.left, t.right - POP.width);
});

test("выравнивание по началу: left = trigger.left", () => {
	const t = trigger(40, 80, 200, 32);
	const pos = computeMenuPopPosition(t, POP, VIEW, { gap: GAP, align: "start" });
	assert.equal(pos.top, t.bottom + GAP);
	assert.equal(pos.left, t.left);
});

test("не хватает места снизу — открывается сверху", () => {
	const t = trigger(600, 500);
	const pos = computeMenuPopPosition(t, POP, VIEW, { gap: GAP, align: "end" });
	assert.equal(pos.top, t.top - GAP - POP.height);
	assert.equal(pos.left, t.right - POP.width);
});

test("не хватает ни сверху ни снизу — кламп в вьюпорт", () => {
	const tall = { width: 180, height: 500 };
	const t = trigger(600, 200);
	const pos = computeMenuPopPosition(t, tall, VIEW, { gap: GAP, align: "end" });
	assert.ok(pos.top >= GAP);
	assert.ok(pos.top + tall.height <= VIEW.height - GAP);
});

test("попал бы за левый край — сдвиг вправо до gap", () => {
	const t = trigger(10, 80, 20, 32);
	const pos = computeMenuPopPosition(t, POP, VIEW, { gap: GAP, align: "end" });
	assert.equal(pos.left, GAP);
});

test("попал бы за правый край — сдвиг влево", () => {
	const t = trigger(780, 80, 16, 32);
	const pos = computeMenuPopPosition(t, POP, VIEW, { gap: GAP, align: "start" });
	assert.equal(pos.left, VIEW.width - POP.width - GAP);
});

test("gap по умолчанию 4", () => {
	const t = trigger(600, 80);
	const pos = computeMenuPopPosition(t, POP, VIEW, { align: "end" });
	assert.equal(pos.top, t.bottom + 4);
});

test("попа шире вьюпорта — left = gap", () => {
	const wide = { width: 900, height: 80 };
	const t = trigger(100, 80);
	const pos = computeMenuPopPosition(t, wide, VIEW, { gap: GAP, align: "end" });
	assert.equal(pos.left, GAP);
});

test("попа выше вьюпорта — top = gap", () => {
	const tall = { width: 180, height: 700 };
	const t = trigger(600, 300);
	const pos = computeMenuPopPosition(t, tall, VIEW, { gap: GAP, align: "end" });
	assert.equal(pos.top, GAP);
});
