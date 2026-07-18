import { test } from "node:test";
import assert from "node:assert/strict";
import { createRelayConnection } from "../src/core/transport/relay-pool.js";
import { createSubscriber } from "../src/core/transport/subscriber.js";

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
}

function setupConnected() {
	FakeWebSocket.instances = [];
	const conn = createRelayConnection("ws://test", { WebSocketImpl: FakeWebSocket });
	conn.connect();
	FakeWebSocket.instances[0]._open();
	return { conn, ws: FakeWebSocket.instances[0] };
}

function ev(id) {
	return { id, kind: 1, created_at: 1, tags: [], content: "", pubkey: "pk", sig: "sig" };
}

function acceptAllVerify(events) {
	return events.map(() => true);
}

test("subscribe(): отправляет REQ с заданным subId и фильтрами", () => {
	const { conn, ws } = setupConnected();
	const sub = createSubscriber(conn, { verifyBatch: acceptAllVerify, onBatch: async () => {} });
	sub.subscribe("sub1", [{ kinds: [1] }]);
	assert.deepEqual(ws.sent[0], ["REQ", "sub1", { kinds: [1] }]);
});

test("unsubscribe(): отправляет CLOSE с subId", () => {
	const { conn, ws } = setupConnected();
	const sub = createSubscriber(conn, { verifyBatch: acceptAllVerify, onBatch: async () => {} });
	sub.subscribe("sub1", [{ kinds: [1] }]);
	sub.unsubscribe("sub1");
	assert.deepEqual(ws.sent[1], ["CLOSE", "sub1"]);
});

test("EOSE форсирует флаш независимо от размера/времени — onBatch вызывается с неполным батчем", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const batches = [];
	const { conn } = setupConnected();
	const sub = createSubscriber(conn, { batchSize: 100, batchWindowMs: 200, verifyBatch: acceptAllVerify, onBatch: async (evs) => batches.push(evs) });
	sub.subscribe("sub1", [{}]);

	sub.handleMessage(["EVENT", "sub1", ev("a")]);
	sub.handleMessage(["EVENT", "sub1", ev("b")]);
	assert.equal(batches.length, 0, "до EOSE/размера/времени — не флашится");

	sub.handleMessage(["EOSE", "sub1"]);
	await Promise.resolve(); // onBatch асинхронный
	assert.equal(batches.length, 1);
	assert.deepEqual(batches[0].map((e) => e.id), ["a", "b"]);
	t.mock.timers.reset();
});

test("флаш по достижении batchSize — немедленно, без ожидания времени/EOSE", async () => {
	const batches = [];
	const { conn } = setupConnected();
	const sub = createSubscriber(conn, { batchSize: 2, batchWindowMs: 200, verifyBatch: acceptAllVerify, onBatch: async (evs) => batches.push(evs) });
	sub.subscribe("sub1", [{}]);

	sub.handleMessage(["EVENT", "sub1", ev("a")]);
	sub.handleMessage(["EVENT", "sub1", ev("b")]);
	await Promise.resolve();
	assert.equal(batches.length, 1);
	assert.equal(batches[0].length, 2);
});

test("флаш по времени (batchWindowMs)", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const batches = [];
	const { conn } = setupConnected();
	const sub = createSubscriber(conn, { batchSize: 100, batchWindowMs: 200, verifyBatch: acceptAllVerify, onBatch: async (evs) => batches.push(evs) });
	sub.subscribe("sub1", [{}]);
	sub.handleMessage(["EVENT", "sub1", ev("a")]);

	t.mock.timers.tick(200);
	await Promise.resolve();
	assert.equal(batches.length, 1);
	t.mock.timers.reset();
});

test("verifyBatch отфильтровывает невалидные — onBatch получает ТОЛЬКО verified===true", async () => {
	const batches = [];
	const { conn } = setupConnected();
	const sub = createSubscriber(conn, {
		batchSize: 2,
		verifyBatch: (events) => events.map((e) => e.id !== "bad"),
		onBatch: async (evs) => batches.push(evs),
	});
	sub.subscribe("sub1", [{}]);
	sub.handleMessage(["EVENT", "sub1", ev("bad")]);
	sub.handleMessage(["EVENT", "sub1", ev("good")]);
	await Promise.resolve();
	assert.deepEqual(batches[0].map((e) => e.id), ["good"]);
});

test("события для неизвестного subId не перехватываются (false), не путаются с другими подписками", () => {
	const { conn } = setupConnected();
	const sub = createSubscriber(conn, { verifyBatch: acceptAllVerify, onBatch: async () => {} });
	sub.subscribe("sub1", [{}]);
	assert.equal(sub.handleMessage(["EVENT", "unknown-sub", ev("x")]), false);
	assert.equal(sub.handleMessage(["OK", "some-id", true, ""]), false);
});

test("две независимые подписки не смешивают свои батчи", async () => {
	const batchesBySub = {};
	const { conn } = setupConnected();
	const sub = createSubscriber(conn, {
		batchSize: 1,
		verifyBatch: acceptAllVerify,
		onBatch: async (evs, subId) => {
			batchesBySub[subId] = (batchesBySub[subId] ?? []).concat(evs);
		},
	});
	sub.subscribe("subA", [{}]);
	sub.subscribe("subB", [{}]);
	sub.handleMessage(["EVENT", "subA", ev("a1")]);
	sub.handleMessage(["EVENT", "subB", ev("b1")]);
	await Promise.resolve();
	assert.deepEqual(batchesBySub.subA.map((e) => e.id), ["a1"]);
	assert.deepEqual(batchesBySub.subB.map((e) => e.id), ["b1"]);
});
