// Rooms, этап 4 — mesh-supervisor.js. Тесты до кода (skill п.14). Контракт и
// design-записка — PROCESS-DOCS/CONTRACTS.md "Rooms — Этап 4" (mesh-supervisor.js).
// createCallRuntime ИНЪЕЦИРУЕТСЯ фейком (тот же DI-приём, что media-controller.js
// сам использует) — реальный WebRTC недоступен в node:test, и это ровно граница
// ответственности mesh-supervisor.js (оркестрация n(n-1)/2 звонковых runtime'ов,
// не сам WebRTC).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMeshSupervisor } from "../src/domain/rooms/adapters/mesh-supervisor.js";

const ALICE = "a".repeat(64);
const BOB = "b".repeat(64);
const CAROL = "c".repeat(64);
const DAVE = "d".repeat(64);

function fakeStream(id) {
	const stream = {
		id,
		cloneCount: 0,
		tracks: [{ stopped: false, stop() { this.stopped = true; } }],
		getTracks() {
			return stream.tracks;
		},
		clone() {
			stream.cloneCount += 1;
			return { id: `${id}-clone-${stream.cloneCount}`, isClone: true, source: id };
		},
	};
	return stream;
}

// Фейковый createCallRuntime — записывает вызовы, позволяет тесту вручную
// дёрнуть onStateChange (эмулируя INCOMING_RINGING) и handleIncomingSignal.
function fakeCallRuntimeFactory() {
	const instances = []; // {options, placeCalls, hangupCalls, acceptCalls, incomingSignals, state}
	function createFakeCallRuntime(options) {
		const instance = {
			options,
			placeCalls: [],
			hangupCalls: 0,
			acceptCalls: 0,
			incomingSignals: [],
			state: { name: "IDLE" },
		};
		const runtime = {
			placeCall: (peerPubkey) => {
				instance.placeCalls.push(peerPubkey);
				instance.state = { name: "OUTGOING_RINGING" };
			},
			accept: () => {
				instance.acceptCalls += 1;
				instance.state = { name: "CONNECTED" };
			},
			reject: () => {},
			hangup: () => {
				instance.hangupCalls += 1;
				instance.state = { name: "ENDED" };
			},
			handleIncomingSignal: (event) => {
				instance.incomingSignals.push(event);
			},
			getState: () => instance.state,
			dismissEnded: () => {},
		};
		instance.runtime = runtime;
		instances.push(instance);
		return runtime;
	}
	return { createFakeCallRuntime, instances };
}

function setup({ selfPubkey = ALICE, maxVoice = 5, onRemoteStream, onLocalStream } = {}) {
	const { createFakeCallRuntime, instances } = fakeCallRuntimeFactory();
	const stream = fakeStream("shared");
	const published = [];
	const supervisor = createMeshSupervisor({
		selfPubkey,
		selfPrivKey: new Uint8Array(32),
		hTopic: "topic".padStart(64, "0"),
		publish: async (event) => {
			published.push(event);
			return { ok: true };
		},
		maxVoice,
		getUserMedia: async () => stream,
		createCallRuntime: createFakeCallRuntime,
		...(onRemoteStream ? { onRemoteStream } : {}),
		...(onLocalStream ? { onLocalStream } : {}),
	});
	return { supervisor, instances, stream, published };
}

test("joinVoice(): захватывает shared stream через инъецированный getUserMedia", async () => {
	const { supervisor, stream } = setup();
	await supervisor.joinVoice();
	assert.equal(stream.cloneCount, 0, "сам joinVoice ещё не создаёт рёбер — клоны появляются только на updateRoster");
});

test("updateRoster: self с МЕНЬШИМ pubkey -> инициатор -> placeCall вызван на runtime к пиру", async () => {
	const { supervisor, instances } = setup({ selfPubkey: ALICE }); // ALICE < BOB лексикографически
	await supervisor.joinVoice();
	supervisor.updateRoster([ALICE, BOB]);

	assert.equal(instances.length, 1, "ровно одно ребро (единственная пара ALICE-BOB)");
	assert.deepEqual(instances[0].placeCalls, [BOB]);
});

test("updateRoster: self с БОЛЬШИМ pubkey -> ответчик -> placeCall НЕ вызывается, ждёт входящий offer", async () => {
	const { supervisor, instances } = setup({ selfPubkey: BOB }); // BOB > ALICE
	await supervisor.joinVoice();
	supervisor.updateRoster([ALICE, BOB]);

	assert.equal(instances.length, 1);
	assert.deepEqual(instances[0].placeCalls, [], "ответчик не инициирует");
});

test("updateRoster: ребро, переданное дочернему runtime для клонирования потока, использует sharedStream.clone(), не сам поток", async () => {
	const { supervisor, instances, stream } = setup({ selfPubkey: ALICE });
	await supervisor.joinVoice();
	supervisor.updateRoster([ALICE, BOB]);

	const opts = instances[0].options;
	assert.equal(typeof opts.getUserMediaImpl, "function", "дочернему runtime передан getUserMediaImpl");
	const cloned = await opts.getUserMediaImpl();
	assert.ok(cloned.isClone, "дочерний getUserMediaImpl возвращает КЛОН, не сырой sharedStream");
	assert.equal(stream.cloneCount, 1);
});

test("updateRoster: рост ростера (третий участник) добавляет ТОЛЬКО новое ребро, существующее не трогает", async () => {
	const { supervisor, instances } = setup({ selfPubkey: ALICE });
	await supervisor.joinVoice();
	supervisor.updateRoster([ALICE, BOB]);
	assert.equal(instances.length, 1);
	const firstEdgeRuntime = instances[0];

	supervisor.updateRoster([ALICE, BOB, CAROL]); // ALICE < CAROL — новое ребро ALICE-CAROL, ALICE инициатор
	assert.equal(instances.length, 2, "добавилось ровно одно новое ребро");
	assert.equal(firstEdgeRuntime.hangupCalls, 0, "существующее ребро ALICE-BOB не тронуто");
	assert.deepEqual(instances[1].placeCalls, [CAROL]);
});

test("updateRoster: уход участника закрывает ребро (hangup), убирает его из карты", async () => {
	const { supervisor, instances } = setup({ selfPubkey: ALICE });
	await supervisor.joinVoice();
	supervisor.updateRoster([ALICE, BOB]);
	assert.equal(instances[0].hangupCalls, 0);

	supervisor.updateRoster([ALICE]); // BOB вышел из голоса
	assert.equal(instances[0].hangupCalls, 1);

	const states = supervisor.getEdgeStates();
	assert.deepEqual(states, [], "ребро к BOB больше не отслеживается");
});

test("updateRoster ДО joinVoice() — no-op (нет sharedStream, нечем открывать рёбра)", () => {
	const { supervisor, instances } = setup({ selfPubkey: ALICE });
	supervisor.updateRoster([ALICE, BOB]);
	assert.equal(instances.length, 0);
});

test("авто-accept: onStateChange('INCOMING_RINGING') на дочернем runtime -> supervisor сам вызывает accept(), без участия пользователя", async () => {
	const { supervisor, instances } = setup({ selfPubkey: BOB }); // ответчик для ALICE
	await supervisor.joinVoice();
	supervisor.updateRoster([ALICE, BOB]);

	const child = instances[0];
	assert.equal(child.acceptCalls, 0);
	child.options.onStateChange("INCOMING_RINGING");
	assert.equal(child.acceptCalls, 1, "supervisor должен был сам вызвать accept()");
});

test("onSignal(event): маршрутизирует по event.pubkey к правильному ребру", async () => {
	const { supervisor, instances } = setup({ selfPubkey: ALICE });
	await supervisor.joinVoice();
	supervisor.updateRoster([ALICE, BOB]);

	const fakeEvent = { pubkey: BOB, kind: 20075, content: "x", tags: [], id: "e1" };
	supervisor.onSignal(fakeEvent);
	assert.deepEqual(instances[0].incomingSignals, [fakeEvent]);
});

test("onSignal(event): событие от неизвестного (нет такого ребра) senderPubkey -> молча отбрасывается, не бросает", async () => {
	const { supervisor } = setup({ selfPubkey: ALICE });
	await supervisor.joinVoice();
	supervisor.updateRoster([ALICE, BOB]);

	const fakeEvent = { pubkey: DAVE, kind: 20075, content: "x", tags: [], id: "e2" };
	assert.doesNotThrow(() => supervisor.onSignal(fakeEvent));
});

test("leaveVoice(): вешает трубку на всех рёбрах, останавливает shared stream, освобождает карту", async () => {
	const { supervisor, instances, stream } = setup({ selfPubkey: ALICE });
	await supervisor.joinVoice();
	supervisor.updateRoster([ALICE, BOB, CAROL]);
	assert.equal(instances.length, 2);

	supervisor.leaveVoice();
	assert.equal(instances[0].hangupCalls, 1);
	assert.equal(instances[1].hangupCalls, 1);
	assert.equal(stream.tracks[0].stopped, true, "shared stream остановлен ОДИН раз в leaveVoice()");
	assert.deepEqual(supervisor.getEdgeStates(), []);
});

test("leaveVoice() затем updateRoster() — no-op, sharedStream уже null (симметрично проверке 'до joinVoice')", async () => {
	const { supervisor, instances } = setup({ selfPubkey: ALICE });
	await supervisor.joinVoice();
	supervisor.updateRoster([ALICE, BOB]);
	supervisor.leaveVoice();
	instances.length = 0; // сброс счётчика для чистоты следующей проверки

	supervisor.updateRoster([ALICE, BOB, CAROL]);
	assert.equal(instances.length, 0, "без активного sharedStream новые рёбра не открываются");
});

test("getEdgeStates(): отражает peer/role/state для каждого активного ребра", async () => {
	const { supervisor, instances } = setup({ selfPubkey: ALICE });
	await supervisor.joinVoice();
	supervisor.updateRoster([ALICE, BOB]);
	instances[0].state = { name: "CONNECTED" };

	const states = supervisor.getEdgeStates();
	assert.deepEqual(states, [{ peer: BOB, role: "initiator", state: "CONNECTED" }]);
});

test("maxVoice: защитное усечение — updateRoster с ростером длиннее maxVoice берёт только префикс", async () => {
	const { supervisor, instances } = setup({ selfPubkey: ALICE, maxVoice: 2 });
	await supervisor.joinVoice();
	// Ростер длиной 4 при maxVoice=2 -> берётся префикс [ALICE, BOB] -> только одно ребро ALICE-BOB
	supervisor.updateRoster([ALICE, BOB, CAROL, DAVE]);

	assert.equal(instances.length, 1, "усечено до maxVoice=2 -> ровно одна пара");
	assert.deepEqual(instances[0].placeCalls, [BOB]);
});

test("hTopic/publish/iceServers пробрасываются в каждый дочерний createCallRuntime", async () => {
	const hTopic = "specific-topic".padStart(64, "0");
	const { createFakeCallRuntime, instances } = fakeCallRuntimeFactory();
	const stream = fakeStream("s");
	const publishFn = async () => ({ ok: true });
	const supervisor = createMeshSupervisor({
		selfPubkey: ALICE,
		selfPrivKey: new Uint8Array(32).fill(9),
		hTopic,
		publish: publishFn,
		maxVoice: 5,
		getUserMedia: async () => stream,
		iceServers: [{ urls: "stun:example.org" }],
		createCallRuntime: createFakeCallRuntime,
	});
	await supervisor.joinVoice();
	supervisor.updateRoster([ALICE, BOB]);

	const opts = instances[0].options;
	assert.equal(opts.myPubkey, ALICE);
	assert.equal(opts.hTopic, hTopic);
	assert.equal(opts.publish, publishFn);
	assert.deepEqual(opts.iceServers, [{ urls: "stun:example.org" }]);
});

test("живая находка №2 (тишина СОХРАНИЛАСЬ после фикса onSignal): дочернему runtime передан onRemoteStream, форвардящий (peer, stream) наверх в инъецированный колбэк супервизора", async () => {
	const remoteStreamCalls = [];
	const { supervisor, instances } = setup({ selfPubkey: ALICE, onRemoteStream: (peer, stream) => remoteStreamCalls.push([peer, stream]) });
	await supervisor.joinVoice();
	supervisor.updateRoster([ALICE, BOB]);

	assert.equal(typeof instances[0].options.onRemoteStream, "function", "media-controller.js должен получить onRemoteStream, иначе ontrack некуда девать (та же дыра, что уже чинилась в 1:1-звонках, call-overlay.jsx)");
	const fakeRemote = { id: "remote-track-stream" };
	instances[0].options.onRemoteStream(fakeRemote);
	assert.deepEqual(remoteStreamCalls, [[BOB, fakeRemote]], "супервизор форвардит поток С ПРАВИЛЬНЫМ peer, не просто наружу");
});

test("живая находка №2: закрытие ребра (updateRoster убрал пира) шлёт onRemoteStream(peer, null) — UI обязана остановить/убрать <audio>", async () => {
	const remoteStreamCalls = [];
	const { supervisor } = setup({ selfPubkey: ALICE, onRemoteStream: (peer, stream) => remoteStreamCalls.push([peer, stream]) });
	await supervisor.joinVoice();
	supervisor.updateRoster([ALICE, BOB]);
	remoteStreamCalls.length = 0; // интересует только момент закрытия
	supervisor.updateRoster([ALICE]); // BOB вышел -> ребро закрывается

	assert.deepEqual(remoteStreamCalls, [[BOB, null]]);
});

test("Этап 5: joinVoice() вызывает onLocalStream(sharedStream) — сырой поток, не клон (нужен audio-graph.js для собственного уровня/спектрограммы)", async () => {
	const localStreamCalls = [];
	const { supervisor, stream } = setup({ onLocalStream: (s) => localStreamCalls.push(s) });
	await supervisor.joinVoice();

	assert.deepEqual(localStreamCalls, [stream]);
});

test("Этап 5: leaveVoice() вызывает onLocalStream(null) ДО остановки треков", async () => {
	const localStreamCalls = [];
	const { supervisor, stream } = setup({ onLocalStream: (s) => localStreamCalls.push(s) });
	await supervisor.joinVoice();
	localStreamCalls.length = 0;
	supervisor.leaveVoice();

	assert.deepEqual(localStreamCalls, [null]);
	assert.ok(stream.tracks[0].stopped, "трек всё равно останавливается — onLocalStream(null) не заменяет leaveVoice()'s cleanup");
});

test("Этап 5: leaveVoice() без предварительного joinVoice() — onLocalStream НЕ вызывается (нечего анонсировать)", () => {
	const localStreamCalls = [];
	const { supervisor } = setup({ onLocalStream: (s) => localStreamCalls.push(s) });
	supervisor.leaveVoice();

	assert.deepEqual(localStreamCalls, []);
});

// --- Адверсарная фаза (skill п.19) ---

test("адверсарно: повторный updateRoster с ТЕМ ЖЕ составом — идемпотентно, не пересоздаёт рёбра", async () => {
	const { supervisor, instances } = setup({ selfPubkey: ALICE });
	await supervisor.joinVoice();
	supervisor.updateRoster([ALICE, BOB]);
	assert.equal(instances.length, 1);
	assert.equal(instances[0].placeCalls.length, 1);

	supervisor.updateRoster([ALICE, BOB]); // тот же состав ещё раз
	assert.equal(instances.length, 1, "не создалось второе ребро на ту же пару");
	assert.equal(instances[0].placeCalls.length, 1, "placeCall не вызван повторно");
	assert.equal(instances[0].hangupCalls, 0, "ребро не закрывалось и не переоткрывалось");
});

test("адверсарно: onSignal ПОСЛЕ того, как ребро уже закрыто тем же тиком updateRoster — молча отброшено, не бросает", async () => {
	const { supervisor, instances } = setup({ selfPubkey: ALICE });
	await supervisor.joinVoice();
	supervisor.updateRoster([ALICE, BOB]);
	supervisor.updateRoster([ALICE]); // BOB вышел, ребро закрыто
	assert.equal(instances[0].hangupCalls, 1);

	const staleSignal = { pubkey: BOB, kind: 20075, content: "x", tags: [], id: "stale" };
	assert.doesNotThrow(() => supervisor.onSignal(staleSignal));
	assert.deepEqual(instances[0].incomingSignals, [], "закрытое ребро не получает сигналов");
});

test("адверсарно: leaveVoice() без единого открытого ребра (сразу после joinVoice) — не бросает", async () => {
	const { supervisor, stream } = setup({ selfPubkey: ALICE });
	await supervisor.joinVoice();
	assert.doesNotThrow(() => supervisor.leaveVoice());
	assert.equal(stream.tracks[0].stopped, true);
});

test("адверсарно: updateRoster с пустым массивом (роспуск голоса извне, без leaveVoice) — закрывает все рёбра", async () => {
	const { supervisor, instances } = setup({ selfPubkey: ALICE });
	await supervisor.joinVoice();
	supervisor.updateRoster([ALICE, BOB, CAROL]);
	assert.equal(instances.length, 2);

	supervisor.updateRoster([]); // сам ALICE тоже "исчез" из переданного ростера
	assert.equal(instances[0].hangupCalls, 1);
	assert.equal(instances[1].hangupCalls, 1);
	assert.deepEqual(supervisor.getEdgeStates(), []);
});

// --- Живая находка (три реальных браузера, полная тишина): гонка heartbeat/offer ---

test("живая находка: onSignal ОТ ПИРА, ещё НЕ известного через updateRoster (offer обогнал heartbeat) — реактивно открывает ребро как responder, не роняет offer молча", async (t) => {
	const { supervisor, instances } = setup({ selfPubkey: BOB }); // BOB > ALICE -> BOB был бы responder
	await supervisor.joinVoice();
	// updateRoster НЕ вызывался вовсе — BOB ещё не узнал через presence, что ALICE в голосе,
	// но offer от ALICE уже пришёл (ровно гонка, найденная живьём).
	assert.equal(instances.length, 0);

	const offerEvent = { pubkey: ALICE, kind: 20075, content: "x", tags: [], id: "e1" };
	supervisor.onSignal(offerEvent);

	assert.equal(instances.length, 1, "ребро открыто реактивно, offer не потерян");
	assert.deepEqual(instances[0].incomingSignals, [offerEvent]);
	assert.deepEqual(instances[0].placeCalls, [], "мы НЕ инициатор — сами не звоним, только приняли");
	assert.deepEqual(supervisor.getEdgeStates(), [{ peer: ALICE, role: "responder", state: "IDLE" }]);
});

test("живая находка: после реактивного открытия ПОСЛЕДУЮЩИЙ updateRoster с тем же ростером НЕ дублирует и НЕ закрывает ребро", async (t) => {
	const { supervisor, instances } = setup({ selfPubkey: BOB });
	await supervisor.joinVoice();

	const offerEvent = { pubkey: ALICE, kind: 20075, content: "x", tags: [], id: "e1" };
	supervisor.onSignal(offerEvent); // реактивное открытие ДО updateRoster

	// Presence наконец догнал — тот же ростер, что уже фактически отражён реактивно.
	supervisor.updateRoster([ALICE, BOB]);

	assert.equal(instances.length, 1, "НЕ создалось второе (дублирующее) ребро");
	assert.equal(instances[0].hangupCalls, 0, "и не закрылось как 'неизвестное' updateRoster'у ребро");
});

test("живая находка: onSignal от неизвестного пира ДО joinVoice() (нет sharedStream) — молча отброшено, не бросает", async () => {
	const { supervisor, instances } = setup({ selfPubkey: BOB });
	// joinVoice() НЕ вызывался.
	const offerEvent = { pubkey: ALICE, kind: 20075, content: "x", tags: [], id: "e1" };
	assert.doesNotThrow(() => supervisor.onSignal(offerEvent));
	assert.equal(instances.length, 0);
});
