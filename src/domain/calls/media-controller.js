// Этап 48, п.3 (VOICE.md §3) — обёртка RTCPeerConnection. Исполняет медиа-команды
// из call-fsm.js (§1.4), эмитит медиа-события обратно в call-runtime.js (§1.3-C).
// Пишет Claude напрямую (не воркер) — риск-точка glare-rollback (§2.1 VOICE.md):
// "Rollback локального описания завязан на signalingState реального
// RTCPeerConnection — это не вписывается в чистое ядро и не годится для воркера."
//
// DI-паттерн — тот же, что src/domain/attachments/voice.js (getUserMediaImpl
// инъецируется, а не жёстко привязан к navigator.mediaDevices) — тестируется без
// реального микрофона/RTCPeerConnection.

export function createMediaController(options = {}) {
	const RTCPeerConnectionImpl = options.RTCPeerConnectionImpl ?? globalThis.RTCPeerConnection;
	const getUserMediaImpl = options.getUserMediaImpl ?? ((constraints) => navigator.mediaDevices.getUserMedia(constraints));
	const iceServers = options.iceServers ?? [];
	// onEvent — обратный канал в call-runtime.js: события Σ_in (§1.3-C VOICE.md),
	// те же, что call-runtime дальше кормит в reduce(). Контроллер НЕ знает про FSM.
	const onEvent = options.onEvent ?? (() => {});
	// onLocalStream/onRemoteStream — опционально, для UI (волновая визуализация
	// через AnalyserNode, план этапа 48) — сам контроллер их не использует.
	const onLocalStream = options.onLocalStream ?? (() => {});
	const onRemoteStream = options.onRemoteStream ?? (() => {});

	let pc = null;
	let localStream = null;
	// Буфер ICE-кандидатов, пришедших ДО setRemoteDescription (§1.4 VOICE.md:
	// "ADD_ICE безопасен всегда: буферизацию инкапсулирует MediaController").
	let pendingRemoteIce = [];

	function ensurePc() {
		if (pc) return pc;
		pc = new RTCPeerConnectionImpl({ iceServers });
		pc.onicecandidate = (e) => {
			if (e.candidate) onEvent({ type: "LOCAL_ICE", candidate: e.candidate });
		};
		pc.oniceconnectionstatechange = () => {
			const iceState = pc.iceConnectionState;
			if (iceState === "connected" || iceState === "completed") onEvent({ type: "ICE_CONNECTED" });
			else if (iceState === "disconnected") onEvent({ type: "ICE_DISCONNECTED" });
			else if (iceState === "failed") onEvent({ type: "ICE_FAILED" });
		};
		pc.ontrack = (e) => {
			onRemoteStream(e.streams[0]);
		};
		return pc;
	}

	async function acquireMic() {
		localStream = await getUserMediaImpl({ audio: true });
		onLocalStream(localStream);
		const peerConnection = ensurePc();
		for (const track of localStream.getTracks()) {
			peerConnection.addTrack(track, localStream);
		}
	}

	async function createOffer(iceRestart) {
		const peerConnection = ensurePc();
		const offer = await peerConnection.createOffer(iceRestart ? { iceRestart: true } : undefined);
		await peerConnection.setLocalDescription(offer);
		onEvent({ type: "LOCAL_OFFER_READY", sdp: peerConnection.localDescription });
	}

	async function createAnswer() {
		const peerConnection = ensurePc();
		const answer = await peerConnection.createAnswer();
		await peerConnection.setLocalDescription(answer);
		onEvent({ type: "LOCAL_ANSWER_READY", sdp: peerConnection.localDescription });
	}

	// РИСК-ТОЧКА (§2.1 VOICE.md) — glare: если у нас уже отправлен свой offer
	// (signalingState === "have-local-offer") и приходит ЧУЖОЙ offer, нужно
	// СНАЧАЛА откатить своё локальное описание, иначе setRemoteDescription
	// бросит InvalidStateError (WebRTC не допускает offer поверх offer без
	// rollback). Именно эта завязка на живой signalingState не вписывается в
	// чистое ядро call-fsm.js — call-fsm сам не знает про rollback вообще,
	// SET_REMOTE — одна команда что для обычного ответа, что для glare.
	async function setRemote(sdp) {
		const peerConnection = ensurePc();
		if (sdp.type === "offer" && peerConnection.signalingState === "have-local-offer") {
			await peerConnection.setLocalDescription({ type: "rollback" });
		}
		await peerConnection.setRemoteDescription(sdp);
		if (pendingRemoteIce.length > 0) {
			const buffered = pendingRemoteIce;
			pendingRemoteIce = [];
			for (const candidate of buffered) {
				await peerConnection.addIceCandidate(candidate);
			}
		}
	}

	async function addIce(candidate) {
		const peerConnection = ensurePc();
		if (peerConnection.remoteDescription) {
			await peerConnection.addIceCandidate(candidate);
		} else {
			pendingRemoteIce.push(candidate);
		}
	}

	function closePc() {
		if (localStream) {
			for (const track of localStream.getTracks()) track.stop();
			localStream = null;
		}
		if (pc) {
			pc.close();
			pc = null;
		}
		pendingRemoteIce = [];
	}

	// execute(command) — исполняет ОДНУ команду Σ_out (§1.4 VOICE.md), адресованную
	// медиа-слою. Команды сигналинга/таймеров/UI (SEND_*, START_TIMER, CANCEL_TIMER,
	// EMIT) сюда не приходят — call-runtime.js их не пересылает контроллеру.
	async function execute(command) {
		switch (command.type) {
			case "ACQUIRE_MIC":
				return acquireMic();
			case "CREATE_OFFER":
				return createOffer(false);
			case "CREATE_ANSWER":
				return createAnswer();
			case "SET_REMOTE":
				return setRemote(command.sdp);
			case "ADD_ICE":
				return addIce(command.candidate);
			case "DO_ICE_RESTART":
				return createOffer(true);
			case "CLOSE_PC":
				return closePc();
			default:
				return undefined;
		}
	}

	return { execute };
}
