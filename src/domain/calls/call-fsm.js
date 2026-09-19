// Этап 48 — VOICE.md, §1-2. Чистое ядро FSM звонка: reduce(state, event) -> {state, commands}.
// Ноль I/O, ноль async — вся грязь (WebRTC, Nostr, таймеры, Date.now()) снаружи, в call-runtime.js.
//
// TZ-recovery-policy.md — модель восстановления переписана целиком (§1-§4 задания).
// Главный сдвиг: потеря сети БОЛЬШЕ НЕ ведёт к завершению звонка. RECONNECTING не
// ограничен по времени попытками (MAX_RESTARTS удалён как условие завершения) —
// единственные автоматические выходы: собеседник объективно пропал (`peer_gone`,
// §3) и общий предохранитель (`safety_cap`, §2.4). Обе причины определяются ЗДЕСЬ
// не по настенным часам (их у чистого ядра нет), а по уже вычисленным снаружи
// числам (`elapsedReconnectingMs`, `peerSilentMs`, `transportConnected`) —
// вычисление "сколько прошло времени" остаётся обязанностью call-runtime.js,
// ядро только СРАВНИВАЕТ готовые числа с именованными порогами.
//
// НАЙДЕНО ПРИ РЕАЛИЗАЦИИ (воркер дважды не справился — undefined restartCount,
// отсутствующий I1, сломанный glare, синтаксис) — переписано Claude напрямую,
// не патчем поверх (triage 13a: гонки состояний, не рутина).

const RING_TIMEOUT = 30000;
const CONNECT_TIMEOUT = 15000;

// TZ-recovery-policy.md §2.2 — пауза после ICE_DISCONNECTED/ICE_FAILED перед
// ПЕРВОЙ попыткой восстановления. Раньше 4000 (DISCONNECT_GRACE) — короче,
// потому что попытки больше не "дорогие" (не тратят последний из четырёх
// шансов) и не ведут к завершению звонка, если промахнутся.
const RESTART_GRACE_MS = 2000;

// §2.2 — дальнейшая каденция ЗАВИСИТ ОТ ТОГО, сколько времени УЖЕ прошло с
// начала текущего эпизода RECONNECTING (не от номера попытки, не от времени
// с предыдущей попытки — интервал сам себя гарантирует самопланированием
// таймера). Три фазы по предложенным в задании границам.
const RESTART_INTERVAL_PHASE1_MS = 5000; // первая минута
const RESTART_INTERVAL_PHASE2_MS = 15000; // с 1-й по 5-ю минуту
const RESTART_INTERVAL_PHASE3_MS = 30000; // после 5-й минуты — верхний предел
// Экспортирован — TZ-recovery-policy.md §6/1: UI использует ту же границу для
// short/long фаз плашки "восстановление связи" (секундомер vs спокойный текст),
// чтобы не заводить отдельную копию этого числа в call-overlay.jsx.
export const RESTART_PHASE1_END_MS = 60000;
const RESTART_PHASE2_END_MS = 300000;

// §2.2 — разброс ±30% применяется в call-runtime.js при АРМИРОВАНИИ реального
// таймера (setTimeout), не здесь: reduce() обязан быть детерминированным,
// Math.random() внутри чистого ядра сделал бы его непредсказуемым для тестов.
// Значение экспортируется, чтобы call-runtime.js не заводило собственное.
export const RESTART_JITTER_RATIO = 0.3;

// §2.3 — с какой попытки пересоздавать RTCPeerConnection (не просто
// pc.createOffer({iceRestart:true}) на старом) и с какой форсировать relay.
// Именованы раздельно (задание упоминает их раздельно), хотя сейчас равны.
const RESTART_RECREATE_PC_AFTER = 3;
const RESTART_FORCE_RELAY_AFTER = 3;

// §2.4 — предохранитель. Единственный оставшийся автоматический выход из
// RECONNECTING по времени. Значение по умолчанию — 10 минут (обоснование
// в самом ТЗ: "покрывает почти любой реальный сбой... не жжёт батарею").
// Настраивается: call-runtime.js передаёт event.safetyCapMs, взятый из
// настроек пользователя; при его отсутствии используется это значение.
export const DEFAULT_RECOVERY_SAFETY_CAP_MS = 600000;

// §3 — признак жизни звонка. CALL_HEARTBEAT_MS — как часто СВОЯ сторона
// шлёт сигнал "я ещё здесь". PEER_ALIVE_FRESH_MS — сколько можно молчать
// собеседнику (при том что НАШ транспорт всё это время подключён), прежде
// чем считать его ушедшим. Разница на порядок (45с окно / 3с период) даёт
// 10+ шансов на успешную доставку одного сигнала до истечения окна даже
// при частичной потере.
export const CALL_HEARTBEAT_MS = 3000;
export const PEER_ALIVE_FRESH_MS = 45000;

// §2.2 — чистая функция расписания: сколько ждать до СЛЕДУЮЩЕЙ проверки,
// в зависимости от того, сколько мы уже в RECONNECTING (считает вызывающая
// сторона, здесь только сравнение с именованными границами).
export function restartIntervalForElapsed(elapsedMs) {
	if (elapsedMs < RESTART_PHASE1_END_MS) return RESTART_INTERVAL_PHASE1_MS;
	if (elapsedMs < RESTART_PHASE2_END_MS) return RESTART_INTERVAL_PHASE2_MS;
	return RESTART_INTERVAL_PHASE3_MS;
}

function emit(stateName, reason) {
	return reason !== undefined ? { type: "EMIT", stateName, reason } : { type: "EMIT", stateName };
}

function ignore(state) {
	return { state, commands: [] };
}

// §4 — любой переход в ENDED, КРОМЕ remote_hangup, обязан слать SEND_HANGUP
// (найдено в 10-LIVE-INCIDENT-2026-09-07.md §11.5: переход по connection_lost
// делал только CLOSE_PC, собеседник висел без единого сигнала). ended() ниже
// — новая ЕДИНАЯ точка для всех «непримиримых» причин (user_hangup решается
// отдельно, там SEND_HANGUP и так уже был всегда); endedByRemote — для
// remote_hangup, единственного случая без SEND_HANGUP (отвечать хангапом на
// хангап — эхо, не нужно).
function ended(state, reason, extraCommands = []) {
	const commands = [{ type: "SEND_HANGUP" }, { type: "CLOSE_PC" }, ...extraCommands, emit("ENDED", reason)];
	return { state: { ...state, name: "ENDED", reason }, commands };
}

function endedByRemote(state, reason) {
	return { state: { ...state, name: "ENDED", reason }, commands: [{ type: "CLOSE_PC" }, emit("ENDED", reason)] };
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
			state: {
				name: "OUTGOING_RINGING",
				role: "caller",
				sessionId,
				peerPubkey: event.peerPubkey,
				polite,
				restartCount: 0,
				reason: null,
				safetyCapMs: event.safetyCapMs ?? DEFAULT_RECOVERY_SAFETY_CAP_MS,
			},
			commands: [{ type: "ACQUIRE_MIC" }, { type: "CREATE_OFFER" }, { type: "START_TIMER", name: "ring", ms: RING_TIMEOUT }, emit("OUTGOING_RINGING")],
		};
	}
	if (event.type === "REMOTE_OFFER") {
		const polite = event.myPubkey < event.fromPubkey;
		return {
			state: {
				name: "INCOMING_RINGING",
				role: "callee",
				sessionId: event.sessionId,
				peerPubkey: event.fromPubkey,
				polite,
				restartCount: 0,
				reason: null,
				safetyCapMs: event.safetyCapMs ?? DEFAULT_RECOVERY_SAFETY_CAP_MS,
			},
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
			return {
				state: { ...state, name: "ENDED", reason: "no_answer" },
				commands: [{ type: "SEND_HANGUP" }, { type: "CLOSE_PC" }, emit("ENDED", "no_answer")],
			};
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
			return {
				state: { ...state, name: "ENDED", reason: "missed" },
				commands: [{ type: "SEND_HANGUP" }, { type: "CLOSE_PC" }, emit("ENDED", "missed")],
			};
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
				commands: [{ type: "CANCEL_TIMER", name: "connect" }, { type: "START_TIMER", name: "heartbeat", ms: CALL_HEARTBEAT_MS }, emit("CONNECTED")],
			};
		case "ICE_FAILED":
			return {
				state: { ...state, name: "ENDED", reason: "connect_failed" },
				commands: [{ type: "SEND_HANGUP" }, { type: "CLOSE_PC" }, emit("ENDED", "connect_failed")],
			};
		case "CONNECT_TIMEOUT":
			return {
				state: { ...state, name: "ENDED", reason: "connect_failed" },
				commands: [{ type: "SEND_HANGUP" }, { type: "CLOSE_PC" }, emit("ENDED", "connect_failed")],
			};
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

// §1 — вход в RECONNECTING. ОБЩИЙ для ICE_DISCONNECTED и ICE_FAILED: раньше
// ICE_FAILED в CONNECTED не имел кейса вовсе (default: ignore) — найдено
// аудитом (09-FINAL-AUDIT.md §2, Opus H4-семья) как "тихий баг: FSM думает
// звонок жив, пока пользователь не положит трубку вручную". Если браузер
// скачет connected→failed в обход disconnected, теперь это тоже вход в
// восстановление, а не зависание.
function enterReconnecting(state) {
	return {
		state: { ...state, name: "RECONNECTING" },
		commands: [{ type: "START_TIMER", name: "restartTick", ms: RESTART_GRACE_MS }, emit("RECONNECTING")],
	};
}

function reduceConnected(state, event) {
	switch (event.type) {
		case "LOCAL_ICE":
			return { state, commands: [{ type: "SEND_ICE", candidate: event.candidate }] };
		case "REMOTE_ICE":
			return { state, commands: [{ type: "ADD_ICE", candidate: event.candidate }] };
		case "ICE_DISCONNECTED":
		case "ICE_FAILED":
			return enterReconnecting(state);
		case "REMOTE_OFFER":
			// Повтор той же сессии без restart — реплей strfry / ретрай первой
			// установки, не ICE-рестарт. Без флага SET_REMOTE со старым SDP
			// на живом соединении ломает пару.
			if (!event.restart) return ignore(state);
			return { state, commands: [{ type: "SET_REMOTE", sdp: event.sdp }, { type: "CREATE_ANSWER" }] };
		case "HEARTBEAT_TICK":
			return { state, commands: [{ type: "SEND_HEARTBEAT" }, { type: "START_TIMER", name: "heartbeat", ms: CALL_HEARTBEAT_MS }] };
		case "USER_HANGUP":
			return ended(state, "hangup");
		case "REMOTE_HANGUP":
			return endedByRemote(state, "remote_hangup");
		default:
			return ignore(state);
	}
}

// §2.1/§2.2/§2.3/§2.4/§3 — единственная точка входа для «время проверить,
// можно ли (нужно ли) попробовать восстановиться ещё раз». event несёт ТРИ
// уже вычисленных снаружи числа/флага — reduce() сам никогда не трогает
// часы:
//   transportConnected — наш сокет к релею сейчас реально подключён;
//   peerSilentMs        — сколько мс молчит собеседник (null, если ещё
//                          ни разу не теряли признак жизни в этом эпизоде);
//   elapsedReconnectingMs — сколько мс мы уже в RECONNECTING.
function reduceRestartTick(state, event) {
	// §3 — собеседник ушёл: наш транспорт жив, а собеседника не слышно дольше
	// PEER_ALIVE_FRESH_MS. Проверяется ПЕРВЫМ и только когда транспорт жив —
	// "пока свой транспорт не подключён, отсчёт приостановлен" (§3, буквально).
	if (event.transportConnected && event.peerSilentMs !== null && event.peerSilentMs >= PEER_ALIVE_FRESH_MS) {
		return ended(state, "peer_gone");
	}
	// §2.4 — предохранитель. Проверяется до предусловия попытки: даже если
	// связи с релеем нет, случайно зависший навсегда звонок всё равно должен
	// когда-нибудь закрыться (реальный автоматический выход остаётся только
	// один — не считая peer_gone выше).
	if (event.elapsedReconnectingMs >= state.safetyCapMs) {
		return ended(state, "safety_cap");
	}
	// §2.1 — предусловие попытки: свой транспорт должен быть подключён.
	// Если нет — НЕ тратим попытку и не двигаем restartCount, просто ждём
	// следующей проверки тем же интервалом (не растим его — это ожидание,
	// не попытка). Причина ожидания — забота вызывающей стороны (трассировка,
	// §7), reduce() её не описывает, только не выполняет DO_ICE_RESTART.
	if (!event.transportConnected) {
		return {
			state,
			commands: [{ type: "START_TIMER", name: "restartTick", ms: restartIntervalForElapsed(event.elapsedReconnectingMs) }],
		};
	}
	// Предусловие выполнено — реальная попытка. restartCount растёт ТОЛЬКО
	// здесь (используется для диагностики и порогов §2.3, не для завершения —
	// TZ-recovery-policy.md §2.2: "MAX_RESTARTS удаляется как условие
	// завершения. Счётчик остаётся только для диагностики и для §2.3").
	const restartCount = state.restartCount + 1;
	const commands = [];
	if (!state.polite) {
		commands.push({
			type: "DO_ICE_RESTART",
			recreate: restartCount >= RESTART_RECREATE_PC_AFTER,
			forceRelay: restartCount >= RESTART_FORCE_RELAY_AFTER,
		});
	}
	commands.push({ type: "START_TIMER", name: "restartTick", ms: restartIntervalForElapsed(event.elapsedReconnectingMs) });
	return { state: { ...state, restartCount }, commands };
}

function reduceReconnecting(state, event) {
	switch (event.type) {
		case "ICE_CONNECTED":
			return {
				state: { ...state, name: "CONNECTED", restartCount: 0 },
				commands: [{ type: "CANCEL_TIMER", name: "restartTick" }, emit("CONNECTED")],
			};
		case "RESTART_TICK":
			return reduceRestartTick(state, event);
		case "HEARTBEAT_TICK":
			return { state, commands: [{ type: "SEND_HEARTBEAT" }, { type: "START_TIMER", name: "heartbeat", ms: CALL_HEARTBEAT_MS }] };
		case "LOCAL_OFFER_READY":
			return { state, commands: [{ type: "SEND_OFFER", sdp: event.sdp, restart: true }] };
		case "REMOTE_OFFER":
			if (!event.restart) return ignore(state);
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
			return ended(state, "hangup");
		case "REMOTE_HANGUP":
			return endedByRemote(state, "remote_hangup");
		default:
			return ignore(state);
	}
}
