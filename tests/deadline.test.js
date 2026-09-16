import { test } from "node:test";
import assert from "node:assert/strict";
import { withDeadline, oneShotRequest } from "../src/core/transport/deadline.js";

// Этап 2 (MESSAGE-DELIVERY-TZ.md, З2.1) — общий примитив, используемый и
// publisher.js (косвенно, через собственную реализацию срока), и всеми
// одноразовыми REQ+EOSE функциями transport.js (fetchDeviceKeyPackages и т.п.,
// З2.3). Минимальный fake-connection ниже — не полноценный relay-pool.js/WS,
// только то, что нужно createSubscriber/oneShotRequest: addMessageHandler/
// removeMessageHandler/send, с ручным управлением, какие сообщения "приходят".

function createFakeConnection() {
	const handlers = [];
	const sent = [];
	return {
		sent,
		addMessageHandler(h) {
			handlers.push(h);
		},
		removeMessageHandler(h) {
			const idx = handlers.indexOf(h);
			if (idx !== -1) handlers.splice(idx, 1);
		},
		send(msg) {
			sent.push(msg);
		},
		// тестовый хелпер — не часть реального интерфейса connection
		_deliver(msg) {
			for (const h of handlers) {
				if (h(msg)) break;
			}
		},
		_handlerCount: () => handlers.length,
	};
}

test("withDeadline: промис резолвится ДО срока -> резолвится значением, таймер не срабатывает", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const inner = Promise.resolve("готово");
	const result = await withDeadline(inner, 1000);
	assert.equal(result, "готово");
	t.mock.timers.reset();
});

test("withDeadline: промис не резолвится до срока -> отклоняется DomainError, onTimeout вызывается", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	let onTimeoutCalled = false;
	const never = new Promise(() => {});
	const resultPromise = withDeadline(never, 1000, { onTimeout: () => (onTimeoutCalled = true), key: "errors.timeout" });

	t.mock.timers.tick(1000);
	await assert.rejects(resultPromise, (err) => {
		assert.equal(err.name, "DomainError");
		assert.equal(err.key, "errors.timeout");
		return true;
	});
	assert.equal(onTimeoutCalled, true);
	t.mock.timers.reset();
});

test("withDeadline: исходный reject ДО срока -> проброс оригинальной ошибки, не таймаута", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const inner = Promise.reject(new Error("сбой send()"));
	await assert.rejects(withDeadline(inner, 1000), /сбой send\(\)/);
	t.mock.timers.reset();
});

// Этап 2, приёмка — "REQ без EOSE -> oneShotRequest отклоняется, подписка снята".
test("oneShotRequest: EOSE не приходит -> отклоняется по сроку, обработчик снят (removeMessageHandler), CLOSE отправлен", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const conn = createFakeConnection();

	const resultPromise = oneShotRequest(conn, [{ kinds: [1] }], { timeoutMs: 10000 });
	assert.equal(conn._handlerCount(), 1, "обработчик зарегистрирован на время ожидания");
	assert.deepEqual(conn.sent[0][0], "REQ");

	t.mock.timers.tick(10000);
	await assert.rejects(resultPromise, (err) => {
		assert.equal(err.name, "DomainError");
		return true;
	});

	assert.equal(conn._handlerCount(), 0, "З2.4 — обработчик обязан быть снят после таймаута, не оставаться в цепочке навсегда");
	assert.deepEqual(
		conn.sent[conn.sent.length - 1],
		["CLOSE", conn.sent[0][1]],
		"CLOSE обязан уйти по subId, на который был REQ",
	);
	t.mock.timers.reset();
});

const acceptAll = async (batch) => batch.map(() => true);

test("oneShotRequest: EOSE приходит до срока -> резолвится собранными событиями, обработчик снят", async () => {
	const conn = createFakeConnection();
	const resultPromise = oneShotRequest(conn, [{ kinds: [1] }], { timeoutMs: 10000, verifyBatch: acceptAll });
	const subId = conn.sent[0][1];

	const event = { id: "e1", kind: 1, tags: [], content: "", pubkey: "pk", sig: "sig", created_at: 1 };
	conn._deliver(["EVENT", subId, event]);
	conn._deliver(["EOSE", subId]);

	const events = await resultPromise;
	assert.deepEqual(events, [event]);
	assert.equal(conn._handlerCount(), 0, "обработчик снят сразу после EOSE, не остаётся до конца сессии (было известное ограничение)");
});

test("oneShotRequest: maxEvents -> резолвится досрочно, не дожидаясь EOSE", async () => {
	const conn = createFakeConnection();
	const resultPromise = oneShotRequest(conn, [{ kinds: [1] }], { timeoutMs: 10000, maxEvents: 1, verifyBatch: acceptAll });
	const subId = conn.sent[0][1];

	const event = { id: "e1", kind: 1, tags: [], content: "", pubkey: "pk", sig: "sig", created_at: 1 };
	conn._deliver(["EVENT", subId, event]);

	const events = await resultPromise;
	assert.deepEqual(events, [event]);
});

test("oneShotRequest: send() бросает синхронно (соединение недоступно) -> отклоняется сразу, обработчик снят", async () => {
	const conn = createFakeConnection();
	conn.send = () => {
		throw new Error("недоступен в состоянии disconnected");
	};
	await assert.rejects(oneShotRequest(conn, [{ kinds: [1] }], { timeoutMs: 10000 }), /недоступен/);
	assert.equal(conn._handlerCount(), 0);
});
