import "fake-indexeddb/auto";
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { db } from "../src/core/store/database.js";
import { queryEvents } from "../src/core/store/event-log.js";
import { mergeEvent } from "../src/core/sync/g-set.js";

function makeEvent(overrides = {}) {
	return {
		id: "id-" + Math.random().toString(36).slice(2),
		pubkey: "pk1",
		created_at: 1000,
		kind: 1059,
		tags: [],
		content: "",
		sig: "sig",
		...overrides,
	};
}

function shuffled(arr) {
	const a = arr.slice();
	for (let i = a.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[a[i], a[j]] = [a[j], a[i]];
	}
	return a;
}

before(async () => {
	await db.open();
});

beforeEach(async () => {
	await db.table("events").clear();
});

after(() => {
	db.close();
});

test("G1: mergeEvent(e) дважды подряд — одна строка в events, added=false второй раз", async () => {
	const ev = makeEvent({ id: "dup" });
	const r1 = await mergeEvent(ev);
	const r2 = await mergeEvent(ev);
	assert.deepEqual(r1, { added: true });
	assert.deepEqual(r2, { added: false });
	const stored = await queryEvents({ ids: ["dup"] });
	assert.equal(stored.length, 1);
});

test("G1: mergeEvent нового события — added=true", async () => {
	const r = await mergeEvent(makeEvent({ id: "fresh" }));
	assert.deepEqual(r, { added: true });
});

test("G1 (race, адверсарная находка): конкурентные mergeEvent(того же события) — только одна вставка", async () => {
	const ev = makeEvent({ id: "race" });
	const results = await Promise.all([mergeEvent(ev), mergeEvent(ev), mergeEvent(ev)]);
	const addedCount = results.filter((r) => r.added).length;
	assert.equal(addedCount, 1, "ровно один вызов должен получить added:true");
	const stored = await queryEvents({ ids: ["race"] });
	assert.equal(stored.length, 1, "в events должна остаться ровно одна строка");
});

test("G2 (property-based): порядок и повторы вызовов mergeEvent не влияют на финальное множество id", async () => {
	const N = 12;
	const events = Array.from({ length: N }, (_, i) => makeEvent({ id: `ev-${i}` }));
	const expectedIds = new Set(events.map((e) => e.id));

	for (let trial = 0; trial < 15; trial++) {
		await db.table("events").clear();

		// случайная последовательность: перемешанные события + случайные повторы
		let sequence = shuffled(events);
		const repeats = Math.floor(Math.random() * N);
		for (let i = 0; i < repeats; i++) {
			const dup = events[Math.floor(Math.random() * N)];
			const pos = Math.floor(Math.random() * sequence.length);
			sequence = [...sequence.slice(0, pos), dup, ...sequence.slice(pos)];
		}

		for (const ev of sequence) {
			await mergeEvent(ev);
		}

		const stored = await queryEvents({});
		const storedIds = new Set(stored.map((e) => e.id));
		assert.equal(storedIds.size, expectedIds.size, `trial ${trial}: размер множества`);
		for (const id of expectedIds) {
			assert.ok(storedIds.has(id), `trial ${trial}: отсутствует ${id}`);
		}
	}
});
