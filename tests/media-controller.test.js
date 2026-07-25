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

test("неизвестная команда — execute не бросает, просто ничего не делает", async () => {
	const { controller } = makeOptions();
	await assert.doesNotReject(() => controller.execute({ type: "SEND_OFFER", sdp: "irrelevant" }));
});
