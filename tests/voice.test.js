import { test } from "node:test";
import assert from "node:assert/strict";
import { VOICE_INLINE_MAX_BYTES, shouldInlineVoice, createVoiceRecorder } from "../src/domain/messaging/voice.js";

test("VOICE_INLINE_MAX_BYTES — 32 KB (F-AT-08)", () => {
	assert.equal(VOICE_INLINE_MAX_BYTES, 32 * 1024);
});

test("shouldInlineVoice: меньше лимита -> true", () => {
	assert.equal(shouldInlineVoice(1000), true);
});

test("shouldInlineVoice: ровно 32768 байт (AC-AT-03b, граница) -> true (inline)", () => {
	assert.equal(shouldInlineVoice(32768), true);
});

test("shouldInlineVoice: 32769 байт (на 1 больше границы) -> false (через Blossom)", () => {
	assert.equal(shouldInlineVoice(32769), false);
});

test("shouldInlineVoice: 0 байт -> true", () => {
	assert.equal(shouldInlineVoice(0), true);
});

test("shouldInlineVoice: сильно больше (видео-длины голосовое) -> false", () => {
	assert.equal(shouldInlineVoice(3 * 1024 * 1024), false);
});

// --- createVoiceRecorder: логика старт/стоп/отмена, MediaRecorder/getUserMedia
// застаблены (браузерные API недоступны в node:test) — сама запись с реального
// микрофона проверяется живым Playwright (--use-fake-device-for-media-stream).

function fakeTrack() {
	return { stopped: false, stop() { this.stopped = true; } };
}

function fakeStream(tracks) {
	return { getTracks: () => tracks };
}

class FakeMediaRecorder {
	constructor(stream, opts) {
		this.stream = stream;
		this.opts = opts;
		this.state = "inactive";
		FakeMediaRecorder.instances.push(this);
	}
	start() {
		this.state = "recording";
	}
	stop() {
		this.state = "inactive";
		this.onstop?.();
	}
}
FakeMediaRecorder.instances = [];

function makeOptions() {
	FakeMediaRecorder.instances = [];
	const tracks = [fakeTrack(), fakeTrack()];
	const stream = fakeStream(tracks);
	const getUserMediaImpl = async (constraints) => {
		getUserMediaImpl.calledWith = constraints;
		return stream;
	};
	return { MediaRecorderImpl: FakeMediaRecorder, getUserMediaImpl, tracks };
}

test("createVoiceRecorder.start(): запрашивает микрофон (audio:true) и запускает MediaRecorder", async () => {
	const options = makeOptions();
	const recorder = createVoiceRecorder(options);
	await recorder.start();
	assert.deepEqual(options.getUserMediaImpl.calledWith, { audio: true });
	assert.equal(FakeMediaRecorder.instances.length, 1);
	assert.equal(FakeMediaRecorder.instances[0].state, "recording");
});

test("createVoiceRecorder.stop(): резолвится Blob'ом из собранных chunks, останавливает треки микрофона", async () => {
	const options = makeOptions();
	const recorder = createVoiceRecorder(options);
	await recorder.start();
	const mr = FakeMediaRecorder.instances[0];
	// ASCII нарочно — .length JS-строки совпадает с байтовым размером Blob (кириллица
	// в UTF-8 даёт 2 байта на символ, что не совпадало бы с .length напрямую).
	mr.ondataavailable({ data: new Blob(["hello "], { type: "audio/webm" }) });
	mr.ondataavailable({ data: new Blob(["world"], { type: "audio/webm" }) });

	const blob = await recorder.stop();
	assert.ok(blob instanceof Blob);
	assert.equal(blob.size, "hello ".length + "world".length);
	assert.ok(options.tracks.every((t) => t.stopped), "остановка записи обязана остановить ВСЕ треки микрофона (иначе индикатор 'микрофон активен' висит бесконечно)");
});

test("createVoiceRecorder.stop(): игнорирует чанки нулевого размера (dataavailable с пустым data)", async () => {
	const options = makeOptions();
	const recorder = createVoiceRecorder(options);
	await recorder.start();
	const mr = FakeMediaRecorder.instances[0];
	mr.ondataavailable({ data: new Blob([], { type: "audio/webm" }) });
	mr.ondataavailable({ data: new Blob(["payload"], { type: "audio/webm" }) });

	const blob = await recorder.stop();
	assert.equal(blob.size, "payload".length);
});

test("createVoiceRecorder.cancel(): останавливает треки, НЕ резолвит start()/не собирает Blob для последующего stop()", async () => {
	const options = makeOptions();
	const recorder = createVoiceRecorder(options);
	await recorder.start();
	const mr = FakeMediaRecorder.instances[0];
	mr.ondataavailable({ data: new Blob(["будет отброшено"], { type: "audio/webm" }) });

	recorder.cancel();
	assert.ok(options.tracks.every((t) => t.stopped), "cancel тоже обязан освободить микрофон");
	assert.equal(mr.state, "inactive");
});

test("createVoiceRecorder.stop() без предварительного start() — понятная ошибка, не падение с невнятным исключением", async () => {
	const recorder = createVoiceRecorder(makeOptions());
	await assert.rejects(() => recorder.stop(), /не была начата|not started/i);
});
