import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakeRelay } from "./fake-relay.js";

function ev(id, overrides = {}) {
	return { id, kind: 1, created_at: 1, tags: [], content: "", pubkey: "pk", sig: "sig", ...overrides };
}

function collector() {
	const delivered = [];
	const relay = createFakeRelay({ onDeliver: (connId, msg) => delivered.push({ connId, msg }) });
	return { relay, delivered };
}

test("publish(): ставит в очередь OK публикующему, доставка не происходит без flush", () => {
	const { relay, delivered } = collector();
	relay.publish("conn1", ev("a"));
	assert.equal(delivered.length, 0, "onDeliver не вызывается синхронно из publish");
	assert.equal(relay.pending().length, 1);
	assert.deepEqual(relay.pending()[0], { connId: "conn1", subId: undefined, msg: ["OK", "a", true, ""] });
});

test("publish(): после flushAll публикующий получает OK", () => {
	const { relay, delivered } = collector();
	relay.publish("conn1", ev("a"));
	relay.flushAll();
	assert.equal(delivered.length, 1);
	assert.deepEqual(delivered[0], { connId: "conn1", msg: ["OK", "a", true, ""] });
});

test("subscribe(): отдаёт историю (уже опубликованные подходящие события) в порядке лога, затем EOSE", () => {
	const { relay, delivered } = collector();
	relay.publish("writer", ev("a", { kind: 1 }));
	relay.publish("writer", ev("b", { kind: 2 }));
	relay.publish("writer", ev("c", { kind: 1 }));
	relay.flushAll();
	delivered.length = 0;

	relay.subscribe("reader", "sub1", [{ kinds: [1] }]);
	relay.flushAll();

	assert.deepEqual(
		delivered.map((d) => d.msg),
		[
			["EVENT", "sub1", ev("a", { kind: 1 })],
			["EVENT", "sub1", ev("c", { kind: 1 })],
			["EOSE", "sub1"],
		],
	);
});

test("subscribe(): несовпавшие по фильтру исторические события не доставляются", () => {
	const { relay, delivered } = collector();
	relay.publish("writer", ev("a", { kind: 99 }));
	relay.flushAll();
	delivered.length = 0;

	relay.subscribe("reader", "sub1", [{ kinds: [1] }]);
	relay.flushAll();

	assert.deepEqual(
		delivered.map((d) => d.msg[0]),
		["EOSE"],
	);
});

test("publish() после subscribe(): доставляется живым подписчикам с совпавшим фильтром", () => {
	const { relay, delivered } = collector();
	relay.subscribe("reader", "sub1", [{ kinds: [1] }]);
	relay.flushAll();
	delivered.length = 0;

	relay.publish("writer", ev("a", { kind: 1 }));
	relay.flushAll();

	assert.deepEqual(
		delivered.map((d) => d.msg),
		[
			["EVENT", "sub1", ev("a", { kind: 1 })],
			["OK", "a", true, ""],
		],
	);
});

test("publish(): не уведомляет подписки с несовпавшим фильтром", () => {
	const { relay, delivered } = collector();
	relay.subscribe("reader", "sub1", [{ kinds: [99] }]);
	relay.flushAll();
	delivered.length = 0;

	relay.publish("writer", ev("a", { kind: 1 }));
	relay.flushAll();

	assert.deepEqual(
		delivered.map((d) => d.msg[0]),
		["OK"],
	);
});

test("publish(): публикующий тоже получает EVENT, если его собственная подписка совпала (relay не различает своё/чужое)", () => {
	const { relay, delivered } = collector();
	relay.subscribe("writer", "sub1", [{ kinds: [1] }]);
	relay.flushAll();
	delivered.length = 0;

	relay.publish("writer", ev("a", { kind: 1 }));
	relay.flushAll();

	assert.deepEqual(
		delivered.map((d) => d.msg[0]).sort(),
		["EVENT", "OK"],
	);
});

test("subscribe(): несколько фильтров в одном REQ — OR (совпадение по любому)", () => {
	const { relay, delivered } = collector();
	relay.publish("writer", ev("a", { kind: 1 }));
	relay.publish("writer", ev("b", { kind: 2 }));
	relay.publish("writer", ev("c", { kind: 3 }));
	relay.flushAll();
	delivered.length = 0;

	relay.subscribe("reader", "sub1", [{ kinds: [1] }, { kinds: [3] }]);
	relay.flushAll();

	assert.deepEqual(
		delivered.filter((d) => d.msg[0] === "EVENT").map((d) => d.msg[2].id),
		["a", "c"],
	);
});

test("subscribe(): фильтр по #h", () => {
	const { relay, delivered } = collector();
	relay.publish("writer", ev("a", { tags: [["h", "group1"]] }));
	relay.publish("writer", ev("b", { tags: [["h", "group2"]] }));
	relay.flushAll();
	delivered.length = 0;

	relay.subscribe("reader", "sub1", [{ "#h": ["group1"] }]);
	relay.flushAll();

	assert.deepEqual(
		delivered.filter((d) => d.msg[0] === "EVENT").map((d) => d.msg[2].id),
		["a"],
	);
});

test("resubscribe с тем же (connId,subId): заменяет прошлую подписку, не дублирует будущие доставки", () => {
	const { relay, delivered } = collector();
	relay.subscribe("reader", "sub1", [{ kinds: [1] }]);
	relay.flushAll();
	relay.subscribe("reader", "sub1", [{ kinds: [2] }]);
	relay.flushAll();
	delivered.length = 0;

	relay.publish("writer", ev("a", { kind: 1 }));
	relay.publish("writer", ev("b", { kind: 2 }));
	relay.flushAll();

	assert.deepEqual(
		delivered.filter((d) => d.msg[0] === "EVENT").map((d) => d.msg[2].id),
		["b"],
	);
});

test("unsubscribe(): гасит будущие доставки этой подписки, не трогает уже стоящие в очереди", () => {
	const { relay, delivered } = collector();
	relay.subscribe("reader", "sub1", [{ kinds: [1] }]);
	relay.flushAll();
	delivered.length = 0;

	relay.publish("writer", ev("a", { kind: 1 })); // ставит EVENT в очередь ДО unsubscribe
	relay.unsubscribe("reader", "sub1");
	relay.publish("writer", ev("b", { kind: 1 })); // подписки уже нет — в очередь не попадает
	relay.flushAll();

	assert.deepEqual(
		delivered.filter((d) => d.msg[0] === "EVENT").map((d) => d.msg[2].id),
		["a"],
	);
});

test("disconnect(): снимает ВСЕ подписки этого connId разом", () => {
	const { relay, delivered } = collector();
	relay.subscribe("reader", "sub1", [{ kinds: [1] }]);
	relay.subscribe("reader", "sub2", [{ kinds: [2] }]);
	relay.flushAll();
	delivered.length = 0;

	relay.disconnect("reader");
	relay.publish("writer", ev("a", { kind: 1 }));
	relay.publish("writer", ev("b", { kind: 2 }));
	relay.flushAll();

	assert.deepEqual(
		delivered.filter((d) => d.msg[0] === "EVENT"),
		[],
	);
});

test("независимые connId не пересекаются: disconnect одного не гасит подписку другого", () => {
	const { relay, delivered } = collector();
	relay.subscribe("reader1", "sub1", [{ kinds: [1] }]);
	relay.subscribe("reader2", "sub1", [{ kinds: [1] }]);
	relay.flushAll();
	delivered.length = 0;

	relay.disconnect("reader1");
	relay.publish("writer", ev("a", { kind: 1 }));
	relay.flushAll();

	assert.deepEqual(
		delivered.filter((d) => d.msg[0] === "EVENT").map((d) => d.connId),
		["reader2"],
	);
});

test("flushNext(): доставляет ровно одну голову очереди за раз, возвращает false на пустой очереди", () => {
	const { relay, delivered } = collector();
	relay.publish("conn1", ev("a"));
	relay.publish("conn2", ev("b"));

	assert.equal(relay.flushNext(), true);
	assert.equal(delivered.length, 1);
	assert.equal(relay.flushNext(), true);
	assert.equal(delivered.length, 2);
	assert.equal(relay.flushNext(), false);
	assert.equal(delivered.length, 2);
});

test("reorder(): меняет порядок ОЖИДАЮЩЕЙ доставки согласно compareFn", () => {
	const { relay, delivered } = collector();
	relay.publish("conn1", ev("a"));
	relay.publish("conn2", ev("b"));
	relay.publish("conn3", ev("c"));

	relay.reorder((x, y) => (x.msg[1] < y.msg[1] ? 1 : -1)); // обратный порядок по eventId
	relay.flushAll();

	assert.deepEqual(
		delivered.map((d) => d.msg[1]),
		["c", "b", "a"],
	);
});

test("pending(): снимок только для чтения, не мутирует очередь", () => {
	const { relay, delivered } = collector();
	relay.publish("conn1", ev("a"));
	const snapshot = relay.pending();
	snapshot.length = 0; // попытка мутации снимка
	assert.equal(relay.pending().length, 1, "внутренняя очередь не должна пострадать от мутации снимка");
	relay.flushAll();
	assert.equal(delivered.length, 1);
});
