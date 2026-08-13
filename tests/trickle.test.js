// Rooms, этап 1 — trickle.js. Тесты до кода (skill п.14). Контракт —
// PROCESS-DOCS/CONTRACTS.md "Rooms — Этап 1" (trickle.js), точный псевдокод
// для воркера там же. RFC 6206 (ROOMS-ALGO.md §4.2).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTrickle } from "../src/domain/rooms/trickle.js";

const I_MIN = 15000;
const I_MAX = 60000;

test("до первого onInterval(): shouldTransmit всегда false", () => {
	const trickle = createTrickle({ iMin: I_MIN, iMax: I_MAX, k: 1, random: (lo) => lo });
	assert.equal(trickle.shouldTransmit(0), false);
	assert.equal(trickle.shouldTransmit(999999), false);
});

test("getIntervalEnd(): null до первого onInterval, затем now+I на каждом вызове (Этап 2 — нужен оркестратору)", () => {
	const trickle = createTrickle({ iMin: I_MIN, iMax: I_MAX, k: 1, random: (lo) => lo });
	assert.equal(trickle.getIntervalEnd(), null);
	trickle.onInterval(1000); // I=30000
	assert.equal(trickle.getIntervalEnd(), 1000 + 30000);
	trickle.onInterval(100000); // I=60000 (капнуто)
	assert.equal(trickle.getIntervalEnd(), 100000 + 60000);
});

test("первый onInterval: I удваивается от iMin, t = now + random(I/2, I)", () => {
	const trickle = createTrickle({ iMin: I_MIN, iMax: I_MAX, k: 1, random: (lo) => lo });
	trickle.onInterval(1000);
	// I = min(2*15000, 60000) = 30000; random(15000,30000)->lo=15000; t = 1000+15000 = 16000
	assert.equal(trickle.shouldTransmit(15999), false, "до t — рано");
	assert.equal(trickle.shouldTransmit(16000), true, "на t: c=0 < k=1 -> передаём");
	assert.equal(trickle.shouldTransmit(16000), false, "повторный вызов в том же интервале — флаг уже взведён");
	assert.equal(trickle.shouldTransmit(20000), false, "всё ещё тот же интервал — подавлено");
});

test("shouldTransmit взводит флаг ДАЖЕ когда подавляет передачу (c>=k)", () => {
	const trickle = createTrickle({ iMin: I_MIN, iMax: I_MAX, k: 1, random: (lo) => lo });
	trickle.onInterval(0); // t=15000
	trickle.onConsistent(); // c=1
	assert.equal(trickle.shouldTransmit(15000), false, "c=1 >= k=1 -> подавлено");
	assert.equal(trickle.shouldTransmit(15000), false, "повторный вызов — тоже false (флаг уже взведён, не пере-проверяет c)");
});

test("k=2: c < k -> передаём; c >= k -> подавлено", () => {
	const withOneConsistent = createTrickle({ iMin: I_MIN, iMax: I_MAX, k: 2, random: (lo) => lo });
	withOneConsistent.onInterval(0);
	withOneConsistent.onConsistent(); // c=1
	assert.equal(withOneConsistent.shouldTransmit(15000), true, "c=1 < k=2 -> передаём");

	const withTwoConsistent = createTrickle({ iMin: I_MIN, iMax: I_MAX, k: 2, random: (lo) => lo });
	withTwoConsistent.onInterval(0);
	withTwoConsistent.onConsistent();
	withTwoConsistent.onConsistent(); // c=2
	assert.equal(withTwoConsistent.shouldTransmit(15000), false, "c=2 >= k=2 -> подавлено");
});

test("I растёт удвоением на каждом регулярном onInterval, ограничено iMax", () => {
	const trickle = createTrickle({ iMin: I_MIN, iMax: I_MAX, k: 1, random: (lo) => lo });
	trickle.onInterval(0); // I=30000, t=15000
	trickle.onInterval(100000); // I=min(60000,60000)=60000, t=100000+30000=130000
	trickle.onInterval(200000); // I=min(120000,60000)=60000 (капнуто), t=200000+30000=230000
	assert.equal(trickle.shouldTransmit(229999), false);
	assert.equal(trickle.shouldTransmit(230000), true);
});

test("random вызывается с границами (I/2, I) от ТЕКУЩЕГО (уже удвоенного) I", () => {
	const calls = [];
	const spyRandom = (lo, hi) => {
		calls.push([lo, hi]);
		return lo;
	};
	const trickle = createTrickle({ iMin: I_MIN, iMax: I_MAX, k: 1, random: spyRandom });
	trickle.onInterval(0);
	assert.deepEqual(calls, [[15000, 30000]], "I=30000 после первого удвоения от iMin=15000 -> random(15000,30000)");
	trickle.onInterval(50000);
	assert.deepEqual(calls[1], [30000, 60000], "I=60000 после второго удвоения -> random(30000,60000)");
});

test("onConsistent: увеличивает c без обращения к now", () => {
	const trickle = createTrickle({ iMin: I_MIN, iMax: I_MAX, k: 3, random: (lo) => lo });
	trickle.onInterval(0);
	trickle.onConsistent();
	trickle.onConsistent();
	assert.equal(trickle.shouldTransmit(15000), true, "c=2 < k=3 -> передаём");
});

test("onInconsistent: сбрасывает I=iMin и c=0; ОБЯЗАТЕЛЬНЫЙ немедленный onInterval(now) пересчитывает t/intervalEnd", () => {
	const trickle = createTrickle({ iMin: I_MIN, iMax: I_MAX, k: 1, random: (lo) => lo });
	trickle.onInterval(0); // I=30000
	trickle.onInterval(50000); // I=60000
	trickle.onConsistent();
	trickle.onInconsistent(); // I сброшено на iMin=15000, c=0
	trickle.onInterval(500); // I=min(2*15000,60000)=30000; t=500+15000=15500
	assert.equal(trickle.shouldTransmit(15499), false, "до нового t — рано");
	assert.equal(trickle.shouldTransmit(15500), true, "c обнулился (0<k=1) -> передаём на новом, укороченном интервале");
});

test("firedThisInterval сбрасывается на каждом onInterval — shouldTransmit может снова сработать в новом интервале", () => {
	const trickle = createTrickle({ iMin: I_MIN, iMax: I_MAX, k: 1, random: (lo) => lo });
	trickle.onInterval(0); // t=15000
	assert.equal(trickle.shouldTransmit(15000), true);
	assert.equal(trickle.shouldTransmit(20000), false, "тот же интервал — подавлено");
	trickle.onInterval(30000); // I=60000, t=30000+30000=60000
	assert.equal(trickle.shouldTransmit(59999), false);
	assert.equal(trickle.shouldTransmit(60000), true, "новый интервал — флаг сброшен, c снова 0");
});

test("shouldTransmit(now) до достижения t внутри интервала — всегда false, независимо от c", () => {
	const trickle = createTrickle({ iMin: I_MIN, iMax: I_MAX, k: 5, random: (lo) => lo });
	trickle.onInterval(0); // t=15000
	trickle.onConsistent();
	trickle.onConsistent();
	assert.equal(trickle.shouldTransmit(14999), false, "ещё не t, даже с c<k");
});
