import { test } from "node:test";
import assert from "node:assert/strict";
import { getPublicKey } from "../src/core/crypto/keys.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { createCallRuntime } from "../src/domain/calls/call-runtime.js";
import { buildCallSignalEvent } from "../src/domain/calls/signaling-adapter.js";

// Этап 48, п.5 — call-runtime.js склеивает call-fsm.js (реальный, не подменяется —
// это и есть предмет проверки) с media-controller.js (ЗАСТАБЛЕН — реальный WebRTC
// недоступен в node:test) и signaling-adapter.js (РЕАЛЬНЫЙ — round-trip шифрования
// реальными ключами даёт более сильную гарантию, чем мок; только `publish` застаблен).
//
// НАЙДЕНО ЖИВЫМ E2E (после первой версии этого файла) — dispatch() внутри
// call-runtime.js стал async и исполняет команды ОДНОГО перехода строго
// последовательно (было — "запустить и забыть", из-за чего ACQUIRE_MIC и
// CREATE_OFFER гонялись между собой, и настоящий WebRTC иногда создавал offer
// БЕЗ ещё не добавленного трека микрофона — ICE не собирался вовсе). Тесты
// поэтому await'ят flush() после каждого действия, запускающего dispatch —
// синхронная проверка сразу после вызова больше не отражает состояние ПОСЛЕ
// полной обработки перехода.
function flush() {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

const ALICE_PRIV = new Uint8Array(32).fill(21);
const ALICE_PUB = bytesToHex(getPublicKey(ALICE_PRIV));
const BOB_PRIV = new Uint8Array(32).fill(42);
const BOB_PUB = bytesToHex(getPublicKey(BOB_PRIV));

function fakeMediaController() {
	const calls = [];
	let onEventRef;
	const factory = (opts) => {
		onEventRef = opts.onEvent;
		return {
			execute: async (command) => {
				calls.push(command);
			},
		};
	};
	return { factory, calls, fire: async (event) => { onEventRef(event); await flush(); } };
}

function fakeTimers() {
	let idCounter = 0;
	const scheduled = new Map(); // id -> fn, в порядке вставки
	return {
		setTimeoutImpl: (fn) => {
			const id = ++idCounter;
			scheduled.set(id, fn);
			return id;
		},
		clearTimeoutImpl: (id) => scheduled.delete(id),
		get pendingCount() {
			return scheduled.size;
		},
		async fireOldest() {
			const [id, fn] = [...scheduled.entries()][0];
			scheduled.delete(id);
			fn();
			await flush();
		},
	};
}

function makeRuntime(myPriv, myPub, extra = {}) {
	const media = fakeMediaController();
	const timers = fakeTimers();
	const published = [];
	const stateChanges = [];
	const runtime = createCallRuntime({
		myPubkey: myPub,
		privKey: myPriv,
		publish: async (event) => {
			published.push(event);
			return { ok: true };
		},
		onStateChange: (stateName, reason) => stateChanges.push({ stateName, reason }),
		createMediaController: media.factory,
		setTimeoutImpl: timers.setTimeoutImpl,
		clearTimeoutImpl: timers.clearTimeoutImpl,
		...extra,
	});
	return { runtime, media, timers, published, stateChanges };
}

function incomingEventFrom(senderPriv, recipientPub, payload) {
	return buildCallSignalEvent(senderPriv, recipientPub, payload);
}

test("placeCall: USER_PLACE_CALL -> OUTGOING_RINGING, ACQUIRE_MIC+CREATE_OFFER на mediaController (СТРОГО последовательно), ring-таймер запущен, EMIT дошёл до onStateChange", async () => {
	const { runtime, media, timers, stateChanges } = makeRuntime(ALICE_PRIV, ALICE_PUB);
	runtime.placeCall(BOB_PUB);
	await flush();

	assert.equal(runtime.getState().name, "OUTGOING_RINGING");
	assert.equal(runtime.getState().role, "caller");
	assert.deepEqual(
		media.calls.map((c) => c.type),
		["ACQUIRE_MIC", "CREATE_OFFER"],
	);
	assert.equal(timers.pendingCount, 1, "ring-таймер должен быть запущен");
	assert.deepEqual(stateChanges, [{ stateName: "OUTGOING_RINGING", reason: undefined }]);
});

test("mediaController эмитит LOCAL_OFFER_READY -> SEND_OFFER реально публикуется через signaling-adapter (kind 20075, NIP-44)", async () => {
	const { runtime, media, published } = makeRuntime(ALICE_PRIV, ALICE_PUB);
	runtime.placeCall(BOB_PUB);
	await flush();
	await media.fire({ type: "LOCAL_OFFER_READY", sdp: { type: "offer", sdp: "real-sdp" } });

	assert.equal(published.length, 1);
	assert.equal(published[0].kind, 20075);
	assert.equal(published[0].pubkey, ALICE_PUB);
});

test("ring timeout: таймер срабатывает -> ENDED(no_answer), CLOSE_PC исполнен, таймеры очищены (кроме нового ended-auto-reset)", async () => {
	const { runtime, media, timers, stateChanges } = makeRuntime(ALICE_PRIV, ALICE_PUB);
	runtime.placeCall(BOB_PUB);
	await flush();
	await timers.fireOldest(); // ring

	assert.equal(runtime.getState().name, "ENDED");
	assert.equal(runtime.getState().reason, "no_answer");
	assert.ok(media.calls.some((c) => c.type === "CLOSE_PC"));
	// CLOSE_PC чистит осиротевшие FSM-таймеры (ring/connect/grace/backoff), но
	// EMIT(ENDED) сразу следом сам планирует РОВНО один новый — автовозврат в IDLE.
	assert.equal(timers.pendingCount, 1, "остаётся только новый ended-auto-reset таймер");
	assert.deepEqual(stateChanges.at(-1), { stateName: "ENDED", reason: "no_answer" });
});

test("ENDED автоматически возвращается в IDLE спустя паузу (VOICE.md §1.1) — иначе следующий звонок не проходил бы вовсе", async () => {
	const { runtime, media, timers, stateChanges } = makeRuntime(ALICE_PRIV, ALICE_PUB);
	runtime.placeCall(BOB_PUB);
	await flush();
	await timers.fireOldest(); // ring -> ENDED(no_answer)
	assert.equal(runtime.getState().name, "ENDED");

	await timers.fireOldest(); // ended-auto-reset
	assert.equal(runtime.getState().name, "IDLE");
	assert.deepEqual(stateChanges.at(-1), { stateName: "IDLE", reason: undefined });

	// Раз мы снова в IDLE — новый звонок обязан пройти как обычный happy path,
	// а не молча проигнорироваться (I5 — ENDED игнорирует ВСЁ, IDLE — нет).
	runtime.placeCall(BOB_PUB);
	await flush();
	assert.equal(runtime.getState().name, "OUTGOING_RINGING");
	assert.deepEqual(
		media.calls.slice(-2).map((c) => c.type),
		["ACQUIRE_MIC", "CREATE_OFFER"],
	);
});

test("dismissEnded(): ручной сброс ENDED -> IDLE сразу, не дожидаясь автотаймера, отменяет сам таймер", async () => {
	const { runtime, timers } = makeRuntime(ALICE_PRIV, ALICE_PUB);
	runtime.placeCall(BOB_PUB);
	await flush();
	await timers.fireOldest(); // ring -> ENDED
	assert.equal(runtime.getState().name, "ENDED");
	assert.equal(timers.pendingCount, 1);

	runtime.dismissEnded();
	assert.equal(runtime.getState().name, "IDLE");
	assert.equal(timers.pendingCount, 0, "dismissEnded обязан отменить запланированный автовозврат");
});

test("dismissEnded() в состоянии, отличном от ENDED, — no-op", async () => {
	const { runtime } = makeRuntime(ALICE_PRIV, ALICE_PUB);
	runtime.placeCall(BOB_PUB);
	await flush();
	const before = runtime.getState();
	runtime.dismissEnded();
	assert.deepEqual(runtime.getState(), before);
});

test("полный happy path caller: placeCall -> LOCAL_OFFER_READY -> входящий REMOTE_ANSWER (реальное шифрование) -> CONNECTING -> ICE_CONNECTED -> CONNECTED", async () => {
	const { runtime, media, stateChanges } = makeRuntime(ALICE_PRIV, ALICE_PUB);
	runtime.placeCall(BOB_PUB);
	await flush();
	const sessionId = runtime.getState().sessionId;
	await media.fire({ type: "LOCAL_OFFER_READY", sdp: { type: "offer", sdp: "offer-sdp" } });

	// Боб отвечает — реальное NIP-44-шифрование Bob -> Alice, тот же путь, что придёт с relay.
	const answerEvent = incomingEventFrom(BOB_PRIV, ALICE_PUB, { type: "answer", sessionId, sdp: { type: "answer", sdp: "answer-sdp" } });
	runtime.handleIncomingSignal(answerEvent);
	await flush();
	assert.equal(runtime.getState().name, "CONNECTING");

	await media.fire({ type: "ICE_CONNECTED" });
	assert.equal(runtime.getState().name, "CONNECTED");
	assert.equal(runtime.getState().restartCount, 0);
	assert.deepEqual(
		stateChanges.map((s) => s.stateName),
		["OUTGOING_RINGING", "CONNECTING", "CONNECTED"],
	);
});

test("полный happy path callee: входящий REMOTE_OFFER (реальное шифрование) -> INCOMING_RINGING -> accept -> CONNECTING -> LOCAL_ANSWER_READY публикует SEND_ANSWER -> ICE_CONNECTED -> CONNECTED", async () => {
	const { runtime, media, published } = makeRuntime(BOB_PRIV, BOB_PUB);
	const offerEvent = incomingEventFrom(ALICE_PRIV, BOB_PUB, { type: "offer", sessionId: "sess-1", sdp: { type: "offer", sdp: "alice-offer" } });

	runtime.handleIncomingSignal(offerEvent);
	await flush();
	assert.equal(runtime.getState().name, "INCOMING_RINGING");
	assert.equal(runtime.getState().peerPubkey, ALICE_PUB);

	runtime.accept();
	await flush();
	assert.equal(runtime.getState().name, "CONNECTING");
	assert.ok(media.calls.some((c) => c.type === "CREATE_ANSWER"));

	await media.fire({ type: "LOCAL_ANSWER_READY", sdp: { type: "answer", sdp: "bob-answer" } });
	assert.equal(published.length, 1);
	assert.equal(published[0].pubkey, BOB_PUB);

	await media.fire({ type: "ICE_CONNECTED" });
	assert.equal(runtime.getState().name, "CONNECTED");
});

test("reject: USER_REJECT -> ENDED(rejected), SEND_HANGUP публикуется", async () => {
	const { runtime, published } = makeRuntime(BOB_PRIV, BOB_PUB);
	const offerEvent = incomingEventFrom(ALICE_PRIV, BOB_PUB, { type: "offer", sessionId: "sess-2", sdp: { type: "offer", sdp: "x" } });
	runtime.handleIncomingSignal(offerEvent);
	await flush();
	runtime.reject();
	await flush();

	assert.equal(runtime.getState().name, "ENDED");
	assert.equal(runtime.getState().reason, "rejected");
	assert.equal(published.length, 1);
});

test("hangup во время CONNECTED: ENDED(hangup), CLOSE_PC исполнен", async () => {
	const { runtime, media } = makeRuntime(ALICE_PRIV, ALICE_PUB);
	runtime.placeCall(BOB_PUB);
	await flush();
	const sessionId = runtime.getState().sessionId;
	const answerEvent = incomingEventFrom(BOB_PRIV, ALICE_PUB, { type: "answer", sessionId, sdp: { type: "answer", sdp: "a" } });
	runtime.handleIncomingSignal(answerEvent);
	await flush();
	await media.fire({ type: "ICE_CONNECTED" });
	assert.equal(runtime.getState().name, "CONNECTED");

	runtime.hangup();
	await flush();
	assert.equal(runtime.getState().name, "ENDED");
	assert.equal(runtime.getState().reason, "hangup");
	assert.ok(media.calls.some((c) => c.type === "CLOSE_PC"));
});

test("ICE restart (impolite): ICE_DISCONNECTED -> grace-таймер -> GRACE_EXPIRED -> DO_ICE_RESTART -> ICE_CONNECTED -> CONNECTED, restartCount сброшен", async () => {
	// ALICE_PUB > BOB_PUB лексикографически (проверено фактическими secp256k1-ключами,
	// не предположением) -> ALICE impolite относительно BOB.
	const { runtime, media, timers } = makeRuntime(ALICE_PRIV, ALICE_PUB);
	const offerEvent = incomingEventFrom(BOB_PRIV, ALICE_PUB, { type: "offer", sessionId: "sess-3", sdp: { type: "offer", sdp: "x" } });
	runtime.handleIncomingSignal(offerEvent);
	await flush();
	runtime.accept();
	await flush();
	await media.fire({ type: "LOCAL_ANSWER_READY", sdp: { type: "answer", sdp: "y" } });
	await media.fire({ type: "ICE_CONNECTED" });
	assert.equal(runtime.getState().name, "CONNECTED");
	assert.equal(runtime.getState().polite, false, "ALICE impolite относительно BOB");

	await media.fire({ type: "ICE_DISCONNECTED" });
	assert.equal(runtime.getState().name, "RECONNECTING");
	assert.equal(timers.pendingCount, 1, "grace-таймер запущен");

	await timers.fireOldest(); // GRACE_EXPIRED
	assert.equal(runtime.getState().name, "RECONNECTING");
	assert.equal(runtime.getState().restartCount, 1);
	assert.ok(media.calls.some((c) => c.type === "DO_ICE_RESTART"), "impolite сам инициирует рестарт");

	await media.fire({ type: "ICE_CONNECTED" });
	assert.equal(runtime.getState().name, "CONNECTED");
	assert.equal(runtime.getState().restartCount, 0);
});

test("handleIncomingSignal: событие, зашифрованное НЕ для нас (чужой получатель) — расшифровка проваливается, состояние не меняется", async () => {
	const { runtime } = makeRuntime(ALICE_PRIV, ALICE_PUB);
	const MALLORY_PRIV = new Uint8Array(32).fill(7);
	const MALLORY_PUB = bytesToHex(getPublicKey(MALLORY_PRIV));
	const notForMe = incomingEventFrom(BOB_PRIV, MALLORY_PUB, { type: "offer", sessionId: "s", sdp: "x" });

	assert.doesNotThrow(() => runtime.handleIncomingSignal(notForMe));
	await flush();
	assert.equal(runtime.getState().name, "IDLE");
});

test("handleIncomingSignal: событие для чужой (устаревшей) сессии игнорируется (I1), текущий звонок не трогается", async () => {
	const { runtime } = makeRuntime(ALICE_PRIV, ALICE_PUB);
	runtime.placeCall(BOB_PUB);
	await flush();
	const before = runtime.getState();

	const staleHangup = incomingEventFrom(BOB_PRIV, ALICE_PUB, { type: "hangup", sessionId: "какая-то-другая-сессия" });
	runtime.handleIncomingSignal(staleHangup);
	await flush();

	assert.deepEqual(runtime.getState(), before);
});

// --- Rooms, этап 4 (ROOMS-SPEC §5.3) — hTopic пробрасывается в ctx сигналинга ---

test("createCallRuntime({hTopic}): опубликованные сигнальные события несут тег h (mesh-supervisor.js использует эту опцию)", async () => {
	const hTopic = "c".repeat(64);
	const { runtime, media, published } = makeRuntime(ALICE_PRIV, ALICE_PUB, { hTopic });
	runtime.placeCall(BOB_PUB);
	await flush();
	await media.fire({ type: "LOCAL_OFFER_READY", sdp: { type: "offer", sdp: "sdp" } });

	assert.equal(published.length, 1);
	assert.deepEqual(published[0].tags, [["p", BOB_PUB], ["h", hTopic]]);
});

test("createCallRuntime без hTopic (обычный 1:1-звонок) — опубликованные события тега h не несут", async () => {
	const { runtime, media, published } = makeRuntime(ALICE_PRIV, ALICE_PUB);
	runtime.placeCall(BOB_PUB);
	await flush();
	await media.fire({ type: "LOCAL_OFFER_READY", sdp: { type: "offer", sdp: "sdp" } });

	assert.deepEqual(published[0].tags, [["p", BOB_PUB]]);
});
