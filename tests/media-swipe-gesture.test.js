import { test } from "node:test";
import assert from "node:assert/strict";
import {
	AXIS_LOCK_PX,
	HORIZONTAL_COMMIT_RATIO,
	EDGE_RESISTANCE,
	VERTICAL_PULL_RANGE_PX,
	VERTICAL_COMMIT_PX,
	resolveAxis,
	elasticDx,
	horizontalCommit,
	verticalPull,
	verticalCommit,
} from "../src/domain/media/swipe-gesture.js";

test("resolveAxis: ниже порога — null (ещё не определена)", () => {
	assert.equal(resolveAxis(0, 0), null);
	assert.equal(resolveAxis(AXIS_LOCK_PX - 1, AXIS_LOCK_PX - 1), null);
});

test("resolveAxis: доминирующая горизонталь на пороге", () => {
	assert.equal(resolveAxis(AXIS_LOCK_PX, 0), "horizontal");
	assert.equal(resolveAxis(-AXIS_LOCK_PX, 0), "horizontal");
});

test("resolveAxis: доминирующая вертикаль на пороге", () => {
	assert.equal(resolveAxis(0, AXIS_LOCK_PX), "vertical");
});

test("resolveAxis: диагональ — решает больший по модулю компонент, не мигает", () => {
	assert.equal(resolveAxis(20, 5), "horizontal");
	assert.equal(resolveAxis(5, 20), "vertical");
	assert.equal(resolveAxis(10, 10), "horizontal"); // равенство — горизонталь (>=), детерминировано
});

test("elasticDx: без сопротивления смещение как есть", () => {
	assert.equal(elasticDx(100, false), 100);
	assert.equal(elasticDx(-40, false), -40);
});

test("elasticDx: на краю плейлиста — 0.3", () => {
	assert.equal(elasticDx(100, true), 30);
	assert.equal(elasticDx(-100, true), -30);
});

test("horizontalCommit: ниже 16% ширины — null (возврат на место)", () => {
	assert.equal(horizontalCommit(50, 1000), null); // 5%
	assert.equal(horizontalCommit(159, 1000), null); // чуть меньше 16%
});

test("horizontalCommit: на пороге и выше — commit по направлению", () => {
	assert.equal(horizontalCommit(-160, 1000), "next"); // влево -> следующий
	assert.equal(horizontalCommit(160, 1000), "prev"); // вправо -> предыдущий
	assert.equal(horizontalCommit(-500, 1000), "next");
});

test("horizontalCommit: widthPx<=0 — защита от деления на 0", () => {
	assert.equal(horizontalCommit(500, 0), null);
	assert.equal(horizontalCommit(500, -10), null);
});

test("verticalPull: 0 в состоянии покоя, растёт линейно до 1", () => {
	assert.equal(verticalPull(0), 0);
	assert.equal(verticalPull(VERTICAL_PULL_RANGE_PX / 2), 0.5);
	assert.equal(verticalPull(VERTICAL_PULL_RANGE_PX), 1);
});

test("verticalPull: клампится сверху за пределами диапазона", () => {
	assert.equal(verticalPull(VERTICAL_PULL_RANGE_PX * 3), 1);
});

test("verticalPull: свайп вверх (dy<0) не задействован — прижат к 0", () => {
	assert.equal(verticalPull(-50), 0);
});

test("verticalCommit: порог 110px — строго больше, не включая", () => {
	assert.equal(verticalCommit(VERTICAL_COMMIT_PX), false);
	assert.equal(verticalCommit(VERTICAL_COMMIT_PX + 1), true);
	assert.equal(verticalCommit(0), false);
});

test("константы совпадают со SPEC §3.1/§3.2 буквально", () => {
	assert.equal(AXIS_LOCK_PX, 8);
	assert.equal(HORIZONTAL_COMMIT_RATIO, 0.16);
	assert.equal(EDGE_RESISTANCE, 0.3);
	assert.equal(VERTICAL_PULL_RANGE_PX, 260);
	assert.equal(VERTICAL_COMMIT_PX, 110);
});
