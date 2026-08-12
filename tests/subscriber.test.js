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

// Этап 74 — flush() теперь проходит через serializedPerSubId (per-subId
// промис-цепочка, см. subscriber.js) — добавляет несколько микротасков между
// вызовом flush() и реальным выполнением onBatch. Один `await Promise.resolve()`
// (как было раньше, до сериализации) уже недостаточен; вместо подбора точного
// числа тиков вручную — гоняем цепочку с запасом. Только микротаски (не
// setTimeout) — совместимо с тестами на mock-таймерах ниже.
async function flushMicrotasks() {
	for (let i = 0; i < 8; i++) await Promise.resolve();
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
	await flushMicrotasks();
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
	await flushMicrotasks();
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
	await flushMicrotasks();
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
	await flushMicrotasks();
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
	await flushMicrotasks();
	assert.deepEqual(batchesBySub.subA.map((e) => e.id), ["a1"]);
	assert.deepEqual(batchesBySub.subB.map((e) => e.id), ["b1"]);
});

test("onEose вызывается ПОСЛЕ flush() текущего батча, не раньше (правка контракта, этап 19)", async () => {
	const events = [];
	let eoseCalledAfterBatch = false;
	const { conn } = setupConnected();
	const sub = createSubscriber(conn, {
		batchSize: 100,
		verifyBatch: acceptAllVerify,
		onBatch: async (evs) => {
			events.push(...evs);
		},
		onEose: (subId) => {
			eoseCalledAfterBatch = events.length === 2 && subId === "sub1";
		},
	});
	sub.subscribe("sub1", [{}]);
	sub.handleMessage(["EVENT", "sub1", ev("a")]);
	sub.handleMessage(["EVENT", "sub1", ev("b")]);
	sub.handleMessage(["EOSE", "sub1"]);
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.equal(eoseCalledAfterBatch, true);
});

// Этап 74 — АДВЕРСАРНЫЙ (живой баг): flush() того же subId раньше не была
// защищена от повторного входа — новое событие, прилетевшее ПОКА onBatch
// предыдущего flush() ещё выполняется, планировало СВОЙ независимый flush(),
// и оба onBatch могли выполняться конкурентно (потребители вроде rebuildGroups
// в transport.js делают "снимок -> пересчёт -> запись" — конкурентная запись
// откатывала состояние). Проверяем строгую сериализацию: onBatch("b") не
// стартует, пока onBatch("a") не завершится, даже если "a" искусственно
// задержан, а "b" прилетает ДО завершения "a".
test("АДВЕРСАРНО: два flush() одного subId НЕ выполняются конкурентно — второй onBatch ждёт завершения первого", async () => {
	const order = [];
	let releaseA;
	const gateA = new Promise((resolve) => {
		releaseA = resolve;
	});
	const { conn } = setupConnected();
	const sub = createSubscriber(conn, {
		batchSize: 1,
		verifyBatch: acceptAllVerify,
		onBatch: async (evs) => {
			const id = evs[0].id;
			order.push(`${id}-start`);
			if (id === "a") await gateA;
			order.push(`${id}-end`);
		},
	});
	sub.subscribe("sub1", [{}]);

	sub.handleMessage(["EVENT", "sub1", ev("a")]); // flush() запускается, onBatch("a") зависает на gateA
	await Promise.resolve();
	await Promise.resolve();
	assert.deepEqual(order, ["a-start"], "onBatch(a) стартовал, но ещё не завершился");

	sub.handleMessage(["EVENT", "sub1", ev("b")]); // второй flush() того же subId, ПОКА первый ещё внутри onBatch
	await Promise.resolve();
	await Promise.resolve();
	assert.deepEqual(order, ["a-start"], "onBatch(b) НЕ должен стартовать, пока onBatch(a) не завершился");

	releaseA();
	await new Promise((resolve) => setTimeout(resolve, 0));
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.deepEqual(order, ["a-start", "a-end", "b-start", "b-end"], "строгий порядок: b начинается только после конца a");
});

test("две независимые подписки НЕ блокируют друг друга через сериализацию flush()", async () => {
	const order = [];
	let releaseA;
	const gateA = new Promise((resolve) => {
		releaseA = resolve;
	});
	const { conn } = setupConnected();
	const sub = createSubscriber(conn, {
		batchSize: 1,
		verifyBatch: acceptAllVerify,
		onBatch: async (evs, subId) => {
			order.push(`${subId}-start`);
			if (subId === "subA") await gateA;
			order.push(`${subId}-end`);
		},
	});
	sub.subscribe("subA", [{}]);
	sub.subscribe("subB", [{}]);

	sub.handleMessage(["EVENT", "subA", ev("a")]); // зависает на gateA
	await Promise.resolve();
	await Promise.resolve();
	sub.handleMessage(["EVENT", "subB", ev("b")]); // другой subId — не должен ждать subA
	await new Promise((resolve) => setTimeout(resolve, 0));
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.deepEqual(order, ["subA-start", "subB-start", "subB-end"], "subB завершается, не дожидаясь subA");

	releaseA();
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.deepEqual(order, ["subA-start", "subB-start", "subB-end", "subA-end"]);
});

test("onEose не обязателен (options без него) — EOSE всё равно флашит батч без ошибки", async () => {
	const batches = [];
	const { conn } = setupConnected();
	const sub = createSubscriber(conn, { verifyBatch: acceptAllVerify, onBatch: async (evs) => batches.push(evs) });
	sub.subscribe("sub1", [{}]);
	sub.handleMessage(["EVENT", "sub1", ev("a")]);
	assert.doesNotThrow(() => sub.handleMessage(["EOSE", "sub1"]));
});
