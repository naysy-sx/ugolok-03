import { test } from "node:test";
import assert from "node:assert/strict";
import { createRelayConnection } from "../src/core/transport/relay-pool.js";
import { createPublisher } from "../src/core/transport/publisher.js";

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

function setupConnected(options) {
	FakeWebSocket.instances = [];
	const conn = createRelayConnection("ws://test", { WebSocketImpl: FakeWebSocket, ...options });
	conn.connect();
	FakeWebSocket.instances[0]._open();
	return { conn, ws: FakeWebSocket.instances[0] };
}

function ev(id) {
	return { id, kind: 1, created_at: 1, tags: [], content: "", pubkey: "pk", sig: "sig" };
}

test("publish(): накапливает в очереди, флашит по времени (batchWindowMs), шлёт каждое отдельным EVENT", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const { conn, ws } = setupConnected();
	const pub = createPublisher(conn, { batchWindowMs: 200, batchSize: 100 });

	pub.publish(ev("a"));
	pub.publish(ev("b"));
	assert.equal(ws.sent.length, 0, "до флаша ничего не отправлено");

	t.mock.timers.tick(200);
	assert.equal(ws.sent.length, 2);
	assert.deepEqual(ws.sent.map((m) => m[0]), ["EVENT", "EVENT"]);
	assert.deepEqual(ws.sent.map((m) => m[1].id), ["a", "b"]);
	t.mock.timers.reset();
});

test("publish(): флаш немедленно при достижении batchSize, не дожидаясь таймера", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const { conn, ws } = setupConnected();
	const pub = createPublisher(conn, { batchWindowMs: 200, batchSize: 3 });

	pub.publish(ev("a"));
	pub.publish(ev("b"));
	assert.equal(ws.sent.length, 0);
	pub.publish(ev("c"));
	assert.equal(ws.sent.length, 3, "3-е событие должно триггернуть немедленный флаш по size");
	t.mock.timers.reset();
});

test("flush(): принудительный немедленный сброс очереди", () => {
	const { conn, ws } = setupConnected();
	const pub = createPublisher(conn, { batchWindowMs: 200, batchSize: 100 });
	pub.publish(ev("a"));
	assert.equal(ws.sent.length, 0);
	pub.flush();
	assert.equal(ws.sent.length, 1);
});

test("publish(): promise резолвится по OK от relay через handleMessage", async () => {
	const { conn } = setupConnected();
	const pub = createPublisher(conn, { batchWindowMs: 0, batchSize: 1 });

	const promise = pub.publish(ev("x"));
	pub.handleMessage(["OK", "x", true, ""]);
	const result = await promise;
	assert.deepEqual(result, { ok: true, reason: "" });
});

test("handleMessage: OK с id, не относящимся к очереди publisher'а — не перехватывается (false)", () => {
	const { conn } = setupConnected();
	const pub = createPublisher(conn);
	assert.equal(pub.handleMessage(["OK", "unknown-id", true, ""]), false);
	assert.equal(pub.handleMessage(["EVENT", "sub1", {}]), false);
});
