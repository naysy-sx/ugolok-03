import "fake-indexeddb/auto";
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { db } from "../src/core/store/database.js";
import { createRelayConnection } from "../src/core/transport/relay-pool.js";
import { runBootstrap, getSyncState, setSyncState } from "../src/core/sync/bootstrap.js";

class FakeWebSocket {
	static instances = [];
	constructor(url) {
		this.url = url;
		this.readyState = 0;
		this.sent = [];
		FakeWebSocket.instances.push(this);
	}
	send(data) {
		this.sent.push(JSON.parse(data));
	}
	close() {
		this.readyState = 3;
		this.onclose?.({});
	}
	_open() {
		this.readyState = 1;
		this.onopen?.({});
	}
	_emit(msg) {
		this.onmessage?.({ data: JSON.stringify(msg) });
	}
}

function setupConnected() {
	FakeWebSocket.instances = [];
	const conn = createRelayConnection("ws://test-relay", { WebSocketImpl: FakeWebSocket });
	conn.connect();
	FakeWebSocket.instances[0]._open();
	return { conn, ws: FakeWebSocket.instances[0] };
}

function ev(id, overrides = {}) {
	return { id, kind: 0, created_at: 1, tags: [], content: "", pubkey: "pk", sig: "sig", ...overrides };
}

function acceptAllVerify(events) {
	return events.map(() => true);
}

const PUBKEY = "a".repeat(64);

before(async () => {
	await db.open();
});

beforeEach(async () => {
	await db.table("events").clear();
	await db.table("messages").clear();
	await db.table("clock").clear();
	await db.table("syncState").clear();
});

after(() => {
	db.close();
});

test("runBootstrap: отправляет ОДИН REQ с двумя фильтрами из TECH.md §12.2 шаг 2", async () => {
	const { conn, ws } = setupConnected();
	const promise = runBootstrap(conn, PUBKEY, { verifyBatch: acceptAllVerify, subId: "boot" });
	assert.deepEqual(ws.sent[0], ["REQ", "boot", { authors: [PUBKEY] }, { "#p": [PUBKEY], kinds: [30053] }]);
	ws._emit(["EOSE", "boot"]);
	await promise;
});

test("runBootstrap: события реально попадают в events (mergeEvents), резолвится после EOSE с addedCount", async () => {
	const { conn, ws } = setupConnected();
	const promise = runBootstrap(conn, PUBKEY, { verifyBatch: acceptAllVerify, subId: "boot" });
	ws._emit(["EVENT", "boot", ev("e1")]);
	ws._emit(["EVENT", "boot", ev("e2")]);
	ws._emit(["EOSE", "boot"]);

	const result = await promise;
	assert.equal(result.addedCount, 2);
	const stored = await db.table("events").toArray();
	assert.deepEqual(new Set(stored.map((e) => e.id)), new Set(["e1", "e2"]));
});

test("runBootstrap: невалидные (verifyBatch=false) события не попадают в addedCount и не пишутся в events", async () => {
	const { conn, ws } = setupConnected();
	const promise = runBootstrap(conn, PUBKEY, {
		verifyBatch: (events) => events.map((e) => e.id !== "bad"),
		subId: "boot",
	});
	ws._emit(["EVENT", "boot", ev("bad")]);
	ws._emit(["EVENT", "boot", ev("good")]);
	ws._emit(["EOSE", "boot"]);

	const result = await promise;
	assert.equal(result.addedCount, 1);
	const stored = await db.table("events").toArray();
	assert.deepEqual(stored.map((e) => e.id), ["good"]);
});

test("runBootstrap: дубликат (уже в events) не увеличивает addedCount повторно", async () => {
	const { conn, ws } = setupConnected();
	const promise = runBootstrap(conn, PUBKEY, { verifyBatch: acceptAllVerify, subId: "boot" });
	ws._emit(["EVENT", "boot", ev("dup")]);
	ws._emit(["EVENT", "boot", ev("dup")]);
	ws._emit(["EOSE", "boot"]);

	const result = await promise;
	assert.equal(result.addedCount, 1);
});

test("runBootstrap: после EOSE lamportValue вычислен и персистирован в clock", async () => {
	await db.table("messages").add({ chatId: "c1", lamportTs: 7, senderPubkey: "pk", id: "m1", status: "sent", deleted: false });
	const { conn, ws } = setupConnected();
	const promise = runBootstrap(conn, PUBKEY, { verifyBatch: acceptAllVerify, subId: "boot" });
	ws._emit(["EOSE", "boot"]);

	const result = await promise;
	assert.equal(result.lamportValue, 8);
	const row = await db.table("clock").get("lamport");
	assert.equal(row.value, 8);
});

test("runBootstrap: записывает syncState.lastSeen для URL соединения", async () => {
	const { conn, ws } = setupConnected();
	const before = Math.floor(Date.now() / 1000);
	const promise = runBootstrap(conn, PUBKEY, { verifyBatch: acceptAllVerify, subId: "boot" });
	ws._emit(["EOSE", "boot"]);
	await promise;

	const lastSeen = await getSyncState("ws://test-relay");
	assert.ok(lastSeen >= before);
});

test("getSyncState/setSyncState: базовый round-trip", async () => {
	assert.equal(await getSyncState("ws://unknown"), undefined);
	await setSyncState("ws://r1", 12345);
	assert.equal(await getSyncState("ws://r1"), 12345);
});
