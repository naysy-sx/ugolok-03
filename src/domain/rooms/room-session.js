// Rooms, этапы 2+3+4 — оркестратор: единственное место, где чистое ядро встречается
// с адаптерами (ROOMS-SPEC.md §1.3). Контракт и design-записка:
// PROCESS-DOCS/CONTRACTS.md "Rooms — Этап 2"/"Этап 3"/"Этап 4" (room-session.js).
//
// Область: LINK-режим (createRoom/joinRoom, name+password+suffix) и открытый
// режим (createRoom({openMode:true})/joinRoomByPassword, name+password —
// suffix находится через указатель под hDisc, ROOMS-MATH §1.2). Этап 4 — голос:
// joinVoice/leaveVoice, VoicePresent через inVoice-флаг heartbeat'а, mesh-supervisor.js.
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { deriveKBase, derivePairKeys, deriveLinkKeys, deriveSessionKey, defaultSlowKdf } from "./room-keys.js";
import { emptyPresence, mergeHeartbeat, mergeExit, present, prune } from "./presence.js";
import { emptyRoomState, create as machineCreate, join as machineJoin, leave as machineLeave, checkTimeout } from "./room-machine.js";
import { createTrickle } from "./trickle.js";
import { createLog } from "./message-log.js";
import {
	buildRoomAnnounceEvent,
	parseRoomAnnounceEvent,
	buildRoomProbeEvent,
	parseRoomProbeEvent,
	buildRoomPresenceEvent,
	parseRoomPresenceEvent,
	buildRoomChatEvent,
	parseRoomChatEvent,
	buildRoomPointerEvent,
	parseRoomPointerEvent,
} from "./room-events.js";
import { ROOM_ANNOUNCE_KIND, ROOM_PROBE_KIND, ROOM_PRESENCE_KIND, ROOM_CHAT_KIND, ROOM_POINTER_KIND } from "../events/kind-registry.js";
import { createEphemeralIdentity } from "./adapters/room-identity.js";
import { openRoomTransport } from "./adapters/room-transport.js";
import { createMeshSupervisor } from "./adapters/mesh-supervisor.js";
import { CALL_SIGNAL_KIND } from "../calls/signaling-adapter.js";

const HEARTBEAT_INTERVAL_MS = 15000; // δ
const PRESENCE_TAU_MS = 45000; // τ — тот же τ используется как окно И9-тайбрейка (ROOMS-MATH §1.4)
const TRICKLE_I_MIN_MS = 15000;
const TRICKLE_I_MAX_MS = 60000;
const TRICKLE_K = 1;
const DISCOVERY_PLACEHOLDER_PUBKEY = "0".repeat(64);
// Р4 (ROOMS-MATH §4.3) — ОДНА именованная константа в ОДНОМ месте.
export const MAX_VOICE_PARTICIPANTS = 5;
const DEFAULT_GET_USER_MEDIA = (constraints) => navigator.mediaDevices.getUserMedia(constraints);

function randomSuffix() {
	return bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
}

function randomSalt() {
	return crypto.getRandomValues(new Uint8Array(32));
}

function syncRoomMachineK(state, targetK, now) {
	if (state.name === "dead" && targetK > 0) state = emptyRoomState();
	while (state.k < targetK) state = state.name === "empty" ? machineCreate(state) : machineJoin(state);
	while (state.k > targetK) state = machineLeave(state, now);
	return state;
}

async function openSession({
	name,
	password,
	suffix,
	nick,
	relayUrl,
	argon2 = defaultSlowKdf,
	now = () => Date.now(),
	random = Math.random,
	sweepIntervalMs = 1000,
	setIntervalImpl = setInterval,
	clearIntervalImpl = clearInterval,
	onChange = () => {},
	isCreator,
	openMode = false,
	precomputedKBase = null,
	getUserMedia = DEFAULT_GET_USER_MEDIA,
	iceServers = [],
	createMeshSupervisor: createMeshSupervisorImpl = createMeshSupervisor,
	onRemoteStream = () => {},
}) {
	const identity = createEphemeralIdentity();
	const kBase = precomputedKBase ?? (await deriveKBase(name, password, argon2));
	const { hDisc, kPointer } = derivePairKeys(kBase);
	const { kRv, hTopic } = deriveLinkKeys(kBase, suffix);

	let ready = false;
	let kSess = null;
	let presenceState = emptyPresence();
	let roomMachineState = emptyRoomState();
	let messageLog = createLog({});
	let lastHeartbeatAt = -Infinity;
	let currentSalt = null;
	const trickle = createTrickle({ iMin: TRICKLE_I_MIN_MS, iMax: TRICKLE_I_MAX_MS, k: TRICKLE_K, random });

	// И9 (ROOMS-MATH §1.4) — только для openMode-создателя.
	let ownPointerId = null;
	let ownPointerPublishedAt = null;
	let bestPointerId = null;
	let bestSuffix = suffix;
	let raceOutcome = null;

	// Этап 4 — голос. meshSupervisor создаётся ЛЕНИВО, при первом joinVoice()
	// (не раньше — незачем существовать, пока пользователь не решил включить голос).
	let voiceActive = false;
	let meshSupervisor = null;

	function getVoicePresent() {
		return present(presenceState, now(), PRESENCE_TAU_MS).filter((p) => p.inVoice);
	}

	function publishHeartbeat(t) {
		const event = buildRoomPresenceEvent(identity.privKey, kSess, hTopic, { type: "heartbeat", nick, inVoice: voiceActive }, t);
		return transport.publish(event);
	}

	function publishAnnounce(t) {
		const event = buildRoomAnnounceEvent(identity.privKey, kRv, hTopic, bytesToHex(currentSalt), t);
		return transport.publish(event);
	}

	function publishProbe(t) {
		const event = buildRoomProbeEvent(identity.privKey, kRv, hTopic, t);
		return transport.publish(event);
	}

	function publishPointer(t) {
		const event = buildRoomPointerEvent(identity.privKey, kPointer, hDisc, suffix, t);
		if (ownPointerId === null) {
			ownPointerId = event.id;
			ownPointerPublishedAt = t;
			bestPointerId = event.id;
		}
		return transport.publish(event);
	}

	function becomeReady(salt, t) {
		currentSalt = salt;
		kSess = deriveSessionKey(kRv, salt);
		ready = true;
		lastHeartbeatAt = -Infinity; // первый sweep-тик после готовности сразу шлёт heartbeat
	}

	function handleEvent(event) {
		switch (event.kind) {
			case ROOM_ANNOUNCE_KIND: {
				const payload = parseRoomAnnounceEvent(event, kRv);
				if (!payload || ready) return;
				becomeReady(hexToBytes(payload.salt), now());
				onChange();
				return;
			}
			case ROOM_PROBE_KIND: {
				const payload = parseRoomProbeEvent(event, kRv);
				if (!payload || !ready) return;
				const t = now();
				publishAnnounce(t);
				// Не только "комната жива" — новичок не увидит УЖЕ присутствующих до их
				// следующего обычного heartbeat (до δ=15с), если те не подтвердятся сразу
				// (найдено тестом: без этого joinRoom видел только себя ~15 раундов подряд).
				publishHeartbeat(t);
				lastHeartbeatAt = t;
				trickle.onInconsistent();
				trickle.onInterval(t);
				return;
			}
			case ROOM_PRESENCE_KIND: {
				if (!ready) return;
				const payload = parseRoomPresenceEvent(event, kSess);
				if (!payload) return;
				if (payload.type === "heartbeat") {
					presenceState = mergeHeartbeat(presenceState, { pubkey: payload.pubkey, nick: payload.nick, inVoice: payload.inVoice, at: payload.at });
				} else if (payload.type === "exit") {
					presenceState = mergeExit(presenceState, { pubkey: payload.pubkey, at: payload.at });
				}
				const t = now();
				const currentK = present(presenceState, t, PRESENCE_TAU_MS).length;
				roomMachineState = syncRoomMachineK(roomMachineState, currentK, t);
				// Этап 4 — новый/ушедший голосовой участник виден немедленно, не ждать
				// следующего sweep-тика (до 1с — некритично, но мгновенная реакция лучше).
				if (voiceActive && meshSupervisor) {
					meshSupervisor.updateRoster(getVoicePresent().map((p) => p.pubkey));
				}
				onChange();
				return;
			}
			case ROOM_CHAT_KIND: {
				if (!ready) return;
				const payload = parseRoomChatEvent(event, kSess);
				if (!payload) return;
				messageLog.insert(payload);
				onChange();
				return;
			}
			case ROOM_POINTER_KIND: {
				if (!openMode || ownPointerId === null) return;
				if (now() - ownPointerPublishedAt >= PRESENCE_TAU_MS) return; // окно гонки закрыто
				const payload = parseRoomPointerEvent(event, kPointer);
				if (!payload) return;
				if (payload.id < bestPointerId) {
					bestPointerId = payload.id;
					bestSuffix = payload.suffix;
					if (bestSuffix !== suffix) {
						raceOutcome = { winningSuffix: bestSuffix };
						onChange();
					}
				}
				return;
			}
			case CALL_SIGNAL_KIND: {
				// room-transport.js уже отфильтровал по тегу p (Этап 2) — событие точно
				// адресовано нам. meshSupervisor может отсутствовать (голос ещё не включён
				// НИ разу за сессию) — тогда сигналу просто некому маршрутизировать.
				if (meshSupervisor) meshSupervisor.onSignal(event);
				return;
			}
			default:
				return; // неизвестный/будущий kind — молча пропускаем
		}
	}

	const transport = await openRoomTransport({
		relayUrl,
		hTopic,
		hDisc: openMode ? hDisc : undefined,
		selfPubkey: identity.pubkeyHex,
		onEvent: handleEvent,
	});

	if (isCreator) {
		becomeReady(randomSalt(), now());
		if (openMode) publishPointer(now());
	} else {
		publishProbe(now());
	}

	// Этап 4 — И10 при гонке: детерминированная само-эвикция, не арбитр
	// (CONTRACTS.md "Rooms — Этап 4" §3). getVoicePresent() уже стабильно
	// отсортирован по joinedAt (presence.js's гарантия, Этап 1) — все наблюдатели
	// вычисляют один и тот же список из одного и того же CvRDT-снимка.
	async function joinVoice() {
		if (!ready) throw new Error("room-session: joinVoice до готовности сессии");
		if (getVoicePresent().length >= MAX_VOICE_PARTICIPANTS) {
			throw new Error("room-session: голосовая часть заполнена");
		}
		if (!meshSupervisor) {
			meshSupervisor = createMeshSupervisorImpl({
				selfPubkey: identity.pubkeyHex,
				selfPrivKey: identity.privKey,
				hTopic,
				publish: transport.publish,
				maxVoice: MAX_VOICE_PARTICIPANTS,
				getUserMedia,
				iceServers,
				onRemoteStream,
			});
		}
		await meshSupervisor.joinVoice();
		voiceActive = true;
		const t = now();
		publishHeartbeat(t);
		lastHeartbeatAt = t;
		// Оптимистичное локальное обновление — не ждать эха публикации с relay
		// (тот же приём, что уже применяется для входящих heartbeat).
		presenceState = mergeHeartbeat(presenceState, { pubkey: identity.pubkeyHex, nick, inVoice: true, at: t });
		meshSupervisor.updateRoster(getVoicePresent().map((p) => p.pubkey));
		onChange();
	}

	function leaveVoice() {
		if (!meshSupervisor) return;
		meshSupervisor.leaveVoice();
		voiceActive = false;
		const t = now();
		publishHeartbeat(t);
		lastHeartbeatAt = t;
		presenceState = mergeHeartbeat(presenceState, { pubkey: identity.pubkeyHex, nick, inVoice: false, at: t });
		meshSupervisor.updateRoster(getVoicePresent().map((p) => p.pubkey));
		onChange();
	}

	function tick() {
		const t = now();
		presenceState = prune(presenceState, t, PRESENCE_TAU_MS);
		const currentK = present(presenceState, t, PRESENCE_TAU_MS).length;
		roomMachineState = syncRoomMachineK(roomMachineState, currentK, t);
		roomMachineState = checkTimeout(roomMachineState, t, PRESENCE_TAU_MS);
		if (ready) {
			if (t - lastHeartbeatAt >= HEARTBEAT_INTERVAL_MS) {
				publishHeartbeat(t);
				lastHeartbeatAt = t;
			}
			if (trickle.getIntervalEnd() === null || t >= trickle.getIntervalEnd()) {
				trickle.onInterval(t);
			}
			if (trickle.shouldTransmit(t)) {
				publishAnnounce(t);
				if (openMode) publishPointer(t);
			}
			if (voiceActive) {
				const voiceList = getVoicePresent();
				const myIndex = voiceList.findIndex((p) => p.pubkey === identity.pubkeyHex);
				if (myIndex >= MAX_VOICE_PARTICIPANTS) {
					leaveVoice(); // И10 при гонке — сам себя эвиктирую, детерминировано для всех наблюдателей
				} else if (meshSupervisor) {
					meshSupervisor.updateRoster(voiceList.map((p) => p.pubkey));
				}
			}
		}
		onChange();
	}

	const timerHandle = setIntervalImpl(tick, sweepIntervalMs);

	return {
		getPubkeyHex: () => identity.pubkeyHex,
		getSuffix: () => suffix,
		isReady: () => ready,
		getPresent: () => present(presenceState, now(), PRESENCE_TAU_MS),
		getMessages: () => messageLog.toArray(),
		getRoomState: () => roomMachineState,
		getVoicePresent,
		isVoiceActive: () => voiceActive,
		getEdgeStates: () => (meshSupervisor ? meshSupervisor.getEdgeStates() : []),
		joinVoice,
		leaveVoice,
		getRaceOutcome: () => raceOutcome,
		sendChat: (text) => {
			if (!ready) return Promise.reject(new Error("room-session: sendChat до готовности сессии (salt ещё не известен)"));
			const event = buildRoomChatEvent(identity.privKey, kSess, hTopic, { nick, text }, now());
			return transport.publish(event);
		},
		close: () => {
			clearIntervalImpl(timerHandle);
			// Локальная очистка ресурсов (микрофон/RTCPeerConnection) — ОБЯЗАТЕЛЬНА
			// независимо от философии "закрытие вкладки — конец, без уборки" (ROOMS-SPEC
			// §0, это про сетевой протокол/lease, не про реальное железо): непойманный
			// активный трек микрофона держит индикатор записи включённым в браузере.
			// Финальный heartbeat НЕ публикуется — transport и так закрывается следом.
			if (meshSupervisor) meshSupervisor.leaveVoice();
			transport.close();
		},
	};
}

// Этап 3 — открытый режим, обнаружение suffix через указатель под hDisc
// (ROOMS-MATH §1.2). Реальное время (setTimeout, без инъекции) — одноразовый
// bootstrap-шаг вне sweep-контура; тесты используют маленький discoveryTimeoutMs.
async function discoverSuffixViaPointer({ hDisc, kPointer, relayUrl, discoveryTimeoutMs }) {
	const pointers = [];
	const transport = await openRoomTransport({
		relayUrl,
		hDisc,
		selfPubkey: DISCOVERY_PLACEHOLDER_PUBKEY,
		onEvent: (event) => {
			if (event.kind !== ROOM_POINTER_KIND) return;
			const payload = parseRoomPointerEvent(event, kPointer);
			if (payload) pointers.push(payload);
		},
	});
	await new Promise((resolve) => setTimeout(resolve, discoveryTimeoutMs));
	transport.close();
	if (pointers.length === 0) return null;
	pointers.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	return pointers[0].suffix;
}

export function createRoom({
	name,
	password,
	nick,
	relayUrl,
	argon2,
	now,
	random,
	sweepIntervalMs,
	setIntervalImpl,
	clearIntervalImpl,
	onChange,
	openMode,
	getUserMedia,
	iceServers,
	createMeshSupervisor,
	onRemoteStream,
}) {
	return openSession({
		name,
		password,
		suffix: randomSuffix(),
		nick,
		relayUrl,
		argon2,
		now,
		random,
		sweepIntervalMs,
		setIntervalImpl,
		clearIntervalImpl,
		onChange,
		isCreator: true,
		openMode,
		getUserMedia,
		iceServers,
		createMeshSupervisor,
		onRemoteStream,
	});
}

export function joinRoom({
	name,
	password,
	suffix,
	nick,
	relayUrl,
	argon2,
	now,
	random,
	sweepIntervalMs,
	setIntervalImpl,
	clearIntervalImpl,
	onChange,
	getUserMedia,
	iceServers,
	createMeshSupervisor,
	onRemoteStream,
}) {
	return openSession({
		name,
		password,
		suffix,
		nick,
		relayUrl,
		argon2,
		now,
		random,
		sweepIntervalMs,
		setIntervalImpl,
		clearIntervalImpl,
		onChange,
		isCreator: false,
		getUserMedia,
		iceServers,
		createMeshSupervisor,
		onRemoteStream,
	});
}

export async function joinRoomByPassword({
	name,
	password,
	nick,
	relayUrl,
	argon2 = defaultSlowKdf,
	now,
	random,
	sweepIntervalMs,
	setIntervalImpl,
	clearIntervalImpl,
	onChange,
	discoveryTimeoutMs = 5000,
	getUserMedia,
	iceServers,
	createMeshSupervisor,
	onRemoteStream,
}) {
	const kBase = await deriveKBase(name, password, argon2);
	const { hDisc, kPointer } = derivePairKeys(kBase);
	const suffix = await discoverSuffixViaPointer({ hDisc, kPointer, relayUrl, discoveryTimeoutMs });
	if (suffix === null) {
		throw new Error("room-session: комната не найдена (открытый режим, ничего не обнаружено за отведённое время)");
	}
	return openSession({
		name,
		password,
		suffix,
		nick,
		relayUrl,
		argon2,
		now,
		random,
		sweepIntervalMs,
		setIntervalImpl,
		clearIntervalImpl,
		onChange,
		isCreator: false,
		precomputedKBase: kBase,
		getUserMedia,
		iceServers,
		createMeshSupervisor,
		onRemoteStream,
	});
}
