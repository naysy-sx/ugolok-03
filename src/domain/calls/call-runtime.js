// Этап 48, п.5 (VOICE.md §3) — imperative shell: подписан на медиа+сигналинг,
// кормит события в reduce() (call-fsm.js), исполняет команды (маршрутизирует в
// media-controller.js/signaling-adapter.js, сам держит таймеры и EMIT-колбэк для UI).
// Написан Claude напрямую (оркестрация, интеграция, порядок эффектов — §5 VOICE.md).

import { reduce } from "./call-fsm.js";
import { createMediaController as defaultCreateMediaController } from "./media-controller.js";
import * as defaultSignalingAdapter from "./signaling-adapter.js";

const TIMER_EVENT_BY_NAME = {
	ring: "RING_TIMEOUT",
	connect: "CONNECT_TIMEOUT",
	grace: "GRACE_EXPIRED",
	backoff: "BACKOFF_EXPIRED",
};

const MEDIA_COMMAND_TYPES = new Set(["ACQUIRE_MIC", "CREATE_OFFER", "CREATE_ANSWER", "SET_REMOTE", "ADD_ICE", "DO_ICE_RESTART", "CLOSE_PC"]);
const SIGNAL_COMMAND_TYPES = new Set(["SEND_OFFER", "SEND_ANSWER", "SEND_ICE", "SEND_HANGUP"]);

// createMediaController/signalingAdapter — инъецируемые (тесты подставляют фейки,
// тот же DI-приём, что media-controller.js/signaling-adapter.js сами используют
// для RTCPeerConnection/getUserMedia). setTimeoutImpl/clearTimeoutImpl — DI по той
// же причине (детерминированные тесты таймеров без реального ожидания).
export function createCallRuntime(options = {}) {
	const {
		myPubkey,
		privKey,
		publish,
		onStateChange = () => {},
		createMediaController = defaultCreateMediaController,
		signalingAdapter = defaultSignalingAdapter,
		setTimeoutImpl = (...args) => setTimeout(...args),
		clearTimeoutImpl = (...args) => clearTimeout(...args),
		...mediaOptions
	} = options;

	let state = { name: "IDLE", role: null, sessionId: null, peerPubkey: null, polite: null, restartCount: 0, reason: null };
	const timers = new Map(); // name -> timer id

	// НАЙДЕНО ЖИВЫМ E2E — команды одного перехода ОБЯЗАНЫ исполняться строго
	// последовательно, не "запустить и забыть": ACQUIRE_MIC добавляет трек в
	// RTCPeerConnection, CREATE_OFFER следом должен УВИДЕТЬ уже добавленный трек.
	// Без await'а оба вызова стартуют почти одновременно (оба — async-функции,
	// синхронный код до первого await выполняется сразу) — CREATE_OFFER нередко
	// успевал создать offer РАНЬШЕ, чем ACQUIRE_MIC's addTrack — SDP без media-
	// секций, ICE вообще не собирался (звонок молча "тикал" 15с до CONNECT_TIMEOUT).
	async function dispatch(event) {
		const result = reduce(state, event);
		state = result.state;
		for (const command of result.commands) {
			await executeCommand(command);
		}
	}

	// media-controller.js создаётся ЗДЕСЬ (не снаружи) — его onEvent обязан звать
	// dispatch, а dispatch определён в этой же функции; порядок объявлений в JS не
	// мешает (function-объявление уже доступно на момент вызова createMediaController).
	const mediaController = createMediaController({ ...mediaOptions, onEvent: (event) => dispatch(event) });

	function clearNamedTimer(name) {
		const id = timers.get(name);
		if (id !== undefined) {
			clearTimeoutImpl(id);
			timers.delete(name);
		}
	}

	function clearAllTimers() {
		for (const id of timers.values()) clearTimeoutImpl(id);
		timers.clear();
	}

	function startTimer(name, ms) {
		clearNamedTimer(name); // на случай повторного START_TIMER тем же именем
		const sessionIdAtStart = state.sessionId;
		const id = setTimeoutImpl(() => {
			timers.delete(name);
			dispatch({ type: TIMER_EVENT_BY_NAME[name], sessionId: sessionIdAtStart });
		}, ms);
		timers.set(name, id);
	}

	async function executeCommand(command) {
		if (MEDIA_COMMAND_TYPES.has(command.type)) {
			if (command.type === "CLOSE_PC") clearAllTimers(); // защита от осиротевших grace/backoff таймеров
			try {
				await mediaController.execute(command);
			} catch (e) {
				console.warn(`call-runtime: медиа-команда ${command.type} упала`, e);
			}
			return;
		}
		if (SIGNAL_COMMAND_TYPES.has(command.type)) {
			try {
				await signalingAdapter.execute(command, { privKey, peerPubkey: state.peerPubkey, sessionId: state.sessionId, publish });
			} catch (e) {
				console.warn(`call-runtime: сигнальная команда ${command.type} упала`, e);
			}
			return;
		}
		if (command.type === "START_TIMER") {
			startTimer(command.name, command.ms);
			return;
		}
		if (command.type === "CANCEL_TIMER") {
			clearNamedTimer(command.name);
			return;
		}
		if (command.type === "EMIT") {
			onStateChange(command.stateName, command.reason);
		}
	}

	// --- Публичный API: пользовательские действия (Σ_in-A, §1.3 VOICE.md) ---
	function placeCall(peerPubkey) {
		dispatch({ type: "USER_PLACE_CALL", peerPubkey, myPubkey });
	}
	function accept() {
		dispatch({ type: "USER_ACCEPT", sessionId: state.sessionId });
	}
	function reject() {
		dispatch({ type: "USER_REJECT", sessionId: state.sessionId });
	}
	function hangup() {
		dispatch({ type: "USER_HANGUP", sessionId: state.sessionId });
	}

	// --- Входящий сигналинг (kind 20075) — сырое nostr-событие с relay. Вызывающий
	// код (transport.js, будущая подписка) передаёт события сюда как есть. ---
	function handleIncomingSignal(event) {
		let payload;
		try {
			payload = signalingAdapter.parseCallSignalEvent(event, privKey);
		} catch {
			return; // не наш сигнал / повреждён / чужим ключом — молча пропустить
		}
		const fsmEvent = signalingAdapter.toFsmEvent(payload, event.pubkey, myPubkey);
		if (fsmEvent) dispatch(fsmEvent);
	}

	function getState() {
		return state;
	}

	return { placeCall, accept, reject, hangup, handleIncomingSignal, getState };
}
