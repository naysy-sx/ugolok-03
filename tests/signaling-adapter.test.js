import { test } from "node:test";
import assert from "node:assert/strict";
import { getPublicKey } from "../src/core/crypto/keys.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
	CALL_SIGNAL_KIND,
	buildCallSignalEvent,
	parseCallSignalEvent,
	execute,
	toFsmEvent,
} from "../src/domain/calls/signaling-adapter.js";

const ALICE_PRIV = new Uint8Array(32).fill(21);
const ALICE_PUB = bytesToHex(getPublicKey(ALICE_PRIV));
const BOB_PRIV = new Uint8Array(32).fill(42);
const BOB_PUB = bytesToHex(getPublicKey(BOB_PRIV));
const SID = "session-xyz";

test("CALL_SIGNAL_KIND — эфемерный диапазон NIP-01 (20000-29999)", () => {
	assert.equal(CALL_SIGNAL_KIND, 20075);
	assert.ok(CALL_SIGNAL_KIND >= 20000 && CALL_SIGNAL_KIND < 30000);
});

test("build/parse round-trip: Alice шлёт offer Бобу, Боб расшифровывает своим privKey", () => {
	const payload = { type: "offer", sessionId: SID, sdp: { type: "offer", sdp: "v=0..." } };
	const event = buildCallSignalEvent(ALICE_PRIV, BOB_PUB, payload);

	assert.equal(event.kind, CALL_SIGNAL_KIND);
	assert.equal(event.pubkey, ALICE_PUB);
	assert.deepEqual(event.tags, [["p", BOB_PUB]]);

	const decrypted = parseCallSignalEvent(event, BOB_PRIV);
	assert.deepEqual(decrypted, payload);
});

test("build/parse round-trip: содержимое НЕ читается напрямую (реально зашифровано, не JSON.stringify как есть)", () => {
	const payload = { type: "hangup", sessionId: SID };
	const event = buildCallSignalEvent(ALICE_PRIV, BOB_PUB, payload);
	assert.ok(!event.content.includes("hangup"), "content обязан быть шифротекстом, не читаемым JSON");
});

test("parse чужим ключом (не адресатом) -> бросает, не расшифровывает молча мусором", () => {
	const payload = { type: "ice", sessionId: SID, candidate: "c1" };
	const event = buildCallSignalEvent(ALICE_PRIV, BOB_PUB, payload);
	const MALLORY_PRIV = new Uint8Array(32).fill(7);
	assert.throws(() => parseCallSignalEvent(event, MALLORY_PRIV));
});

test("execute: SEND_OFFER публикует событие с payload {type:'offer', sessionId, sdp}", async () => {
	const published = [];
	const publish = async (event) => {
		published.push(event);
		return { ok: true };
	};
	await execute(
		{ type: "SEND_OFFER", sdp: { type: "offer", sdp: "offer-sdp" } },
		{ privKey: ALICE_PRIV, peerPubkey: BOB_PUB, sessionId: SID, publish },
	);
	assert.equal(published.length, 1);
	const payload = parseCallSignalEvent(published[0], BOB_PRIV);
	assert.deepEqual(payload, { type: "offer", sessionId: SID, sdp: { type: "offer", sdp: "offer-sdp" } });
});

test("execute: SEND_ANSWER публикует payload {type:'answer', sessionId, sdp}", async () => {
	const published = [];
	const publish = async (event) => published.push(event);
	await execute({ type: "SEND_ANSWER", sdp: { type: "answer", sdp: "answer-sdp" } }, { privKey: BOB_PRIV, peerPubkey: ALICE_PUB, sessionId: SID, publish });
	const payload = parseCallSignalEvent(published[0], ALICE_PRIV);
	assert.deepEqual(payload, { type: "answer", sessionId: SID, sdp: { type: "answer", sdp: "answer-sdp" } });
});

test("execute: SEND_ICE публикует payload {type:'ice', sessionId, candidate}", async () => {
	const published = [];
	const publish = async (event) => published.push(event);
	await execute({ type: "SEND_ICE", candidate: "cand-1" }, { privKey: ALICE_PRIV, peerPubkey: BOB_PUB, sessionId: SID, publish });
	const payload = parseCallSignalEvent(published[0], BOB_PRIV);
	assert.deepEqual(payload, { type: "ice", sessionId: SID, candidate: "cand-1" });
});

test("execute: SEND_HANGUP публикует payload {type:'hangup', sessionId}", async () => {
	const published = [];
	const publish = async (event) => published.push(event);
	await execute({ type: "SEND_HANGUP" }, { privKey: ALICE_PRIV, peerPubkey: BOB_PUB, sessionId: SID, publish });
	const payload = parseCallSignalEvent(published[0], BOB_PRIV);
	assert.deepEqual(payload, { type: "hangup", sessionId: SID });
});

test("execute: команда без сигнального эквивалента (напр. ACQUIRE_MIC) -> ничего не публикует", async () => {
	let called = false;
	const publish = async () => {
		called = true;
	};
	const result = await execute({ type: "ACQUIRE_MIC" }, { privKey: ALICE_PRIV, peerPubkey: BOB_PUB, sessionId: SID, publish });
	assert.equal(result, undefined);
	assert.equal(called, false);
});

test("toFsmEvent: offer -> REMOTE_OFFER с fromPubkey и myPubkey", () => {
	const fsmEvent = toFsmEvent({ type: "offer", sessionId: SID, sdp: "x" }, ALICE_PUB, BOB_PUB);
	assert.deepEqual(fsmEvent, { type: "REMOTE_OFFER", sdp: "x", sessionId: SID, fromPubkey: ALICE_PUB, myPubkey: BOB_PUB });
});

test("toFsmEvent: answer -> REMOTE_ANSWER (без fromPubkey/myPubkey — не нужны для этого перехода)", () => {
	const fsmEvent = toFsmEvent({ type: "answer", sessionId: SID, sdp: "y" }, ALICE_PUB, BOB_PUB);
	assert.deepEqual(fsmEvent, { type: "REMOTE_ANSWER", sdp: "y", sessionId: SID });
});

test("toFsmEvent: ice -> REMOTE_ICE", () => {
	const fsmEvent = toFsmEvent({ type: "ice", sessionId: SID, candidate: "c" }, ALICE_PUB, BOB_PUB);
	assert.deepEqual(fsmEvent, { type: "REMOTE_ICE", candidate: "c", sessionId: SID });
});

test("toFsmEvent: hangup -> REMOTE_HANGUP", () => {
	const fsmEvent = toFsmEvent({ type: "hangup", sessionId: SID }, ALICE_PUB, BOB_PUB);
	assert.deepEqual(fsmEvent, { type: "REMOTE_HANGUP", sessionId: SID });
});

test("toFsmEvent: неизвестный payload.type -> null (не бросает, не выдумывает событие)", () => {
	assert.equal(toFsmEvent({ type: "какой-то-мусор" }, ALICE_PUB, BOB_PUB), null);
});

test("сквозной цикл: Алиса publish(SEND_OFFER) -> Боб получает event -> parse -> toFsmEvent даёт валидный REMOTE_OFFER для reduce()", async () => {
	const published = [];
	const publish = async (event) => published.push(event);
	await execute({ type: "SEND_OFFER", sdp: { type: "offer", sdp: "real-offer" } }, { privKey: ALICE_PRIV, peerPubkey: BOB_PUB, sessionId: SID, publish });

	const incomingEvent = published[0]; // как будто Боб получил это через relay
	const payload = parseCallSignalEvent(incomingEvent, BOB_PRIV);
	const fsmEvent = toFsmEvent(payload, incomingEvent.pubkey, BOB_PUB);
	assert.deepEqual(fsmEvent, {
		type: "REMOTE_OFFER",
		sdp: { type: "offer", sdp: "real-offer" },
		sessionId: SID,
		fromPubkey: ALICE_PUB,
		myPubkey: BOB_PUB,
	});
});
