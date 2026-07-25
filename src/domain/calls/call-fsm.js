// Этап 48 — VOICE.md, §1-2. Чистое ядро FSM звонка: reduce(state, event) -> {state, commands}.
// Ноль I/O, ноль async — вся грязь (WebRTC, Nostr, таймеры) снаружи, в call-runtime.js.
//
// НАЙДЕНО ПРИ РЕАЛИЗАЦИИ (воркер дважды не справился — undefined restartCount,
// отсутствующий I1, сломанный glare, синтаксис) — переписано Claude напрямую,
// не патчем поверх (triage 13a: гонки состояний, не рутина).

const RING_TIMEOUT = 30000;
const CONNECT_TIMEOUT = 15000;
const DISCONNECT_GRACE = 4000;
const MAX_RESTARTS = 4;

function backoff(n) {
	return Math.min(1000 * 2 ** (n - 1), 8000);
}

function emit(stateName, reason) {
	return reason !== undefined ? { type: "EMIT", stateName, reason } : { type: "EMIT", stateName };
}

function ignore(state) {
	return { state, commands: [] };
}

function ended(state, reason, commandTypes) {
	const commands = commandTypes.map((type) => ({ type }));
	commands.push(emit("ENDED", reason));
	return { state: { ...state, name: "ENDED", reason }, commands };
}

// I1 (§1.5) — событие с чужим sessionId игнорируется. Исключения: USER_PLACE_CALL
// (создаёт сессию, своего sessionId ещё нет) и REMOTE_OFFER в IDLE/OUTGOING_RINGING
// (создаёт сессию с нуля, либо это glare §2.1 — ДРУГАЯ сессия того же peer'а,
// разрешается отдельной веткой, не обычным I1-отбросом).
function needsSessionCheck(state, event) {
	if (event.sessionId === undefined) return false;
	if (event.type === "USER_PLACE_CALL") return false;
	if (event.type === "REMOTE_OFFER" && (state.name === "IDLE" || state.name === "OUTGOING_RINGING")) return false;
	return true;
}

export function reduce(state, event) {
	if (needsSessionCheck(state, event) && event.sessionId !== state.sessionId) {
		return ignore(state);
	}

	switch (state.name) {
		case "IDLE":
			return reduceIdle(state, event);
		case "OUTGOING_RINGING":
			return reduceOutgoingRinging(state, event);
		case "INCOMING_RINGING":
			return reduceIncomingRinging(state, event);
		case "CONNECTING":
			return reduceConnecting(state, event);
		case "CONNECTED":
			return reduceConnected(state, event);
		case "RECONNECTING":
			return reduceReconnecting(state, event);
		case "ENDED":
		default:
			return ignore(state);
	}
}

function reduceIdle(state, event) {
	if (event.type === "USER_PLACE_CALL") {
		const sessionId = crypto.randomUUID();
		const polite = event.myPubkey < event.peerPubkey;
		return {
			state: { name: "OUTGOING_RINGING", role: "caller", sessionId, peerPubkey: event.peerPubkey, polite, restartCount: 0, reason: null },
			commands: [{ type: "ACQUIRE_MIC" }, { type: "CREATE_OFFER" }, { type: "START_TIMER", name: "ring", ms: RING_TIMEOUT }, emit("OUTGOING_RINGING")],
		};
	}
	if (event.type === "REMOTE_OFFER") {
		const polite = event.myPubkey < event.fromPubkey;
		return {
			state: { name: "INCOMING_RINGING", role: "callee", sessionId: event.sessionId, peerPubkey: event.fromPubkey, polite, restartCount: 0, reason: null },
			commands: [{ type: "SET_REMOTE", sdp: event.sdp }, { type: "START_TIMER", name: "ring", ms: RING_TIMEOUT }, emit("INCOMING_RINGING")],
		};
	}
	return ignore(state);
}

// §2.1 — glare: OUTGOING_RINGING + встречный REMOTE_OFFER от того же peer.
// Тайбрейкер — УЖЕ вычисленный state.polite (то же myPubkey/peerPubkey, что и
// при создании нашей исходящей сессии, пересчитывать не нужно).
function handleGlare(state, event) {
	if (state.polite) {
		return {
			state: { ...state, name: "CONNECTING", role: "callee", sessionId: event.sessionId },
			commands: [
				{ type: "SET_REMOTE", sdp: event.sdp },
				{ type: "CREATE_ANSWER" },
				{ type: "CANCEL_TIMER", name: "ring" },
				{ type: "START_TIMER", name: "connect", ms: CONNECT_TIMEOUT },
				emit("CONNECTING"),
			],
		};
	}
	// impolite — игнорируем встречный оффер, остаёмся caller со своей сессией (I5).
	return ignore(state);
}

function reduceOutgoingRinging(state, event) {
	switch (event.type) {
		case "LOCAL_OFFER_READY":
			return { state, commands: [{ type: "SEND_OFFER", sdp: event.sdp }] };
		case "LOCAL_ICE":
			return { state, commands: [{ type: "SEND_ICE", candidate: event.candidate }] };
		case "REMOTE_ANSWER":
			return {
				state: { ...state, name: "CONNECTING" },
				commands: [
					{ type: "SET_REMOTE", sdp: event.sdp },
					{ type: "CANCEL_TIMER", name: "ring" },
					{ type: "START_TIMER", name: "connect", ms: CONNECT_TIMEOUT },
					emit("CONNECTING"),
				],
			};
		case "REMOTE_ICE":
			return { state, commands: [{ type: "ADD_ICE", candidate: event.candidate }] };
		case "RING_TIMEOUT":
			return ended(state, "no_answer", ["SEND_HANGUP", "CLOSE_PC"]);
		case "USER_HANGUP":
			return {
				state: { ...state, name: "ENDED", reason: "cancelled" },
				commands: [{ type: "SEND_HANGUP" }, { type: "CLOSE_PC" }, { type: "CANCEL_TIMER", name: "ring" }, emit("ENDED", "cancelled")],
			};
		case "REMOTE_HANGUP":
			return {
				state: { ...state, name: "ENDED", reason: "rejected" },
				commands: [{ type: "CLOSE_PC" }, { type: "CANCEL_TIMER", name: "ring" }, emit("ENDED", "rejected")],
			};
		case "REMOTE_OFFER":
			return handleGlare(state, event);
		default:
			return ignore(state);
	}
}

function reduceIncomingRinging(state, event) {
	switch (event.type) {
		case "REMOTE_ICE":
			return { state, commands: [{ type: "ADD_ICE", candidate: event.candidate }] };
		case "USER_ACCEPT":
			return {
				state: { ...state, name: "CONNECTING" },
				commands: [
					{ type: "ACQUIRE_MIC" },
					{ type: "CREATE_ANSWER" },
					{ type: "CANCEL_TIMER", name: "ring" },
					{ type: "START_TIMER", name: "connect", ms: CONNECT_TIMEOUT },
					emit("CONNECTING"),
				],
			};
		case "USER_REJECT":
			return {
				state: { ...state, name: "ENDED", reason: "rejected" },
				commands: [{ type: "SEND_HANGUP" }, { type: "CLOSE_PC" }, { type: "CANCEL_TIMER", name: "ring" }, emit("ENDED", "rejected")],
			};
		case "RING_TIMEOUT":
			return ended(state, "missed", ["SEND_HANGUP", "CLOSE_PC"]);
		case "REMOTE_HANGUP":
			return {
				state: { ...state, name: "ENDED", reason: "cancelled_by_caller" },
				commands: [{ type: "CLOSE_PC" }, { type: "CANCEL_TIMER", name: "ring" }, emit("ENDED", "cancelled_by_caller")],
			};
		default:
			return ignore(state);
	}
}

function reduceConnecting(state, event) {
	switch (event.type) {
		case "LOCAL_ANSWER_READY":
			return { state, commands: [{ type: "SEND_ANSWER", sdp: event.sdp }] };
		case "LOCAL_ICE":
			return { state, commands: [{ type: "SEND_ICE", candidate: event.candidate }] };
		case "REMOTE_ICE":
			return { state, commands: [{ type: "ADD_ICE", candidate: event.candidate }] };
		case "ICE_CONNECTED":
			return {
				state: { ...state, name: "CONNECTED", restartCount: 0 },
				commands: [{ type: "CANCEL_TIMER", name: "connect" }, emit("CONNECTED")],
			};
		case "ICE_FAILED":
			return ended(state, "connect_failed", ["SEND_HANGUP", "CLOSE_PC"]);
		case "CONNECT_TIMEOUT":
			return ended(state, "connect_failed", ["SEND_HANGUP", "CLOSE_PC"]);
		case "USER_HANGUP":
			return {
				state: { ...state, name: "ENDED", reason: "hangup" },
				commands: [{ type: "SEND_HANGUP" }, { type: "CLOSE_PC" }, { type: "CANCEL_TIMER", name: "connect" }, emit("ENDED", "hangup")],
			};
		case "REMOTE_HANGUP":
			return {
				state: { ...state, name: "ENDED", reason: "remote_hangup" },
				commands: [{ type: "CLOSE_PC" }, { type: "CANCEL_TIMER", name: "connect" }, emit("ENDED", "remote_hangup")],
			};
		default:
			return ignore(state);
	}
}

function reduceConnected(state, event) {
	switch (event.type) {
		case "LOCAL_ICE":
			return { state, commands: [{ type: "SEND_ICE", candidate: event.candidate }] };
		case "REMOTE_ICE":
			return { state, commands: [{ type: "ADD_ICE", candidate: event.candidate }] };
		case "ICE_DISCONNECTED":
			return {
				state: { ...state, name: "RECONNECTING" },
				commands: [{ type: "START_TIMER", name: "grace", ms: DISCONNECT_GRACE }, emit("RECONNECTING")],
			};
		case "REMOTE_OFFER":
			// Пир инициировал ICE restart (§2.2) — отвечаем, оставаясь CONNECTED.
			return { state, commands: [{ type: "SET_REMOTE", sdp: event.sdp }, { type: "CREATE_ANSWER" }] };
		case "USER_HANGUP":
			return ended(state, "hangup", ["SEND_HANGUP", "CLOSE_PC"]);
		case "REMOTE_HANGUP":
			return ended(state, "remote_hangup", ["CLOSE_PC"]);
		default:
			return ignore(state);
	}
}

function reduceReconnecting(state, event) {
	switch (event.type) {
		case "ICE_CONNECTED":
			return {
				state: { ...state, name: "CONNECTED", restartCount: 0 },
				commands: [{ type: "CANCEL_TIMER", name: "grace" }, { type: "CANCEL_TIMER", name: "backoff" }, emit("CONNECTED")],
			};
		case "GRACE_EXPIRED":
		case "BACKOFF_EXPIRED":
		case "ICE_FAILED":
			return handleRestartAttempt(state);
		case "LOCAL_OFFER_READY":
			return { state, commands: [{ type: "SEND_OFFER", sdp: event.sdp }] };
		case "REMOTE_OFFER":
			return { state, commands: [{ type: "SET_REMOTE", sdp: event.sdp }, { type: "CREATE_ANSWER" }] };
		case "REMOTE_ANSWER":
			return { state, commands: [{ type: "SET_REMOTE", sdp: event.sdp }] };
		case "LOCAL_ANSWER_READY":
			return { state, commands: [{ type: "SEND_ANSWER", sdp: event.sdp }] };
		case "LOCAL_ICE":
			return { state, commands: [{ type: "SEND_ICE", candidate: event.candidate }] };
		case "REMOTE_ICE":
			return { state, commands: [{ type: "ADD_ICE", candidate: event.candidate }] };
		case "USER_HANGUP":
			return ended(state, "hangup", ["SEND_HANGUP", "CLOSE_PC"]);
		case "REMOTE_HANGUP":
			return ended(state, "remote_hangup", ["CLOSE_PC"]);
		default:
			return ignore(state);
	}
}

// §2.2 — ICE restart. Тайбрейкер — тот же state.polite, что и в glare (§2.1):
// impolite инициирует DO_ICE_RESTART, polite ждёт restart-оффер от него.
function handleRestartAttempt(state) {
	if (state.restartCount >= MAX_RESTARTS) {
		return ended(state, "connection_lost", ["CLOSE_PC"]);
	}
	const restartCount = state.restartCount + 1;
	const commands = [];
	if (!state.polite) {
		commands.push({ type: "DO_ICE_RESTART" });
	}
	commands.push({ type: "START_TIMER", name: "backoff", ms: backoff(restartCount) });
	return { state: { ...state, restartCount }, commands };
}
