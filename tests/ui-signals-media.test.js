import { test } from "node:test";
import assert from "node:assert/strict";
import { mediaSession, openMedia, mediaNext, mediaPrev, mediaToggle, mediaMinimize, mediaRestore, mediaEnded, closeMedia } from "../src/ui/signals/media.js";
import { callState } from "../src/ui/signals/call.js";

function ref(digest, mime = "image/jpeg") {
	return { digest, key: new Uint8Array([1]), mime, name: digest, size: 100, sourceKind: "attachment", sourceMeta: {} };
}

function resetCallState() {
	callState.value = { name: "IDLE", role: null, sessionId: null, peerPubkey: null, polite: null, restartCount: 0, reason: null };
}

test("openMedia: заполняет mediaSession по transition('open', ...)", () => {
	resetCallState();
	closeMedia();
	openMedia({ refs: [ref("a"), ref("b", "video/mp4")], position: 0 });
	assert.equal(mediaSession.value.cls, "image");
	assert.equal(mediaSession.value.position, 0);
	assert.equal(mediaSession.value.display, "full");
	assert.equal(mediaSession.value.play, "playing");
	assert.ok(mediaSession.value.playlist);
	closeMedia();
});

test("mediaNext/mediaPrev: перемещают позицию в пределах класса (та же семантика, что media-machine.test.js)", () => {
	resetCallState();
	closeMedia();
	openMedia({ refs: [ref("a"), ref("b"), ref("c")], position: 0 });
	mediaNext();
	assert.equal(mediaSession.value.position, 1);
	mediaPrev();
	assert.equal(mediaSession.value.position, 0);
	closeMedia();
});

test("mediaToggle/mediaMinimize/mediaRestore: дергают ожидаемые поля состояния", () => {
	resetCallState();
	closeMedia();
	openMedia({ refs: [ref("a", "video/mp4")], position: 0 });
	assert.equal(mediaSession.value.play, "playing");
	mediaToggle();
	assert.equal(mediaSession.value.play, "paused");
	mediaMinimize();
	assert.equal(mediaSession.value.display, "mini");
	mediaRestore();
	assert.equal(mediaSession.value.display, "full");
	closeMedia();
});

test("mediaEnded: переходит к следующему треку своего класса (doEnded уже покрыт этапом A, здесь — проверка что событие реально доходит до автомата)", () => {
	resetCallState();
	closeMedia();
	openMedia({ refs: [ref("a", "audio/mpeg"), ref("b", "audio/mpeg")], position: 0 });
	mediaEnded();
	assert.equal(mediaSession.value.position, 1);
	assert.equal(mediaSession.value.play, "playing");
	mediaEnded();
	assert.equal(mediaSession.value.position, 1, "на последнем треке класса — остаться на месте");
	assert.equal(mediaSession.value.play, "paused");
	closeMedia();
});

test("closeMedia: обнуляет mediaSession", () => {
	resetCallState();
	openMedia({ refs: [ref("a")], position: 0 });
	closeMedia();
	assert.equal(mediaSession.value, null);
});

test("И5: изображение не сворачивается (minimize — no-op для cls=image, media-machine.js уже гарантирует, здесь — сквозная проверка через сигнал)", () => {
	resetCallState();
	closeMedia();
	openMedia({ refs: [ref("a", "image/png")], position: 0 });
	mediaMinimize();
	assert.equal(mediaSession.value.display, "full");
	closeMedia();
});

test("callState edge-detection: последовательность OUTGOING_RINGING->CONNECTING->CONNECTED даёт РОВНО один переход play playing->suspended (один callStart, не три)", async () => {
	resetCallState();
	closeMedia();
	openMedia({ refs: [ref("a", "video/mp4")], position: 0 });
	assert.equal(mediaSession.value.play, "playing");

	callState.value = { ...callState.value, name: "OUTGOING_RINGING" };
	await Promise.resolve();
	assert.equal(mediaSession.value.play, "suspended", "первый переход в активное состояние звонка обязан приостановить проигрывание");

	callState.value = { ...callState.value, name: "CONNECTING" };
	await Promise.resolve();
	callState.value = { ...callState.value, name: "CONNECTED" };
	await Promise.resolve();
	assert.equal(mediaSession.value.play, "suspended", "внутренние переходы FSM звонка не должны заново дёргать callStart (и так уже suspended)");
	assert.equal(mediaSession.value.callActive, true);

	callState.value = { ...callState.value, name: "ENDED" };
	await Promise.resolve();
	assert.equal(mediaSession.value.play, "paused", "callEnd переводит suspended -> paused (решение §1.4 — не возобновлять)");
	assert.equal(mediaSession.value.callActive, false);

	resetCallState();
	await Promise.resolve();
	closeMedia();
});

test("И2: play нельзя перевести в playing, пока callActive=true (toggle — no-op)", async () => {
	resetCallState();
	closeMedia();
	openMedia({ refs: [ref("a", "video/mp4")], position: 0 });
	callState.value = { ...callState.value, name: "CONNECTED" };
	await Promise.resolve();
	assert.equal(mediaSession.value.play, "suspended");
	mediaToggle();
	assert.equal(mediaSession.value.play, "suspended", "toggle во время активного звонка не должен включать playing (И2)");
	resetCallState();
	await Promise.resolve();
	closeMedia();
});
