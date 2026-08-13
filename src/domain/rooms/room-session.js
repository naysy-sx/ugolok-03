// Rooms, этап 2 — оркестратор: единственное место, где чистое ядро встречается
// с адаптерами (ROOMS-SPEC.md §1.3). Контракт и design-записка:
// PROCESS-DOCS/CONTRACTS.md "Rooms — Этап 2" (room-session.js).
//
// Область Этапа 2: только LINK-режим (name+password+suffix уже известны),
// без UI, без голоса (kind 20075 молча проходит мимо диспетчера).
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { deriveRoomKeys, deriveSessionKey, defaultSlowKdf } from "./room-keys.js";
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
} from "./room-events.js";
import { ROOM_ANNOUNCE_KIND, ROOM_PROBE_KIND, ROOM_PRESENCE_KIND, ROOM_CHAT_KIND } from "../events/kind-registry.js";
import { createEphemeralIdentity } from "./adapters/room-identity.js";
import { openRoomTransport } from "./adapters/room-transport.js";

const HEARTBEAT_INTERVAL_MS = 15000; // δ
const PRESENCE_TAU_MS = 45000; // τ
const TRICKLE_I_MIN_MS = 15000;
const TRICKLE_I_MAX_MS = 60000;
const TRICKLE_K = 1;

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
}) {
	const identity = createEphemeralIdentity();
	const keys = await deriveRoomKeys(name, password, suffix, argon2);
	const { kRv, hTopic } = keys;

	let ready = false;
	let kSess = null;
	let presenceState = emptyPresence();
	let roomMachineState = emptyRoomState();
	let messageLog = createLog({});
	let lastHeartbeatAt = -Infinity;
	const trickle = createTrickle({ iMin: TRICKLE_I_MIN_MS, iMax: TRICKLE_I_MAX_MS, k: TRICKLE_K, random });

	function publishHeartbeat(t) {
		const event = buildRoomPresenceEvent(identity.privKey, kSess, hTopic, { type: "heartbeat", nick }, t);
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

	function becomeReady(salt, t) {
		currentSalt = salt;
		kSess = deriveSessionKey(kRv, salt);
		ready = true;
		lastHeartbeatAt = -Infinity; // первый sweep-тик после готовности сразу шлёт heartbeat
	}

	let currentSalt = null;

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
					presenceState = mergeHeartbeat(presenceState, { pubkey: payload.pubkey, nick: payload.nick, at: payload.at });
				} else if (payload.type === "exit") {
					presenceState = mergeExit(presenceState, { pubkey: payload.pubkey, at: payload.at });
				}
				const t = now();
				const currentK = present(presenceState, t, PRESENCE_TAU_MS).length;
				roomMachineState = syncRoomMachineK(roomMachineState, currentK, t);
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
			default:
				return; // сигналинг голоса и прочее — Этап 4, молча пропускаем
		}
	}

	const transport = await openRoomTransport({ relayUrl, hTopic, selfPubkey: identity.pubkeyHex, onEvent: handleEvent });

	if (isCreator) {
		becomeReady(randomSalt(), now());
	} else {
		publishProbe(now());
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
		sendChat: (text) => {
			if (!ready) return Promise.reject(new Error("room-session: sendChat до готовности сессии (salt ещё не известен)"));
			const event = buildRoomChatEvent(identity.privKey, kSess, hTopic, { nick, text }, now());
			return transport.publish(event);
		},
		close: () => {
			clearIntervalImpl(timerHandle);
			transport.close();
		},
	};
}

export function createRoom({ name, password, nick, relayUrl, argon2, now, random, sweepIntervalMs, setIntervalImpl, clearIntervalImpl, onChange }) {
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
	});
}

export function joinRoom({ name, password, suffix, nick, relayUrl, argon2, now, random, sweepIntervalMs, setIntervalImpl, clearIntervalImpl, onChange }) {
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
	});
}
