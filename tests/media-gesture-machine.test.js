import { test } from "node:test";
import assert from "node:assert/strict";
import {
	GESTURE_STATES,
	GESTURE_EVENTS,
	IDLE_STATE,
	gestureTransition,
	gestureOutput,
} from "../src/domain/media/gesture-machine.js";

function pressed(over) {
	return { name: "PRESSED", axis: null, dx: 0, dy: 0, dir: null, gen: 0, ...over };
}
function dragH(over) {
	return { name: "DRAG_H", axis: "horizontal", dx: 0, dy: 0, dir: null, gen: 0, ...over };
}
function dragV(over) {
	return { name: "DRAG_V", axis: "vertical", dx: 0, dy: 0, dir: null, gen: 0, ...over };
}
function settling(over) {
	return { name: "SETTLING", axis: "horizontal", dx: 0, dy: 0, dir: null, gen: 1, ...over };
}

test("алфавит состояний/событий буквально из spec §7.1", () => {
	assert.deepEqual(GESTURE_STATES, ["IDLE", "PRESSED", "DRAG_H", "DRAG_V", "SETTLING"]);
	assert.deepEqual(GESTURE_EVENTS, ["down", "move", "up", "cancel", "settleEnd"]);
});

// ------------------------------------------------------------------
// IDLE
// ------------------------------------------------------------------

test("IDLE.down -> PRESSED, dx/dy/axis/dir сброшены, gen сохраняется", () => {
	const s = gestureTransition({ ...IDLE_STATE, gen: 3 }, "down", null);
	assert.equal(s.name, "PRESSED");
	assert.equal(s.axis, null);
	assert.equal(s.dx, 0);
	assert.equal(s.dy, 0);
	assert.equal(s.dir, null);
	assert.equal(s.gen, 3, "gen не сбрасывается на down");
});

test("IDLE игнорирует move/up/cancel/settleEnd", () => {
	for (const event of ["move", "up", "cancel", "settleEnd"]) {
		const s = gestureTransition(IDLE_STATE, event, { dx: 999, dy: 999, gen: 999 });
		assert.deepEqual(s, IDLE_STATE, `IDLE.${event} обязан быть no-op`);
	}
});

// ------------------------------------------------------------------
// PRESSED
// ------------------------------------------------------------------

test("PRESSED.down игнорируется (жест уже идёт)", () => {
	const p = pressed();
	assert.deepEqual(gestureTransition(p, "down", null), p);
});

test("PRESSED.move: ось не определилась (< 8px) -> остаётся PRESSED", () => {
	const s = gestureTransition(pressed(), "move", { dx: 3, dy: 3 });
	assert.equal(s.name, "PRESSED");
	assert.equal(s.axis, null);
	assert.equal(s.dx, 3);
	assert.equal(s.dy, 3);
});

test("PRESSED.move: горизонталь на пороге -> DRAG_H", () => {
	const s = gestureTransition(pressed(), "move", { dx: 20, dy: 2 });
	assert.equal(s.name, "DRAG_H");
	assert.equal(s.axis, "horizontal");
	assert.equal(s.dx, 20);
});

test("PRESSED.move: вертикаль на пороге -> DRAG_V", () => {
	const s = gestureTransition(pressed(), "move", { dx: 2, dy: 20 });
	assert.equal(s.name, "DRAG_V");
	assert.equal(s.axis, "vertical");
	assert.equal(s.dy, 20);
});

test("PRESSED.up -> IDLE, тап проходит (это и есть 'клик не гасится')", () => {
	const s = gestureTransition(pressed({ dx: 1, dy: 1 }), "up", {});
	assert.equal(s.name, "IDLE");
});

test("PRESSED.cancel -> IDLE", () => {
	const s = gestureTransition(pressed(), "cancel", null);
	assert.equal(s.name, "IDLE");
});

test("PRESSED.settleEnd игнорируется", () => {
	const p = pressed();
	assert.deepEqual(gestureTransition(p, "settleEnd", { gen: p.gen }), p);
});

// ------------------------------------------------------------------
// DRAG_H
// ------------------------------------------------------------------

test("DRAG_H.down игнорируется", () => {
	const s0 = dragH({ dx: 50 });
	assert.deepEqual(gestureTransition(s0, "down", null), s0);
});

test("DRAG_H.move: остаётся DRAG_H, ось не пересматривается, dx/dy обновляются", () => {
	const s = gestureTransition(dragH({ dx: 50, dy: 60 }), "move", { dx: 80, dy: 5 });
	assert.equal(s.name, "DRAG_H");
	assert.equal(s.axis, "horizontal");
	assert.equal(s.dx, 80);
	assert.equal(s.dy, 5, "dy тоже переносится, даже если ось горизонтальная (для полноты состояния)");
});

test("DRAG_H.up: коммит (dx достаточно, не на краю) -> SETTLING(dir), gen+1", () => {
	const s = gestureTransition(dragH({ dx: -300, gen: 4 }), "up", { widthPx: 1000, rank: 1, total: 3 });
	assert.equal(s.name, "SETTLING");
	assert.equal(s.dir, "next");
	assert.equal(s.gen, 5);
});

test("DRAG_H.up: dx недостаточен -> SETTLING(null), gen+1 (пружинка — тоже доводка)", () => {
	const s = gestureTransition(dragH({ dx: -50, gen: 4 }), "up", { widthPx: 1000, rank: 1, total: 3 });
	assert.equal(s.name, "SETTLING");
	assert.equal(s.dir, null);
	assert.equal(s.gen, 5);
});

test("DRAG_H.up: коммит на краю плейлиста гасится в null (edge-clamp)", () => {
	// rank=0, тянут вправо (dx>0) -> "prev" запрещён на первом элементе
	const s1 = gestureTransition(dragH({ dx: 300, gen: 0 }), "up", { widthPx: 1000, rank: 0, total: 3 });
	assert.equal(s1.dir, null, "prev на rank=0 гасится");
	// rank=total-1, тянут влево (dx<0) -> "next" запрещён на последнем элементе
	const s2 = gestureTransition(dragH({ dx: -300, gen: 0 }), "up", { widthPx: 1000, rank: 2, total: 3 });
	assert.equal(s2.dir, null, "next на rank=total-1 гасится");
});

test("DRAG_H.cancel -> SETTLING(null), gen+1", () => {
	const s = gestureTransition(dragH({ dx: -300, gen: 4 }), "cancel", null);
	assert.equal(s.name, "SETTLING");
	assert.equal(s.dir, null);
	assert.equal(s.gen, 5);
});

test("DRAG_H.settleEnd игнорируется", () => {
	const s0 = dragH({ dx: 50 });
	assert.deepEqual(gestureTransition(s0, "settleEnd", { gen: 0 }), s0);
});

// ------------------------------------------------------------------
// DRAG_V
// ------------------------------------------------------------------

test("DRAG_V.down игнорируется", () => {
	const s0 = dragV({ dy: 50 });
	assert.deepEqual(gestureTransition(s0, "down", null), s0);
});

test("DRAG_V.move: остаётся DRAG_V, ось не пересматривается", () => {
	const s = gestureTransition(dragV({ dy: 50 }), "move", { dx: 5, dy: 90 });
	assert.equal(s.name, "DRAG_V");
	assert.equal(s.axis, "vertical");
	assert.equal(s.dy, 90);
});

test("DRAG_V.up -> IDLE безусловно (коммит-закрытие — забота вызывающей стороны, не δ)", () => {
	assert.equal(gestureTransition(dragV({ dy: 200 }), "up", {}).name, "IDLE");
	assert.equal(gestureTransition(dragV({ dy: 10 }), "up", {}).name, "IDLE");
});

test("DRAG_V.cancel -> IDLE", () => {
	assert.equal(gestureTransition(dragV({ dy: 200 }), "cancel", null).name, "IDLE");
});

test("DRAG_V.settleEnd игнорируется", () => {
	const s0 = dragV({ dy: 50 });
	assert.deepEqual(gestureTransition(s0, "settleEnd", { gen: 0 }), s0);
});

// ------------------------------------------------------------------
// SETTLING — три новые клетки (И-G/И-H)
// ------------------------------------------------------------------

test("SETTLING.down: завершить немедленно -> PRESSED, gen НЕ инкрементируется здесь", () => {
	const s = gestureTransition(settling({ gen: 7, dir: "next" }), "down", null);
	assert.equal(s.name, "PRESSED");
	assert.equal(s.axis, null);
	assert.equal(s.dx, 0);
	assert.equal(s.dy, 0);
	assert.equal(s.dir, null);
	assert.equal(s.gen, 7, "gen переживает форс-финиш — инкремент только на входе В SETTLING");
});

test("SETTLING.cancel: завершить немедленно -> IDLE", () => {
	const s = gestureTransition(settling({ gen: 7, dir: "prev" }), "cancel", null);
	assert.equal(s.name, "IDLE");
	assert.equal(s.gen, 7);
});

test("SETTLING.settleEnd: gen совпал -> IDLE", () => {
	const s = gestureTransition(settling({ gen: 7 }), "settleEnd", { gen: 7 });
	assert.equal(s.name, "IDLE");
});

test("SETTLING.settleEnd: чужой (более старый) gen -> игнор, остаёмся в SETTLING", () => {
	const cur = settling({ gen: 6 });
	const s = gestureTransition(cur, "settleEnd", { gen: 5 });
	assert.deepEqual(s, cur, "опоздавшая доводка от прошлого gen не трогает текущую");
});

test("SETTLING.move игнорируется (доводка уже решена, живых пикселей нет)", () => {
	const s0 = settling({ gen: 3 });
	assert.deepEqual(gestureTransition(s0, "move", { dx: 999, dy: 999 }), s0);
});

// Сценарий из DESIGN.md целиком: SETTLING(5) -> down -> PRESSED(gen=5) ->
// DRAG_H -> up -> SETTLING(6); опоздавший settleEnd(5) не должен задеть
// SETTLING(6).
test("сквозной сценарий: опоздавшая доводка старого поколения не завершает новую", () => {
	let s = settling({ gen: 5, dir: "next" });
	s = gestureTransition(s, "down", null); // -> PRESSED, gen=5
	assert.equal(s.name, "PRESSED");
	assert.equal(s.gen, 5);
	s = gestureTransition(s, "move", { dx: 20, dy: 1 }); // -> DRAG_H
	assert.equal(s.name, "DRAG_H");
	s = gestureTransition(s, "up", { widthPx: 1000, rank: 1, total: 5 }); // -> SETTLING(6)
	assert.equal(s.name, "SETTLING");
	assert.equal(s.gen, 6);
	// опоздавший settleEnd от ПЕРВОЙ (уже давно покинутой) доводки
	const stale = gestureTransition(s, "settleEnd", { gen: 5 });
	assert.deepEqual(stale, s, "gen=5 не совпадает с текущим gen=6 — игнор");
	// а вот settleEnd(6) корректно завершает
	const done = gestureTransition(s, "settleEnd", { gen: 6 });
	assert.equal(done.name, "IDLE");
});

// ------------------------------------------------------------------
// Тотальность δ — весь алфавит из каждого состояния не роняет и не
// возвращает undefined/null-мусор.
// ------------------------------------------------------------------

test("тотальность: δ определена на всех 25 парах состояние×событие", () => {
	const samples = {
		IDLE: IDLE_STATE,
		PRESSED: pressed({ dx: 5, dy: 5 }),
		DRAG_H: dragH({ dx: 100 }),
		DRAG_V: dragV({ dy: 100 }),
		SETTLING: settling({ gen: 2, dir: "next" }),
	};
	for (const name of GESTURE_STATES) {
		for (const event of GESTURE_EVENTS) {
			const result = gestureTransition(samples[name], event, { dx: 10, dy: 10, widthPx: 500, rank: 0, total: 2, gen: samples[name].gen });
			assert.ok(result && typeof result === "object", `${name}.${event} обязан вернуть объект состояния`);
			assert.ok(GESTURE_STATES.includes(result.name), `${name}.${event} вернул неизвестное имя состояния: ${result.name}`);
		}
	}
});

// ------------------------------------------------------------------
// λ (gestureOutput) — семантический выход
// ------------------------------------------------------------------

test("gestureOutput: IDLE — всё выключено, --media-pull без перехода", () => {
	const o = gestureOutput(IDLE_STATE);
	assert.equal(o.dragging, false);
	assert.equal(o.settling, false);
	assert.equal(o.dragPx, 0);
	assert.equal(o.pull, 0);
});

test("gestureOutput: PRESSED — dragging=true, но dragPx=0 (движения ещё не было)", () => {
	const o = gestureOutput(pressed());
	assert.equal(o.dragging, true);
	assert.equal(o.settling, false);
	assert.equal(o.dragPx, 0);
});

test("gestureOutput: DRAG_H — dragPx равен сырому dx состояния", () => {
	const o = gestureOutput(dragH({ dx: -123 }));
	assert.equal(o.dragging, true);
	assert.equal(o.dragPx, -123);
	assert.equal(o.pull, 0);
});

test("gestureOutput: DRAG_V — pull считается по dy через verticalPull", () => {
	const o = gestureOutput(dragV({ dy: 130 }));
	assert.equal(o.dragging, false, "вертикаль не двигает ленту");
	assert.equal(o.pull, 0.5); // 130/260
});

test("gestureOutput: SETTLING — dragPx знаковый юнит по dir, не пиксели", () => {
	assert.equal(gestureOutput(settling({ dir: "next" })).dragPx, -1);
	assert.equal(gestureOutput(settling({ dir: "prev" })).dragPx, 1);
	assert.equal(gestureOutput(settling({ dir: null })).dragPx, 0);
	assert.equal(gestureOutput(settling({ dir: "next" })).settling, true);
	assert.equal(gestureOutput(settling({ dir: "next" })).dragging, false);
});
