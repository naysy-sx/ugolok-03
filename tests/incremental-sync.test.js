import "fake-indexeddb/auto";
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { db } from "../src/core/store/database.js";
import { createRelayConnection } from "../src/core/transport/relay-pool.js";
import { setSyncState } from "../src/core/sync/bootstrap.js";
import { startIncrementalSync } from "../src/core/sync/incremental-sync.js";

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

function setupConnected(url = "ws://test-relay") {
	FakeWebSocket.instances = [];
	const conn = createRelayConnection(url, { WebSocketImpl: FakeWebSocket });
	conn.connect();
	FakeWebSocket.instances[0]._open();
	return { conn, ws: FakeWebSocket.instances[0] };
}

function ev(id, overrides = {}) {
	return { id, kind: 1, created_at: Math.floor(Date.now() / 1000), tags: [], content: "", pubkey: "pk", sig: "sig", ...overrides };
}

function acceptAllVerify(events) {
	return events.map(() => true);
}

const PUBKEY = "b".repeat(64);

before(async () => {
	await db.open();
});

beforeEach(async () => {
	await db.table("events").clear();
	await db.table("syncState").clear();
});

after(() => {
	db.close();
});

test("startIncrementalSync: подписывается с since из уже сохранённого syncState (переиспользует значение bootstrap.js)", async () => {
	await setSyncState("ws://test-relay", 12345);
	const { conn, ws } = setupConnected();
	const controller = await startIncrementalSync(conn, PUBKEY, { verifyBatch: acceptAllVerify });
	assert.deepEqual(ws.sent[0], ["REQ", "incremental-sync", { authors: [PUBKEY], since: 12345 }]);
	controller.stop();
});

test("startIncrementalSync: без сохранённого syncState — since: 0", async () => {
	const { conn, ws } = setupConnected();
	const controller = await startIncrementalSync(conn, PUBKEY, { verifyBatch: acceptAllVerify });
	assert.deepEqual(ws.sent[0], ["REQ", "incremental-sync", { authors: [PUBKEY], since: 0 }]);
	controller.stop();
});

test("onCaughtUp вызывается на EOSE; onEvent вызывается на каждый обработанный батч", async () => {
	const caughtUp = [];
	const onEventCalls = [];
	const { conn, ws } = setupConnected();
	const controller = await startIncrementalSync(conn, PUBKEY, {
		verifyBatch: acceptAllVerify,
		onCaughtUp: () => caughtUp.push(true),
		onEvent: (addedCount) => onEventCalls.push(addedCount),
	});

	ws._emit(["EVENT", "incremental-sync", ev("e1")]);
	ws._emit(["EVENT", "incremental-sync", ev("e2")]);
	ws._emit(["EOSE", "incremental-sync"]);
	await new Promise((r) => setTimeout(r, 10));

	assert.equal(caughtUp.length, 1);
	assert.deepEqual(onEventCalls, [2]);
	controller.stop();
});

test("подписка ОСТАЁТСЯ открытой после EOSE — новые события ПОСЛЕ EOSE тоже обрабатываются (F-CS-10, живой поток)", async () => {
	const onEventCalls = [];
	const { conn, ws } = setupConnected();
	const controller = await startIncrementalSync(conn, PUBKEY, {
		verifyBatch: acceptAllVerify,
		onEvent: (addedCount) => onEventCalls.push(addedCount),
	});

	ws._emit(["EOSE", "incremental-sync"]);
	await new Promise((r) => setTimeout(r, 10));
	ws._emit(["EVENT", "incremental-sync", ev("live-1")]);
	await new Promise((r) => setTimeout(r, 250)); // дождаться флаша по времени (batchWindowMs)

	assert.ok(onEventCalls.length >= 1, "события после EOSE тоже должны доходить до onEvent");
	const stored = await db.table("events").toArray();
	assert.ok(stored.some((e) => e.id === "live-1"));
	controller.stop();
});

test("onClockSkew срабатывает при |now - created_at| > 30с, не срабатывает на свежих событиях (F-RL-06)", async () => {
	const skews = [];
	const { conn, ws } = setupConnected();
	const controller = await startIncrementalSync(conn, PUBKEY, {
		verifyBatch: acceptAllVerify,
		onClockSkew: (skew) => skews.push(skew),
	});

	const staleEvent = ev("stale", { created_at: Math.floor(Date.now() / 1000) - 100 });
	ws._emit(["EVENT", "incremental-sync", staleEvent]);
	ws._emit(["EOSE", "incremental-sync"]);
	await new Promise((r) => setTimeout(r, 10));

	assert.equal(skews.length, 1);
	assert.ok(skews[0] >= 100);
	controller.stop();
});

test("onClockSkew НЕ срабатывает, когда расхождение в пределах 30с", async () => {
	const skews = [];
	const { conn, ws } = setupConnected();
	const controller = await startIncrementalSync(conn, PUBKEY, {
		verifyBatch: acceptAllVerify,
		onClockSkew: (skew) => skews.push(skew),
	});

	ws._emit(["EVENT", "incremental-sync", ev("fresh")]);
	ws._emit(["EOSE", "incremental-sync"]);
	await new Promise((r) => setTimeout(r, 10));

	assert.equal(skews.length, 0);
	controller.stop();
});

test("stop(): отправляет CLOSE, дальнейшие события для этой подписки игнорируются", async () => {
	const onEventCalls = [];
	const { conn, ws } = setupConnected();
	const controller = await startIncrementalSync(conn, PUBKEY, {
		verifyBatch: acceptAllVerify,
		onEvent: (n) => onEventCalls.push(n),
	});
	controller.stop();
	assert.ok(ws.sent.some((m) => m[0] === "CLOSE" && m[1] === "incremental-sync"));

	ws._emit(["EVENT", "incremental-sync", ev("after-stop")]);
	await new Promise((r) => setTimeout(r, 10));
	assert.equal(onEventCalls.length, 0, "после stop() события той же подписки не должны обрабатываться");
});
