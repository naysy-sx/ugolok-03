import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakeRelay } from "./fake-relay.js";
import { createWsBridge } from "./ws-bridge.js";

function ev(id, overrides = {}) {
	return { id, kind: 1, created_at: 1, tags: [], content: "", pubkey: "pk", sig: "sig", ...overrides };
}

async function setup() {
	let bridge;
	const relay = createFakeRelay({ onDeliver: (connId, msg) => bridge.deliver(connId, msg) });
	bridge = createWsBridge(relay, { port: 0 });
	const { port } = await bridge.start();
	return { relay, bridge, port };
}

function connect(port) {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(`ws://127.0.0.1:${port}`);
		const received = [];
		ws.onmessage = (evt) => received.push(JSON.parse(evt.data));
		ws.onopen = () => resolve({ ws, received });
		ws.onerror = reject;
	});
}

function waitFor(fn, timeoutMs = 2000) {
	return new Promise((resolve, reject) => {
		const start = Date.now();
		const tick = () => {
			if (fn()) return resolve();
			if (Date.now() - start > timeoutMs) return reject(new Error("waitFor: таймаут"));
			setTimeout(tick, 10);
		};
		tick();
	});
}

test("REQ по реальному сокету доходит до relay.subscribe, EOSE приходит обратно клиенту после flush", async (t) => {
	const { relay, bridge, port } = await setup();
	t.after(() => bridge.stop());
	const { ws, received } = await connect(port);

	ws.send(JSON.stringify(["REQ", "sub1", { kinds: [1] }]));
	await waitFor(() => relay.pending().length > 0);
	relay.flushAll();
	await waitFor(() => received.some((m) => m[0] === "EOSE"));

	assert.deepEqual(
		received.map((m) => m[0]),
		["EOSE"],
	);
	ws.close();
});

test("EVENT по реальному сокету доходит до relay.publish, OK приходит обратно клиенту после flush", async (t) => {
	const { relay, bridge, port } = await setup();
	t.after(() => bridge.stop());
	const { ws, received } = await connect(port);

	ws.send(JSON.stringify(["EVENT", ev("a")]));
	await waitFor(() => relay.pending().length > 0);
	relay.flushAll();
	await waitFor(() => received.some((m) => m[0] === "OK"));

	assert.deepEqual(received[0], ["OK", "a", true, ""]);
	ws.close();
});

test("живая подписка: publish от одного клиента доставляется другому после flush (реальные два сокета)", async (t) => {
	const { relay, bridge, port } = await setup();
	t.after(() => bridge.stop());
	const reader = await connect(port);
	const writer = await connect(port);

	reader.ws.send(JSON.stringify(["REQ", "sub1", { kinds: [1] }]));
	await waitFor(() => relay.pending().length > 0);
	relay.flushAll();
	await waitFor(() => reader.received.some((m) => m[0] === "EOSE"));
	reader.received.length = 0;

	writer.ws.send(JSON.stringify(["EVENT", ev("a", { kind: 1 })]));
	await waitFor(() => relay.pending().length > 0);
	relay.flushAll();
	await waitFor(() => reader.received.some((m) => m[0] === "EVENT"));

	assert.deepEqual(reader.received[0], ["EVENT", "sub1", ev("a", { kind: 1 })]);
	reader.ws.close();
	writer.ws.close();
});

test("CLOSE по реальному сокету доходит до relay.unsubscribe — дальнейший publish не порождает доставку", async (t) => {
	const { relay, bridge, port } = await setup();
	t.after(() => bridge.stop());
	const { ws } = await connect(port);

	ws.send(JSON.stringify(["REQ", "sub1", { kinds: [1] }]));
	await waitFor(() => relay.pending().length > 0);
	relay.flushAll();

	ws.send(JSON.stringify(["CLOSE", "sub1"]));
	// CLOSE идёт по реальной сети — нельзя проверять эффект синхронно, нужно
	// дождаться, пока сервер ФАКТИЧЕСКИ обработает сообщение (нет прямого
	// сигнала от unsubscribe(), поэтому опрашиваем — публикуем пробное
	// событие только ПОСЛЕ паузы, дав event loop'у время на round-trip).
	await new Promise((r) => setTimeout(r, 100));
	relay.publish("probe", ev("a", { kind: 1 }));
	const eventDeliveries = relay.pending().filter((p) => p.msg[0] === "EVENT");
	assert.deepEqual(eventDeliveries, []);
	ws.close();
});

test("разрыв соединения клиентом → relay.disconnect для его connId (будущий publish не порождает для него EVENT)", async (t) => {
	const { relay, bridge, port } = await setup();
	t.after(() => bridge.stop());
	const { ws } = await connect(port);

	ws.send(JSON.stringify(["REQ", "sub1", { kinds: [1] }]));
	await waitFor(() => relay.pending().length > 0);
	relay.flushAll();

	ws.close();
	await waitFor(() => true, 100).catch(() => {}); // дать серверу время обработать close
	await new Promise((r) => setTimeout(r, 100));

	relay.publish("probe", ev("a", { kind: 1 }));
	const eventDeliveries = relay.pending().filter((p) => p.msg[0] === "EVENT");
	assert.deepEqual(eventDeliveries, []);
});

test("deliver(): доставка в уже закрытый/несуществующий сокет — тихий no-op, не бросает", async (t) => {
	const { relay, bridge } = await setup();
	t.after(() => bridge.stop());
	assert.doesNotThrow(() => bridge.deliver("no-such-conn", ["EOSE", "sub1"]));
});

test("start(): резолвится с реальным занятым портом при port:0", async (t) => {
	let bridge;
	const relay = createFakeRelay({ onDeliver: (connId, msg) => bridge.deliver(connId, msg) });
	bridge = createWsBridge(relay, { port: 0 });
	const { port } = await bridge.start();
	t.after(() => bridge.stop());
	assert.ok(Number.isInteger(port) && port > 0);
});
