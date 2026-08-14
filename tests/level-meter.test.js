// Rooms, этап 5 — level-meter.js. Тесты до кода (skill п.14). Контракт и
// design-записка — PROCESS-DOCS/CONTRACTS.md/DESIGN.md "Rooms — Этап 5".
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeRms, createLevelTracker } from "../src/domain/rooms/level-meter.js";

function silentBuffer(length = 256) {
	return new Uint8Array(length).fill(128); // 128 = ноль амплитуды (Web Audio time-domain byte)
}

function loudBuffer(length = 256) {
	// Чередование 0/255 -> максимальная амплитуда каждой выборки.
	const buf = new Uint8Array(length);
	for (let i = 0; i < length; i++) buf[i] = i % 2 === 0 ? 0 : 255;
	return buf;
}

test("computeRms: тишина (все байты 128) -> 0", () => {
	assert.equal(computeRms(silentBuffer()), 0);
});

test("computeRms: максимальная амплитуда -> около 1 (в пределах округления байтового представления)", () => {
	const rms = computeRms(loudBuffer());
	assert.ok(rms > 0.99 && rms <= 1.001, `rms=${rms}`);
});

test("createLevelTracker: монотонный рост rms от 0 через оба порога — ровно один переход false->true", () => {
	const tracker = createLevelTracker({ alpha: 1, onThreshold: 0.15, offThreshold: 0.1 }); // alpha=1 -> level=rms сразу
	const transitions = [];
	let prevSpeaking = false;
	for (const rms of [0, 0.05, 0.1, 0.14, 0.15, 0.2, 0.3, 0.5]) {
		const { speaking } = tracker.update(rms);
		if (speaking !== prevSpeaking) transitions.push(speaking);
		prevSpeaking = speaking;
	}
	assert.deepEqual(transitions, [true], "ровно один переход, в true");
});

test("createLevelTracker: рост до мёртвой зоны и обратно вниз БЕЗ пересечения offThreshold — speaking остаётся true (регрессия на дребезг)", () => {
	const tracker = createLevelTracker({ alpha: 1, onThreshold: 0.15, offThreshold: 0.1 });
	tracker.update(0.2); // выше onThreshold -> speaking=true
	assert.equal(tracker.get().speaking, true);
	tracker.update(0.12); // ниже onThreshold, но ВЫШЕ offThreshold — мёртвая зона
	assert.equal(tracker.get().speaking, true, "не должен погаснуть в мёртвой зоне");
	tracker.update(0.13);
	assert.equal(tracker.get().speaking, true);
	tracker.update(0.09); // ниже offThreshold — теперь гаснет
	assert.equal(tracker.get().speaking, false);
});

test("createLevelTracker: не пересекая onThreshold снизу вверх — speaking остаётся false даже если level входит и выходит из мёртвой зоны", () => {
	const tracker = createLevelTracker({ alpha: 1, onThreshold: 0.15, offThreshold: 0.1 });
	tracker.update(0.12); // мёртвая зона, но speaking никогда не был true
	assert.equal(tracker.get().speaking, false);
	tracker.update(0.05);
	assert.equal(tracker.get().speaking, false);
});

test("createLevelTracker: EMA сглаживает — alpha=0.3, level растёт постепенно, не скачком, к постоянному rms", () => {
	const tracker = createLevelTracker({ alpha: 0.3 });
	const levels = [];
	for (let i = 0; i < 5; i++) levels.push(tracker.update(1).level);
	for (let i = 1; i < levels.length; i++) assert.ok(levels[i] > levels[i - 1], "монотонный рост к 1");
	assert.ok(levels[0] < 1, "первый шаг ещё не достиг целевого значения (не мгновенно)");
});

test("createLevelTracker: граничные alpha — alpha=0 не сглаживает (level остаётся 0 навсегда), alpha=1 мгновенно принимает rms", () => {
	const frozen = createLevelTracker({ alpha: 0 });
	frozen.update(1);
	frozen.update(1);
	assert.equal(frozen.get().level, 0);

	const instant = createLevelTracker({ alpha: 1 });
	assert.equal(instant.update(0.42).level, 0.42);
	assert.equal(instant.update(0.7).level, 0.7);
});

test("createLevelTracker: не бросает и не делит на ноль при rms=0 повторно", () => {
	const tracker = createLevelTracker();
	assert.doesNotThrow(() => {
		for (let i = 0; i < 10; i++) tracker.update(0);
	});
	assert.equal(tracker.get().level, 0);
});
