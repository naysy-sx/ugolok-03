// Этап A5 (MEDIA-SPEC.md §3.4, ALGO §4.6): исчерпывающий обход в ширину по графу
// достижимости автомата media-machine.js. Не рассуждение и не выборочные сценарии —
// проверка, что И1–И6 выполнены на КАЖДОМ достижимом переходе, и что δ тотальна
// (не бросает исключение и не возвращает undefined) на всём алфавите событий.
import { test } from "node:test";
import assert from "node:assert/strict";
import { transition, allocWindow, EVENTS } from "../src/domain/media/media-machine.js";
import { buildPlaylist, firstOfClass } from "../src/domain/media/playlist.js";

function ref(digest, mime, size) {
	return { digest, key: null, mime, name: digest, size, sourceKind: "attachment", sourceMeta: {} };
}

function playlist() {
	return buildPlaylist([
		ref("a0", "audio/mpeg", 10),
		ref("a1", "audio/mpeg", 10),
		ref("v0", "video/mp4", 10),
		ref("i0", "image/png", 10),
		ref("i1", "image/png", 10),
		ref("i2", "image/png", 10),
	]);
}

function stateKey(s) {
	// Этап 10 (§10.6) — repeat/autoplay ОБЯЗАНЫ входить в ключ: без них обход
	// в ширину схлопнет состояния, различающиеся только режимом повтора, в
	// одно — тест продолжил бы проходить, молча перестав быть исчерпывающим.
	return s === null ? "null" : `${s.cls}|${s.position}|${s.display}|${s.play}|${s.callActive}|${s.repeat}|${s.autoplay}`;
}

function checkInvariants(pl, prevState, event, payload, next) {
	// И6 — тотальность: переход обязан существовать и быть валидным значением типа.
	assert.notEqual(next, undefined, `δ(${stateKey(prevState)}, ${event}) не определена (undefined)`);
	if (next !== null) {
		assert.equal(typeof next, "object", `δ(${stateKey(prevState)}, ${event}) вернула не объект и не null`);
		// И2
		if (next.play === "playing") {
			assert.equal(next.callActive, false, `И2 нарушен: playing при активном звонке, переход ${event} из ${stateKey(prevState)}`);
		}
		// И4
		assert.ok(next.position >= 0 && next.position < pl.items.length, `И4 нарушен: position вне [0,|L|), переход ${event} из ${stateKey(prevState)}`);
		// И5
		if (next.cls === "image") {
			assert.notEqual(next.display, "mini", `И5 нарушен: просмотрщик изображений свёрнут, переход ${event} из ${stateKey(prevState)}`);
		}
		// Этап 10 — repeat всегда одно из трёх допустимых значений.
		assert.ok(["off", "all", "one"].includes(next.repeat), `repeat вне {off,all,one}: "${next.repeat}", переход ${event} из ${stateKey(prevState)}`);
		// Этап 10 — при cls==="image" ended остаётся no-op НЕЗАВИСИМО от repeat
		// (doEnded проверяет cls раньше repeat — структурная гарантия, но
		// spec §10.6 требует явной проверки на каждом достижимом состоянии).
		if (next.cls === "image") {
			const afterEnded = transition(next, "ended", {}, pl);
			assert.deepEqual(afterEnded, next, `ended не no-op для image, переход ${event} из ${stateKey(prevState)}`);
		}
		// Этап 10 — при repeat==="one" ended не меняет position (доводку к
		// нулю делает вид, не δ — И-D).
		if (next.repeat === "one") {
			const afterEnded = transition(next, "ended", {}, pl);
			assert.equal(afterEnded.position, next.position, `repeat="one": ended сдвинул position, переход ${event} из ${stateKey(prevState)}`);
		}
	}
	// И3
	const alloc = allocWindow(next, pl, 1_000_000);
	if (next === null) {
		assert.deepEqual(alloc, [], `И3 нарушен: allocWindow(null) не пуст после ${event} из ${stateKey(prevState)}`);
	}
}

test("EVENTS покрыт полностью, δ тотальна и И1–И6 выполнены на каждом достижимом переходе (обход в ширину)", () => {
	const pl = playlist();

	function openPayloads() {
		return [
			{ cls: "audio", position: firstOfClass(pl, "audio") },
			{ cls: "video", position: firstOfClass(pl, "video") },
			{ cls: "image", position: firstOfClass(pl, "image") },
		];
	}

	const edges = [
		...openPayloads().map((p) => ["open", p]),
		["next", {}],
		["prev", {}],
		["toggle", {}],
		["minimize", {}],
		["restore", {}],
		["close", {}],
		["callStart", {}],
		["callEnd", {}],
		["ended", {}],
		["seek", { t: 0 }],
		// Этап 10 — три режима repeat + оба autoplay как отдельные рёбра:
		// обход в ширину сам находит все 6 комбинаций repeat×autoplay из
		// любого достижимого состояния (§10.6: "пространство вырастет в
		// шесть раз — это ожидаемо").
		["setRepeat", { mode: "off" }],
		["setRepeat", { mode: "all" }],
		["setRepeat", { mode: "one" }],
		["setAutoplay", { value: true }],
		["setAutoplay", { value: false }],
	];

	// Каждое имя события из EVENTS обязано встретиться хотя бы раз среди рёбер обхода —
	// иначе тест молча не проверит забытую ветку (ровно та ошибка, которую должен ловить А5).
	const coveredEvents = new Set(edges.map(([e]) => e));
	for (const e of EVENTS) assert.ok(coveredEvents.has(e), `событие "${e}" из EVENTS не проверяется обходом`);

	const visited = new Set([stateKey(null)]);
	const queue = [null];
	let transitionsChecked = 0;

	while (queue.length > 0) {
		const state = queue.shift();
		for (const [event, payload] of edges) {
			const next = transition(state, event, payload, pl);
			checkInvariants(pl, state, event, payload, next);
			transitionsChecked++;
			const key = stateKey(next);
			if (!visited.has(key)) {
				visited.add(key);
				queue.push(next);
			}
		}
	}

	// ALGO §4.6: "порядка 40 абстрактных состояний... порядка ~440 переходов" —
	// сотни, не тысячи; проверка, что обход не выродился (0 состояний) и не взорвался.
	assert.ok(visited.size > 1, "обход не нашёл ни одного состояния кроме null — подозрительно");
	assert.ok(visited.size < 500, `обход нашёл ${visited.size} состояний — подозрительно много, возможна утечка position в идентичность`);
	assert.ok(transitionsChecked >= visited.size * edges.length * 0.5, "обход проверил подозрительно мало переходов");
});

test("δ не бросает исключение ни на одной паре (состояние, событие) даже с payload={}", () => {
	const pl = playlist();
	const sampleStates = [
		null,
		{ cls: "audio", position: 0, display: "full", play: "playing", callActive: false },
		{ cls: "video", position: 2, display: "mini", play: "suspended", callActive: true },
		{ cls: "image", position: 3, display: "full", play: "paused", callActive: false },
	];
	for (const s of sampleStates) {
		for (const e of EVENTS) {
			assert.doesNotThrow(() => transition(s, e, {}, pl), `transition(${stateKey(s)}, ${e}, {}) бросила исключение`);
		}
	}
});
