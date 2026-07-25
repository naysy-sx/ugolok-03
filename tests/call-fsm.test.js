import { test } from "node:test";
import assert from "node:assert/strict";
import { reduce } from "../src/domain/calls/call-fsm.js";

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
	assert.deepEqual(names(r.commands), ["CANCEL_TIMER", "EMIT"]);
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
	let s = { name: "CONNECTED", role: "caller", sessionId: SID, peerPubkey: BOB, polite: true, restartCount: 0, reason: null };

	let r = reduce(s, { type: "ICE_DISCONNECTED", sessionId: SID });
	assert.equal(r.state.name, "RECONNECTING");
	assert.deepEqual(names(r.commands), ["START_TIMER", "EMIT"]);
	assert.deepEqual(findCmd(r.commands, "START_TIMER"), { type: "START_TIMER", name: "grace", ms: 4000 });
	s = r.state;

	r = reduce(s, { type: "ICE_CONNECTED", sessionId: SID });
	assert.equal(r.state.name, "CONNECTED");
	assert.equal(r.state.restartCount, 0);
	assert.deepEqual(names(r.commands), ["CANCEL_TIMER", "CANCEL_TIMER", "EMIT"]);
});

// --- 8. Рестарт с восстановлением: GRACE_EXPIRED -> (impolite: DO_ICE_RESTART) -> ICE_CONNECTED -> CONNECTED ---
test("рестарт (impolite): GRACE_EXPIRED -> DO_ICE_RESTART -> ICE_CONNECTED -> CONNECTED", () => {
	let s = { name: "RECONNECTING", role: "caller", sessionId: SID, peerPubkey: ALICE, polite: false, restartCount: 0, reason: null };

	let r = reduce(s, { type: "GRACE_EXPIRED", sessionId: SID });
	assert.equal(r.state.name, "RECONNECTING");
	assert.equal(r.state.restartCount, 1);
	assert.deepEqual(names(r.commands), ["DO_ICE_RESTART", "START_TIMER"]);
	assert.deepEqual(findCmd(r.commands, "START_TIMER"), { type: "START_TIMER", name: "backoff", ms: 1000 });
	s = r.state;

	r = reduce(s, { type: "ICE_CONNECTED", sessionId: SID });
	assert.equal(r.state.name, "CONNECTED");
	assert.equal(r.state.restartCount, 0, "восстановление сбрасывает счётчик");
});

test("рестарт (polite): GRACE_EXPIRED -> ждёт (без DO_ICE_RESTART), REMOTE_OFFER -> CREATE_ANSWER", () => {
	let s = { name: "RECONNECTING", role: "callee", sessionId: SID, peerPubkey: BOB, polite: true, restartCount: 0, reason: null };

	let r = reduce(s, { type: "GRACE_EXPIRED", sessionId: SID });
	assert.equal(r.state.name, "RECONNECTING");
	assert.equal(r.state.restartCount, 1);
	assert.deepEqual(names(r.commands), ["START_TIMER"], "polite НЕ инициирует рестарт сам");
	s = r.state;

	r = reduce(s, { type: "REMOTE_OFFER", sdp: "restart-offer", sessionId: SID, fromPubkey: BOB });
	assert.equal(r.state.name, "RECONNECTING");
	assert.deepEqual(names(r.commands), ["SET_REMOTE", "CREATE_ANSWER"]);
});

// --- 9. Исчерпание рестартов: MAX_RESTARTS попыток -> ENDED(connection_lost) (I4) ---
test("исчерпание рестартов: restartCount достигает MAX_RESTARTS -> ENDED(connection_lost)", () => {
	let s = { name: "RECONNECTING", role: "caller", sessionId: SID, peerPubkey: ALICE, polite: false, restartCount: 4, reason: null };

	const r = reduce(s, { type: "GRACE_EXPIRED", sessionId: SID });
	assert.equal(r.state.name, "ENDED");
	assert.equal(r.state.reason, "connection_lost");
	assert.deepEqual(names(r.commands), ["CLOSE_PC", "EMIT"]);
});

test("исчерпание рестартов доходит за 4 цикла ровно (MAX_RESTARTS=4), завершаемость (I4)", () => {
	let s = { name: "RECONNECTING", role: "caller", sessionId: SID, peerPubkey: ALICE, polite: false, restartCount: 0, reason: null };
	for (let i = 0; i < 4; i++) {
		const r = reduce(s, { type: "GRACE_EXPIRED", sessionId: SID });
		assert.equal(r.state.name, "RECONNECTING", `итерация ${i}: ещё не сдались`);
		s = r.state;
	}
	const r = reduce(s, { type: "GRACE_EXPIRED", sessionId: SID });
	assert.equal(r.state.name, "ENDED");
	assert.equal(r.state.reason, "connection_lost");
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

test("RECONNECTING: ICE_FAILED считается как повод для рестарта (не сразу ENDED)", () => {
	const s = { name: "RECONNECTING", role: "caller", sessionId: SID, peerPubkey: BOB, polite: false, restartCount: 0, reason: null };
	const r = reduce(s, { type: "ICE_FAILED", sessionId: SID });
	assert.equal(r.state.name, "RECONNECTING");
	assert.equal(r.state.restartCount, 1);
	assert.deepEqual(names(r.commands), ["DO_ICE_RESTART", "START_TIMER"]);
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

	s = { name: "RECONNECTING", role: "caller", sessionId: SID, peerPubkey: BOB, polite: false, restartCount: 0, reason: null };
	r = reduce(s, { type: "GRACE_EXPIRED", sessionId: SID });
	assert.deepEqual(findCmd(r.commands, "DO_ICE_RESTART"), { type: "DO_ICE_RESTART" });

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
			Object.freeze({ name: "RECONNECTING", role: "caller", sessionId: SID, peerPubkey: BOB, polite: false, restartCount: 0, reason: null }),
			{ type: "GRACE_EXPIRED", sessionId: SID },
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

test("trickle ICE: LOCAL_ICE/REMOTE_ICE в OUTGOING_RINGING остаются в том же состоянии", () => {
	let s = { name: "OUTGOING_RINGING", role: "caller", sessionId: SID, peerPubkey: BOB, polite: true, restartCount: 0, reason: null };
	let r = reduce(s, { type: "LOCAL_ICE", sessionId: SID, candidate: "cand-1" });
	assert.equal(r.state.name, "OUTGOING_RINGING");
	assert.deepEqual(r.commands, [{ type: "SEND_ICE", candidate: "cand-1" }]);

	r = reduce(s, { type: "REMOTE_ICE", sessionId: SID, candidate: "cand-2" });
	assert.equal(r.state.name, "OUTGOING_RINGING");
	assert.deepEqual(r.commands, [{ type: "ADD_ICE", candidate: "cand-2" }]);
});
