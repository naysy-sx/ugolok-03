// Rooms, этап 2 — room-transport.js. Тесты до кода (skill п.14). Контракт —
// PROCESS-DOCS/CONTRACTS.md "Rooms — Этап 2" (room-transport.js), ROOMS-SPEC.md §4.2.
//
// Реальный WebSocket + фейковый relay (tests/harness/ws-bridge.js + fake-relay.js,
// тот же приём, что MLS multidevice-харнесс) — упражняет НАСТОящий relay-pool.js/
// publisher.js/subscriber.js без строфри, с ручным управлением доставкой (flush).
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { sign } from "../src/core/crypto/sign.js";
import { createFakeRelay } from "./harness/fake-relay.js";
import { createWsBridge } from "./harness/ws-bridge.js";
import { openRoomTransport } from "../src/domain/rooms/adapters/room-transport.js";
import { ROOM_ANNOUNCE_KIND, ROOM_CHAT_KIND } from "../src/domain/events/kind-registry.js";
import { CALL_SIGNAL_KIND } from "../src/domain/calls/signaling-adapter.js";

async function setup() {
	let bridge;
	const relay = createFakeRelay({ onDeliver: (connId, msg) => bridge.deliver(connId, msg) });
	bridge = createWsBridge(relay, { port: 0 });
	const { port } = await bridge.start();
	return { relay, bridge, relayUrl: `ws://127.0.0.1:${port}` };
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

function rawEvent(privKey, kind, tags, content, createdAt = Math.floor(Date.now() / 1000)) {
	return sign({ kind, tags, content, created_at: createdAt }, privKey);
}

// Несколько независимых REQ/EVENT над одним и тем же relayUrl прибывают на
// сервер по НЕЗАВИСИМЫМ websocket-раундтрипам — единичный "pending>0 -> flushAll
// один раз" гонится с тем, что ВТОРОЕ сообщение ещё в пути. Вместо одной точки
// синхронизации — несколько раундов "подождать/слить", пока очередь не устаканится.
async function flushUntilSettled(relay, { rounds = 15, delayMs = 40 } = {}) {
	for (let i = 0; i < rounds; i++) {
		await new Promise((r) => setTimeout(r, delayMs));
		if (relay.pending().length > 0) relay.flushAll();
	}
}

test("openRoomTransport: подключается, публикует, событие того же топика доходит адресату", async (t) => {
	const { relay, bridge, relayUrl } = await setup();
	t.after(() => bridge.stop());

	const hTopic = "topic1".padStart(64, "0");
	const aliceKey = generateSecretKey();
	const bobKey = generateSecretKey();
	const bobPubkey = getPublicKey(bobKey);

	const received = [];
	const alice = await openRoomTransport({ relayUrl, hTopic, selfPubkey: getPublicKey(aliceKey), onEvent: () => {} });
	t.after(() => alice.close());
	const bob = await openRoomTransport({ relayUrl, hTopic, selfPubkey: bobPubkey, onEvent: (e) => received.push(e) });
	t.after(() => bob.close());

	await flushUntilSettled(relay); // дренируем ОБЕ начальные подписки (alice + bob)

	const event = rawEvent(aliceKey, ROOM_CHAT_KIND, [["h", hTopic]], "encrypted-content-stub");
	const publishPromise = alice.publish(event); // НЕ await — публикация уходит с внутренней задержкой batchWindowMs
	await flushUntilSettled(relay);
	const result = await publishPromise;
	assert.equal(result.ok, true);

	await waitFor(() => received.length > 0);
	assert.equal(received[0].id, event.id);
});

test("предфильтр h: событие с чужим h-тегом не доходит до onEvent, даже если релей его прислал бы (защита в глубину)", async (t) => {
	const { relay, bridge, relayUrl } = await setup();
	t.after(() => bridge.stop());

	const hTopic = "topic-a".padStart(64, "0");
	const foreignKey = generateSecretKey();
	const received = [];
	const listener = await openRoomTransport({ relayUrl, hTopic, selfPubkey: getPublicKey(generateSecretKey()), onEvent: (e) => received.push(e) });
	t.after(() => listener.close());

	await waitFor(() => relay.pending().length > 0);
	relay.flushAll();

	// Публикуем НАПРЯМУЮ в fake-relay (минуя фильтр REQ — имитирует ситуацию,
	// когда relay прислал бы событие несмотря на фильтр, либо совпадение подписки).
	const foreignEvent = rawEvent(foreignKey, ROOM_ANNOUNCE_KIND, [["h", "другой-топик".padStart(64, "0")]], "x");
	relay.publish("attacker-conn", foreignEvent);
	relay.flushAll();
	await new Promise((r) => setTimeout(r, 350)); // > subscriber's batchWindowMs (200ms)

	assert.deepEqual(received, [], "событие с несовпадающим h не должно было дойти до onEvent");
});

test("предфильтр p: CALL_SIGNAL_KIND с чужим p-тегом отбрасывается без вызова onEvent", async (t) => {
	const { relay, bridge, relayUrl } = await setup();
	t.after(() => bridge.stop());

	const hTopic = "topic-voice".padStart(64, "0");
	const senderKey = generateSecretKey();
	const selfKey = generateSecretKey();
	const someoneElsePubkey = getPublicKey(generateSecretKey());
	const received = [];
	const listener = await openRoomTransport({ relayUrl, hTopic, selfPubkey: getPublicKey(selfKey), onEvent: (e) => received.push(e) });
	t.after(() => listener.close());

	await waitFor(() => relay.pending().length > 0);
	relay.flushAll();

	const signalForSomeoneElse = rawEvent(senderKey, CALL_SIGNAL_KIND, [
		["p", someoneElsePubkey],
		["h", hTopic],
	], "cipher");
	relay.publish("sender-conn", signalForSomeoneElse);
	relay.flushAll();
	await new Promise((r) => setTimeout(r, 350));

	assert.deepEqual(received, [], "сигналинг для чужого p не должен доходить до onEvent (нельзя даже пытаться расшифровать)");
});

test("предфильтр p: CALL_SIGNAL_KIND, адресованный self, доходит до onEvent", async (t) => {
	const { relay, bridge, relayUrl } = await setup();
	t.after(() => bridge.stop());

	const hTopic = "topic-voice2".padStart(64, "0");
	const senderKey = generateSecretKey();
	const selfKey = generateSecretKey();
	const selfPubkey = getPublicKey(selfKey);
	const received = [];
	const listener = await openRoomTransport({ relayUrl, hTopic, selfPubkey, onEvent: (e) => received.push(e) });
	t.after(() => listener.close());

	await waitFor(() => relay.pending().length > 0);
	relay.flushAll();

	const signalForSelf = rawEvent(senderKey, CALL_SIGNAL_KIND, [
		["p", selfPubkey],
		["h", hTopic],
	], "cipher");
	relay.publish("sender-conn", signalForSelf);
	relay.flushAll();
	await waitFor(() => received.length > 0);

	assert.equal(received.length, 1);
	assert.equal(received[0].id, signalForSelf.id);
});

test("verify: событие с подделанным content (id больше не соответствует подписи) отбрасывается", async (t) => {
	const { relay, bridge, relayUrl } = await setup();
	t.after(() => bridge.stop());

	const hTopic = "topic-tamper".padStart(64, "0");
	const attackerKey = generateSecretKey();
	const received = [];
	const listener = await openRoomTransport({ relayUrl, hTopic, selfPubkey: getPublicKey(generateSecretKey()), onEvent: (e) => received.push(e) });
	t.after(() => listener.close());

	await waitFor(() => relay.pending().length > 0);
	relay.flushAll();

	const legit = rawEvent(attackerKey, ROOM_ANNOUNCE_KIND, [["h", hTopic]], "original");
	const tampered = { ...legit, content: "ПОДМЕНЁННЫЙ" }; // id/sig больше не соответствуют content
	relay.publish("attacker-conn", tampered);
	relay.flushAll();
	await new Promise((r) => setTimeout(r, 350));

	assert.deepEqual(received, [], "событие с несовпадающей подписью не должно доходить до onEvent");
});

test("close(): после закрытия дальнейшие события не доставляются (соединение разорвано)", async (t) => {
	const { relay, bridge, relayUrl } = await setup();
	t.after(() => bridge.stop());

	const hTopic = "topic-close".padStart(64, "0");
	const senderKey = generateSecretKey();
	const received = [];
	const listener = await openRoomTransport({ relayUrl, hTopic, selfPubkey: getPublicKey(generateSecretKey()), onEvent: (e) => received.push(e) });

	await waitFor(() => relay.pending().length > 0);
	relay.flushAll();

	listener.close();
	await new Promise((r) => setTimeout(r, 100));

	const event = rawEvent(senderKey, ROOM_ANNOUNCE_KIND, [["h", hTopic]], "x");
	relay.publish("sender-conn", event);
	relay.flushAll();
	await new Promise((r) => setTimeout(r, 350));

	assert.deepEqual(received, [], "после close() новые события не должны приходить");
});
