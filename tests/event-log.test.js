import "fake-indexeddb/auto";
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { db } from "../src/core/store/database.js";
import {
	appendEvent,
	queryEvents,
	getEventById,
	hasEvent,
} from "../src/core/store/event-log.js";

function makeEvent(overrides = {}) {
	return {
		id: "id-" + Math.random().toString(36).slice(2),
		pubkey: "pk1",
		created_at: 1000,
		kind: 1,
		tags: [],
		content: "",
		sig: "sig",
		...overrides,
	};
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

test("appendEvent возвращает числовой seq, растущий с каждой вставкой", async () => {
	const seq1 = await appendEvent(makeEvent());
	const seq2 = await appendEvent(makeEvent());
	assert.equal(typeof seq1, "number");
	assert.ok(seq2 > seq1);
});

test("appendEvent считает flatTags: теги короче 2 элементов пропускаются", async () => {
	const ev = makeEvent({
		id: "ev-tags",
		tags: [
			["p", "abc"],
			["channel", "topic1", "extra-ignored"],
			["nonce"], // длины 1 — пропускается
		],
	});
	await appendEvent(ev);
	const stored = await getEventById("ev-tags");
	assert.deepEqual(stored.flatTags.sort(), ["channel:topic1", "p:abc"]);
});

test("hasEvent / getEventById: true и запись после вставки, false/undefined для чужого id", async () => {
	await appendEvent(makeEvent({ id: "known-id" }));
	assert.equal(await hasEvent("known-id"), true);
	assert.equal(await hasEvent("unknown-id"), false);
	assert.equal((await getEventById("known-id")).id, "known-id");
	assert.equal(await getEventById("unknown-id"), undefined);
});

test("appendEvent не дедуплицирует по id (не его контракт)", async () => {
	await appendEvent(makeEvent({ id: "dup-id" }));
	await appendEvent(makeEvent({ id: "dup-id" }));
	const all = await queryEvents({ ids: ["dup-id"] });
	assert.equal(all.length, 2);
});

test("queryEvents({}) возвращает все события", async () => {
	await appendEvent(makeEvent());
	await appendEvent(makeEvent());
	await appendEvent(makeEvent());
	const all = await queryEvents({});
	assert.equal(all.length, 3);
});

test("queryEvents по ids (OR)", async () => {
	await appendEvent(makeEvent({ id: "a" }));
	await appendEvent(makeEvent({ id: "b" }));
	await appendEvent(makeEvent({ id: "c" }));
	const res = await queryEvents({ ids: ["a", "c"] });
	assert.deepEqual(res.map((e) => e.id).sort(), ["a", "c"]);
});

test("queryEvents по authors и kinds (AND между полями, OR внутри поля)", async () => {
	await appendEvent(makeEvent({ id: "1", pubkey: "alice", kind: 1 }));
	await appendEvent(makeEvent({ id: "2", pubkey: "alice", kind: 2 }));
	await appendEvent(makeEvent({ id: "3", pubkey: "bob", kind: 1 }));
	const res = await queryEvents({ authors: ["alice", "bob"], kinds: [1] });
	assert.deepEqual(res.map((e) => e.id).sort(), ["1", "3"]);
});

test("queryEvents по since/until (диапазон created_at, включительно)", async () => {
	await appendEvent(makeEvent({ id: "old", created_at: 100 }));
	await appendEvent(makeEvent({ id: "mid", created_at: 200 }));
	await appendEvent(makeEvent({ id: "new", created_at: 300 }));
	const res = await queryEvents({ since: 150, until: 250 });
	assert.deepEqual(res.map((e) => e.id), ["mid"]);
	const inclusive = await queryEvents({ since: 100, until: 300 });
	assert.equal(inclusive.length, 3);
});

test("queryEvents по тегам (#p, #channel) — OR внутри тега, AND между тегами", async () => {
	await appendEvent(
		makeEvent({ id: "t1", tags: [["p", "alice"], ["channel", "topicA"]] }),
	);
	await appendEvent(
		makeEvent({ id: "t2", tags: [["p", "bob"], ["channel", "topicA"]] }),
	);
	await appendEvent(makeEvent({ id: "t3", tags: [["p", "alice"]] }));

	const byP = await queryEvents({ "#p": ["alice", "bob"] });
	assert.deepEqual(byP.map((e) => e.id).sort(), ["t1", "t2", "t3"]);

	const byPAndChannel = await queryEvents({
		"#p": ["alice", "bob"],
		"#channel": ["topicA"],
	});
	assert.deepEqual(byPAndChannel.map((e) => e.id).sort(), ["t1", "t2"]);
});

test("queryEvents: limit обрезает до первых N после сортировки по возрастанию created_at", async () => {
	await appendEvent(makeEvent({ id: "e3", created_at: 300 }));
	await appendEvent(makeEvent({ id: "e1", created_at: 100 }));
	await appendEvent(makeEvent({ id: "e2", created_at: 200 }));
	const res = await queryEvents({ limit: 2 });
	assert.deepEqual(res.map((e) => e.id), ["e1", "e2"]);
});

test("queryEvents: результат всегда отсортирован по возрастанию created_at", async () => {
	await appendEvent(makeEvent({ id: "z", created_at: 300 }));
	await appendEvent(makeEvent({ id: "y", created_at: 100 }));
	await appendEvent(makeEvent({ id: "x", created_at: 200 }));
	const res = await queryEvents({});
	assert.deepEqual(res.map((e) => e.created_at), [100, 200, 300]);
});

test("queryEvents: since/until/limit равные 0 — не falsy-игнорируются (адверсарная находка)", async () => {
	await appendEvent(makeEvent({ id: "zero", created_at: 0 }));
	await appendEvent(makeEvent({ id: "later", created_at: 500 }));
	assert.deepEqual((await queryEvents({ until: 0 })).map((e) => e.id), ["zero"]);
	assert.deepEqual((await queryEvents({ since: 0 })).map((e) => e.id).sort(), ["later", "zero"]);
	assert.deepEqual(await queryEvents({ limit: 0 }), []);
});
