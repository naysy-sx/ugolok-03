// Этап 48, п.5 (VOICE.md §3) — imperative shell: подписан на медиа+сигналинг,
// кормит события в reduce() (call-fsm.js), исполняет команды (маршрутизирует в
// media-controller.js/signaling-adapter.js, сам держит таймеры и EMIT-колбэк для UI).
// Написан Claude напрямую (оркестрация, интеграция, порядок эффектов — §5 VOICE.md).

import { reduce, RESTART_JITTER_RATIO, DEFAULT_RECOVERY_SAFETY_CAP_MS } from "./call-fsm.js";
import { createMediaController as defaultCreateMediaController } from "./media-controller.js";
import * as defaultSignalingAdapter from "./signaling-adapter.js";

const TIMER_EVENT_BY_NAME = {
	ring: "RING_TIMEOUT",
	connect: "CONNECT_TIMEOUT",
	restartTick: "RESTART_TICK",
	heartbeat: "HEARTBEAT_TICK",
};

// TZ-recovery-policy.md §4 — SEND_HANGUP выделен из общего
// SIGNAL_COMMAND_TYPES: это единственная сигнальная команда, которой нужен
// retry-с-дедлайном (см. sendHangupReliably ниже), остальные (SEND_OFFER/
// SEND_ANSWER/SEND_ICE/SEND_HEARTBEAT) по-прежнему at-most-once — рестарт
// ICE и так повторяется по расписанию §2, а heartbeat самой своей частотой
// (раз в CALL_HEARTBEAT_MS) переживает единичную потерю без отдельного retry.
const MEDIA_COMMAND_TYPES = new Set(["ACQUIRE_MIC", "CREATE_OFFER", "CREATE_ANSWER", "SET_REMOTE", "ADD_ICE", "DO_ICE_RESTART", "CLOSE_PC"]);
const SIGNAL_COMMAND_TYPES = new Set(["SEND_OFFER", "SEND_ANSWER", "SEND_ICE", "SEND_HEARTBEAT"]);
const RETRIABLE_SIGNAL_TYPES = new Set(["SEND_OFFER", "SEND_ANSWER", "SEND_ICE"]);
// Согласовано явно: CONNECT_TIMEOUT=15с, publisher timeout=8с, reconnect backoff от 1с.
// Бюджет 10с — успевает дождаться реконнекта и одну полную публикацию, не съедая
// CONNECT_TIMEOUT. Поллинг 400мс — чаще минимального backoff релея.
const SIGNAL_RETRY_BUDGET_MS = 10000;
const SIGNAL_RETRY_POLL_MS = 400;

// TZ-recovery-policy.md §2.2 — разброс ±30% на реальном таймере (не в чистом
// FSM, которое обязано быть детерминированным — см. call-fsm.js). Применяется
// только к каденции попыток восстановления, не к ring/connect/heartbeat.
// random — DI (тот же приём, что уже применяется в room-session.js): без
// него — настоящий Math.random, с ним — тесты фиксируют расписание попыток
// и проверяют его на точные секунды, а не "где-то в пределах ±30%".
function applyJitter(ms, ratio, random) {
	const spread = ms * ratio;
	return ms - spread + random() * spread * 2;
}

// §4 — единственное ограничение relay, которое касается ретрая: strfry
// отклоняет эфемерные события старше 60с от created_at (rejectEphemeralEventsOlderThanSeconds,
// server/strfry/strfry.conf) — SEND_HANGUP пересобирается (новый created_at)
// на каждую попытку, поэтому это не дедлайн relay, а именно дедлайн ТЗ
// ("не позже 60 секунд"), число совпадает не случайно.
const HANGUP_DELIVERY_DEADLINE_MS = 60000;
const HANGUP_RETRY_INTERVAL_MS = 3000;

// НАЙДЕНО ПОЛЬЗОВАТЕЛЕМ (живое использование) — ENDED терминален в чистом
// call-fsm.js (игнорирует вообще все события, I5), но VOICE.md §1.1 буквально:
// "ENDED после очистки ресурсов переходит в IDLE (новый звонок начинается из
// IDLE)" — это ответственность runtime, не reduce(). Без явного возврата ни
// следующий исходящий, ни входящий звонок не обрабатывался бы вовсе (плюс
// UI-плашка "Звонок завершён" висела бы бесконечно — второй найденный баг,
// закрыт тем же fix'ом). Короткая пауза даёт пользователю увидеть причину.
const ENDED_AUTO_RESET_MS = 3000;

function idleState() {
	return { name: "IDLE", role: null, sessionId: null, peerPubkey: null, polite: null, restartCount: 0, reason: null };
}

// createMediaController/signalingAdapter — инъецируемые (тесты подставляют фейки,
// тот же DI-приём, что media-controller.js/signaling-adapter.js сами используют
// для RTCPeerConnection/getUserMedia). setTimeoutImpl/clearTimeoutImpl — DI по той
// же причине (детерминированные тесты таймеров без реального ожидания).
export function createCallRuntime(options = {}) {
	const {
		myPubkey,
		privKey,
		publish,
		hTopic, // Rooms, этап 4 (ROOMS-SPEC §5.3) — undefined для обычных 1:1-звонков, тег h не добавляется
		onStateChange = () => {},
		createMediaController = defaultCreateMediaController,
		signalingAdapter = defaultSignalingAdapter,
		setTimeoutImpl = (...args) => setTimeout(...args),
		clearTimeoutImpl = (...args) => clearTimeout(...args),
		// TZ-diag-trace.md §0.1/§0.3 — DI, не импорт трассировщика; ни один из
		// перехватов ниже НЕ меняет то, что уже было (в частности — не чинит
		// call-runtime.js:118-124: сбой публикации по-прежнему только
		// console.warn, команда по-прежнему теряется, если релей её отверг).
		// getRelayState — необязательный снимок состояния сокета к релею
		// (relay-pool.js's getState()) в момент исполнения SEND_*-команды.
		onTrace,
		getRelayState,
		// TZ-recovery-policy.md §2.4 — предохранитель, настраиваемый: значение
		// по умолчанию соответствует call-fsm.js's DEFAULT_RECOVERY_SAFETY_CAP_MS,
		// но вызывающая сторона (UI-настройка) может передать null/Infinity —
		// "без предела, пока вкладка открыта", как и просило задание вторым
		// вариантом.
		safetyCapMs = DEFAULT_RECOVERY_SAFETY_CAP_MS,
		random = Math.random,
		...mediaOptions
	} = options;

	function trace(ev, payload) {
		if (!onTrace) return;
		try {
			onTrace(ev, payload);
		} catch {
			// TZ §0.5 — сбой трассировки не должен долетать до звонка
		}
	}

	let state = idleState();
	const timers = new Map(); // name -> timer id
	let endedResetTimerId = null;
	let dispatchChain = Promise.resolve();
	let outgoingSeq = 0;
	// TZ-recovery-policy.md §3 — бухгалтерия "жив ли собеседник" ЦЕЛИКОМ здесь
	// (call-fsm.js чистое ядро, часов не имеет). reconnectingStartedAt — момент
	// входа в текущий эпизод RECONNECTING (null вне его), нужен для §2.2's фаз
	// каденции и §2.4's предохранителя. lastPeerAliveAt — момент последнего
	// доказательства, что собеседник жив (любое REMOTE_*-событие); засеивается
	// оптимистично в момент входа в RECONNECTING (мы только что были CONNECTED
	// — собеседник заведомо был жив секунду назад), см. §3: "либо мы ещё ни
	// разу его не теряли в этом эпизоде".
	let reconnectingStartedAt = null;
	let lastPeerAliveAt = null;

	function resetToIdle() {
		if (endedResetTimerId !== null) {
			clearTimeoutImpl(endedResetTimerId);
			endedResetTimerId = null;
		}
		if (state.name !== "ENDED") return; // уже сброшено (ручной dismiss опередил таймер) или новый звонок
		state = idleState();
		onStateChange("IDLE");
	}

	// НАЙДЕНО ЖИВЫМ E2E — команды одного перехода ОБЯЗАНЫ исполняться строго
	// последовательно, не "запустить и забыть": ACQUIRE_MIC добавляет трек в
	// RTCPeerConnection, CREATE_OFFER следом должен УВИДЕТЬ уже добавленный трек.
	// Без await'а оба вызова стартуют почти одновременно (оба — async-функции,
	// синхронный код до первого await выполняется сразу) — CREATE_OFFER нередко
	// успевал создать offer РАНЬШЕ, чем ACQUIRE_MIC's addTrack — SDP без media-
	// секций, ICE вообще не собирался (звонок молча "тикал" 15с до CONNECT_TIMEOUT).
	function dispatch(event) {
		const run = () => runDispatch(event);
		dispatchChain = dispatchChain.then(run, run);
		return dispatchChain;
	}

	async function runDispatch(event) {
		const prevState = state;

		// TZ-recovery-policy.md §4 — REMOTE_HANGUP, пришедший когда FSM уже в
		// IDLE (запоздавшее завершение — ровно тот случай из 10-LIVE-INCIDENT
		// §11.5, где REMOTE_HANGUP пришёл на 68с позже: человек на дальнем
		// конце вручную положил трубку, дозвониться до уже сброшенного здесь
		// состояния не может ничего изменить, но и молча теряться не должен).
		if (event.type === "REMOTE_HANGUP" && prevState.name === "IDLE") {
			trace("late-remote-hangup", { sessionId: event.sessionId ?? null });
		}

		// §3 — любое событие с признаками "от собеседника" продлевает окно
		// его жизни. Список — все Σ_in-B (входящий сигналинг), не только
		// heartbeat: обычный ICE-кандидат или offer доказывает жизнь ничуть не
		// хуже отдельного heartbeat-сигнала.
		if (event.type === "REMOTE_ICE" || event.type === "REMOTE_OFFER" || event.type === "REMOTE_ANSWER" || event.type === "REMOTE_HEARTBEAT") {
			lastPeerAliveAt = Date.now();
		}

		// §1/§3 — вход в RECONNECTING: засеваем оба таймера бухгалтерии ЗДЕСЬ,
		// а не в call-fsm.js (у чистого ядра нет часов). Проверяем ПЕРЕХОД, а
		// не итоговое состояние — событие ICE_DISCONNECTED/ICE_FAILED, пришедшее
		// НЕ из CONNECTED (например уже в RECONNECTING — второй ICE_FAILED
		// подряд), не должно пересеивать окно заново.
		if (prevState.name === "CONNECTED" && (event.type === "ICE_DISCONNECTED" || event.type === "ICE_FAILED")) {
			reconnectingStartedAt = Date.now();
			lastPeerAliveAt = Date.now();
		}

		const relayStateNow = getRelayState ? getRelayState() : "connected"; // без getRelayState (старые тесты) — считаем транспорт всегда живым, как было раньше
		const transportConnected = relayStateNow === "connected" || relayStateNow === "subscribed" || relayStateNow === "authenticating";

		// RESTART_TICK — единственное событие, которому нужны вычисленные
		// снаружи числа (§2.1/§2.2/§2.3/§2.4/§3): call-fsm.js сравнивает их с
		// именованными порогами, но само не вычисляет.
		if (event.type === "RESTART_TICK") {
			event = {
				...event,
				transportConnected,
				peerSilentMs: lastPeerAliveAt !== null ? Date.now() - lastPeerAliveAt : null,
				elapsedReconnectingMs: reconnectingStartedAt !== null ? Date.now() - reconnectingStartedAt : 0,
			};
			trace("restart-decision", {
				sessionId: event.sessionId,
				transportConnected,
				peerSilentMs: event.peerSilentMs,
				elapsedReconnectingMs: event.elapsedReconnectingMs,
			});
		}

		const result = reduce(state, event);
		state = result.state;
		if (state.sessionId && state.sessionId !== prevState.sessionId) {
			outgoingSeq = 0;
		}

		// Выход из эпизода RECONNECTING (восстановились или завершились) —
		// обнулить бухгалтерию, чтобы следующий эпизод (новый обрыв того же
		// звонка) считал фазы §2.2 заново, с нуля.
		if (prevState.name === "RECONNECTING" && state.name !== "RECONNECTING") {
			reconnectingStartedAt = null;
		}

		// TZ §2.3 — переход целиком: откуда/куда/по какому событию/причина/
		// restartCount на этот момент. call-fsm.js сам не тронут ни строкой —
		// reduce() вызывается ровно как раньше, трассировка читает уже готовый
		// result, ничего в нём не меняя.
		trace("fsm-transition", {
			sessionId: state.sessionId ?? prevState.sessionId,
			peerPubkey: state.peerPubkey ?? prevState.peerPubkey,
			from: prevState.name,
			to: state.name,
			event: event.type,
			reason: state.reason ?? null,
			restartCount: state.restartCount,
		});
		for (const command of result.commands) {
			await executeCommand(command);
		}
	}

	// media-controller.js создаётся ЗДЕСЬ (не снаружи) — его onEvent обязан звать
	// dispatch, а dispatch определён в этой же функции; порядок объявлений в JS не
	// мешает (function-объявление уже доступно на момент вызова createMediaController).
	// onTrace явно докидывается сюда отдельно от ...mediaOptions — он уже
	// вынут из options деструктуризацией выше (нужен и здесь, для fsm/command-
	// трассировки, и в media-controller.js, для pc-уровневой).
	const mediaController = createMediaController({ ...mediaOptions, onEvent: (event) => dispatch(event), onTrace });

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
		// §2.2 — разброс ±30% ТОЛЬКО на каденцию попыток восстановления: обе
		// стороны звонка иначе били бы рестарт синхронно (задание явно этого
		// требует — "чтобы две стороны не били синхронно"). ring/connect/
		// heartbeat — точные, джиттер им не нужен и не запрошен.
		const armedMs = name === "restartTick" ? Math.max(0, Math.round(applyJitter(ms, RESTART_JITTER_RATIO, random))) : ms;
		trace("timer", { name, ms: armedMs, phase: "armed", sessionId: sessionIdAtStart });
		const id = setTimeoutImpl(() => {
			timers.delete(name);
			trace("timer", { name, ms: armedMs, phase: "fired", sessionId: sessionIdAtStart });
			dispatch({ type: TIMER_EVENT_BY_NAME[name], sessionId: sessionIdAtStart });
		}, armedMs);
		timers.set(name, id);
	}

	// TZ §4 — из SDP в трассировку идут только строки a=ice-ufrag (видно, был
	// ли реальный ICE-рестарт) и a=candidate; полный текст SDP сюда не передаётся
	// вообще, даже временно — вырезка происходит здесь, до записи.
	function extractSdpTraceFields(sdp) {
		const text = sdp?.sdp;
		if (typeof text !== "string") return {};
		const ufrag = /^a=ice-ufrag:(.+)$/m.exec(text)?.[1] ?? null;
		const candidateLines = text.match(/^a=candidate:.+$/gm) ?? [];
		return { iceUfrag: ufrag, candidateCount: candidateLines.length };
	}

	// TZ-recovery-policy.md §4 — SEND_HANGUP отдельно от остальных сигнальных
	// команд: если публикация не удалась, ставим в очередь и повторяем, пока
	// не доставим или не истечёт HANGUP_DELIVERY_DEADLINE_MS (60с — предел
	// strfry на возраст эфемерного события, см. константу выше). ctx
	// захватывается ДО первого await — state.peerPubkey/sessionId к моменту
	// повтора (секунды спустя) уже могут быть стёрты автосбросом ENDED->IDLE
	// (ENDED_AUTO_RESET_MS=3000, ниже) — реальный сетевой сбой длиннее.
	async function sendHangupReliably(ctx) {
		const deadline = Date.now() + HANGUP_DELIVERY_DEADLINE_MS;
		let attempt = 0;
		for (;;) {
			attempt += 1;
			const relayStateBefore = getRelayState ? getRelayState() : undefined;
			trace("command", { name: "SEND_HANGUP", phase: "start", sessionId: ctx.sessionId, attempt, relayState: relayStateBefore });
			try {
				const result = await signalingAdapter.execute({ type: "SEND_HANGUP" }, { privKey, peerPubkey: ctx.peerPubkey, sessionId: ctx.sessionId, publish, hTopic });
				trace("command", { name: "SEND_HANGUP", phase: "ok", sessionId: ctx.sessionId, attempt, relayOk: result?.ok, relayReason: result?.reason, eventId: result?.eventId });
				return;
			} catch (e) {
				const remaining = deadline - Date.now();
				if (remaining <= 0) {
					trace("command", { name: "SEND_HANGUP", phase: "dropped", sessionId: ctx.sessionId, attempt, errorMessage: String(e?.message ?? e) });
					console.warn("call-runtime: SEND_HANGUP не доставлен за отведённое время, отброшен", e);
					return;
				}
				trace("command", { name: "SEND_HANGUP", phase: "error", sessionId: ctx.sessionId, attempt, errorMessage: String(e?.message ?? e) });
				await new Promise((resolve) => setTimeoutImpl(resolve, Math.min(HANGUP_RETRY_INTERVAL_MS, remaining)));
			}
		}
	}

	function sleep(ms) {
		return new Promise((resolve) => setTimeoutImpl(resolve, ms));
	}

	async function publishSignal(command, ctx = {}) {
		const seq = ++outgoingSeq;
		const peerPubkey = ctx.peerPubkey ?? state.peerPubkey;
		const sessionId = ctx.sessionId ?? state.sessionId;
		const relayStateBefore = getRelayState ? getRelayState() : undefined;
		trace("command", { name: command.type, phase: "start", sessionId, relayState: relayStateBefore, seq });
		const started = Date.now();
		try {
			const result = await signalingAdapter.execute(
				{ ...command, seq },
				{ privKey, peerPubkey, sessionId, publish, hTopic },
			);
			const tookMs = Date.now() - started;
			const sdpFields = command.sdp ? extractSdpTraceFields(command.sdp) : {};
			trace("command", {
				name: command.type,
				phase: "ok",
				sessionId,
				relayOk: result?.ok,
				relayReason: result?.reason,
				eventId: result?.eventId,
				seq,
				...sdpFields,
			});
			trace("publish-result", {
				commandType: command.type,
				sessionId,
				ok: result?.ok !== false,
				reason: result?.reason ?? null,
				tookMs,
			});
			return result;
		} catch (e) {
			const tookMs = Date.now() - started;
			trace("command", { name: command.type, phase: "error", sessionId, errorMessage: String(e?.message ?? e), seq });
			trace("publish-result", {
				commandType: command.type,
				sessionId,
				ok: false,
				reason: String(e?.message ?? e),
				tookMs,
			});
			throw e;
		}
	}

	async function executeSignalCommand(command) {
		const sessionIdAtStart = state.sessionId;
		const nameAtStart = state.name;
		const peerAtStart = state.peerPubkey;
		const deadline = Date.now() + SIGNAL_RETRY_BUDGET_MS;
		while (Date.now() < deadline) {
			if (state.sessionId !== sessionIdAtStart || state.name !== nameAtStart) return;
			if (transportAlive()) {
				try {
					const result = await publishSignal(command, { peerPubkey: peerAtStart, sessionId: sessionIdAtStart });
					if (result?.ok !== false) return;
				} catch {
					// повторим, пока жив транспорт и не истёк бюджет
				}
			}
			if (state.sessionId !== sessionIdAtStart || state.name !== nameAtStart) return;
			const remaining = deadline - Date.now();
			if (remaining <= 0) break;
			await sleep(Math.min(SIGNAL_RETRY_POLL_MS, remaining));
		}
		console.warn(`call-runtime: сигнальная команда ${command.type} не доставлена за ${SIGNAL_RETRY_BUDGET_MS}мс`);
	}

	function transportAlive() {
		const s = getRelayState ? getRelayState() : "connected";
		return s === "connected" || s === "subscribed" || s === "authenticating";
	}

	async function executeCommand(command) {
		if (command.type === "SEND_HANGUP") {
			void sendHangupReliably({ peerPubkey: state.peerPubkey, sessionId: state.sessionId });
			return;
		}
		if (MEDIA_COMMAND_TYPES.has(command.type)) {
			if (command.type === "CLOSE_PC") clearAllTimers(); // защита от осиротевших grace/backoff/restartTick таймеров
			// §2.3 — recreate/forceRelay относятся только к DO_ICE_RESTART, но
			// безобидно спредить их всегда (undefined для остальных команд).
			const extraFields = command.type === "DO_ICE_RESTART" ? { recreate: command.recreate, forceRelay: command.forceRelay } : {};
			trace("command", { name: command.type, phase: "start", sessionId: state.sessionId, ...extraFields });
			try {
				await mediaController.execute(command);
				trace("command", { name: command.type, phase: "ok", sessionId: state.sessionId, ...extraFields });
			} catch (e) {
				// НЕ ЧИНИТЬ (TZ §0.1) — по-прежнему только console.warn, команда
				// по-прежнему теряется. Трассировка только НАБЛЮДАЕТ этот путь.
				trace("command", { name: command.type, phase: "error", sessionId: state.sessionId, ...extraFields, errorMessage: String(e?.message ?? e) });
				console.warn(`call-runtime: медиа-команда ${command.type} упала`, e);
			}
			return;
		}
		if (SIGNAL_COMMAND_TYPES.has(command.type)) {
			if (RETRIABLE_SIGNAL_TYPES.has(command.type)) void executeSignalCommand(command);
			else void publishSignal(command).catch(() => {});
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
			if (command.stateName === "ENDED") {
				endedResetTimerId = setTimeoutImpl(resetToIdle, ENDED_AUTO_RESET_MS);
			}
		}
	}

	// --- Публичный API: пользовательские действия (Σ_in-A, §1.3 VOICE.md) ---
	function placeCall(peerPubkey) {
		return dispatch({ type: "USER_PLACE_CALL", peerPubkey, myPubkey, safetyCapMs });
	}
	function accept() {
		return dispatch({ type: "USER_ACCEPT", sessionId: state.sessionId });
	}
	function reject() {
		return dispatch({ type: "USER_REJECT", sessionId: state.sessionId });
	}
	function hangup() {
		return dispatch({ type: "USER_HANGUP", sessionId: state.sessionId });
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
		// safetyCapMs нужен только REMOTE_OFFER (создаёт сессию с нуля, §2.4) —
		// безобидно приклеивать всегда, reduceIdle читает поле только там.
		if (fsmEvent) dispatch({ ...fsmEvent, safetyCapMs });
	}

	function getState() {
		return state;
	}

	function getInboundAudioStats() {
		return mediaController.getInboundAudioStats?.() ?? Promise.resolve(null);
	}

	function closeNow() {
		clearAllTimers();
		return mediaController.execute({ type: "CLOSE_PC" });
	}

	return { placeCall, accept, reject, hangup, handleIncomingSignal, getState, getInboundAudioStats, closeNow, dismissEnded: resetToIdle };
}
