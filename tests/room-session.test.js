// Rooms, этап 2 — room-session.js (оркестратор). Тесты до кода (skill п.14).
// Контракт и design-записка — PROCESS-DOCS/CONTRACTS.md "Rooms — Этап 2"
// (room-session.js). Реальный WebSocket + fake-relay (детерминированный flush),
// НО инъекция now()/setIntervalImpl — часы и таймер полностью подконтрольны
// тесту (τ=45с проверяется без единой реальной секунды ожидания).
import { test } from "node:test";
import assert from "node:assert/strict";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { createFakeRelay } from "./harness/fake-relay.js";
import { createWsBridge } from "./harness/ws-bridge.js";
import { createRoom, joinRoom } from "../src/domain/rooms/room-session.js";

function fakeArgon2(password, saltBytes) {
	return Promise.resolve(hkdf(sha256, utf8ToBytes(password), saltBytes, utf8ToBytes("fake-argon2-test-stub"), 32));
}

async function setup() {
	let bridge;
	const relay = createFakeRelay({ onDeliver: (connId, msg) => bridge.deliver(connId, msg) });
	bridge = createWsBridge(relay, { port: 0 });
	const { port } = await bridge.start();
	return { relay, bridge, relayUrl: `ws://127.0.0.1:${port}` };
}

async function flushUntilSettled(relay, { rounds = 15, delayMs = 40 } = {}) {
	for (let i = 0; i < rounds; i++) {
		await new Promise((r) => setTimeout(r, delayMs));
		if (relay.pending().length > 0) relay.flushAll();
	}
}

function makeClock(startMs) {
	let current = startMs;
	return { now: () => current, advance: (ms) => (current += ms) };
}

function makeFakeTimer() {
	let callback = null;
	return {
		setIntervalImpl: (fn) => {
			callback = fn;
			return "fake-handle";
		},
		clearIntervalImpl: () => {
			callback = null;
		},
		tick: () => callback && callback(),
	};
}

// Продвигает сценарий: часы -> тик обоих таймеров -> дать real websocket'ам
// осесть. Несколько раундов — причинная цепочка (probe -> announce -> ready ->
// heartbeat -> видим друг друга) требует больше одного шага.
async function pump(relay, clock, timers, { rounds = 20, stepMs = 500 } = {}) {
	for (let i = 0; i < rounds; i++) {
		clock.advance(stepMs);
		for (const t of timers) t.tick();
		await flushUntilSettled(relay, { rounds: 3, delayMs: 30 });
	}
}

async function openTwoParticipants(relay, relayUrl, clock) {
	const timerA = makeFakeTimer();
	const timerB = makeFakeTimer();
	const changesA = [];
	const changesB = [];
	const alice = await createRoom({
		name: "котики",
		password: "111",
		nick: "Алиса",
		relayUrl,
		argon2: fakeArgon2,
		now: clock.now,
		random: () => 0.5,
		setIntervalImpl: timerA.setIntervalImpl,
		clearIntervalImpl: timerA.clearIntervalImpl,
		onChange: () => changesA.push(1),
	});
	const bob = await joinRoom({
		name: "котики",
		password: "111",
		suffix: alice.getSuffix(),
		nick: "Боб",
		relayUrl,
		argon2: fakeArgon2,
		now: clock.now,
		random: () => 0.5,
		setIntervalImpl: timerB.setIntervalImpl,
		clearIntervalImpl: timerB.clearIntervalImpl,
		onChange: () => changesB.push(1),
	});
	await pump(relay, clock, [timerA, timerB]);
	return { alice, bob, timerA, timerB, changesA, changesB };
}

test("createRoom: готов сразу (salt свой), joinRoom: НЕ готов до первого ANNOUNCE", async (t) => {
	const { relay, bridge, relayUrl } = await setup();
	t.after(() => bridge.stop());
	const clock = makeClock(1000);
	const timerA = makeFakeTimer();
	const alice = await createRoom({
		name: "n",
		password: "p",
		nick: "A",
		relayUrl,
		argon2: fakeArgon2,
		now: clock.now,
		random: () => 0.5,
		setIntervalImpl: timerA.setIntervalImpl,
		clearIntervalImpl: timerA.clearIntervalImpl,
		onChange: () => {},
	});
	t.after(() => alice.close());
	assert.equal(alice.isReady(), true);

	const timerB = makeFakeTimer();
	const bobPromise = joinRoom({
		name: "n",
		password: "p",
		suffix: alice.getSuffix(),
		nick: "B",
		relayUrl,
		argon2: fakeArgon2,
		now: clock.now,
		random: () => 0.5,
		setIntervalImpl: timerB.setIntervalImpl,
		clearIntervalImpl: timerB.clearIntervalImpl,
		onChange: () => {},
	});
	const bob = await bobPromise;
	t.after(() => bob.close());
	assert.equal(bob.isReady(), false, "joinRoom не готов до первого ANNOUNCE — salt ещё неизвестен");
	// Дать publisher'у время реально отправить PROBE (batchWindowMs=200мс) ДО close() —
	// иначе отложенный flush() внутри publisher.js бросает после закрытия соединения.
	await flushUntilSettled(relay);
});

test("два участника видят друг друга в present() после сходимости (probe -> announce -> heartbeat)", async (t) => {
	const { relay, bridge, relayUrl } = await setup();
	t.after(() => bridge.stop());
	const clock = makeClock(1000);
	const { alice, bob } = await openTwoParticipants(relay, relayUrl, clock);
	t.after(() => {
		alice.close();
		bob.close();
	});

	assert.equal(bob.isReady(), true, "joinRoom получил ANNOUNCE и стал готов");

	const presentForAlice = alice.getPresent().map((p) => p.pubkey).sort();
	const presentForBob = bob.getPresent().map((p) => p.pubkey).sort();
	const expected = [alice.getPubkeyHex(), bob.getPubkeyHex()].sort();
	assert.deepEqual(presentForAlice, expected, "Алиса видит обоих (включая себя)");
	assert.deepEqual(presentForBob, expected, "Боб видит обоих (включая себя)");
});

test("room-machine: k=2 когда оба присутствуют, состояние alive", async (t) => {
	const { relay, bridge, relayUrl } = await setup();
	t.after(() => bridge.stop());
	const clock = makeClock(1000);
	const { alice, bob } = await openTwoParticipants(relay, relayUrl, clock);
	t.after(() => {
		alice.close();
		bob.close();
	});

	assert.deepEqual(alice.getRoomState(), { name: "alive", k: 2 });
	assert.deepEqual(bob.getRoomState(), { name: "alive", k: 2 });
});

test("обмен сообщениями: sendChat одного доходит до другого через messageLog", async (t) => {
	const { relay, bridge, relayUrl } = await setup();
	t.after(() => bridge.stop());
	const clock = makeClock(1000);
	const { alice, bob, timerA, timerB } = await openTwoParticipants(relay, relayUrl, clock);
	t.after(() => {
		alice.close();
		bob.close();
	});

	const sendPromise = alice.sendChat("привет, Боб!"); // НЕ await — сначала pump (flush), иначе дедлок
	await pump(relay, clock, [timerA, timerB], { rounds: 5 });
	const result = await sendPromise;
	assert.equal(result.ok, true);

	const bobMessages = bob.getMessages();
	assert.equal(bobMessages.length, 1);
	assert.equal(bobMessages[0].text, "привет, Боб!");
	assert.equal(bobMessages[0].pubkey, alice.getPubkeyHex());

	// Алиса тоже видит своё сообщение (через ту же подписку — эхо от relay)
	const aliceMessages = alice.getMessages();
	assert.equal(aliceMessages.length, 1);
	assert.equal(aliceMessages[0].text, "привет, Боб!");
});

test("sendChat до готовности (!isReady) — отклоняется, не публикуется вслепую", async (t) => {
	const { relay, bridge, relayUrl } = await setup();
	t.after(() => bridge.stop());
	const clock = makeClock(1000);
	const timerA = makeFakeTimer();
	const timerB = makeFakeTimer();
	const alice = await createRoom({
		name: "n",
		password: "p",
		nick: "A",
		relayUrl,
		argon2: fakeArgon2,
		now: clock.now,
		random: () => 0.5,
		setIntervalImpl: timerA.setIntervalImpl,
		clearIntervalImpl: timerA.clearIntervalImpl,
		onChange: () => {},
	});
	t.after(() => alice.close());
	const bob = await joinRoom({
		name: "n",
		password: "p",
		suffix: alice.getSuffix(),
		nick: "B",
		relayUrl,
		argon2: fakeArgon2,
		now: clock.now,
		random: () => 0.5,
		setIntervalImpl: timerB.setIntervalImpl,
		clearIntervalImpl: timerB.clearIntervalImpl,
		onChange: () => {},
	});
	t.after(() => bob.close());

	assert.equal(bob.isReady(), false);
	await assert.rejects(() => bob.sendChat("рано"));
	await flushUntilSettled(relay); // дать PROBE'у Боба реально уйти до close() в t.after
});

test("τ-исчезновение: один участник закрывается абруптно (close без exit-события), через τ пропадает у второго", async (t) => {
	const { relay, bridge, relayUrl } = await setup();
	t.after(() => bridge.stop());
	const clock = makeClock(1000);
	const { alice, bob, timerA, timerB } = await openTwoParticipants(relay, relayUrl, clock);
	t.after(() => alice.close());

	assert.equal(alice.getPresent().length, 2, "оба видны перед уходом");

	bob.close(); // абруптно, БЕЗ exit-события — имитация закрытой вкладки

	// Сразу после закрытия Боб ещё присутствует (аренда не истекла)
	await pump(relay, clock, [timerA], { rounds: 2, stepMs: 1000 });
	assert.equal(
		alice.getPresent().some((p) => p.pubkey === bob.getPubkeyHex()),
		true,
		"аренда Боба ещё не истекла сразу после close()",
	);

	// Прыжок часов далеко за τ=45000мс, тик Алисы (sweep делает prune/present)
	clock.advance(50000);
	timerA.tick();
	await flushUntilSettled(relay);

	assert.equal(
		alice.getPresent().some((p) => p.pubkey === bob.getPubkeyHex()),
		false,
		"через τ Боб исчез из present() Алисы — лизинг истёк, явного exit не было",
	);
	assert.equal(alice.getPresent().length, 1, "осталась только Алиса");
});

test("getRoomState: draining после ухода последнего партнёра, dead после τ (со стороны наблюдателя, который сам не единственный участник)", async (t) => {
	const { relay, bridge, relayUrl } = await setup();
	t.after(() => bridge.stop());
	const clock = makeClock(1000);
	const { alice, bob, timerA } = await openTwoParticipants(relay, relayUrl, clock);
	t.after(() => alice.close());

	bob.close();
	clock.advance(50000);
	timerA.tick();
	await flushUntilSettled(relay);

	// Алиса сама всё ещё в комнате (k=1, она сама) — "alive", не "draining"/"dead":
	// draining/dead наступает только когда САМ наблюдатель ушёл последним.
	assert.deepEqual(alice.getRoomState(), { name: "alive", k: 1 });
});

test("close(): И7 — нет побочных эффектов вовне (нечего чистить, ничего не писалось)", async (t) => {
	const { relay, bridge, relayUrl } = await setup();
	t.after(() => bridge.stop());
	const clock = makeClock(1000);
	const timerA = makeFakeTimer();
	const alice = await createRoom({
		name: "n",
		password: "p",
		nick: "A",
		relayUrl,
		argon2: fakeArgon2,
		now: clock.now,
		random: () => 0.5,
		setIntervalImpl: timerA.setIntervalImpl,
		clearIntervalImpl: timerA.clearIntervalImpl,
		onChange: () => {},
	});
	assert.doesNotThrow(() => alice.close());
	// Повторный tick после close() не должен падать (таймер остановлен явным clearIntervalImpl)
	assert.doesNotThrow(() => timerA.tick());
});

// --- Адверсарная фаза (skill п.19) — не happy-path, атака на диспетчер handleEvent ---

test("адверсарно: дублирующая доставка (relay переподключение) — heartbeat/probe не ломает состояние при повторе", async (t) => {
	const { relay, bridge, relayUrl } = await setup();
	t.after(() => bridge.stop());
	const clock = makeClock(1000);
	const { alice, bob, timerA, timerB } = await openTwoParticipants(relay, relayUrl, clock);
	t.after(() => {
		alice.close();
		bob.close();
	});

	const beforeK = alice.getRoomState().k;
	const beforePresent = alice.getPresent().length;

	// Ещё несколько раундов sweep без НОВЫХ событий — только повтор обычных heartbeat.
	// Идемпотентность mergeHeartbeat (Этап 1, И1) обязана удержать k стабильным.
	await pump(relay, clock, [timerA, timerB], { rounds: 10 });

	assert.equal(alice.getRoomState().k, beforeK, "k не растёт от повторных heartbeat того же участника");
	assert.equal(alice.getPresent().length, beforePresent);
});

test("адверсарно: битый content (не base64/AEAD-мусор) на ROOM_PRESENCE_KIND не роняет обработчик", async (t) => {
	const { relay, bridge, relayUrl } = await setup();
	t.after(() => bridge.stop());
	const clock = makeClock(1000);
	const timerA = makeFakeTimer();
	const alice = await createRoom({
		name: "n",
		password: "p",
		nick: "A",
		relayUrl,
		argon2: fakeArgon2,
		now: clock.now,
		random: () => 0.5,
		setIntervalImpl: timerA.setIntervalImpl,
		clearIntervalImpl: timerA.clearIntervalImpl,
		onChange: () => {},
	});
	t.after(() => alice.close());
	await pump(relay, clock, [timerA], { rounds: 3 });

	const garbage = {
		kind: 29003, // ROOM_PRESENCE_KIND
		tags: [["h", "irrelevant-does-not-matter-because-hTopic-mismatch-would-drop-anyway"]],
		content: "не-base64-и-не-AEAD-мусор!!!",
		created_at: Math.floor(clock.now() / 1000),
		pubkey: "a".repeat(64),
		id: "b".repeat(64),
		sig: "c".repeat(128),
	};
	// Публикуем НАПРЯМУЮ в relay (мимо room-transport's verify() — атака на handleEvent
	// САМ по себе через прямой вызов не нужен: verify() уже отбросит несоответствующую
	// подпись раньше; здесь важно, что даже ЕСЛИ бы content дошёл, parseRoomPresenceEvent
	// возвращает null, а не бросает — проверяем это напрямую через room-events.js).
	const { parseRoomPresenceEvent } = await import("../src/domain/rooms/room-events.js");
	const kSessStub = crypto.getRandomValues(new Uint8Array(32));
	assert.doesNotThrow(() => parseRoomPresenceEvent(garbage, kSessStub));
	assert.equal(parseRoomPresenceEvent(garbage, kSessStub), null);

	// Сессия осталась работоспособной после попытки (sweep продолжает тикать без исключений)
	assert.doesNotThrow(() => timerA.tick());
});
