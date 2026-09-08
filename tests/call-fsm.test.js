import { test } from "node:test";
import assert from "node:assert/strict";
import { reduce, restartIntervalForElapsed, DEFAULT_RECOVERY_SAFETY_CAP_MS, PEER_ALIVE_FRESH_MS } from "../src/domain/calls/call-fsm.js";

// TZ-recovery-policy.md — RESTART_TICK несёт уже вычисленные снаружи числа
// (call-runtime.js в реальности), здесь собираем вручную. tickEvent()
// по умолчанию описывает "всё в порядке, пора попробовать": транспорт жив,
// собеседник не потерян, эпизод только начался.
function tickEvent(overrides = {}) {
	return { type: "RESTART_TICK", sessionId: SID, transportConnected: true, peerSilentMs: 0, elapsedReconnectingMs: 0, ...overrides };
}

// Этап 48 — VOICE.md, §4 (тест-спека). Табличные тесты: строка =
// (state_in, event) ⇒ (state_out, commands). Две identity фиксированы так,
// чтобы ALICE < BOB лексикографически (hex) — ALICE всегда polite, BOB всегда
// impolite, независимо от того, кто в конкретном тесте звонит первым.
const ALICE = "1111111111111111111111111111111111111111111111111111111111111111".slice(0, 64);
const BOB = "2222222222222222222222222222222222222222222222222222222222222222".slice(0, 64);
const SID = "session-abc";
const OTHER_SID = "session-zzz";

function idle() {
	return { name: "IDLE", role: null, sessionId: null, peerPubkey: null, polite: null, restartCount: 0, reason: null };
}

function names(commands) {
	return commands.map((c) => c.type);
}

function findCmd(commands, type) {
	return commands.find((c) => c.type === type);
}

// --- 1. Happy caller: IDLE→OUTGOING→(offer→answer)→CONNECTING→CONNECTED ---
test("happy caller: IDLE -> OUTGOING_RINGING -> CONNECTING -> CONNECTED", () => {
	let s = idle();

	let r = reduce(s, { type: "USER_PLACE_CALL", peerPubkey: BOB, myPubkey: ALICE });
	assert.equal(r.state.name, "OUTGOING_RINGING");
	assert.equal(r.state.role, "caller");
	assert.equal(r.state.peerPubkey, BOB);
	assert.equal(r.state.polite, true); // ALICE < BOB
	assert.ok(r.state.sessionId, "sessionId сгенерирован");
	assert.deepEqual(names(r.commands), ["ACQUIRE_MIC", "CREATE_OFFER", "START_TIMER", "EMIT"]);
	assert.deepEqual(findCmd(r.commands, "START_TIMER"), { type: "START_TIMER", name: "ring", ms: 30000 });
	s = r.state;
	const sid = s.sessionId;

	r = reduce(s, { type: "LOCAL_OFFER_READY", sessionId: sid, sdp: "offer-sdp" });
	assert.equal(r.state.name, "OUTGOING_RINGING");
	assert.deepEqual(r.commands, [{ type: "SEND_OFFER", sdp: "offer-sdp" }]);
	s = r.state;

	r = reduce(s, { type: "REMOTE_ANSWER", sessionId: sid, sdp: "answer-sdp" });
	assert.equal(r.state.name, "CONNECTING");
	assert.deepEqual(names(r.commands), ["SET_REMOTE", "CANCEL_TIMER", "START_TIMER", "EMIT"]);
	assert.deepEqual(findCmd(r.commands, "START_TIMER"), { type: "START_TIMER", name: "connect", ms: 15000 });
	s = r.state;

	r = reduce(s, { type: "ICE_CONNECTED", sessionId: sid });
	assert.equal(r.state.name, "CONNECTED");
	assert.equal(r.state.restartCount, 0);
	// TZ-recovery-policy.md §3 — первое успешное соединение взводит heartbeat.
	assert.deepEqual(names(r.commands), ["CANCEL_TIMER", "START_TIMER", "EMIT"]);
	assert.deepEqual(findCmd(r.commands, "START_TIMER"), { type: "START_TIMER", name: "heartbeat", ms: 3000 });
});

// --- 2. Happy callee: IDLE→(offer)→INCOMING→(accept)→CONNECTING→(answer, ice_connected)→CONNECTED ---
test("happy callee: IDLE -> INCOMING_RINGING -> CONNECTING -> CONNECTED", () => {
	let s = idle();

	let r = reduce(s, { type: "REMOTE_OFFER", sdp: "offer-sdp", sessionId: SID, fromPubkey: ALICE, myPubkey: BOB });
	assert.equal(r.state.name, "INCOMING_RINGING");
	assert.equal(r.state.role, "callee");
	assert.equal(r.state.sessionId, SID);
	assert.equal(r.state.peerPubkey, ALICE);
	assert.equal(r.state.polite, false); // myPubkey=BOB, peerPubkey=ALICE; BOB < ALICE лексикографически -> false, BOB impolite
	assert.deepEqual(names(r.commands), ["SET_REMOTE", "START_TIMER", "EMIT"]);
	s = r.state;

	r = reduce(s, { type: "USER_ACCEPT", sessionId: SID });
	assert.equal(r.state.name, "CONNECTING");
	assert.deepEqual(names(r.commands), ["ACQUIRE_MIC", "CREATE_ANSWER", "CANCEL_TIMER", "START_TIMER", "EMIT"]);
	s = r.state;

	r = reduce(s, { type: "LOCAL_ANSWER_READY", sessionId: SID, sdp: "answer-sdp" });
	assert.deepEqual(r.commands, [{ type: "SEND_ANSWER", sdp: "answer-sdp" }]);
	s = r.state;

	r = reduce(s, { type: "ICE_CONNECTED", sessionId: SID });
	assert.equal(r.state.name, "CONNECTED");
	assert.equal(r.state.restartCount, 0);
});

// --- 3. Ring timeout у caller и callee ---
test("ring timeout: caller -> ENDED(no_answer)", () => {
	let s = idle();
	let r = reduce(s, { type: "USER_PLACE_CALL", peerPubkey: BOB, myPubkey: ALICE });
	s = r.state;
	r = reduce(s, { type: "RING_TIMEOUT", sessionId: s.sessionId });
	assert.equal(r.state.name, "ENDED");
	assert.equal(r.state.reason, "no_answer");
	assert.deepEqual(names(r.commands), ["SEND_HANGUP", "CLOSE_PC", "EMIT"]);
});

test("ring timeout: callee -> ENDED(missed)", () => {
	let s = idle();
	let r = reduce(s, { type: "REMOTE_OFFER", sdp: "offer", sessionId: SID, fromPubkey: ALICE, myPubkey: BOB });
	s = r.state;
	r = reduce(s, { type: "RING_TIMEOUT", sessionId: SID });
	assert.equal(r.state.name, "ENDED");
	assert.equal(r.state.reason, "missed");
	assert.deepEqual(names(r.commands), ["SEND_HANGUP", "CLOSE_PC", "EMIT"]);
});

// --- 4. Reject: callee USER_REJECT -> ENDED(rejected); caller видит REMOTE_HANGUP ---
test("reject: callee USER_REJECT -> ENDED(rejected)", () => {
	let s = idle();
	let r = reduce(s, { type: "REMOTE_OFFER", sdp: "offer", sessionId: SID, fromPubkey: ALICE, myPubkey: BOB });
	s = r.state;
	r = reduce(s, { type: "USER_REJECT", sessionId: SID });
	assert.equal(r.state.name, "ENDED");
	assert.equal(r.state.reason, "rejected");
	assert.deepEqual(names(r.commands), ["SEND_HANGUP", "CLOSE_PC", "CANCEL_TIMER", "EMIT"]);
});

test("reject: caller получает REMOTE_HANGUP -> ENDED(rejected)", () => {
	let s = idle();
	let r = reduce(s, { type: "USER_PLACE_CALL", peerPubkey: BOB, myPubkey: ALICE });
	s = r.state;
	r = reduce(s, { type: "REMOTE_HANGUP", sessionId: s.sessionId });
	assert.equal(r.state.name, "ENDED");
	assert.equal(r.state.reason, "rejected");
	assert.deepEqual(names(r.commands), ["CLOSE_PC", "CANCEL_TIMER", "EMIT"]);
});

// --- 5. Glare, polite-ветка: OUTGOING + REMOTE_OFFER (от того же пира) -> CONNECTING как callee ---
test("glare, polite-ветка: ALICE (polite) видит встречный REMOTE_OFFER -> CONNECTING как callee", () => {
	let s = idle();
	let r = reduce(s, { type: "USER_PLACE_CALL", peerPubkey: BOB, myPubkey: ALICE });
	s = r.state;
	assert.equal(s.polite, true);
	const mySid = s.sessionId;

	r = reduce(s, { type: "REMOTE_OFFER", sdp: "bob-offer", sessionId: "bob-session", fromPubkey: BOB, myPubkey: ALICE });
	assert.equal(r.state.name, "CONNECTING");
	assert.equal(r.state.role, "callee");
	assert.equal(r.state.sessionId, "bob-session", "polite принимает СЕССИЮ импровайзера (impolite-пира), а не свою");
	assert.ok(names(r.commands).includes("SET_REMOTE"));
	assert.ok(names(r.commands).includes("CREATE_ANSWER"));
	assert.ok(names(r.commands).includes("CANCEL_TIMER"));
	assert.notEqual(r.state.sessionId, mySid);
});

// --- 6. Glare, impolite-ветка: OUTGOING + REMOTE_OFFER -> игнор, остаётся caller ---
test("glare, impolite-ветка: BOB (impolite) игнорирует встречный REMOTE_OFFER, остаётся caller", () => {
	let s = idle();
	let r = reduce(s, { type: "USER_PLACE_CALL", peerPubkey: ALICE, myPubkey: BOB });
	s = r.state;
	assert.equal(s.polite, false);
	const mySid = s.sessionId;

	r = reduce(s, { type: "REMOTE_OFFER", sdp: "alice-offer", sessionId: "alice-session", fromPubkey: ALICE, myPubkey: BOB });
	assert.equal(r.state.name, "OUTGOING_RINGING", "impolite остаётся в исходном состоянии");
	assert.equal(r.state.role, "caller");
	assert.equal(r.state.sessionId, mySid, "своя сессия не заменяется");
	assert.deepEqual(r.commands, [], "встречный оффер молча игнорируется (I5)");
});

// --- 7. Самолечение: CONNECTED->ICE_DISCONNECTED->RECONNECTING->ICE_CONNECTED->CONNECTED (restartCount=0) ---
test("самолечение ICE: CONNECTED -> RECONNECTING -> CONNECTED, restartCount остаётся 0", () => {
	let s = { name: "CONNECTED", role: "caller", sessionId: SID, peerPubkey: BOB, polite: true, restartCount: 0, reason: null, safetyCapMs: DEFAULT_RECOVERY_SAFETY_CAP_MS };

	let r = reduce(s, { type: "ICE_DISCONNECTED", sessionId: SID });
	assert.equal(r.state.name, "RECONNECTING");
	assert.deepEqual(names(r.commands), ["START_TIMER", "EMIT"]);
	// TZ-recovery-policy.md §2.2 — пауза перед первой попыткой сократилась с
	// 4000 (DISCONNECT_GRACE) до RESTART_GRACE_MS=2000 (попытки больше не
	// "дорогие" — не тратят один из четырёх шансов, которых больше нет).
	assert.deepEqual(findCmd(r.commands, "START_TIMER"), { type: "START_TIMER", name: "restartTick", ms: 2000 });
	s = r.state;

	r = reduce(s, { type: "ICE_CONNECTED", sessionId: SID });
	assert.equal(r.state.name, "CONNECTED");
	assert.equal(r.state.restartCount, 0);
	// Один таймер восстановления (restartTick) вместо старых двух (grace+backoff).
	assert.deepEqual(names(r.commands), ["CANCEL_TIMER", "EMIT"]);
});

// TZ-recovery-policy.md §1 — тот же бонус-фикс, что был найден аудитом
// (09-FINAL-AUDIT.md, Opus H4-семья): ICE_FAILED в CONNECTED раньше вообще
// не имел кейса (default:ignore) — звонок тихо зависал. Теперь ICE_FAILED
// в CONNECTED ведёт в RECONNECTING ТОЧНО ТАК ЖЕ, как ICE_DISCONNECTED.
test("ICE_FAILED в CONNECTED (не только ICE_DISCONNECTED) тоже ведёт в RECONNECTING — старый тихий баг закрыт", () => {
	const s = { name: "CONNECTED", role: "caller", sessionId: SID, peerPubkey: BOB, polite: true, restartCount: 0, reason: null, safetyCapMs: DEFAULT_RECOVERY_SAFETY_CAP_MS };
	const r = reduce(s, { type: "ICE_FAILED", sessionId: SID });
	assert.equal(r.state.name, "RECONNECTING");
	assert.deepEqual(findCmd(r.commands, "START_TIMER"), { type: "START_TIMER", name: "restartTick", ms: 2000 });
});

// --- 8. Рестарт с восстановлением: RESTART_TICK -> (impolite: DO_ICE_RESTART) -> ICE_CONNECTED -> CONNECTED ---
test("рестарт (impolite): RESTART_TICK -> DO_ICE_RESTART -> ICE_CONNECTED -> CONNECTED", () => {
	let s = { name: "RECONNECTING", role: "caller", sessionId: SID, peerPubkey: ALICE, polite: false, restartCount: 0, reason: null, safetyCapMs: DEFAULT_RECOVERY_SAFETY_CAP_MS };

	let r = reduce(s, tickEvent());
	assert.equal(r.state.name, "RECONNECTING");
	assert.equal(r.state.restartCount, 1);
	assert.deepEqual(names(r.commands), ["DO_ICE_RESTART", "START_TIMER"]);
	// §2.3 — попытка №1: не пересоздаём pc, не форсируем relay (порог — 3-я).
	assert.deepEqual(findCmd(r.commands, "DO_ICE_RESTART"), { type: "DO_ICE_RESTART", recreate: false, forceRelay: false });
	// §2.2 — фаза 1 (первая минута, elapsedReconnectingMs=0): интервал 5000.
	assert.deepEqual(findCmd(r.commands, "START_TIMER"), { type: "START_TIMER", name: "restartTick", ms: 5000 });
	s = r.state;

	r = reduce(s, { type: "ICE_CONNECTED", sessionId: SID });
	assert.equal(r.state.name, "CONNECTED");
	assert.equal(r.state.restartCount, 0, "восстановление сбрасывает счётчик");
});

test("рестарт (polite): RESTART_TICK -> ждёт (без DO_ICE_RESTART), REMOTE_OFFER -> CREATE_ANSWER", () => {
	let s = { name: "RECONNECTING", role: "callee", sessionId: SID, peerPubkey: BOB, polite: true, restartCount: 0, reason: null, safetyCapMs: DEFAULT_RECOVERY_SAFETY_CAP_MS };

	let r = reduce(s, tickEvent());
	assert.equal(r.state.name, "RECONNECTING");
	assert.equal(r.state.restartCount, 1, "счётчик растёт у ОБЕИХ сторон — это диагностика (§2.2), не только у инициатора");
	assert.deepEqual(names(r.commands), ["START_TIMER"], "polite НЕ инициирует рестарт сам");
	s = r.state;

	r = reduce(s, { type: "REMOTE_OFFER", sdp: "restart-offer", sessionId: SID, fromPubkey: BOB });
	assert.equal(r.state.name, "RECONNECTING");
	assert.deepEqual(names(r.commands), ["SET_REMOTE", "CREATE_ANSWER"]);
});

// --- 9. Новая модель восстановления (TZ-recovery-policy.md §1/§2/§3/§2.4):
// потеря сети САМА ПО СЕБЕ больше не завершает звонок. Автоматических
// выходов из RECONNECTING остаётся ровно два: peer_gone и safety_cap. ---

test("RECONNECTING переживает ЛЮБОЕ число попыток без завершения, пока транспорт жив и собеседник не потерян", () => {
	let s = { name: "RECONNECTING", role: "caller", sessionId: SID, peerPubkey: ALICE, polite: false, restartCount: 0, reason: null, safetyCapMs: DEFAULT_RECOVERY_SAFETY_CAP_MS };
	// 20 тиков — намного больше старого MAX_RESTARTS=4 — и всё ещё RECONNECTING.
	for (let i = 0; i < 20; i++) {
		const r = reduce(s, tickEvent({ peerSilentMs: 100, elapsedReconnectingMs: i * 5000 }));
		assert.equal(r.state.name, "RECONNECTING", `тик ${i}: старая модель завершила бы звонок на 4-м`);
		s = r.state;
	}
	assert.equal(s.restartCount, 20, "счётчик продолжает расти — используется для диагностики и §2.3, не для завершения");
});

test("§3: собеседник объективно ушёл — свой транспорт жив, признаков жизни нет дольше PEER_ALIVE_FRESH_MS -> ENDED(peer_gone), с SEND_HANGUP (§4)", () => {
	const s = { name: "RECONNECTING", role: "caller", sessionId: SID, peerPubkey: ALICE, polite: false, restartCount: 3, reason: null, safetyCapMs: DEFAULT_RECOVERY_SAFETY_CAP_MS };
	const r = reduce(s, tickEvent({ transportConnected: true, peerSilentMs: PEER_ALIVE_FRESH_MS, elapsedReconnectingMs: 50000 }));
	assert.equal(r.state.name, "ENDED");
	assert.equal(r.state.reason, "peer_gone");
	assert.deepEqual(names(r.commands), ["SEND_HANGUP", "CLOSE_PC", "EMIT"]);
});

test("§3: собеседник молчит дольше PEER_ALIVE_FRESH_MS, НО свой транспорт не подключён — НЕ завершается (своя проблема, не считается уходом собеседника)", () => {
	const s = { name: "RECONNECTING", role: "caller", sessionId: SID, peerPubkey: ALICE, polite: false, restartCount: 3, reason: null, safetyCapMs: DEFAULT_RECOVERY_SAFETY_CAP_MS };
	const r = reduce(s, tickEvent({ transportConnected: false, peerSilentMs: PEER_ALIVE_FRESH_MS * 3, elapsedReconnectingMs: 50000 }));
	assert.equal(r.state.name, "RECONNECTING", "отсчёт §3 приостановлен, пока свой транспорт лежит");
	assert.equal(r.state.restartCount, 3, "попытка не потрачена — предусловие §2.1 не выполнено");
	assert.deepEqual(names(r.commands), ["START_TIMER"], "ждём следующей проверки тем же интервалом, не растим его");
});

test("§2.1: собственный транспорт не подключён — попытка не делается (restartCount не растёт), просто следующая проверка", () => {
	const s = { name: "RECONNECTING", role: "caller", sessionId: SID, peerPubkey: ALICE, polite: false, restartCount: 1, reason: null, safetyCapMs: DEFAULT_RECOVERY_SAFETY_CAP_MS };
	const r = reduce(s, tickEvent({ transportConnected: false, peerSilentMs: 1000, elapsedReconnectingMs: 10000 }));
	assert.equal(r.state.name, "RECONNECTING");
	assert.equal(r.state.restartCount, 1, "не потрачена");
	assert.deepEqual(r.commands, [{ type: "START_TIMER", name: "restartTick", ms: restartIntervalForElapsed(10000) }]);
});

test("§2.4: предохранитель — elapsedReconnectingMs достиг safetyCapMs -> ENDED(safety_cap), с SEND_HANGUP", () => {
	const s = { name: "RECONNECTING", role: "caller", sessionId: SID, peerPubkey: ALICE, polite: false, restartCount: 40, reason: null, safetyCapMs: 600000 };
	const r = reduce(s, tickEvent({ transportConnected: true, peerSilentMs: 500, elapsedReconnectingMs: 600000 }));
	assert.equal(r.state.name, "ENDED");
	assert.equal(r.state.reason, "safety_cap");
	assert.deepEqual(names(r.commands), ["SEND_HANGUP", "CLOSE_PC", "EMIT"]);
});

test("§2.4: предохранитель проверяется ДО предусловия транспорта — даже с лежащим транспортом предохранитель всё равно сработает", () => {
	const s = { name: "RECONNECTING", role: "caller", sessionId: SID, peerPubkey: ALICE, polite: false, restartCount: 40, reason: null, safetyCapMs: 600000 };
	const r = reduce(s, tickEvent({ transportConnected: false, peerSilentMs: null, elapsedReconnectingMs: 600000 }));
	assert.equal(r.state.name, "ENDED");
	assert.equal(r.state.reason, "safety_cap");
});

test("§2.3: с 3-й попытки — recreate и forceRelay включаются в DO_ICE_RESTART", () => {
	const s = { name: "RECONNECTING", role: "caller", sessionId: SID, peerPubkey: ALICE, polite: false, restartCount: 2, reason: null, safetyCapMs: DEFAULT_RECOVERY_SAFETY_CAP_MS };
	const r = reduce(s, tickEvent({ elapsedReconnectingMs: 20000 }));
	assert.equal(r.state.restartCount, 3);
	assert.deepEqual(findCmd(r.commands, "DO_ICE_RESTART"), { type: "DO_ICE_RESTART", recreate: true, forceRelay: true });
});

test("restartIntervalForElapsed: три фазы каденции (§2.2)", () => {
	assert.equal(restartIntervalForElapsed(0), 5000);
	assert.equal(restartIntervalForElapsed(59999), 5000);
	assert.equal(restartIntervalForElapsed(60000), 15000);
	assert.equal(restartIntervalForElapsed(299999), 15000);
	assert.equal(restartIntervalForElapsed(300000), 30000);
	assert.equal(restartIntervalForElapsed(10 * 60000), 30000, "верхний предел, не растёт дальше");
});

// --- 10. Устаревшая сессия: событие с чужим sessionId -> игнор, состояние не меняется (I1) ---
test("I1: событие с чужим sessionId игнорируется, состояние не меняется", () => {
	const s = { name: "CONNECTED", role: "caller", sessionId: SID, peerPubkey: BOB, polite: true, restartCount: 0, reason: null };
	const r = reduce(s, { type: "ICE_DISCONNECTED", sessionId: OTHER_SID });
	assert.deepEqual(r.state, s, "состояние — тот же объект по значению, БЕЗ изменений");
	assert.deepEqual(r.commands, []);
});

test("I1: REMOTE_HANGUP с чужим sessionId в CONNECTING игнорируется", () => {
	const s = { name: "CONNECTING", role: "callee", sessionId: SID, peerPubkey: ALICE, polite: true, restartCount: 0, reason: null };
	const r = reduce(s, { type: "REMOTE_HANGUP", sessionId: OTHER_SID });
	assert.deepEqual(r.state, s);
	assert.deepEqual(r.commands, []);
});

// --- 11. Тотальность: случайное событие в случайном состоянии, не описанное в δ -> без изменений (I5) ---
test("I5: неописанное в δ событие в IDLE -> игнор (тотальность)", () => {
	const s = idle();
	const r = reduce(s, { type: "ICE_CONNECTED", sessionId: "whatever" });
	assert.deepEqual(r.state, s);
	assert.deepEqual(r.commands, []);
});

test("I5: неописанное в δ событие в ENDED -> игнор (терминальное состояние без исходящих переходов)", () => {
	const s = { name: "ENDED", role: "caller", sessionId: SID, peerPubkey: BOB, polite: true, restartCount: 0, reason: "hangup" };
	const r = reduce(s, { type: "USER_HANGUP", sessionId: SID });
	assert.deepEqual(r.state, s);
	assert.deepEqual(r.commands, []);
});

test("I5: RING_TIMEOUT в CONNECTED (не описан в δ для этого состояния) -> игнор", () => {
	const s = { name: "CONNECTED", role: "caller", sessionId: SID, peerPubkey: BOB, polite: true, restartCount: 0, reason: null };
	const r = reduce(s, { type: "RING_TIMEOUT", sessionId: SID });
	assert.deepEqual(r.state, s);
	assert.deepEqual(r.commands, []);
});

// --- Дополнительно: остальные переходы CONNECTING/CONNECTED/RECONNECTING (§2 VOICE.md), не входящие в 11 обязательных групп ---

test("CONNECTING: ICE_FAILED -> ENDED(connect_failed) без попытки рестарта", () => {
	const s = { name: "CONNECTING", role: "caller", sessionId: SID, peerPubkey: BOB, polite: true, restartCount: 0, reason: null };
	const r = reduce(s, { type: "ICE_FAILED", sessionId: SID });
	assert.equal(r.state.name, "ENDED");
	assert.equal(r.state.reason, "connect_failed");
	assert.deepEqual(names(r.commands), ["SEND_HANGUP", "CLOSE_PC", "EMIT"]);
});

test("CONNECTING: CONNECT_TIMEOUT -> ENDED(connect_failed)", () => {
	const s = { name: "CONNECTING", role: "callee", sessionId: SID, peerPubkey: ALICE, polite: true, restartCount: 0, reason: null };
	const r = reduce(s, { type: "CONNECT_TIMEOUT", sessionId: SID });
	assert.equal(r.state.name, "ENDED");
	assert.equal(r.state.reason, "connect_failed");
});

test("CONNECTING: USER_HANGUP -> ENDED(hangup)", () => {
	const s = { name: "CONNECTING", role: "caller", sessionId: SID, peerPubkey: BOB, polite: true, restartCount: 0, reason: null };
	const r = reduce(s, { type: "USER_HANGUP", sessionId: SID });
	assert.equal(r.state.name, "ENDED");
	assert.equal(r.state.reason, "hangup");
	assert.deepEqual(names(r.commands), ["SEND_HANGUP", "CLOSE_PC", "CANCEL_TIMER", "EMIT"]);
});

test("CONNECTED: USER_HANGUP -> ENDED(hangup)", () => {
	const s = { name: "CONNECTED", role: "caller", sessionId: SID, peerPubkey: BOB, polite: true, restartCount: 0, reason: null };
	const r = reduce(s, { type: "USER_HANGUP", sessionId: SID });
	assert.equal(r.state.name, "ENDED");
	assert.equal(r.state.reason, "hangup");
	assert.deepEqual(names(r.commands), ["SEND_HANGUP", "CLOSE_PC", "EMIT"]);
});

test("CONNECTED: REMOTE_HANGUP -> ENDED(remote_hangup)", () => {
	const s = { name: "CONNECTED", role: "callee", sessionId: SID, peerPubkey: ALICE, polite: false, restartCount: 0, reason: null };
	const r = reduce(s, { type: "REMOTE_HANGUP", sessionId: SID });
	assert.equal(r.state.name, "ENDED");
	assert.equal(r.state.reason, "remote_hangup");
	assert.deepEqual(names(r.commands), ["CLOSE_PC", "EMIT"]);
});

test("CONNECTED: REMOTE_OFFER (пир инициировал ICE restart) -> остаёмся CONNECTED, отвечаем", () => {
	const s = { name: "CONNECTED", role: "callee", sessionId: SID, peerPubkey: ALICE, polite: true, restartCount: 0, reason: null };
	const r = reduce(s, { type: "REMOTE_OFFER", sdp: "restart-offer", sessionId: SID, fromPubkey: ALICE });
	assert.equal(r.state.name, "CONNECTED", "остаёмся в CONNECTED, НЕ переходим в RECONNECTING сами по себе");
	assert.deepEqual(names(r.commands), ["SET_REMOTE", "CREATE_ANSWER"]);
});

// TZ-recovery-policy.md §2 — попытки теперь driven исключительно расписанием
// (RESTART_TICK), не реактивно каждым ICE_FAILED: "не тратить попытку" (§2.1)
// значит в том числе не устраивать лишнюю попытку ПОВЕРХ уже запланированной
// только потому, что браузер прислал ещё один ICE_FAILED, пока мы и так ждём
// свой restartTick. ICE_FAILED, пока УЖЕ в RECONNECTING — молча игнорируется,
// restartCount не растёт, ничего не планируется заново.
test("RECONNECTING: повторный ICE_FAILED, пока УЖЕ в RECONNECTING, не тратит попытку — ждём запланированный RESTART_TICK", () => {
	const s = { name: "RECONNECTING", role: "caller", sessionId: SID, peerPubkey: BOB, polite: false, restartCount: 0, reason: null, safetyCapMs: DEFAULT_RECOVERY_SAFETY_CAP_MS };
	const r = reduce(s, { type: "ICE_FAILED", sessionId: SID });
	assert.equal(r.state.name, "RECONNECTING");
	assert.equal(r.state.restartCount, 0);
	assert.deepEqual(r.commands, []);
});

test("RECONNECTING: USER_HANGUP -> ENDED(hangup) в любой момент восстановления", () => {
	const s = { name: "RECONNECTING", role: "caller", sessionId: SID, peerPubkey: BOB, polite: false, restartCount: 2, reason: null };
	const r = reduce(s, { type: "USER_HANGUP", sessionId: SID });
	assert.equal(r.state.name, "ENDED");
	assert.equal(r.state.reason, "hangup");
	assert.deepEqual(names(r.commands), ["SEND_HANGUP", "CLOSE_PC", "EMIT"]);
});

test("I2: RECONNECTING достижимо только из CONNECTED — ICE_DISCONNECTED в CONNECTING не переводит в RECONNECTING", () => {
	const s = { name: "CONNECTING", role: "caller", sessionId: SID, peerPubkey: BOB, polite: true, restartCount: 0, reason: null };
	const r = reduce(s, { type: "ICE_DISCONNECTED", sessionId: SID });
	assert.deepEqual(r.state, s, "ICE_DISCONNECTED не описан для CONNECTING -> игнор (I5), не RECONNECTING");
});

// --- Точная форма КАЖДОЙ команды (для воркера — без двусмысленности; §1.4 VOICE.md) ---

test("форма команд: SET_REMOTE несёт sdp как есть", () => {
	const s = idle();
	const r = reduce(s, { type: "REMOTE_OFFER", sdp: "the-offer-sdp", sessionId: SID, fromPubkey: ALICE, myPubkey: BOB });
	assert.deepEqual(findCmd(r.commands, "SET_REMOTE"), { type: "SET_REMOTE", sdp: "the-offer-sdp" });
});

test("форма команд: CANCEL_TIMER несёт имя таймера", () => {
	let s = idle();
	let r = reduce(s, { type: "USER_PLACE_CALL", peerPubkey: BOB, myPubkey: ALICE });
	s = r.state;
	r = reduce(s, { type: "REMOTE_ANSWER", sessionId: s.sessionId, sdp: "answer" });
	assert.deepEqual(findCmd(r.commands, "CANCEL_TIMER"), { type: "CANCEL_TIMER", name: "ring" });
});

test("форма команд: SEND_HANGUP без payload", () => {
	let s = idle();
	let r = reduce(s, { type: "USER_PLACE_CALL", peerPubkey: BOB, myPubkey: ALICE });
	s = r.state;
	r = reduce(s, { type: "USER_HANGUP", sessionId: s.sessionId });
	assert.deepEqual(findCmd(r.commands, "SEND_HANGUP"), { type: "SEND_HANGUP" });
});

test("форма команд: ACQUIRE_MIC/CREATE_OFFER/CREATE_ANSWER/DO_ICE_RESTART/CLOSE_PC без payload", () => {
	let s = idle();
	let r = reduce(s, { type: "USER_PLACE_CALL", peerPubkey: BOB, myPubkey: ALICE });
	assert.deepEqual(findCmd(r.commands, "ACQUIRE_MIC"), { type: "ACQUIRE_MIC" });
	assert.deepEqual(findCmd(r.commands, "CREATE_OFFER"), { type: "CREATE_OFFER" });

	s = { name: "INCOMING_RINGING", role: "callee", sessionId: SID, peerPubkey: ALICE, polite: true, restartCount: 0, reason: null };
	r = reduce(s, { type: "USER_ACCEPT", sessionId: SID });
	assert.deepEqual(findCmd(r.commands, "CREATE_ANSWER"), { type: "CREATE_ANSWER" });

	s = { name: "RECONNECTING", role: "caller", sessionId: SID, peerPubkey: BOB, polite: false, restartCount: 0, reason: null, safetyCapMs: DEFAULT_RECOVERY_SAFETY_CAP_MS };
	r = reduce(s, tickEvent());
	assert.deepEqual(findCmd(r.commands, "DO_ICE_RESTART"), { type: "DO_ICE_RESTART", recreate: false, forceRelay: false });

	s = { name: "CONNECTED", role: "caller", sessionId: SID, peerPubkey: BOB, polite: true, restartCount: 0, reason: null };
	r = reduce(s, { type: "USER_HANGUP", sessionId: SID });
	assert.deepEqual(findCmd(r.commands, "CLOSE_PC"), { type: "CLOSE_PC" });
});

test("форма команд: EMIT без reason в нетерминальном состоянии, С reason в ENDED", () => {
	let s = idle();
	let r = reduce(s, { type: "USER_PLACE_CALL", peerPubkey: BOB, myPubkey: ALICE });
	assert.deepEqual(findCmd(r.commands, "EMIT"), { type: "EMIT", stateName: "OUTGOING_RINGING" });

	s = r.state;
	r = reduce(s, { type: "RING_TIMEOUT", sessionId: s.sessionId });
	assert.deepEqual(findCmd(r.commands, "EMIT"), { type: "EMIT", stateName: "ENDED", reason: "no_answer" });
});

// --- Адверсарный заход (rule 19): reduce не мутирует замороженный вход ---

test("адверсарно: reduce НЕ мутирует замороженный state ни при одном из переходов", () => {
	const scenarios = [
		[Object.freeze(idle()), { type: "USER_PLACE_CALL", peerPubkey: BOB, myPubkey: ALICE }],
		[
			Object.freeze({ name: "OUTGOING_RINGING", role: "caller", sessionId: SID, peerPubkey: BOB, polite: true, restartCount: 0, reason: null }),
			{ type: "REMOTE_ANSWER", sessionId: SID, sdp: "x" },
		],
		[
			Object.freeze({ name: "CONNECTED", role: "caller", sessionId: SID, peerPubkey: BOB, polite: true, restartCount: 0, reason: null }),
			{ type: "ICE_DISCONNECTED", sessionId: SID },
		],
		[
			Object.freeze({ name: "RECONNECTING", role: "caller", sessionId: SID, peerPubkey: BOB, polite: false, restartCount: 0, reason: null, safetyCapMs: DEFAULT_RECOVERY_SAFETY_CAP_MS }),
			tickEvent(),
		],
		// заведомо неописанное в δ событие — тоже не должно бросить и не должно мутировать
		[Object.freeze(idle()), { type: "СОВЕРШЕННО_СЛУЧАЙНОЕ_СОБЫТИЕ_ГАРБАЖ" }],
	];
	for (const [frozenState, event] of scenarios) {
		assert.doesNotThrow(() => reduce(frozenState, event), `reduce не должен бросать на замороженном state для события ${event.type}`);
	}
});

test("адверсарно: событие без sessionId в состоянии, ожидающем сессию, не роняет reduce", () => {
	const s = { name: "CONNECTED", role: "caller", sessionId: SID, peerPubkey: BOB, polite: true, restartCount: 0, reason: null };
	assert.doesNotThrow(() => reduce(s, { type: "ICE_DISCONNECTED" }));
});

// --- TZ-recovery-policy.md §3: heartbeat в CONNECTED и RECONNECTING ---

test("HEARTBEAT_TICK в CONNECTED -> SEND_HEARTBEAT + перевзвод таймера", () => {
	const s = { name: "CONNECTED", role: "caller", sessionId: SID, peerPubkey: BOB, polite: true, restartCount: 0, reason: null, safetyCapMs: DEFAULT_RECOVERY_SAFETY_CAP_MS };
	const r = reduce(s, { type: "HEARTBEAT_TICK", sessionId: SID });
	assert.equal(r.state.name, "CONNECTED");
	assert.deepEqual(names(r.commands), ["SEND_HEARTBEAT", "START_TIMER"]);
	assert.deepEqual(findCmd(r.commands, "START_TIMER"), { type: "START_TIMER", name: "heartbeat", ms: 3000 });
});

test("HEARTBEAT_TICK в RECONNECTING -> тоже SEND_HEARTBEAT (собеседник может услышать нас, даже пока ICE не встал)", () => {
	const s = { name: "RECONNECTING", role: "caller", sessionId: SID, peerPubkey: BOB, polite: true, restartCount: 1, reason: null, safetyCapMs: DEFAULT_RECOVERY_SAFETY_CAP_MS };
	const r = reduce(s, { type: "HEARTBEAT_TICK", sessionId: SID });
	assert.equal(r.state.name, "RECONNECTING");
	assert.deepEqual(names(r.commands), ["SEND_HEARTBEAT", "START_TIMER"]);
});

test("ICE_CONNECTED (первое соединение, из CONNECTING) взводит heartbeat-таймер", () => {
	const s = { name: "CONNECTING", role: "caller", sessionId: SID, peerPubkey: BOB, polite: true, restartCount: 0, reason: null };
	const r = reduce(s, { type: "ICE_CONNECTED", sessionId: SID });
	assert.deepEqual(findCmd(r.commands, "START_TIMER"), { type: "START_TIMER", name: "heartbeat", ms: 3000 });
});

// --- TZ-recovery-policy.md §2.4: safetyCapMs передаётся снаружи или берёт значение по умолчанию ---

test("USER_PLACE_CALL: safetyCapMs берётся из события, по умолчанию — DEFAULT_RECOVERY_SAFETY_CAP_MS", () => {
	let r = reduce(idle(), { type: "USER_PLACE_CALL", peerPubkey: BOB, myPubkey: ALICE });
	assert.equal(r.state.safetyCapMs, DEFAULT_RECOVERY_SAFETY_CAP_MS);

	r = reduce(idle(), { type: "USER_PLACE_CALL", peerPubkey: BOB, myPubkey: ALICE, safetyCapMs: 120000 });
	assert.equal(r.state.safetyCapMs, 120000, "настройка пользователя (§2.4, второй вариант) переопределяет умолчание");
});

test("REMOTE_OFFER: safetyCapMs тоже принимается (входящий звонок настраивается так же)", () => {
	const r = reduce(idle(), { type: "REMOTE_OFFER", sdp: "x", sessionId: SID, fromPubkey: ALICE, myPubkey: BOB, safetyCapMs: 999 });
	assert.equal(r.state.safetyCapMs, 999);
});

test("trickle ICE: LOCAL_ICE/REMOTE_ICE в OUTGOING_RINGING остаются в том же состоянии", () => {
	let s = { name: "OUTGOING_RINGING", role: "caller", sessionId: SID, peerPubkey: BOB, polite: true, restartCount: 0, reason: null };
	let r = reduce(s, { type: "LOCAL_ICE", sessionId: SID, candidate: "cand-1" });
	assert.equal(r.state.name, "OUTGOING_RINGING");
	assert.deepEqual(r.commands, [{ type: "SEND_ICE", candidate: "cand-1" }]);

	r = reduce(s, { type: "REMOTE_ICE", sessionId: SID, candidate: "cand-2" });
	assert.equal(r.state.name, "OUTGOING_RINGING");
	assert.deepEqual(r.commands, [{ type: "ADD_ICE", candidate: "cand-2" }]);
});
