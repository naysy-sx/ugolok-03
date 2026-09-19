import { test } from "node:test";
import assert from "node:assert/strict";
import { computeBackoffDelay, createRelayConnection, createRelayPool, publishToRelay, fetchFromRelay } from "../src/core/transport/relay-pool.js";

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

test("битый кадр в onmessage не роняет обработчик соединения", () => {
	const WS = freshWS();
	const messages = [];
	const conn = createRelayConnection("ws://test", { WebSocketImpl: WS, onMessage: (msg) => messages.push(msg) });
	conn.connect();
	WS.instances[0]._open();
	assert.doesNotThrow(() => WS.instances[0].onmessage({ data: "not-json{" }));
	assert.equal(conn.getState(), "connected");
	WS.instances[0].onmessage({ data: JSON.stringify(["EOSE", "sub1"]) });
	assert.deepEqual(messages, [["EOSE", "sub1"]]);
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

// Этап 2 (MESSAGE-DELIVERY-TZ.md, З2.5, приёмка) — раньше AUTH_FAIL переводил
// в "connected" БЕЗ повтора активных подписок: REQ, закрытый relay'ем как
// auth-required ДО AUTH, так и оставался закрытым навсегда (реле не видело
// его снова, пока клиент сам не переподключится) — ensureChatEstablished/
// fetchProfiles и т.п. висели бы до собственного таймаута (oneShotRequest),
// не получив ни одного EVENT.
test("reportAuthFail(): активные REQ реплеятся немедленно (тот же приём, что reportAuthOk)", () => {
	const WS = freshWS();
	const conn = createRelayConnection("ws://test", { WebSocketImpl: WS });
	conn.connect();
	WS.instances[0]._open();
	conn.send(["REQ", "sub1", { kinds: [1] }]);
	const sentBeforeAuth = WS.instances[0].sent.length;

	conn.reportAuthChallenge();
	conn.reportAuthFail();

	assert.equal(conn.getState(), "connected");
	assert.equal(WS.instances[0].sent.length, sentBeforeAuth + 1, "REQ должен уйти повторно СРАЗУ после AUTH_FAIL");
	const replayed = JSON.parse(WS.instances[0].sent[sentBeforeAuth]);
	assert.deepEqual(replayed, ["REQ", "sub1", { kinds: [1] }]);
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

// --- TZ-recovery-policy.md §5 — сброс счётчика реконнекта ТОЛЬКО после
// RECONNECT_STABLE_MS стабильной работы (найдено живьём, 10-LIVE-INCIDENT
// §11.5: 11 циклов connect/disconnect за 14с — экспонента не росла, потому
// что onopen сбрасывал счётчик даже для соединений, прожинувших доли секунды). ---

test("мелькание (connect/disconnect короче RECONNECT_STABLE_MS) — задержка переподключения РАСТЁТ, не сбрасывается", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const WS = freshWS();
	const conn = createRelayConnection("ws://test", { WebSocketImpl: WS, backoff: { baseMs: 1000, maxMs: 30000, multiplier: 2, jitter: 0 } });

	conn.connect();
	WS.instances[0]._open(); // "открылось", но стабильным не пробыло
	WS.instances[0]._remoteClose(); // мелькнуло сразу же — RECONNECT_STABLE_MS не прошло
	t.mock.timers.tick(1000); // первая попытка реконнекта, задержка baseMs=1000
	assert.equal(WS.instances.length, 2);

	WS.instances[1]._open();
	WS.instances[1]._remoteClose(); // снова мелькнуло, снова короче RECONNECT_STABLE_MS
	t.mock.timers.tick(1999); // ещё не 2000 (baseMs*multiplier^1) — попытки не должно быть
	assert.equal(WS.instances.length, 2, "задержка выросла (не сброс к baseMs), 1999мс ещё недостаточно");
	t.mock.timers.tick(1);
	assert.equal(WS.instances.length, 3, "а вот на 2000мс — да, экспонента реально сработала");
	t.mock.timers.reset();
});

test("после RECONNECT_STABLE_MS стабильной работы задержка реконнекта СБРАСЫВАЕТСЯ к baseMs", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const WS = freshWS();
	const conn = createRelayConnection("ws://test", { WebSocketImpl: WS, backoff: { baseMs: 1000, maxMs: 30000, multiplier: 2, jitter: 0 } });

	conn.connect();
	WS.instances[0]._open();
	WS.instances[0]._remoteClose(); // попытка 1, задержка вырастет до 2000 на следующей
	t.mock.timers.tick(1000);
	assert.equal(WS.instances.length, 2);

	WS.instances[1]._open();
	t.mock.timers.tick(5000); // дожили до RECONNECT_STABLE_MS=5000 — стабильно
	WS.instances[1]._remoteClose();
	t.mock.timers.tick(999);
	assert.equal(WS.instances.length, 2, "999мс ещё рано, если бы счётчик НЕ сбросился — потребовалось бы 2000мс");
	t.mock.timers.tick(1);
	assert.equal(WS.instances.length, 3, "1000мс (baseMs) хватило — счётчик реально сброшен стабильностью");
	t.mock.timers.reset();
});

// --- TZ-recovery-policy.md §5 — возобновление подписки от метки времени
// последнего полученного события, не с начала. ---

test("после реконнекта REQ реплеится с since = created_at последнего виденного EVENT (включительно, чтобы не потерять пачку той же секунды)", () => {
	const WS = freshWS();
	// autoReconnect:false — реконнект вызывается вручную, без реальных
	// таймеров backoff (не предмет этого теста, только резюмирование since).
	const conn = createRelayConnection("ws://test", { WebSocketImpl: WS, autoReconnect: false });
	conn.connect();
	WS.instances[0]._open();
	conn.send(["REQ", "sub1", { kinds: [1] }]);

	WS.instances[0].onmessage({ data: JSON.stringify(["EVENT", "sub1", { id: "e1", created_at: 1000 }]) });
	WS.instances[0].onmessage({ data: JSON.stringify(["EVENT", "sub1", { id: "e2", created_at: 1500 }]) });

	WS.instances[0]._remoteClose();
	conn.connect(); // ручной реконнект (activeReqs пережил close по remote-обрыву, не намеренный close())
	WS.instances[1]._open(); // реплей activeReqs

	const replayed = WS.instances[1].sent.map((s) => JSON.parse(s));
	assert.deepEqual(replayed, [["REQ", "sub1", { kinds: [1], since: 1500 }]]);
});

// Этап 3 (MESSAGE-DELIVERY-TZ.md, З3.5) — водяной знак ОБРАБОТКИ (reportProcessed)
// отдельно от водяного знака "видел" (обновляется на каждый сырой EVENT). Без
// этого разделения kind:445, дошедший до сокета, но не обработанный (буфер
// no-group/decrypt fail, transport.js), поднимал бы since ВЫШЕ себя — после
// реконнекта relay решил бы "уже видел", событие не переехало бы никогда.
test("reportProcessed(): withResumedSince использует МЕНЬШИЙ водяной знак обработки, не 'видел', если он репортился для этого subId", () => {
	const WS = freshWS();
	const conn = createRelayConnection("ws://test", { WebSocketImpl: WS, autoReconnect: false });
	conn.connect();
	WS.instances[0]._open();
	conn.send(["REQ", "sub1", { kinds: [445] }]);

	// Три EVENT "видены" (сокет их доставил), но вызывающий код успешно
	// ОБРАБОТАЛ только первое (e1) — e2/e3 условно ушли в буфер (no-group/decrypt fail).
	WS.instances[0].onmessage({ data: JSON.stringify(["EVENT", "sub1", { id: "e1", created_at: 1000 }]) });
	WS.instances[0].onmessage({ data: JSON.stringify(["EVENT", "sub1", { id: "e2", created_at: 1500 }]) });
	WS.instances[0].onmessage({ data: JSON.stringify(["EVENT", "sub1", { id: "e3", created_at: 2000 }]) });
	conn.reportProcessed("sub1", 1000);

	WS.instances[0]._remoteClose();
	conn.connect();
	WS.instances[1]._open();

	const replayed = WS.instances[1].sent.map((s) => JSON.parse(s));
	assert.deepEqual(
		replayed,
		[["REQ", "sub1", { kinds: [445], since: 1000 }]],
		"since включительно от последнего ОБРАБОТАННОГО — повтор дешевле потери пачки той же секунды",
	);
});

test("reportProcessed(): без единого вызова для subId — поведение не меняется (водяной знак 'видел' как раньше)", () => {
	const WS = freshWS();
	const conn = createRelayConnection("ws://test", { WebSocketImpl: WS, autoReconnect: false });
	conn.connect();
	WS.instances[0]._open();
	conn.send(["REQ", "sub-other", { kinds: [1] }]);
	WS.instances[0].onmessage({ data: JSON.stringify(["EVENT", "sub-other", { id: "e1", created_at: 42 }]) });

	WS.instances[0]._remoteClose();
	conn.connect();
	WS.instances[1]._open();

	const replayed = WS.instances[1].sent.map((s) => JSON.parse(s));
	assert.deepEqual(replayed, [["REQ", "sub-other", { kinds: [1], since: 42 }]]);
});

test("без единого полученного EVENT по subId после обрыва — REQ реплеится с since = (обрыв − 10с)", () => {
	const WS = freshWS();
	const conn = createRelayConnection("ws://test", { WebSocketImpl: WS, autoReconnect: false });
	conn.connect();
	WS.instances[0]._open();
	conn.send(["REQ", "sub1", { kinds: [1] }]);
	const beforeClose = Date.now();
	WS.instances[0]._remoteClose();
	conn.connect();
	WS.instances[1]._open();
	const replayed = WS.instances[1].sent.map((s) => JSON.parse(s));
	assert.equal(replayed.length, 1);
	assert.equal(replayed[0][0], "REQ");
	assert.equal(replayed[0][1], "sub1");
	const since = replayed[0][2].since;
	assert.equal(typeof since, "number");
	assert.ok(since >= Math.floor((beforeClose - 10000) / 1000) - 1);
	assert.ok(since <= Math.floor(Date.now() / 1000));
});

// TZ-diag-trace.md §2.5 — открытие/закрытие(код)/ошибка/каждая попытка
// переподключения и её задержка. onTrace — необязательный, DI (§0.3): без
// него ничего из этого не меняется (см. остальные тесты файла, ни один из
// них его не передаёт и продолжает проходить).
test("onTrace: connect-attempt/open/close(code)/reconnect-scheduled(delay) — все события видны, без изменения поведения самого автомата", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const traced = [];
	const WS = freshWS();
	const conn = createRelayConnection("ws://test", {
		WebSocketImpl: WS,
		backoff: { baseMs: 1000, maxMs: 30000, multiplier: 2, jitter: 0 },
		onTrace: (ev, payload) => traced.push({ ev, payload }),
	});
	conn.connect();
	assert.ok(traced.some((t2) => t2.ev === "connect-attempt"));
	WS.instances[0]._open();
	assert.ok(traced.some((t2) => t2.ev === "open"));
	WS.instances[0].onclose({ code: 1006, reason: "" });
	assert.ok(traced.some((t2) => t2.ev === "close" && t2.payload.code === 1006));
	const scheduled = traced.find((t2) => t2.ev === "reconnect-scheduled");
	assert.ok(scheduled);
	assert.equal(scheduled.payload.delayMs, 1000);
	assert.equal(conn.getState(), "disconnected", "поведение автомата не изменилось");
	t.mock.timers.reset();
});

test("onTrace, который бросает исключение, не долетает до relay-pool.js (соединение продолжает работать)", () => {
	const WS = freshWS();
	const conn = createRelayConnection("ws://test", {
		WebSocketImpl: WS,
		autoReconnect: false,
		onTrace: () => {
			throw new Error("трассировщик сломан");
		},
	});
	assert.doesNotThrow(() => conn.connect());
	assert.doesNotThrow(() => WS.instances[0]._open());
	assert.equal(conn.getState(), "connected");
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

// Этап 60 — publishToRelay: эфемерное one-shot соединение для доставки на
// relay ПОЛУЧАТЕЛЯ (не входящий в собственный пул, этап 58).

test("publishToRelay: connect -> send EVENT -> resolve на OK -> close()", async () => {
	const WS = freshWS();
	const event = { id: "e1", kind: 1 };
	const resultPromise = publishToRelay("wss://recipient-relay.example", event, { WebSocketImpl: WS });

	WS.instances[0]._open();
	assert.deepEqual(JSON.parse(WS.instances[0].sent[0]), ["EVENT", event], "событие должно быть отправлено сразу после connected");

	WS.instances[0].onmessage({ data: JSON.stringify(["OK", "e1", true, ""]) });
	const result = await resultPromise;
	assert.deepEqual(result, { ok: true, reason: "" });
	assert.equal(WS.instances[0].readyState, 3, "соединение должно закрыться сразу после ответа");
});

test("publishToRelay: OK с ok:false резолвится (не reject) с {ok:false,reason}, соединение всё равно закрывается", async () => {
	const WS = freshWS();
	const event = { id: "e2", kind: 1 };
	const resultPromise = publishToRelay("wss://recipient-relay.example", event, { WebSocketImpl: WS });
	WS.instances[0]._open();
	WS.instances[0].onmessage({ data: JSON.stringify(["OK", "e2", false, "blocked: spam"]) });
	const result = await resultPromise;
	assert.deepEqual(result, { ok: false, reason: "blocked: spam" });
	assert.equal(WS.instances[0].readyState, 3);
});

test("publishToRelay: таймаут подключения -> reject, соединение закрыто", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const WS = freshWS();
	const resultPromise = publishToRelay("wss://unreachable.example", { id: "e3" }, { WebSocketImpl: WS, timeoutMs: 5000 });
	t.mock.timers.tick(5000);
	await assert.rejects(() => resultPromise, /таймаут/);
	assert.equal(WS.instances[0].readyState, 3);
	t.mock.timers.reset();
});

test("publishToRelay: не переиспользует createRelayPool — ровно одно соединение на вызов", async () => {
	const WS = freshWS();
	const resultPromise = publishToRelay("wss://x", { id: "e4" }, { WebSocketImpl: WS });
	WS.instances[0]._open();
	assert.equal(WS.instances.length, 1);
	WS.instances[0].onmessage({ data: JSON.stringify(["OK", "e4", true, ""]) });
	await resultPromise;
});

// Этап 61 — fetchFromRelay: эфемерное one-shot REQ+EOSE, симметрично publishToRelay.

test("fetchFromRelay: connect -> REQ -> собирает EVENT до EOSE -> резолвится массивом -> close()", async () => {
	const WS = freshWS();
	const resultPromise = fetchFromRelay("wss://x", [{ kinds: [10002] }], { WebSocketImpl: WS });
	WS.instances[0]._open();
	assert.equal(WS.instances[0].sent.length, 1, "REQ должен быть отправлен сразу после connected");
	const [type, subId] = JSON.parse(WS.instances[0].sent[0]);
	assert.equal(type, "REQ");

	WS.instances[0].onmessage({ data: JSON.stringify(["EVENT", subId, { id: "e1", kind: 10002 }]) });
	WS.instances[0].onmessage({ data: JSON.stringify(["EVENT", subId, { id: "e2", kind: 10002 }]) });
	WS.instances[0].onmessage({ data: JSON.stringify(["EOSE", subId]) });

	const result = await resultPromise;
	assert.deepEqual(
		result.map((e) => e.id),
		["e1", "e2"],
	);
	assert.equal(WS.instances[0].readyState, 3, "соединение должно закрыться сразу после EOSE");
});

test("fetchFromRelay: EOSE без единого EVENT -> резолвится пустым массивом (валидный исход, не ошибка)", async () => {
	const WS = freshWS();
	const resultPromise = fetchFromRelay("wss://x", [{ kinds: [10002] }], { WebSocketImpl: WS });
	WS.instances[0]._open();
	const [, subId] = JSON.parse(WS.instances[0].sent[0]);
	WS.instances[0].onmessage({ data: JSON.stringify(["EOSE", subId]) });
	const result = await resultPromise;
	assert.deepEqual(result, []);
});

test("fetchFromRelay: таймаут подключения -> reject (отличимо от 'нашли 0 событий')", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const WS = freshWS();
	const resultPromise = fetchFromRelay("wss://unreachable.example", [{ kinds: [10002] }], { WebSocketImpl: WS, timeoutMs: 5000 });
	t.mock.timers.tick(5000);
	await assert.rejects(() => resultPromise, /таймаут/);
	assert.equal(WS.instances[0].readyState, 3);
	t.mock.timers.reset();
});

test("fetchFromRelay: игнорирует EVENT/EOSE с чужим subId", async () => {
	const WS = freshWS();
	const resultPromise = fetchFromRelay("wss://x", [{ kinds: [10002] }], { WebSocketImpl: WS });
	WS.instances[0]._open();
	const [, subId] = JSON.parse(WS.instances[0].sent[0]);
	WS.instances[0].onmessage({ data: JSON.stringify(["EVENT", "чужой-subid", { id: "foreign" }]) });
	WS.instances[0].onmessage({ data: JSON.stringify(["EOSE", "чужой-subid"]) });
	WS.instances[0].onmessage({ data: JSON.stringify(["EVENT", subId, { id: "e1" }]) });
	WS.instances[0].onmessage({ data: JSON.stringify(["EOSE", subId]) });
	const result = await resultPromise;
	assert.deepEqual(
		result.map((e) => e.id),
		["e1"],
	);
});
