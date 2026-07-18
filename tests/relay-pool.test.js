import { test } from "node:test";
import assert from "node:assert/strict";
import { computeBackoffDelay, createRelayConnection } from "../src/core/transport/relay-pool.js";

class FakeWebSocket {
	static instances = [];

	constructor(url) {
		this.url = url;
		this.readyState = 0; // CONNECTING
		this.sent = [];
		FakeWebSocket.instances.push(this);
	}

	send(data) {
		this.sent.push(data);
	}

	close() {
		this.readyState = 3;
		this.onclose?.({});
	}

	// тестовые хелперы — симулируют реальные WS-события
	_open() {
		this.readyState = 1;
		this.onopen?.({});
	}

	_remoteClose() {
		this.readyState = 3;
		this.onclose?.({});
	}

	_error() {
		this.onerror?.({});
	}
}

function freshWS() {
	FakeWebSocket.instances = [];
	return FakeWebSocket;
}

test("computeBackoffDelay: растёт экспоненциально и упирается в потолок", () => {
	const config = { baseMs: 1000, maxMs: 30000, multiplier: 2, jitter: 0 };
	assert.equal(computeBackoffDelay(0, config), 1000);
	assert.equal(computeBackoffDelay(1, config), 2000);
	assert.equal(computeBackoffDelay(2, config), 4000);
	assert.equal(computeBackoffDelay(10, config), 30000); // упёрлось в потолок
});

test("computeBackoffDelay: джиттер держится в заявленных границах", () => {
	const config = { baseMs: 1000, maxMs: 30000, multiplier: 2, jitter: 0.2 };
	for (let i = 0; i < 50; i++) {
		const delay = computeBackoffDelay(0, config);
		assert.ok(delay >= 800 && delay <= 1200, `delay ${delay} вне [800,1200]`);
	}
});

test("createRelayConnection: начальное состояние disconnected", () => {
	const conn = createRelayConnection("ws://test", { WebSocketImpl: freshWS() });
	assert.equal(conn.getState(), "disconnected");
});

test("connect() -> connecting -> OPEN -> connected (НЕ authenticating — ключевая правка автомата)", () => {
	const WS = freshWS();
	const conn = createRelayConnection("ws://test", { WebSocketImpl: WS });
	conn.connect();
	assert.equal(conn.getState(), "connecting");
	WS.instances[0]._open();
	assert.equal(conn.getState(), "connected");
});

test("reportAuthChallenge из connected -> authenticating; AUTH_OK возвращает в connected", () => {
	const WS = freshWS();
	const conn = createRelayConnection("ws://test", { WebSocketImpl: WS });
	conn.connect();
	WS.instances[0]._open();
	conn.reportAuthChallenge();
	assert.equal(conn.getState(), "authenticating");
	conn.reportAuthOk();
	assert.equal(conn.getState(), "connected");
});

test("AUTH_FAIL и AUTH_TIMEOUT тоже возвращают в connected, НЕ в disconnected", () => {
	const WS = freshWS();
	const connA = createRelayConnection("ws://a", { WebSocketImpl: WS });
	connA.connect();
	WS.instances[0]._open();
	connA.reportAuthChallenge();
	connA.reportAuthFail();
	assert.equal(connA.getState(), "connected");

	const connB = createRelayConnection("ws://b", { WebSocketImpl: WS });
	connB.connect();
	WS.instances[1]._open();
	connB.reportAuthChallenge();
	connB.reportAuthTimeout();
	assert.equal(connB.getState(), "connected");
});

test("reportSubscribed из connected -> subscribed; AUTH_CHALLENGE реактивно даже из subscribed", () => {
	const WS = freshWS();
	const conn = createRelayConnection("ws://test", { WebSocketImpl: WS });
	conn.connect();
	WS.instances[0]._open();
	conn.reportSubscribed();
	assert.equal(conn.getState(), "subscribed");
	conn.reportAuthChallenge();
	assert.equal(conn.getState(), "authenticating");
});

test("send(): работает в connected/subscribed, бросает в disconnected/connecting", () => {
	const WS = freshWS();
	const conn = createRelayConnection("ws://test", { WebSocketImpl: WS, autoReconnect: false });
	assert.throws(() => conn.send(["REQ", "sub1", {}]));
	conn.connect();
	assert.throws(() => conn.send(["REQ", "sub1", {}])); // ещё connecting
	WS.instances[0]._open();
	conn.send(["REQ", "sub1", {}]);
	assert.deepEqual(JSON.parse(WS.instances[0].sent[0]), ["REQ", "sub1", {}]);
});

test("close(): намеренное закрытие -> disconnected, без автопереподключения", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const WS = freshWS();
	const conn = createRelayConnection("ws://test", { WebSocketImpl: WS });
	conn.connect();
	WS.instances[0]._open();
	conn.close();
	assert.equal(conn.getState(), "disconnected");
	t.mock.timers.tick(60000);
	assert.equal(WS.instances.length, 1, "close() не должен планировать реконнект");
	t.mock.timers.reset();
});

test("неожиданный обрыв (remote close) -> disconnected -> автопереподключение с backoff", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const WS = freshWS();
	const conn = createRelayConnection("ws://test", { WebSocketImpl: WS, backoff: { baseMs: 1000, maxMs: 30000, multiplier: 2, jitter: 0 } });
	conn.connect();
	WS.instances[0]._open();
	WS.instances[0]._remoteClose();
	assert.equal(conn.getState(), "disconnected");
	assert.equal(WS.instances.length, 1, "реконнект не должен произойти немедленно");
	t.mock.timers.tick(1000);
	assert.equal(WS.instances.length, 2, "после backoff-задержки должна появиться новая попытка подключения");
	t.mock.timers.reset();
});

test("ERROR из subscribed -> connected (не полный реконнект — сохранено из TECH.md)", () => {
	const WS = freshWS();
	const conn = createRelayConnection("ws://test", { WebSocketImpl: WS });
	conn.connect();
	WS.instances[0]._open();
	conn.reportSubscribed();
	WS.instances[0]._error();
	assert.equal(conn.getState(), "connected");
});

test("повторный connect() на уже подключённом соединении бросает (F2: недопустимый переход, не тихий no-op)", () => {
	const WS = freshWS();
	const conn = createRelayConnection("ws://test", { WebSocketImpl: WS });
	conn.connect();
	WS.instances[0]._open();
	assert.equal(conn.getState(), "connected");
	assert.throws(() => conn.connect());
});

test("send() также разрешён в authenticating (нужно для отправки AUTH-ответа, этап 17)", () => {
	const WS = freshWS();
	const conn = createRelayConnection("ws://test", { WebSocketImpl: WS });
	conn.connect();
	WS.instances[0]._open();
	conn.reportAuthChallenge();
	assert.equal(conn.getState(), "authenticating");
	assert.doesNotThrow(() => conn.send(["AUTH", { kind: 22242 }]));
});

test("addMessageHandler: композиция нескольких обработчиков, first-match-wins; onMessage — сырой наблюдатель, видит всё независимо", () => {
	const WS = freshWS();
	const observed = [];
	const conn = createRelayConnection("ws://test", {
		WebSocketImpl: WS,
		onMessage: (msg) => observed.push(msg),
	});
	conn.connect();
	WS.instances[0]._open();

	const calls = [];
	conn.addMessageHandler((msg) => {
		calls.push(["first", msg]);
		return msg[0] === "AUTH"; // перехватывает только AUTH
	});
	conn.addMessageHandler((msg) => {
		calls.push(["second", msg]);
		return true;
	});

	WS.instances[0].onmessage({ data: JSON.stringify(["AUTH", "chal"]) });
	assert.deepEqual(
		calls.map((c) => c[0]),
		["first"],
		"первый обработчик вернул true на AUTH — второй не должен вызываться",
	);

	calls.length = 0;
	WS.instances[0].onmessage({ data: JSON.stringify(["EVENT", "sub1", {}]) });
	assert.deepEqual(
		calls.map((c) => c[0]),
		["first", "second"],
		"первый не забрал EVENT (вернул false) — дошло до второго",
	);

	assert.equal(observed.length, 2, "onMessage-наблюдатель видел оба сообщения независимо от перехвата");
});
