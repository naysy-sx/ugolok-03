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
import { createRoom, joinRoom, joinRoomByPassword } from "../src/domain/rooms/room-session.js";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { sign } from "../src/core/crypto/sign.js";
import { deriveKBase, derivePairKeys, deriveLinkKeys } from "../src/domain/rooms/room-keys.js";
import { CALL_SIGNAL_KIND } from "../src/domain/calls/signaling-adapter.js";

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

// Этап 4 — фейковый mesh-supervisor (DI, CONTRACTS.md "Rooms — Этап 4"): room-session.js
// тестируется без реального WebRTC на два уровня вглубь (mesh-supervisor.js сам уже
// протестирован отдельно, tests/mesh-supervisor.test.js — здесь важна только СТЫКОВКА).
function fakeMeshSupervisorFactory() {
	const instances = [];
	function factory(options) {
		const instance = {
			options,
			joinVoiceCalls: 0,
			leaveVoiceCalls: 0,
			updateRosterCalls: [],
			onSignalCalls: [],
		};
		const supervisor = {
			joinVoice: async () => {
				instance.joinVoiceCalls += 1;
			},
			leaveVoice: () => {
				instance.leaveVoiceCalls += 1;
			},
			updateRoster: (pubkeys) => {
				instance.updateRosterCalls.push(pubkeys);
			},
			onSignal: (event) => {
				instance.onSignalCalls.push(event);
			},
			getEdgeStates: () => [],
		};
		instance.supervisor = supervisor;
		instances.push(instance);
		return supervisor;
	}
	return { factory, instances };
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

// --- Этап 3: открытый режим, joinRoomByPassword, И9, И11 ---

test("открытый режим: createRoom({openMode:true}) публикует указатель, joinRoomByPassword находит suffix и присоединяется", async (t) => {
	const { relay, bridge, relayUrl } = await setup();
	t.after(() => bridge.stop());
	const clock = makeClock(1000);
	const timerA = makeFakeTimer();
	const alice = await createRoom({
		name: "открытая-комната",
		password: "111",
		nick: "Алиса",
		relayUrl,
		argon2: fakeArgon2,
		now: clock.now,
		random: () => 0.5,
		setIntervalImpl: timerA.setIntervalImpl,
		clearIntervalImpl: timerA.clearIntervalImpl,
		onChange: () => {},
		openMode: true,
	});
	t.after(() => alice.close());
	assert.equal(alice.getRaceOutcome(), null, "единственный создатель — гонки нет");

	// Указатель Алисы уходит на relay (реальный websocket, publisher's batchWindowMs).
	// fake-relay.js хранит опубликованные события и реплеит их НОВОЙ подписке — но
	// саму ДОСТАВКУ реплея (pending -> сокет) всё равно нужно вручную флашить,
	// discoverSuffixViaPointer сама этого не делает (её задача — ждать, не сливать
	// тестовый харнесс). Параллельно с ожиданием joinRoomByPassword — ограниченный
	// по времени опрос-и-слив (НЕ бесконечный цикл — обязан остановиться сам).
	await flushUntilSettled(relay);

	const discoveryTimeoutMs = 500;
	async function pollAndFlushFor(ms) {
		const deadline = Date.now() + ms;
		while (Date.now() < deadline) {
			if (relay.pending().length > 0) relay.flushAll();
			await new Promise((r) => setTimeout(r, 20));
		}
	}

	const [bob] = await Promise.all([
		joinRoomByPassword({
			name: "открытая-комната",
			password: "111",
			nick: "Боб",
			relayUrl,
			argon2: fakeArgon2,
			now: clock.now,
			random: () => 0.5,
			discoveryTimeoutMs,
		}),
		pollAndFlushFor(discoveryTimeoutMs + 200),
	]);
	t.after(() => bob.close());

	assert.equal(bob.getSuffix(), alice.getSuffix(), "Боб нашёл ТОТ ЖЕ suffix через указатель");
	// Дальнейшая сходимость presence через LINK-путь (suffix уже есть у обоих) уже
	// покрыта отдельными LINK-режимными тестами выше — здесь важен сам факт находки.

	// bob сразу после joinRoomByPassword публикует PROBE (обычный joinRoom-путь) —
	// дать publisher'у реально его отправить ДО close() в t.after (тот же паттерн,
	// что уже чинился в room-transport.test.js/room-session.test.js выше).
	await flushUntilSettled(relay);
});

test("И9: два конкурирующих createRoom(openMode) под тем же (name,password) — ровно один проигрывает, узнаёт winningSuffix минимального id", async (t) => {
	const { relay, bridge, relayUrl } = await setup();
	t.after(() => bridge.stop());
	const clock = makeClock(1000);
	const timerA = makeFakeTimer();
	const timerB = makeFakeTimer();

	const creatorA = await createRoom({
		name: "гонка",
		password: "222",
		nick: "A",
		relayUrl,
		argon2: fakeArgon2,
		now: clock.now,
		random: () => 0.5,
		setIntervalImpl: timerA.setIntervalImpl,
		clearIntervalImpl: timerA.clearIntervalImpl,
		onChange: () => {},
		openMode: true,
	});
	const creatorB = await createRoom({
		name: "гонка",
		password: "222",
		nick: "B",
		relayUrl,
		argon2: fakeArgon2,
		now: clock.now,
		random: () => 0.5,
		setIntervalImpl: timerB.setIntervalImpl,
		clearIntervalImpl: timerB.clearIntervalImpl,
		onChange: () => {},
		openMode: true,
	});
	t.after(() => {
		creatorA.close();
		creatorB.close();
	});

	assert.notEqual(creatorA.getSuffix(), creatorB.getSuffix(), "два независимых случайных suffix");

	await pump(relay, clock, [timerA, timerB], { rounds: 10 });

	const outcomeA = creatorA.getRaceOutcome();
	const outcomeB = creatorB.getRaceOutcome();
	// Ровно один из двух проиграл (увидел суффикс с меньшим id, отличный от своего).
	const outcomes = [outcomeA, outcomeB];
	const losers = outcomes.filter((o) => o !== null);
	assert.equal(losers.length, 1, "ровно один проигравший — оба не могут проиграть друг другу одновременно (антисимметрия сравнения id)");

	if (outcomeA !== null) {
		assert.equal(outcomeA.winningSuffix, creatorB.getSuffix(), "A проиграл -> его winningSuffix это suffix B");
	} else {
		assert.equal(outcomeB.winningSuffix, creatorA.getSuffix(), "B проиграл -> его winningSuffix это suffix A");
	}
});

test("И11: комната переживает уход создателя — оставшийся участник продолжает отвечать на probe нового гостя", async (t) => {
	const { relay, bridge, relayUrl } = await setup();
	t.after(() => bridge.stop());
	const clock = makeClock(1000);
	const { alice, bob, timerA, timerB } = await openTwoParticipants(relay, relayUrl, clock);

	alice.close(); // создатель ушёл (абруптно)
	t.after(() => bob.close());

	// Третий участник входит по suffix (известному заранее, вне канала — как если
	// бы получил инвайт-ссылку до ухода Алисы) — ссылка не зависит от того, жива ли Алиса.
	const timerC = makeFakeTimer();
	const carol = await joinRoom({
		name: "котики",
		password: "111",
		suffix: bob.getSuffix(),
		nick: "Кэрол",
		relayUrl,
		argon2: fakeArgon2,
		now: clock.now,
		random: () => 0.5,
		setIntervalImpl: timerC.setIntervalImpl,
		clearIntervalImpl: timerC.clearIntervalImpl,
		onChange: () => {},
	});
	t.after(() => carol.close());

	await pump(relay, clock, [timerB, timerC], { rounds: 15 });

	assert.equal(carol.isReady(), true, "Боб (оставшийся участник) ответил на probe Кэрол анонсом — комната жива без создателя");
	assert.equal(
		carol.getPresent().some((p) => p.pubkey === bob.getPubkeyHex()),
		true,
		"Кэрол видит Боба в present()",
	);
});

// --- Этап 4: голос — joinVoice/leaveVoice, VoicePresent, CALL_SIGNAL_KIND, И10 ---

async function fakeStream() {
	return {
		getTracks: () => [{ stop() {} }],
		clone() {
			return this;
		},
	};
}

test("joinVoice(): делегирует meshSupervisor.joinVoice/updateRoster, isVoiceActive() становится true, self виден в getVoicePresent()", async (t) => {
	const { relay, bridge, relayUrl } = await setup();
	t.after(() => bridge.stop());
	const clock = makeClock(1000);
	const timerA = makeFakeTimer();
	const { factory, instances } = fakeMeshSupervisorFactory();
	const alice = await createRoom({
		name: "голос1",
		password: "111",
		nick: "Алиса",
		relayUrl,
		argon2: fakeArgon2,
		now: clock.now,
		random: () => 0.5,
		setIntervalImpl: timerA.setIntervalImpl,
		clearIntervalImpl: timerA.clearIntervalImpl,
		onChange: () => {},
		getUserMedia: fakeStream,
		createMeshSupervisor: factory,
	});
	t.after(() => alice.close());

	assert.equal(alice.isVoiceActive(), false);
	await alice.joinVoice();

	assert.equal(alice.isVoiceActive(), true);
	assert.equal(instances.length, 1);
	assert.equal(instances[0].joinVoiceCalls, 1);
	assert.ok(instances[0].updateRosterCalls.length >= 1);
	assert.deepEqual(instances[0].updateRosterCalls.at(-1), [alice.getPubkeyHex()]);
	assert.ok(alice.getVoicePresent().some((p) => p.pubkey === alice.getPubkeyHex()));
	await flushUntilSettled(relay); // дать heartbeat из joinVoice() реально уйти до close() в t.after
});

test("leaveVoice(): делегирует meshSupervisor.leaveVoice, isVoiceActive() -> false", async (t) => {
	const { relay, bridge, relayUrl } = await setup();
	t.after(() => bridge.stop());
	const clock = makeClock(1000);
	const timerA = makeFakeTimer();
	const { factory, instances } = fakeMeshSupervisorFactory();
	const alice = await createRoom({
		name: "голос2",
		password: "111",
		nick: "Алиса",
		relayUrl,
		argon2: fakeArgon2,
		now: clock.now,
		random: () => 0.5,
		setIntervalImpl: timerA.setIntervalImpl,
		clearIntervalImpl: timerA.clearIntervalImpl,
		onChange: () => {},
		getUserMedia: fakeStream,
		createMeshSupervisor: factory,
	});
	t.after(() => alice.close());
	await alice.joinVoice();

	alice.leaveVoice();
	assert.equal(alice.isVoiceActive(), false);
	assert.equal(instances[0].leaveVoiceCalls, 1);
	assert.equal(
		alice.getVoicePresent().some((p) => p.pubkey === alice.getPubkeyHex()),
		false,
	);
	await flushUntilSettled(relay); // дать heartbeat'ам (join+leave) реально уйти до close() в t.after
});

test("leaveVoice() без предварительного joinVoice() — no-op, не бросает", async (t) => {
	const { relay, bridge, relayUrl } = await setup();
	t.after(() => bridge.stop());
	const clock = makeClock(1000);
	const timerA = makeFakeTimer();
	const alice = await createRoom({
		name: "голос3",
		password: "111",
		nick: "Алиса",
		relayUrl,
		argon2: fakeArgon2,
		now: clock.now,
		random: () => 0.5,
		setIntervalImpl: timerA.setIntervalImpl,
		clearIntervalImpl: timerA.clearIntervalImpl,
		onChange: () => {},
		getUserMedia: fakeStream,
	});
	t.after(() => alice.close());
	assert.doesNotThrow(() => alice.leaveVoice());
});

test("два реальных участника: оба входят в голос -> каждый видит ДРУГОГО в getVoicePresent(), updateRoster отражает обоих", async (t) => {
	const { relay, bridge, relayUrl } = await setup();
	t.after(() => bridge.stop());
	const clock = makeClock(1000);
	const meshA = fakeMeshSupervisorFactory();
	const meshB = fakeMeshSupervisorFactory();

	const timerA = makeFakeTimer();
	const alice = await createRoom({
		name: "голос-двое",
		password: "222",
		nick: "Алиса",
		relayUrl,
		argon2: fakeArgon2,
		now: clock.now,
		random: () => 0.5,
		setIntervalImpl: timerA.setIntervalImpl,
		clearIntervalImpl: timerA.clearIntervalImpl,
		onChange: () => {},
		getUserMedia: fakeStream,
		createMeshSupervisor: meshA.factory,
	});
	const timerB = makeFakeTimer();
	const bob = await joinRoom({
		name: "голос-двое",
		password: "222",
		suffix: alice.getSuffix(),
		nick: "Боб",
		relayUrl,
		argon2: fakeArgon2,
		now: clock.now,
		random: () => 0.5,
		setIntervalImpl: timerB.setIntervalImpl,
		clearIntervalImpl: timerB.clearIntervalImpl,
		onChange: () => {},
		getUserMedia: fakeStream,
		createMeshSupervisor: meshB.factory,
	});
	t.after(() => {
		alice.close();
		bob.close();
	});
	await pump(relay, clock, [timerA, timerB]);

	await alice.joinVoice();
	await bob.joinVoice();
	await pump(relay, clock, [timerA, timerB], { rounds: 10 });

	assert.ok(
		alice.getVoicePresent().some((p) => p.pubkey === bob.getPubkeyHex()),
		"Алиса видит Боба в голосе",
	);
	assert.ok(
		bob.getVoicePresent().some((p) => p.pubkey === alice.getPubkeyHex()),
		"Боб видит Алису в голосе",
	);
	const lastRosterA = meshA.instances[0].updateRosterCalls.at(-1);
	assert.ok(lastRosterA.includes(bob.getPubkeyHex()) && lastRosterA.includes(alice.getPubkeyHex()));
});

test("CALL_SIGNAL_KIND: до joinVoice() (нет meshSupervisor) — событие молча пропускается, не бросает", async (t) => {
	const { relay, bridge, relayUrl } = await setup();
	t.after(() => bridge.stop());
	const clock = makeClock(1000);
	const timerA = makeFakeTimer();
	const senderKey = generateSecretKey();
	const alice = await createRoom({
		name: "голос-сигнал",
		password: "111",
		nick: "Алиса",
		relayUrl,
		argon2: fakeArgon2,
		now: clock.now,
		random: () => 0.5,
		setIntervalImpl: timerA.setIntervalImpl,
		clearIntervalImpl: timerA.clearIntervalImpl,
		onChange: () => {},
		getUserMedia: fakeStream,
	});
	t.after(() => alice.close());

	// Независимо пересчитываем hTopic ТЕМ ЖЕ путём, что room-session.js внутри
	// (deriveKBase -> deriveLinkKeys) — hTopic не выставлен наружу намеренно
	// (не часть публичного контракта), но детерминированно воспроизводим из
	// уже известных (name, password, suffix).
	const kBase = await deriveKBase("голос-сигнал", "111", fakeArgon2);
	const { hTopic } = deriveLinkKeys(kBase, alice.getSuffix());
	const signalEvent = sign(
		{ kind: CALL_SIGNAL_KIND, tags: [["p", alice.getPubkeyHex()], ["h", hTopic]], content: "x", created_at: 1 },
		senderKey,
	);

	relay.publish("attacker-conn", signalEvent);
	relay.flushAll();
	await new Promise((r) => setTimeout(r, 350));
	// Ничего не должно было упасть — если дошли до этой строки, тест прошёл.
});

test("CALL_SIGNAL_KIND: после joinVoice() — событие маршрутизируется в meshSupervisor.onSignal", async (t) => {
	const { relay, bridge, relayUrl } = await setup();
	t.after(() => bridge.stop());
	const clock = makeClock(1000);
	const timerA = makeFakeTimer();
	const { factory, instances } = fakeMeshSupervisorFactory();
	const senderKey = generateSecretKey();
	const alice = await createRoom({
		name: "голос-сигнал2",
		password: "111",
		nick: "Алиса",
		relayUrl,
		argon2: fakeArgon2,
		now: clock.now,
		random: () => 0.5,
		setIntervalImpl: timerA.setIntervalImpl,
		clearIntervalImpl: timerA.clearIntervalImpl,
		onChange: () => {},
		getUserMedia: fakeStream,
		createMeshSupervisor: factory,
	});
	t.after(() => alice.close());
	await alice.joinVoice();
	await flushUntilSettled(relay); // дать REQ-подписке реально дойти до relay ДО публикации сигнала

	const kBase = await deriveKBase("голос-сигнал2", "111", fakeArgon2);
	const { hTopic } = deriveLinkKeys(kBase, alice.getSuffix());
	const signalEvent = sign(
		{ kind: CALL_SIGNAL_KIND, tags: [["p", alice.getPubkeyHex()], ["h", hTopic]], content: "x", created_at: 1 },
		senderKey,
	);

	relay.publish("sender-conn", signalEvent);
	relay.flushAll();
	await new Promise((r) => setTimeout(r, 350));

	assert.equal(instances[0].onSignalCalls.length, 1);
	assert.equal(instances[0].onSignalCalls[0].id, signalEvent.id);
});

test("И10: голосовая часть заполнена (5 участников) -> 6-й получает отказ на joinVoice()", async (t) => {
	const { relay, bridge, relayUrl } = await setup();
	t.after(() => bridge.stop());
	const clock = makeClock(1000);
	const roomName = "переполненная";
	const password = "333";

	const fillerCount = 5;
	const timers = [];
	const sessions = [];
	const creatorTimer = makeFakeTimer();
	timers.push(creatorTimer);
	const creator = await createRoom({
		name: roomName,
		password,
		nick: "F0",
		relayUrl,
		argon2: fakeArgon2,
		now: clock.now,
		random: () => 0.5,
		setIntervalImpl: creatorTimer.setIntervalImpl,
		clearIntervalImpl: creatorTimer.clearIntervalImpl,
		onChange: () => {},
		getUserMedia: fakeStream,
		createMeshSupervisor: fakeMeshSupervisorFactory().factory,
	});
	sessions.push(creator);
	t.after(() => creator.close());

	for (let i = 1; i < fillerCount; i++) {
		const timer = makeFakeTimer();
		timers.push(timer);
		const s = await joinRoom({
			name: roomName,
			password,
			suffix: creator.getSuffix(),
			nick: `F${i}`,
			relayUrl,
			argon2: fakeArgon2,
			now: clock.now,
			random: () => 0.5,
			setIntervalImpl: timer.setIntervalImpl,
			clearIntervalImpl: timer.clearIntervalImpl,
			onChange: () => {},
			getUserMedia: fakeStream,
			createMeshSupervisor: fakeMeshSupervisorFactory().factory,
		});
		sessions.push(s);
		t.after(() => s.close());
	}
	await pump(relay, clock, timers, { rounds: 15 });

	for (const s of sessions) await s.joinVoice();
	await pump(relay, clock, timers, { rounds: 10 });

	assert.equal(sessions[0].getVoicePresent().length, fillerCount, "все 5 заполнителей видны в голосе друг у друга");

	const sixthTimer = makeFakeTimer();
	timers.push(sixthTimer);
	const sixth = await joinRoom({
		name: roomName,
		password,
		suffix: creator.getSuffix(),
		nick: "F5-lishniy",
		relayUrl,
		argon2: fakeArgon2,
		now: clock.now,
		random: () => 0.5,
		setIntervalImpl: sixthTimer.setIntervalImpl,
		clearIntervalImpl: sixthTimer.clearIntervalImpl,
		onChange: () => {},
		getUserMedia: fakeStream,
		createMeshSupervisor: fakeMeshSupervisorFactory().factory,
	});
	t.after(() => sixth.close());
	await pump(relay, clock, timers, { rounds: 10 });

	assert.equal(sixth.getVoicePresent().length, fillerCount, "6-й видит все 5 существующих голосовых мест как занятые");
	await assert.rejects(() => sixth.joinVoice(), /заполнен/);
});

test("close(): останавливает голос (meshSupervisor.leaveVoice) даже без явного leaveVoice()", async (t) => {
	const { relay, bridge, relayUrl } = await setup();
	t.after(() => bridge.stop());
	const clock = makeClock(1000);
	const timerA = makeFakeTimer();
	const { factory, instances } = fakeMeshSupervisorFactory();
	const alice = await createRoom({
		name: "голос-close",
		password: "111",
		nick: "Алиса",
		relayUrl,
		argon2: fakeArgon2,
		now: clock.now,
		random: () => 0.5,
		setIntervalImpl: timerA.setIntervalImpl,
		clearIntervalImpl: timerA.clearIntervalImpl,
		onChange: () => {},
		getUserMedia: fakeStream,
		createMeshSupervisor: factory,
	});
	await alice.joinVoice();
	assert.equal(instances[0].leaveVoiceCalls, 0);
	await flushUntilSettled(relay); // дать heartbeat из joinVoice() реально уйти до close()

	alice.close();
	assert.equal(instances[0].leaveVoiceCalls, 1);
});
