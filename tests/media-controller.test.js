import { test } from "node:test";
import assert from "node:assert/strict";
import { createMediaController } from "../src/domain/calls/media-controller.js";

// Этап 48, п.3 — RTCPeerConnection/getUserMedia недоступны в node:test, застаблены
// (тот же DI-приём, что voice.js/voice.test.js). Реальное ICE-согласование — живой
// Playwright (--use-fake-device-for-media-stream), см. план этапа.

function fakeTrack() {
	return { stopped: false, stop() { this.stopped = true; } };
}
function fakeStream(tracks) {
	return { getTracks: () => tracks };
}

class FakeRTCPeerConnection {
	constructor(config) {
		this.config = config;
		this.signalingState = "stable";
		this.iceConnectionState = "new";
		this.localDescription = null;
		this.remoteDescription = null;
		this.addedTracks = [];
		this.addedIceCandidates = [];
		this.closed = false;
		FakeRTCPeerConnection.instances.push(this);
	}
	addTrack(track, stream) {
		this.addedTracks.push({ track, stream });
	}
	async createOffer(opts) {
		this.lastCreateOfferOpts = opts;
		return { type: "offer", sdp: opts?.iceRestart ? "restart-offer-sdp" : "offer-sdp" };
	}
	async createAnswer() {
		return { type: "answer", sdp: "answer-sdp" };
	}
	async setLocalDescription(desc) {
		if (desc.type === "rollback") {
			this.rolledBack = true;
			this.signalingState = "stable";
			return;
		}
		this.localDescription = desc;
		this.signalingState = desc.type === "offer" ? "have-local-offer" : "stable";
	}
	async setRemoteDescription(desc) {
		this.remoteDescription = desc;
		this.signalingState = desc.type === "offer" ? "have-remote-offer" : "stable";
	}
	async addIceCandidate(candidate) {
		this.addedIceCandidates.push(candidate);
	}
	setConfiguration(config) {
		this.setConfigurationCalls = this.setConfigurationCalls ?? [];
		this.setConfigurationCalls.push(config);
	}
	close() {
		this.closed = true;
	}
}
FakeRTCPeerConnection.instances = [];

function makeOptions(extra = {}) {
	FakeRTCPeerConnection.instances = [];
	const events = [];
	const localStreams = [];
	const remoteStreams = [];
	const tracks = [fakeTrack(), fakeTrack()];
	const stream = fakeStream(tracks);
	const getUserMediaImpl = async (constraints) => {
		getUserMediaImpl.calledWith = constraints;
		return stream;
	};
	const controller = createMediaController({
		RTCPeerConnectionImpl: FakeRTCPeerConnection,
		getUserMediaImpl,
		iceServers: [{ urls: "stun:example" }],
		onEvent: (e) => events.push(e),
		onLocalStream: (s) => localStreams.push(s),
		onRemoteStream: (s) => remoteStreams.push(s),
		...extra,
	});
	return { controller, events, localStreams, remoteStreams, tracks, stream, getUserMediaImpl };
}

test("ACQUIRE_MIC: запрашивает микрофон (audio:true), добавляет треки в pc, зовёт onLocalStream", async () => {
	const { controller, getUserMediaImpl, localStreams, stream, tracks } = makeOptions();
	await controller.execute({ type: "ACQUIRE_MIC" });
	assert.deepEqual(getUserMediaImpl.calledWith, { audio: true });
	assert.deepEqual(localStreams, [stream]);
	const pc = FakeRTCPeerConnection.instances[0];
	assert.equal(pc.addedTracks.length, tracks.length);
	assert.equal(pc.config.iceServers[0].urls, "stun:example");
});

test("CREATE_OFFER: createOffer -> setLocalDescription -> эмитит LOCAL_OFFER_READY(pc.localDescription)", async () => {
	const { controller, events } = makeOptions();
	await controller.execute({ type: "CREATE_OFFER" });
	const pc = FakeRTCPeerConnection.instances[0];
	assert.equal(pc.lastCreateOfferOpts, undefined, "обычный CREATE_OFFER — без iceRestart");
	assert.deepEqual(events, [{ type: "LOCAL_OFFER_READY", sdp: { type: "offer", sdp: "offer-sdp" } }]);
	assert.equal(pc.signalingState, "have-local-offer");
});

test("DO_ICE_RESTART: createOffer({iceRestart:true}) -> эмитит LOCAL_OFFER_READY с restart-sdp", async () => {
	const { controller, events } = makeOptions();
	await controller.execute({ type: "DO_ICE_RESTART" });
	const pc = FakeRTCPeerConnection.instances[0];
	assert.deepEqual(pc.lastCreateOfferOpts, { iceRestart: true });
	assert.deepEqual(events, [{ type: "LOCAL_OFFER_READY", sdp: { type: "offer", sdp: "restart-offer-sdp" } }]);
});

// --- TZ-recovery-policy.md §2.3 — DO_ICE_RESTART{recreate,forceRelay} ---

test("DO_ICE_RESTART без recreate (попытки 1-2): setConfiguration() на СУЩЕСТВУЮЩЕМ pc, НЕ пересоздаёт его", async () => {
	const { controller } = makeOptions();
	await controller.execute({ type: "ACQUIRE_MIC" });
	const pcBefore = FakeRTCPeerConnection.instances[0];
	await controller.execute({ type: "DO_ICE_RESTART", recreate: false, forceRelay: false });
	assert.equal(FakeRTCPeerConnection.instances.length, 1, "recreate:false — новый pc не создаётся");
	assert.deepEqual(pcBefore.setConfigurationCalls, [{ iceServers: [{ urls: "stun:example" }] }]);
});

test("DO_ICE_RESTART {recreate:true}: явно закрывает старый pc (освобождает TURN-аллокации), создаёт новый, микрофон НЕ останавливается и переносится на новый pc", async () => {
	const { controller, tracks, stream } = makeOptions();
	await controller.execute({ type: "ACQUIRE_MIC" });
	const oldPc = FakeRTCPeerConnection.instances[0];
	assert.equal(oldPc.addedTracks.length, tracks.length);

	await controller.execute({ type: "DO_ICE_RESTART", recreate: true, forceRelay: false });

	assert.ok(oldPc.closed, "старый pc должен быть явно закрыт ПЕРЕД пересозданием (10-LIVE-INCIDENT §5 — иначе TURN-аллокации висят до серверного таймаута)");
	assert.equal(FakeRTCPeerConnection.instances.length, 2, "создан НОВЫЙ RTCPeerConnection");
	const newPc = FakeRTCPeerConnection.instances[1];
	assert.notEqual(newPc, oldPc);
	assert.ok(tracks.every((t) => !t.stopped), "микрофонный трек НЕ останавливается между попытками (§2.3, буквально)");
	assert.deepEqual(
		newPc.addedTracks.map((a) => a.track),
		tracks,
		"те же самые (живые) треки того же stream переносятся на новый pc",
	);
	assert.equal(newPc.addedTracks[0].stream, stream);
});

test("DO_ICE_RESTART {recreate:true}: трасса получает НОВЫЙ pcId для нового RTCPeerConnection (TZ-recovery-policy.md §7/10-LIVE-INCIDENT §8 — раньше id был один на весь controller, трасса не отличала звонок до/после пересоздания)", async () => {
	const traced = [];
	const { controller } = makeOptions({
		onTrace: (ev, payload) => traced.push({ ev, payload }),
		setIntervalImpl: () => "fake-interval-id", // не полагаемся на реальный таймер в этом тесте
		clearIntervalImpl: () => {},
	});
	await controller.execute({ type: "ACQUIRE_MIC" });
	const pcIdBefore = traced.find((t) => t.ev === "created").payload.pc;
	assert.ok(pcIdBefore);

	await controller.execute({ type: "DO_ICE_RESTART", recreate: true, forceRelay: false });

	const createdEvents = traced.filter((t) => t.ev === "created");
	assert.equal(createdEvents.length, 2, "'created' пишется для каждого RTCPeerConnection");
	const pcIdAfter = createdEvents[1].payload.pc;
	assert.ok(pcIdAfter);
	assert.notEqual(pcIdAfter, pcIdBefore, "id второго pc должен отличаться от первого");

	const pcRecreateEvent = traced.find((t) => t.ev === "pc-recreate");
	assert.ok(pcRecreateEvent, "явное закрытие/пересоздание тоже трассируется");
	assert.equal(pcRecreateEvent.payload.pc, pcIdBefore, "'pc-recreate' пишется ДО пересоздания — ещё со старым id (описывает закрытие старого pc)");
});

test("DO_ICE_RESTART {recreate:true, forceRelay:true}: новый pc создаётся с iceTransportPolicy:'relay'", async () => {
	const { controller } = makeOptions();
	await controller.execute({ type: "ACQUIRE_MIC" });
	await controller.execute({ type: "DO_ICE_RESTART", recreate: true, forceRelay: true });
	const newPc = FakeRTCPeerConnection.instances[1];
	assert.equal(newPc.config.iceTransportPolicy, "relay");
});

test("DO_ICE_RESTART: iceServers-резолвер вызывается с {refreshIfStale:true} перед КАЖДОЙ попыткой (§2.3 — свежесть TURN-кредов)", async () => {
	const calls = [];
	const { controller } = makeOptions({
		iceServers: async (opts) => {
			calls.push(opts);
			return [{ urls: "turn:fresh.example", username: "u", credential: "p" }];
		},
	});
	await controller.execute({ type: "ACQUIRE_MIC" }); // первый резолв — без опций (обычный ensurePc())
	await controller.execute({ type: "DO_ICE_RESTART", recreate: false });
	await controller.execute({ type: "DO_ICE_RESTART", recreate: true });
	assert.deepEqual(calls[0], undefined, "первый вызов, из ensurePc() при ACQUIRE_MIC — без аргументов");
	assert.deepEqual(calls[1], { refreshIfStale: true });
	assert.deepEqual(calls[2], { refreshIfStale: true });
});

test("CREATE_ANSWER: createAnswer -> setLocalDescription -> эмитит LOCAL_ANSWER_READY", async () => {
	const { controller, events } = makeOptions();
	await controller.execute({ type: "CREATE_ANSWER" });
	assert.deepEqual(events, [{ type: "LOCAL_ANSWER_READY", sdp: { type: "answer", sdp: "answer-sdp" } }]);
});

test("SET_REMOTE (обычный случай, без glare): просто setRemoteDescription, без rollback", async () => {
	const { controller } = makeOptions();
	await controller.execute({ type: "ACQUIRE_MIC" }); // создаёт pc в stable
	const pc = FakeRTCPeerConnection.instances[0];
	await controller.execute({ type: "SET_REMOTE", sdp: { type: "offer", sdp: "remote-offer" } });
	assert.deepEqual(pc.remoteDescription, { type: "offer", sdp: "remote-offer" });
	assert.ok(!pc.rolledBack, "rollback не должен вызываться, если своего offer'а не было");
});

test("SET_REMOTE (glare, риск-точка §2.1): свой offer уже отправлен (have-local-offer) + приходит чужой offer -> ROLLBACK перед setRemoteDescription", async () => {
	const { controller } = makeOptions();
	await controller.execute({ type: "CREATE_OFFER" }); // signalingState -> have-local-offer
	const pc = FakeRTCPeerConnection.instances[0];
	assert.equal(pc.signalingState, "have-local-offer");

	await controller.execute({ type: "SET_REMOTE", sdp: { type: "offer", sdp: "peer-offer" } });
	assert.ok(pc.rolledBack, "glare обязан откатить локальное описание ПЕРЕД setRemoteDescription");
	assert.deepEqual(pc.remoteDescription, { type: "offer", sdp: "peer-offer" });
});

test("SET_REMOTE: answer НЕ вызывает rollback, даже если signalingState have-local-offer", async () => {
	const { controller } = makeOptions();
	await controller.execute({ type: "CREATE_OFFER" });
	const pc = FakeRTCPeerConnection.instances[0];
	await controller.execute({ type: "SET_REMOTE", sdp: { type: "answer", sdp: "peer-answer" } });
	assert.ok(!pc.rolledBack, "answer — нормальный ответ на НАШ offer, rollback не нужен");
});

test("ADD_ICE до setRemoteDescription: буферизуется, addIceCandidate НЕ вызывается сразу", async () => {
	const { controller } = makeOptions();
	await controller.execute({ type: "ACQUIRE_MIC" });
	const pc = FakeRTCPeerConnection.instances[0];
	await controller.execute({ type: "ADD_ICE", candidate: "c1" });
	await controller.execute({ type: "ADD_ICE", candidate: "c2" });
	assert.deepEqual(pc.addedIceCandidates, [], "remoteDescription ещё не установлен — кандидаты в буфере");
});

test("ADD_ICE до setRemoteDescription: буфер сливается СРАЗУ ПОСЛЕ SET_REMOTE, в порядке поступления", async () => {
	const { controller } = makeOptions();
	await controller.execute({ type: "ACQUIRE_MIC" });
	const pc = FakeRTCPeerConnection.instances[0];
	await controller.execute({ type: "ADD_ICE", candidate: "c1" });
	await controller.execute({ type: "ADD_ICE", candidate: "c2" });
	await controller.execute({ type: "SET_REMOTE", sdp: { type: "offer", sdp: "x" } });
	assert.deepEqual(pc.addedIceCandidates, ["c1", "c2"]);
});

test("ADD_ICE после SET_REMOTE: добавляется немедленно, без буферизации", async () => {
	const { controller } = makeOptions();
	await controller.execute({ type: "ACQUIRE_MIC" });
	const pc = FakeRTCPeerConnection.instances[0];
	await controller.execute({ type: "SET_REMOTE", sdp: { type: "offer", sdp: "x" } });
	await controller.execute({ type: "ADD_ICE", candidate: "c3" });
	assert.deepEqual(pc.addedIceCandidates, ["c3"]);
});

test("CLOSE_PC: останавливает ВСЕ треки микрофона и закрывает pc", async () => {
	const { controller, tracks } = makeOptions();
	await controller.execute({ type: "ACQUIRE_MIC" });
	const pc = FakeRTCPeerConnection.instances[0];
	await controller.execute({ type: "CLOSE_PC" });
	assert.ok(tracks.every((t) => t.stopped), "микрофон обязан освободиться (иначе индикатор 'запись' висит вечно)");
	assert.ok(pc.closed);
});

test("CLOSE_PC затем новый ACQUIRE_MIC: создаётся НОВЫЙ RTCPeerConnection (новый звонок с нуля)", async () => {
	const { controller } = makeOptions();
	await controller.execute({ type: "ACQUIRE_MIC" });
	await controller.execute({ type: "CLOSE_PC" });
	await controller.execute({ type: "ACQUIRE_MIC" });
	assert.equal(FakeRTCPeerConnection.instances.length, 2, "старый pc не переиспользуется после CLOSE_PC");
});

test("pc переиспользуется (singleton) в рамках ОДНОГО звонка — ACQUIRE_MIC + CREATE_OFFER не создают два разных pc", async () => {
	const { controller } = makeOptions();
	await controller.execute({ type: "ACQUIRE_MIC" });
	await controller.execute({ type: "CREATE_OFFER" });
	assert.equal(FakeRTCPeerConnection.instances.length, 1);
});

test("onicecandidate: реальный candidate -> эмитит LOCAL_ICE; null (конец сбора) -> ничего не эмитит", async () => {
	const { controller, events } = makeOptions();
	await controller.execute({ type: "ACQUIRE_MIC" });
	const pc = FakeRTCPeerConnection.instances[0];
	pc.onicecandidate({ candidate: "real-candidate" });
	pc.onicecandidate({ candidate: null });
	assert.deepEqual(events, [{ type: "LOCAL_ICE", candidate: "real-candidate" }]);
});

test("oniceconnectionstatechange: connected/completed -> ICE_CONNECTED", async () => {
	for (const s of ["connected", "completed"]) {
		const { controller, events } = makeOptions();
		await controller.execute({ type: "ACQUIRE_MIC" });
		const pc = FakeRTCPeerConnection.instances[0];
		pc.iceConnectionState = s;
		pc.oniceconnectionstatechange();
		assert.deepEqual(events, [{ type: "ICE_CONNECTED" }], `состояние ${s}`);
	}
});

test("oniceconnectionstatechange: disconnected -> ICE_DISCONNECTED, failed -> ICE_FAILED", async () => {
	const { controller, events } = makeOptions();
	await controller.execute({ type: "ACQUIRE_MIC" });
	const pc = FakeRTCPeerConnection.instances[0];
	pc.iceConnectionState = "disconnected";
	pc.oniceconnectionstatechange();
	pc.iceConnectionState = "failed";
	pc.oniceconnectionstatechange();
	assert.deepEqual(events, [{ type: "ICE_DISCONNECTED" }, { type: "ICE_FAILED" }]);
});

test("oniceconnectionstatechange: промежуточные состояния (checking/new) не эмитят ничего", async () => {
	const { controller, events } = makeOptions();
	await controller.execute({ type: "ACQUIRE_MIC" });
	const pc = FakeRTCPeerConnection.instances[0];
	pc.iceConnectionState = "checking";
	pc.oniceconnectionstatechange();
	assert.deepEqual(events, []);
});

test("ontrack: зовёт onRemoteStream с первым потоком из event.streams", async () => {
	const { controller, remoteStreams } = makeOptions();
	await controller.execute({ type: "ACQUIRE_MIC" });
	const pc = FakeRTCPeerConnection.instances[0];
	const remoteStream = fakeStream([fakeTrack()]);
	pc.ontrack({ streams: [remoteStream] });
	assert.deepEqual(remoteStreams, [remoteStream]);
});

// Этап 6 (TZ-cicd-hardening) — options.iceServers может быть async-функцией
// (свежие TURN-креды перед КАЖДЫМ новым pc, не один раз при старте сессии).
test("iceServers как async-функция: дожидается ПЕРЕД созданием RTCPeerConnection", async () => {
	const { controller } = makeOptions({
		iceServers: async () => {
			await new Promise((r) => setTimeout(r, 1));
			return [{ urls: "turn:fresh.example", username: "u", credential: "p" }];
		},
	});
	await controller.execute({ type: "ACQUIRE_MIC" });
	const pc = FakeRTCPeerConnection.instances[0];
	assert.deepEqual(pc.config.iceServers, [{ urls: "turn:fresh.example", username: "u", credential: "p" }]);
});

test("iceServers как async-функция: гонка ACQUIRE_MIC + ADD_ICE до готовности pc создаёт РОВНО один RTCPeerConnection", async () => {
	let resolveIce;
	const { controller } = makeOptions({
		iceServers: () => new Promise((r) => (resolveIce = r)),
	});
	const micPromise = controller.execute({ type: "ACQUIRE_MIC" });
	const icePromise = controller.execute({ type: "ADD_ICE", candidate: "c1" });
	resolveIce([{ urls: "stun:race.example" }]);
	await Promise.all([micPromise, icePromise]);
	assert.equal(FakeRTCPeerConnection.instances.length, 1, "оба вызова ensurePc() до готовности pc не должны создать два pc");
});

test("неизвестная команда — execute не бросает, просто ничего не делает", async () => {
	const { controller } = makeOptions();
	await assert.doesNotReject(() => controller.execute({ type: "SEND_OFFER", sdp: "irrelevant" }));
});

// TZ-diag-trace.md §0.4/§6 — без onTrace ни один опрос getStats() не должен
// стартовать: подменяем глобальный setInterval и убеждаемся, что его не
// вызвали ни разу за весь жизненный цикл ACQUIRE_MIC (единственное место,
// где startStatsPolling() мог бы сработать).
test("без onTrace: не появляются НОВЫЕ подписки (onconnectionstatechange/onsignalingstatechange/onicegatheringstatechange/onnegotiationneeded) — их не было в коде до TZ-diag-trace.md", async () => {
	const { controller } = makeOptions(); // без onTrace
	await controller.execute({ type: "ACQUIRE_MIC" });
	const pc = FakeRTCPeerConnection.instances[0];
	assert.equal(pc.onconnectionstatechange, undefined);
	assert.equal(pc.onsignalingstatechange, undefined);
	assert.equal(pc.onicegatheringstatechange, undefined);
	assert.equal(pc.onnegotiationneeded, undefined);
});

test("без onTrace: getStats() не опрашивается вообще — глобальный setInterval не вызывается", async () => {
	const originalSetInterval = globalThis.setInterval;
	let calls = 0;
	globalThis.setInterval = (...args) => {
		calls++;
		return originalSetInterval(...args);
	};
	try {
		const { controller } = makeOptions(); // без onTrace
		await controller.execute({ type: "ACQUIRE_MIC" });
		assert.equal(calls, 0, "setInterval не должен вызываться, когда onTrace не передан");
	} finally {
		globalThis.setInterval = originalSetInterval;
	}
});

test("onTrace: 'created' содержит uris/hasCredentials, 'icecandidate' и 'statechange' приходят при штатных событиях pc", async () => {
	const traced = [];
	const { controller } = makeOptions({
		onTrace: (ev, payload) => traced.push({ ev, payload }),
		setIntervalImpl: () => "fake-interval-id", // не полагаемся на реальный таймер в этом тесте
		clearIntervalImpl: () => {},
	});
	await controller.execute({ type: "ACQUIRE_MIC" });
	const pc = FakeRTCPeerConnection.instances[0];

	const created = traced.find((t) => t.ev === "created");
	assert.ok(created);
	assert.deepEqual(created.payload.uris, ["stun:example"]);
	assert.equal(created.payload.hasCredentials, false);

	pc.iceConnectionState = "checking";
	pc.oniceconnectionstatechange();
	assert.ok(traced.some((t) => t.ev === "statechange" && t.payload.iceConnectionState === "checking"));

	pc.onicecandidate({ candidate: { type: "srflx", protocol: "udp", address: "203.0.113.9", port: 5555 } });
	const candidateTrace = traced.find((t) => t.ev === "icecandidate" && t.payload.candidateType === "srflx");
	assert.ok(candidateTrace);
	// Маскировка — забота call-trace.js (record()), не media-controller.js:
	// здесь передаётся адрес КАК ЕСТЬ, что и проверяем (сырое значение).
	assert.equal(candidateTrace.payload.address, "203.0.113.9");

	await controller.execute({ type: "CLOSE_PC" });
});

test("ownsLocalStream:false — CLOSE_PC не останавливает треки клона", async () => {
	const { controller, tracks } = makeOptions({ ownsLocalStream: false });
	await controller.execute({ type: "ACQUIRE_MIC" });
	await controller.execute({ type: "CLOSE_PC" });
	assert.equal(tracks[0].stopped, false);
});

test("ontrack без streams[0] не бросает и отдаёт поток, если MediaStream доступен", async () => {
	const { controller, remoteStreams } = makeOptions();
	await controller.execute({ type: "CREATE_OFFER" });
	const pc = FakeRTCPeerConnection.instances[0];
	const track = fakeTrack();
	assert.doesNotThrow(() => pc.ontrack({ track, streams: [] }));
	if (typeof MediaStream === "function") {
		assert.equal(remoteStreams.length, 1);
	}
});

test("getInboundAudioStats: inbound-rtp audio + nominated pair", async () => {
	const { controller } = makeOptions();
	await controller.execute({ type: "CREATE_OFFER" });
	const pc = FakeRTCPeerConnection.instances[0];
	pc.getStats = async () => {
		const local = { id: "L", type: "local-candidate", candidateType: "relay" };
		const remote = { id: "R", type: "remote-candidate", candidateType: "srflx" };
		const pair = { id: "P", type: "candidate-pair", nominated: true, state: "succeeded", localCandidateId: "L", remoteCandidateId: "R" };
		const inbound = { id: "I", type: "inbound-rtp", kind: "audio", packetsReceived: 9, bytesReceived: 99, jitter: 0.01 };
		const map = new Map([
			["L", local],
			["R", remote],
			["P", pair],
			["I", inbound],
		]);
		map.forEach = Map.prototype.forEach;
		return map;
	};
	const st = await controller.getInboundAudioStats();
	assert.deepEqual(st, {
		packetsReceived: 9,
		bytesReceived: 99,
		jitter: 0.01,
		localType: "relay",
		remoteType: "srflx",
	});
});

test("onTrace, который бросает исключение, не долетает до media-controller.js (ACQUIRE_MIC всё равно отрабатывает)", async () => {
	const { controller, localStreams } = makeOptions({
		onTrace: () => {
			throw new Error("трассировщик сломан");
		},
		setIntervalImpl: () => "fake-interval-id",
		clearIntervalImpl: () => {},
	});
	await assert.doesNotReject(() => controller.execute({ type: "ACQUIRE_MIC" }));
	assert.equal(localStreams.length, 1);
	await controller.execute({ type: "CLOSE_PC" });
});
