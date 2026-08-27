import { test } from "node:test";
import assert from "node:assert/strict";
import { extractVideoPoster, dataUrlFromJpegBytes } from "../src/ui/media/extract-video-poster.js";

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
