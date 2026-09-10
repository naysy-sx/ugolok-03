import { test } from "node:test";
import assert from "node:assert/strict";
import { extractVideoPoster, extractVideoPosterCapture, dataUrlFromJpegBytes } from "../src/ui/media/extract-video-poster.js";

// MEDIA-PERF-TZ-5.md §3 — общий helper для fake video/canvas (тот же приём,
// что "revoke вызывается даже при таймауте" выше), параметризован реальными
// байтами кадра и длительностью — чтобы не дублировать разметку в каждом тесте.
function fakeVideoAdapters({ jpegBytes = new Uint8Array([1, 2, 3]), duration = 12.7, videoWidth = 320, videoHeight = 180 } = {}) {
	const revoked = [];
	return {
		revoked,
		createObjectURL: () => "blob:fake",
		revokeObjectURL: (u) => revoked.push(u),
		makeVideo: () => {
			const listeners = {};
			const video = {
				muted: false,
				playsInline: false,
				preload: "",
				src: "",
				duration,
				videoWidth,
				videoHeight,
				currentTime: 0,
				addEventListener: (name, cb) => {
					listeners[name] = cb;
				},
				removeEventListener: () => {},
			};
			// loadedmetadata/seeked срабатывают синхронно на присвоение — captureVideoFrame
			// ждёт их через once()+Promise.race, микротаска достаточно.
			Object.defineProperty(video, "currentTime", {
				get() {
					return this._t;
				},
				set(v) {
					this._t = v;
					queueMicrotask(() => listeners.seeked?.());
				},
			});
			queueMicrotask(() => listeners.loadedmetadata?.());
			return video;
		},
		makeCanvas: () => ({
			width: 0,
			height: 0,
			getContext: () => ({ drawImage: () => {} }),
			toBlob: (cb) => cb(new Blob([jpegBytes], { type: "image/jpeg" })),
		}),
	};
}

test("extractVideoPoster: type не video → null", async () => {
	assert.equal(await extractVideoPoster({ type: "image/png" }), null);
	assert.equal(await extractVideoPoster({ type: "application/pdf" }), null);
	assert.equal(await extractVideoPoster(null), null);
	assert.equal(await extractVideoPoster(undefined), null);
});

test("extractVideoPoster: readyBlob больше потолка → null", async () => {
	const oversized = new Blob([new Uint8Array(32769)]);
	assert.equal(await extractVideoPoster({ type: "video/mp4" }, { readyBlob: oversized }), null);
});

test("extractVideoPoster: readyBlob в пределах потолка → data:image/jpeg", async () => {
	const blob = new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: "image/jpeg" });
	const url = await extractVideoPoster({ type: "video/mp4" }, { readyBlob: blob });
	assert.equal(typeof url, "string");
	assert.ok(url.startsWith("data:image/jpeg;base64,"));
});

test("extractVideoPoster: нет Video/Canvas → null", async () => {
	assert.equal(
		await extractVideoPoster(
			{ type: "video/mp4" },
			{ makeVideo: null, makeCanvas: null, createObjectURL: () => "blob:x" },
		),
		null,
	);
});

test("extractVideoPoster: revoke вызывается даже при таймауте", async () => {
	const revoked = [];
	const created = [];
	const result = await extractVideoPoster(
		{ type: "video/mp4" },
		{
			timeoutMs: 20,
			createObjectURL: () => {
				created.push("blob:fake");
				return "blob:fake";
			},
			revokeObjectURL: (u) => revoked.push(u),
			makeVideo: () => {
				const listeners = {};
				return {
					muted: false,
					playsInline: false,
					preload: "",
					src: "",
					duration: 10,
					addEventListener: (name, cb) => {
						listeners[name] = cb;
					},
					removeEventListener: () => {},
				};
			},
			makeCanvas: () => ({
				width: 0,
				height: 0,
				getContext: () => ({ drawImage: () => {} }),
				toBlob: (cb) => cb(null),
			}),
		},
	);
	assert.equal(result, null);
	assert.deepEqual(created, ["blob:fake"]);
	assert.deepEqual(revoked, ["blob:fake"]);
});

test("dataUrlFromJpegBytes: собирает data URL из байт", () => {
	const url = dataUrlFromJpegBytes(new Uint8Array([1, 2, 3]));
	assert.ok(url.startsWith("data:image/jpeg;base64,"));
	assert.equal(url, "data:image/jpeg;base64," + Buffer.from([1, 2, 3]).toString("base64"));
});

// MEDIA-PERF-TZ-5.md §3 — extractVideoPosterCapture: сырые байты (для
// putStream) + duration/width/height, снятые с того же loadedmetadata.

test("extractVideoPosterCapture: type не video → null", async () => {
	assert.equal(await extractVideoPosterCapture({ type: "image/png" }), null);
	assert.equal(await extractVideoPosterCapture(null), null);
});

test("extractVideoPosterCapture: возвращает сырые JPEG-байты + duration/width/height", async () => {
	const jpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 9, 9]);
	const adapters = fakeVideoAdapters({ jpegBytes, duration: 42.3, videoWidth: 640, videoHeight: 360 });
	const result = await extractVideoPosterCapture({ type: "video/mp4" }, adapters);

	assert.ok(result, "не должен вернуть null на успешном пути");
	assert.deepEqual(result.bytes, jpegBytes);
	assert.equal(result.mime, "image/jpeg");
	assert.equal(result.duration, 42.3);
	assert.equal(result.width, 640);
	assert.equal(result.height, 360);
	assert.deepEqual(adapters.revoked, ["blob:fake"], "object URL освобождён после захвата кадра");
});

test("extractVideoPosterCapture: нет maxBlobSize-потолка (в отличие от extractVideoPoster) — крупный кадр всё равно возвращается", async () => {
	const bigJpeg = new Uint8Array(40000); // больше 32768 — потолок extractVideoPoster здесь не применяется
	const adapters = fakeVideoAdapters({ jpegBytes: bigJpeg });
	const result = await extractVideoPosterCapture({ type: "video/mp4" }, adapters);
	assert.ok(result);
	assert.equal(result.bytes.length, 40000);
});

test("extractVideoPosterCapture: canvas.toBlob вернул null (отказ кодека) → null", async () => {
	const result = await extractVideoPosterCapture(
		{ type: "video/mp4" },
		{
			createObjectURL: () => "blob:fake",
			revokeObjectURL: () => {},
			makeVideo: () => {
				const listeners = {};
				const video = {
					muted: false,
					playsInline: false,
					preload: "",
					src: "",
					duration: 5,
					addEventListener: (name, cb) => {
						listeners[name] = cb;
					},
					removeEventListener: () => {},
					set currentTime(v) {
						queueMicrotask(() => listeners.seeked?.());
					},
				};
				queueMicrotask(() => listeners.loadedmetadata?.());
				return video;
			},
			makeCanvas: () => ({ width: 0, height: 0, getContext: () => ({ drawImage: () => {} }), toBlob: (cb) => cb(null) }),
		},
	);
	assert.equal(result, null);
});

test("extractVideoPoster (data:URL) и extractVideoPosterCapture (сырые байты) дают ОДИНАКОВЫЕ пиксели — общий captureVideoFrame под капотом", async () => {
	const jpegBytes = new Uint8Array([1, 2, 3, 4, 5]);
	const dataUrl = await extractVideoPoster({ type: "video/mp4" }, fakeVideoAdapters({ jpegBytes }));
	const captured = await extractVideoPosterCapture({ type: "video/mp4" }, fakeVideoAdapters({ jpegBytes }));
	assert.equal(dataUrl, dataUrlFromJpegBytes(captured.bytes));
});
