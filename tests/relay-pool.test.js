import { test } from "node:test";
import assert from "node:assert/strict";
import { computeBackoffDelay, createRelayConnection, createRelayPool } from "../src/core/transport/relay-pool.js";

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

// Этап 58 — createRelayPool. Формализация (агрегатное состояние — max по
// порядку полезности, дедуп EVENT по (subId,id), EOSE "первый — финальный") —
// DESIGN.md, раздел "Этап 58". Тесты выведены прямо из инвариантов П1-П4.

test("createRelayPool: throw на пустом списке entries", () => {
	assert.throws(() => createRelayPool([]));
});

test("createRelayPool: агрегатное состояние — max по порядку disconnected<connecting<authenticating<connected<subscribed (П1)", () => {
	const WS = freshWS();
	const pool = createRelayPool(
		[
			{ url: "wss://a", read: true, write: true },
			{ url: "wss://b", read: true, write: true },
		],
		{ WebSocketImpl: WS },
	);
	assert.equal(pool.getState(), "disconnected");
	pool.connect();
	assert.equal(pool.getState(), "connecting");
	WS.instances[0]._open(); // только "a" открылось
	assert.equal(pool.getState(), "connected", "хотя бы одно connected -> пул connected, даже если b ещё connecting");
	WS.instances[1]._open();
	assert.equal(pool.getState(), "connected");
});

test("createRelayPool: send(REQ) рассылается только read-соединениям, пропускает read:false", () => {
	const WS = freshWS();
	const pool = createRelayPool(
		[
			{ url: "wss://reader", read: true, write: false },
			{ url: "wss://writer-only", read: false, write: true },
		],
		{ WebSocketImpl: WS },
	);
	pool.connect();
	WS.instances[0]._open();
	WS.instances[1]._open();
	pool.send(["REQ", "sub1", {}]);
	assert.equal(WS.instances[0].sent.length, 1, "read-соединение получило REQ");
	assert.equal(WS.instances[1].sent.length, 0, "write-only соединение НЕ получило REQ");
});

test("createRelayPool: send(EVENT) рассылается только write-соединениям, пропускает write:false", () => {
	const WS = freshWS();
	const pool = createRelayPool(
		[
			{ url: "wss://reader-only", read: true, write: false },
			{ url: "wss://writer", read: true, write: true },
		],
		{ WebSocketImpl: WS },
	);
	pool.connect();
	WS.instances[0]._open();
	WS.instances[1]._open();
	pool.send(["EVENT", { id: "e1" }]);
	assert.equal(WS.instances[0].sent.length, 0, "read-only соединение НЕ получило EVENT");
	assert.equal(WS.instances[1].sent.length, 1, "write-соединение получило EVENT");
});

test("createRelayPool: send() пропускает неготовое соединение, не бросает, если хотя бы одно готово (П2)", () => {
	const WS = freshWS();
	const pool = createRelayPool(
		[
			{ url: "wss://down", read: true, write: true },
			{ url: "wss://up", read: true, write: true },
		],
		{ WebSocketImpl: WS },
	);
	pool.connect();
	WS.instances[1]._open(); // только "up" открылось, "down" остался connecting
	assert.doesNotThrow(() => pool.send(["REQ", "sub1", {}]));
	assert.equal(WS.instances[1].sent.length, 1);
});

test("createRelayPool: send() бросает, если НИ ОДНО соединение подходящей роли не готово (П2)", () => {
	const WS = freshWS();
	const pool = createRelayPool([{ url: "wss://a", read: true, write: true }], { WebSocketImpl: WS });
	assert.throws(() => pool.send(["REQ", "sub1", {}]), /relay-pool/);
});

test("createRelayPool: EVENT-дедупликация по (subId, event.id) — одно и то же событие от двух read-членов доставляется наверх один раз (П3)", () => {
	const WS = freshWS();
	const pool = createRelayPool(
		[
			{ url: "wss://a", read: true, write: true },
			{ url: "wss://b", read: true, write: true },
		],
		{ WebSocketImpl: WS },
	);
	pool.connect();
	WS.instances[0]._open();
	WS.instances[1]._open();

	const received = [];
	pool.addMessageHandler((msg) => {
		received.push(msg);
		return true;
	});

	const event = { id: "same-event", content: "x" };
	WS.instances[0].onmessage({ data: JSON.stringify(["EVENT", "sub1", event]) });
	WS.instances[1].onmessage({ data: JSON.stringify(["EVENT", "sub1", event]) }); // тот же event.id от другого relay

	assert.equal(received.length, 1, "второй экземпляр того же event.id по тому же subId должен быть поглощён пулом");
});

test("createRelayPool: EVENT с одним и тем же id, но РАЗНЫМИ subId, доставляется по каждому subId отдельно (дедуп — не глобальный)", () => {
	const WS = freshWS();
	const pool = createRelayPool([{ url: "wss://a", read: true, write: true }], { WebSocketImpl: WS });
	pool.connect();
	WS.instances[0]._open();
	const received = [];
	pool.addMessageHandler((msg) => {
		received.push(msg);
		return true;
	});
	const event = { id: "e1" };
	WS.instances[0].onmessage({ data: JSON.stringify(["EVENT", "subA", event]) });
	WS.instances[0].onmessage({ data: JSON.stringify(["EVENT", "subB", event]) });
	assert.equal(received.length, 2, "дедуп ключом (subId,id) — разные subId не должны схлопываться");
});

test("createRelayPool: EOSE — первый пришедший форвардится, повторные по тому же subId поглощаются (П4)", () => {
	const WS = freshWS();
	const pool = createRelayPool(
		[
			{ url: "wss://a", read: true, write: true },
			{ url: "wss://b", read: true, write: true },
		],
		{ WebSocketImpl: WS },
	);
	pool.connect();
	WS.instances[0]._open();
	WS.instances[1]._open();

	const eoseCount = [];
	pool.addMessageHandler((msg) => {
		if (msg[0] === "EOSE") eoseCount.push(msg[1]);
		return true;
	});

	WS.instances[0].onmessage({ data: JSON.stringify(["EOSE", "sub1"]) });
	WS.instances[1].onmessage({ data: JSON.stringify(["EOSE", "sub1"]) });
	assert.deepEqual(eoseCount, ["sub1"], "второй EOSE по тому же subId не должен пройти дальше");
});

test("createRelayPool: события от медленного relay после уже проброшенного EOSE всё равно доходят наверх (данные не теряются)", () => {
	const WS = freshWS();
	const pool = createRelayPool(
		[
			{ url: "wss://fast", read: true, write: true },
			{ url: "wss://slow", read: true, write: true },
		],
		{ WebSocketImpl: WS },
	);
	pool.connect();
	WS.instances[0]._open();
	WS.instances[1]._open();

	const events = [];
	pool.addMessageHandler((msg) => {
		if (msg[0] === "EVENT") events.push(msg[2].id);
		return true;
	});

	WS.instances[0].onmessage({ data: JSON.stringify(["EOSE", "sub1"]) }); // быстрый relay уже закончил
	WS.instances[1].onmessage({ data: JSON.stringify(["EVENT", "sub1", { id: "late-1" }]) }); // медленный ещё досылает бэклог
	assert.deepEqual(events, ["late-1"], "событие от ещё не завершившего relay должно дойти, даже после чужого EOSE");
});

test("createRelayPool: connect()/close() применяются ко всем членам", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const WS = freshWS();
	const pool = createRelayPool(
		[
			{ url: "wss://a", read: true, write: true },
			{ url: "wss://b", read: true, write: true },
		],
		{ WebSocketImpl: WS },
	);
	pool.connect();
	assert.equal(WS.instances.length, 2, "connect() должен открыть WS на КАЖДОМ члене");
	WS.instances[0]._open();
	WS.instances[1]._open();
	pool.close();
	assert.equal(pool.getState(), "disconnected");
	t.mock.timers.tick(60000);
	assert.equal(WS.instances.length, 2, "close() — намеренное закрытие, без автопереподключения ни на одном члене");
	t.mock.timers.reset();
});
