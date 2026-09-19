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
	// options.iceServers — статический массив (обратная совместимость, тесты) ИЛИ
	// async-функция () => iceServers[] — этап 6 (TZ-cicd-hardening): TURN-креды
	// дожидаются здесь, ПЕРЕД созданием RTCPeerConnection (не один раз при старте
	// сессии в call.js — иначе креды протухают к середине долгой сессии).
	const resolveIceServers = typeof options.iceServers === "function" ? options.iceServers : async () => options.iceServers ?? [];
	const ownsLocalStream = options.ownsLocalStream !== false;

	function normalizeIceServers(resolved) {
		if (Array.isArray(resolved)) return resolved;
		if (resolved && Array.isArray(resolved.iceServers)) return resolved.iceServers;
		return [];
	}
	// onEvent — обратный канал в call-runtime.js: события Σ_in (§1.3-C VOICE.md),
	// те же, что call-runtime дальше кормит в reduce(). Контроллер НЕ знает про FSM.
	const onEvent = options.onEvent ?? (() => {});
	// onLocalStream/onRemoteStream — опционально, для UI (волновая визуализация
	// через AnalyserNode, план этапа 48) — сам контроллер их не использует.
	const onLocalStream = options.onLocalStream ?? (() => {});
	const onRemoteStream = options.onRemoteStream ?? (() => {});

	// TZ-diag-trace.md §0.3 — DI, не импорт: этот файл не знает про
	// src/core/diag/call-trace.js вообще, только про необязательный колбэк.
	// onTrace отсутствует (undefined) => каждая точка ниже, включая опрос
	// getStats(), буквально не выполняется — это и есть "нулевая стоимость
	// при выключенном флаге" (TZ §0.4), а не отдельная проверка флага.
	const onTrace = options.onTrace;
	// Тот же кэш, что resolveIceServers уже читает изнутри (bootstrap-endpoints.js) —
	// НЕ повторный запрос кредов, просто чтение того, что уже там лежит (TZ §2.1).
	const getIceCredsExpiryMs = options.getIceCredsExpiryMs ?? (() => null);

	function ttlRemainingSecNow() {
		const expiryMs = getIceCredsExpiryMs();
		return typeof expiryMs === "number" ? Math.round((expiryMs - Date.now()) / 1000) : null;
	}
	const setIntervalImpl = options.setIntervalImpl ?? ((...args) => setInterval(...args));
	const clearIntervalImpl = options.clearIntervalImpl ?? ((...args) => clearInterval(...args));
	// TZ-recovery-policy.md §7/incident §8 — раньше pcId генерировался один раз на
	// весь createMediaController() (одно значение на всю жизнь mesh-грани), из-за
	// чего трасса не отличала звонок ДО пересоздания RTCPeerConnection (DO_ICE_RESTART
	// recreate:true, см. doIceRestart ниже) от звонка ПОСЛЕ — оба писались одним pcId.
	// Теперь id живёт на сам RTCPeerConnection и переприсваивается в ensurePc() при
	// каждом `new RTCPeerConnectionImpl(...)`.
	let pcId = null;

	function trace(ev, payload) {
		if (!onTrace) return;
		try {
			onTrace(ev, { pc: pcId, ...payload });
		} catch {
			// TZ §0.5 — сбой трассировки не должен долетать до звонка
		}
	}

	let pc = null;
	let pcPromise = null;
	let localStream = null;
	let statsIntervalId = null;
	// Буфер ICE-кандидатов, пришедших ДО setRemoteDescription (§1.4 VOICE.md:
	// "ADD_ICE безопасен всегда: буферизацию инкапсулирует MediaController").
	let pendingRemoteIce = [];

	// pcPromise — защита от гонки: resolveIceServers() асинхронна, и без общего
	// in-flight promise два "одновременных" (per-microtask) первых вызова
	// ensurePc() (например ACQUIRE_MIC и уже прилетевший ADD_ICE) оба прошли бы
	// проверку "pc ещё нет" и создали бы ДВА RTCPeerConnection.
	// TZ-recovery-policy.md §2.3 — overrides позволяет DO_ICE_RESTART's
	// пересозданию (см. recreatePcForRestart ниже) передать УЖЕ разрешённые
	// свежие iceServers (не резолвить их дважды) и форсировать iceTransportPolicy
	// "relay" с 3-й попытки, не трогая обычный путь ACQUIRE_MIC/первого коннекта.
	function ensurePc(overrides) {
		if (pc) return Promise.resolve(pc);
		if (!pcPromise) {
			pcPromise = (async () => {
				const resolved = overrides?.iceServers ?? (await resolveIceServers());
				const iceServers = normalizeIceServers(resolved);
				if (!Array.isArray(resolved) && resolved?.turn) {
					trace("turn-status", { status: resolved.turn, urlCount: iceServers.length, tookMs: resolved.tookMs ?? null });
				}
				const config = { iceServers };
				if (overrides?.iceTransportPolicy) config.iceTransportPolicy = overrides.iceTransportPolicy;
				pc = new RTCPeerConnectionImpl(config);
				if (onTrace) pcId = Math.random().toString(36).slice(2, 8);
				trace("created", {
					uris: iceServers.flatMap((s) => (Array.isArray(s.urls) ? s.urls : s.urls ? [s.urls] : [])),
					hasCredentials: iceServers.some((s) => !!s.username),
					ttlRemainingSec: ttlRemainingSecNow(),
					iceTransportPolicy: config.iceTransportPolicy ?? "all",
				});
				pc.onicecandidate = (e) => {
					trace("icecandidate", e.candidate
						? { candidateType: e.candidate.type, protocol: e.candidate.protocol, address: e.candidate.address, port: e.candidate.port, gatheringDone: false }
						: { gatheringDone: true });
					if (e.candidate) onEvent({ type: "LOCAL_ICE", candidate: e.candidate });
				};
				pc.oniceconnectionstatechange = () => {
					const iceState = pc.iceConnectionState;
					trace("statechange", { iceConnectionState: iceState, connectionState: pc.connectionState, signalingState: pc.signalingState, iceGatheringState: pc.iceGatheringState });
					if (iceState === "connected" || iceState === "completed") onEvent({ type: "ICE_CONNECTED" });
					else if (iceState === "disconnected") onEvent({ type: "ICE_DISCONNECTED" });
					else if (iceState === "failed") onEvent({ type: "ICE_FAILED" });
				};
				// TZ §2.1 — существующие подписки (onicecandidate/oniceconnectionstatechange/
				// ontrack) не тронуты выше ни строкой логики, добавлена только трассировка.
				// Эти четыре — НОВЫЕ подписки: их не было в коде до TZ-diag-trace.md, домен
				// (call-fsm.js/call-runtime.js) их не потребляет, они существуют только ради
				// записи (05-tests-media-lifecycle.md, раздел B — этих обработчиков не было
				// нигде, "связь формально жива, звука нет" нечем было поймать). TZ §0.4 —
				// "нулевая стоимость при выключенном флаге" читается буквально: раз эти
				// подписки не нужны никому, кроме трассировки, при onTrace=undefined их
				// не должно существовать вообще, не просто "существуют, но no-op".
				if (onTrace) {
					pc.onconnectionstatechange = () => {
						trace("statechange", { iceConnectionState: pc.iceConnectionState, connectionState: pc.connectionState, signalingState: pc.signalingState, iceGatheringState: pc.iceGatheringState });
					};
					pc.onsignalingstatechange = () => {
						trace("statechange", { iceConnectionState: pc.iceConnectionState, connectionState: pc.connectionState, signalingState: pc.signalingState, iceGatheringState: pc.iceGatheringState });
					};
					pc.onicegatheringstatechange = () => {
						trace("statechange", { iceConnectionState: pc.iceConnectionState, connectionState: pc.connectionState, signalingState: pc.signalingState, iceGatheringState: pc.iceGatheringState });
					};
					pc.onnegotiationneeded = () => {
						trace("negotiationneeded", {});
					};
				}
				pc.ontrack = (e) => {
					trace("track", { kind: e.track?.kind, added: true });
					if (onTrace) {
						e.track.onmute = () => trace("track", { kind: e.track.kind, muteEvent: "mute" });
						e.track.onunmute = () => trace("track", { kind: e.track.kind, muteEvent: "unmute" });
						e.track.onended = () => trace("track", { kind: e.track.kind, muteEvent: "ended" });
					}
					const stream = e.streams?.[0] ?? (e.track && typeof MediaStream === "function" ? new MediaStream([e.track]) : undefined);
					if (stream) onRemoteStream(stream);
				};
				if (onTrace) startStatsPolling();
				return pc;
			})();
		}
		return pcPromise;
	}

	// TZ §2.2 — getStats() нигде в коде звонка не вызывался (04-ice-turn-infra.md,
	// 05-tests-media-lifecycle.md). Опрос существует ТОЛЬКО когда onTrace передан
	// (см. вызов выше) — при выключенном флаге эта функция не создаётся вовсе.
	function summarizeStats(report) {
		let transportStats = null;
		for (const s of report.values()) if (s.type === "transport") transportStats = s;
		const summary = { dtlsState: transportStats?.dtlsState ?? null, iceState: transportStats?.iceState ?? null };
		const pairId = transportStats?.selectedCandidatePairId;
		const pair = pairId ? report.get(pairId) : [...report.values()].find((s) => s.type === "candidate-pair" && s.nominated);
		if (pair) {
			const local = report.get(pair.localCandidateId);
			const remote = report.get(pair.remoteCandidateId);
			summary.pairPath = `${local?.candidateType ?? "?"}/${local?.protocol ?? "?"} -> ${remote?.candidateType ?? "?"}/${remote?.protocol ?? "?"}`;
			summary.currentRoundTripTime = pair.currentRoundTripTime ?? null;
			summary.bytesSent = pair.bytesSent ?? null;
			summary.bytesReceived = pair.bytesReceived ?? null;
			summary.requestsSent = pair.requestsSent ?? null;
			summary.responsesReceived = pair.responsesReceived ?? null;
			summary.consentRequestsSent = pair.consentRequestsSent ?? null;
		}
		for (const s of report.values()) {
			if (s.type === "inbound-rtp" && s.kind === "audio") {
				summary.inboundPacketsReceived = s.packetsReceived ?? null;
				summary.inboundPacketsLost = s.packetsLost ?? null;
				summary.inboundJitter = s.jitter ?? null;
			}
			if (s.type === "outbound-rtp" && s.kind === "audio") {
				summary.outboundPacketsSent = s.packetsSent ?? null;
			}
		}
		return summary;
	}

	function startStatsPolling() {
		statsIntervalId = setIntervalImpl(async () => {
			if (!pc || typeof pc.getStats !== "function") return;
			if (pc.connectionState === "closed") {
				clearIntervalImpl(statsIntervalId);
				statsIntervalId = null;
				return;
			}
			try {
				const report = await pc.getStats();
				trace("stats", summarizeStats(report));
			} catch {
				// TZ §0.5
			}
		}, 1000);
	}

	async function acquireMic() {
		localStream = await getUserMediaImpl({ audio: true });
		onLocalStream(localStream);
		const peerConnection = await ensurePc();
		for (const track of localStream.getTracks()) {
			peerConnection.addTrack(track, localStream);
		}
	}

	async function createOffer(iceRestart) {
		const peerConnection = await ensurePc();
		const offer = await peerConnection.createOffer(iceRestart ? { iceRestart: true } : undefined);
		await peerConnection.setLocalDescription(offer);
		onEvent({ type: "LOCAL_OFFER_READY", sdp: peerConnection.localDescription });
	}

	// TZ-recovery-policy.md §2.3 — исполняет DO_ICE_RESTART{recreate,forceRelay}
	// (call-fsm.js решает КОГДА и с какими флагами, эта функция — КАК):
	//
	// 1. Перед КАЖДОЙ попыткой — свежие TURN-креды, если протухло больше
	//    половины TTL (иначе при сбое на десятки минут креды гарантированно
	//    протухнут, восстановление станет невозможно в принципе).
	// 2. Без recreate (попытки 1-2) — тот же pc, только setConfiguration()
	//    с обновлёнными iceServers.
	// 3. С recreate (с 3-й попытки) — СНАЧАЛА явно pc.close() (освободить
	//    TURN-аллокации предыдущей попытки — найдено 10-LIVE-INCIDENT.md §5:
	//    именно так был исчерпан user-quota=10 за один шторм рестартов), ЗАТЕМ
	//    новый RTCPeerConnection, микрофонный трек НЕ останавливается —
	//    localStream переживает пересоздание, добавляется в НОВЫЙ pc заново
	//    (повторный запрос разрешения микрофона на мобильном может не пройти
	//    без явного жеста пользователя — задание §2.3, буквально).
	async function doIceRestart(command) {
		const recreate = !!command?.recreate;
		const forceRelay = !!command?.forceRelay;

		const iceServers = normalizeIceServers(await resolveIceServers({ refreshIfStale: true }));
		trace("ice-cred-refresh", { hasCredentials: iceServers.some((s) => !!s.username), ttlRemainingSec: ttlRemainingSecNow() });

		if (!recreate) {
			const peerConnection = await ensurePc();
			if (typeof peerConnection.setConfiguration === "function") {
				const config = { iceServers };
				if (forceRelay) config.iceTransportPolicy = "relay";
				peerConnection.setConfiguration(config);
			}
			return createOffer(true);
		}

		trace("pc-recreate", { forceRelay, hadPreviousPc: !!pc });
		if (pc) pc.close(); // §2.3 — явно освободить TURN-аллокации ДО пересоздания
		if (statsIntervalId !== null) {
			clearIntervalImpl(statsIntervalId);
			statsIntervalId = null;
		}
		pc = null;
		pcPromise = null;
		pendingRemoteIce = [];
		const peerConnection = await ensurePc({ iceServers, iceTransportPolicy: forceRelay ? "relay" : undefined });
		if (localStream) {
			for (const track of localStream.getTracks()) peerConnection.addTrack(track, localStream);
		}
		return createOffer(true);
	}

	async function createAnswer() {
		const peerConnection = await ensurePc();
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
		const peerConnection = await ensurePc();
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
		const peerConnection = await ensurePc();
		if (peerConnection.remoteDescription) {
			await peerConnection.addIceCandidate(candidate);
		} else {
			pendingRemoteIce.push(candidate);
		}
	}

	function closePc() {
		if (statsIntervalId !== null) {
			clearIntervalImpl(statsIntervalId);
			statsIntervalId = null;
		}
		if (localStream) {
			if (ownsLocalStream) {
				for (const track of localStream.getTracks()) track.stop();
			}
			localStream = null;
		}
		if (pc) {
			pc.close();
			pc = null;
		}
		pcPromise = null;
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
				return doIceRestart(command);
			case "CLOSE_PC":
				return closePc();
			default:
				return undefined;
		}
	}

	async function getInboundAudioStats() {
		if (!pc || typeof pc.getStats !== "function") return null;
		const report = await pc.getStats();
		let inbound = null;
		let pair = null;
		report.forEach((s) => {
			if (s.type === "inbound-rtp" && s.kind === "audio") inbound = s;
			if (s.type === "candidate-pair" && s.nominated && s.state === "succeeded") pair = s;
		});
		if (!inbound) return null;
		const local = pair ? report.get(pair.localCandidateId) : null;
		const remote = pair ? report.get(pair.remoteCandidateId) : null;
		return {
			packetsReceived: inbound.packetsReceived ?? 0,
			bytesReceived: inbound.bytesReceived ?? 0,
			jitter: inbound.jitter ?? null,
			localType: local?.candidateType ?? null,
			remoteType: remote?.candidateType ?? null,
		};
	}

	return { execute, getInboundAudioStats };
}
