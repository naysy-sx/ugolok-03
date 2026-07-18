import { test } from "node:test";
import assert from "node:assert/strict";
import { verify } from "../src/core/crypto/sign.js";
import { createRelayConnection } from "../src/core/transport/relay-pool.js";
import { buildAuthEvent, createAuthHandler } from "../src/core/transport/relay-auth.js";

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

function freshWS() {
	FakeWebSocket.instances = [];
	return FakeWebSocket;
}

const PRIV_KEY = new Uint8Array(32).fill(7);
const RELAY_URL = "ws://127.0.0.1:7777";

function setupConnected() {
	const WS = freshWS();
	const conn = createRelayConnection(RELAY_URL, { WebSocketImpl: WS });
	conn.connect();
	WS.instances[0]._open();
	return { conn, ws: WS.instances[0] };
}

test("buildAuthEvent: kind 22242, теги relay/challenge, валидная подпись", () => {
	const event = buildAuthEvent("test-challenge-abc", RELAY_URL, PRIV_KEY);
	assert.equal(event.kind, 22242);
	assert.equal(event.content, "");
	assert.deepEqual(event.tags.find((t) => t[0] === "challenge"), ["challenge", "test-challenge-abc"]);
	assert.deepEqual(event.tags.find((t) => t[0] === "relay"), ["relay", RELAY_URL]);
	assert.equal(verify(event), true);
});

test("['AUTH', challenge] -> connection переходит в authenticating и отправляет подписанный AUTH-ответ", () => {
	const { conn, ws } = setupConnected();
	const handleMessage = createAuthHandler(conn, RELAY_URL, PRIV_KEY);

	const handled = handleMessage(["AUTH", "chal-1"]);
	assert.equal(handled, true);
	assert.equal(conn.getState(), "authenticating");
	assert.equal(ws.sent.length, 1);
	assert.equal(ws.sent[0][0], "AUTH");
	assert.equal(verify(ws.sent[0][1]), true);
});

test("['OK', <id auth-события>, true, ...] -> AUTH_OK, обратно в connected", () => {
	const { conn, ws } = setupConnected();
	const handleMessage = createAuthHandler(conn, RELAY_URL, PRIV_KEY);
	handleMessage(["AUTH", "chal-2"]);
	const authEventId = ws.sent[0][1].id;

	const handled = handleMessage(["OK", authEventId, true, "successfully authenticated"]);
	assert.equal(handled, true);
	assert.equal(conn.getState(), "connected");
});

test("['OK', <id auth-события>, false, ...] -> AUTH_FAIL, тоже обратно в connected (не disconnected)", () => {
	const { conn, ws } = setupConnected();
	const handleMessage = createAuthHandler(conn, RELAY_URL, PRIV_KEY);
	handleMessage(["AUTH", "chal-3"]);
	const authEventId = ws.sent[0][1].id;

	handleMessage(["OK", authEventId, false, "blocked: bad challenge"]);
	assert.equal(conn.getState(), "connected");
});

test("сообщения, не относящиеся к AUTH, не перехватываются (false) и не трогают состояние", () => {
	const { conn } = setupConnected();
	const handleMessage = createAuthHandler(conn, RELAY_URL, PRIV_KEY);

	assert.equal(handleMessage(["EVENT", "sub1", { kind: 1 }]), false);
	assert.equal(handleMessage(["EOSE", "sub1"]), false);
	assert.equal(conn.getState(), "connected");
});

test("['OK', <чужой id>, ...] — не относится к ожидаемому AUTH-событию, не перехватывается", () => {
	const { conn } = setupConnected();
	const handleMessage = createAuthHandler(conn, RELAY_URL, PRIV_KEY);
	handleMessage(["AUTH", "chal-4"]);

	const handled = handleMessage(["OK", "0000000000000000000000000000000000000000000000000000000000000000", true, ""]);
	assert.equal(handled, false, "OK с несовпадающим id — не про AUTH, должен пройти дальше по цепочке обработчиков");
	assert.equal(conn.getState(), "authenticating", "состояние не должно измениться от чужого OK");
});

test("таймаут ожидания ответа -> AUTH_TIMEOUT, обратно в connected", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const { conn } = setupConnected();
	const handleMessage = createAuthHandler(conn, RELAY_URL, PRIV_KEY, { timeoutMs: 5000 });
	handleMessage(["AUTH", "chal-5"]);
	assert.equal(conn.getState(), "authenticating");

	t.mock.timers.tick(5000);
	assert.equal(conn.getState(), "connected");
	t.mock.timers.reset();
});

test("своевременный AUTH_OK гасит таймер — не срабатывает лишний report после успеха", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const { conn, ws } = setupConnected();
	const handleMessage = createAuthHandler(conn, RELAY_URL, PRIV_KEY, { timeoutMs: 5000 });
	handleMessage(["AUTH", "chal-6"]);
	const authEventId = ws.sent[0][1].id;
	handleMessage(["OK", authEventId, true, ""]);
	assert.equal(conn.getState(), "connected");

	// таймер не должен ничего сломать, даже если тикнет уже после успешного AUTH_OK
	assert.doesNotThrow(() => t.mock.timers.tick(5000));
	assert.equal(conn.getState(), "connected");
	t.mock.timers.reset();
});

test("повторный challenge, пока предыдущий ещё не разрешён — новый AUTH-ответ заменяет ожидание старого (спецификация: challenge валиден до следующего challenge)", () => {
	const { conn, ws } = setupConnected();
	const handleMessage = createAuthHandler(conn, RELAY_URL, PRIV_KEY);
	handleMessage(["AUTH", "chal-old"]);
	const oldId = ws.sent[0][1].id;
	handleMessage(["AUTH", "chal-new"]);
	assert.equal(ws.sent.length, 2);
	const newId = ws.sent[1][1].id;
	assert.notEqual(oldId, newId);

	// OK по старому id больше не должен приниматься как актуальный ответ
	const handledOld = handleMessage(["OK", oldId, true, ""]);
	assert.equal(handledOld, false);
	assert.equal(conn.getState(), "authenticating", "всё ещё ждём ответа на НОВЫЙ challenge");

	const handledNew = handleMessage(["OK", newId, true, ""]);
	assert.equal(handledNew, true);
	assert.equal(conn.getState(), "connected");
});
