import test from "node:test";
import assert from "node:assert/strict";
import { clampScale, clampAxis, clampState, zoomAbout, distance, midpoint, isZoomed, MAX_SCALE, MIN_SCALE } from "../src/domain/media/zoom-math.js";

const viewport = { left: 0, top: 0, width: 400, height: 800 };
const base = { cx: 200, cy: 400, w: 400, h: 300 };

test("clampScale держит масштаб в [1, MAX] и терпит мусор", () => {
	assert.equal(clampScale(0.3), MIN_SCALE);
	assert.equal(clampScale(99), MAX_SCALE);
	assert.equal(clampScale(2), 2);
	assert.equal(clampScale(NaN), MIN_SCALE);
});

test("clampAxis: картинка не больше окна стоит по центру", () => {
	assert.equal(clampAxis(50, 200, 300, 0, 400), 0);
});

test("clampAxis: увеличенная картинка не отпускает край внутрь окна", () => {
	// размер 800 при окне 400 и центре 200: края в [-200, 600] — сдвиг в [-200, 200]
	assert.equal(clampAxis(500, 200, 800, 0, 400), 200);
	assert.equal(clampAxis(-500, 200, 800, 0, 400), -200);
	assert.equal(clampAxis(30, 200, 800, 0, 400), 30);
});

test("zoomAbout: точка под пальцем остаётся на месте", () => {
	const start = { scale: 1, tx: 0, ty: 0 };
	// точка (300, 450) правее центра базы; на масштабе 2 картинка (800 при окне 400) шире окна,
	// так что зажим не срабатывает по X и образ точки должен остаться ровно там же.
	const next = zoomAbout(start, 2, 300, 450, base, viewport);
	assert.equal(next.scale, 2);
	const u = 300 - base.cx; // положение точки относительно центра базы при масштабе 1
	assert.equal(base.cx + next.tx + next.scale * u, 300);
	// по Y картинка (600) помещается в окно (800) — стоит по центру
	assert.equal(next.ty, 0);
});

test("zoomAbout: возврат к 1 даёт нулевое смещение", () => {
	const zoomed = { scale: 3, tx: 120, ty: -40 };
	const back = zoomAbout(zoomed, 1, 200, 400, base, viewport);
	assert.deepEqual(back, { scale: 1, tx: 0, ty: 0 });
});

test("zoomAbout: не выходит за MAX", () => {
	const next = zoomAbout({ scale: 4, tx: 0, ty: 0 }, 50, 200, 400, base, viewport);
	assert.equal(next.scale, MAX_SCALE);
});

test("distance / midpoint / isZoomed", () => {
	assert.equal(distance({ x: 0, y: 0 }, { x: 3, y: 4 }), 5);
	assert.deepEqual(midpoint({ x: 0, y: 0 }, { x: 10, y: 20 }), { x: 5, y: 10 });
	assert.equal(isZoomed(1), false);
	assert.equal(isZoomed(1.2), true);
});
