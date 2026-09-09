import { test } from "node:test";
import assert from "node:assert/strict";
import { rasterizeImageBytes } from "../src/domain/media/raster-image.js";
import { resolveImagePreviewUrl } from "../src/domain/media/image-preview.js";
import { clearPlaintextCache, getPlaintextBytes } from "../src/domain/media/plaintext-cache.js";

test("rasterizeImageBytes: без bitmap API отдаёт исходный blob (Node fallback)", async () => {
	const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
	const { url, rasterized } = await rasterizeImageBytes(bytes, "image/jpeg", { createImageBitmap: null });
	assert.equal(rasterized, false);
	assert.ok(typeof url === "string");
	URL.revokeObjectURL(url);
});

test("rasterizeImageBytes: с convertBitmap src не равен исходному progressive-потоку", async () => {
	const original = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 9, 9, 9]);
	const pngLike = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
	const { url, rasterized } = await rasterizeImageBytes(original, "image/jpeg", {
		createImageBitmap: async () => ({ width: 1, height: 1, close() {} }),
		convertBitmap: async () => new Blob([pngLike], { type: "image/png" }),
	});
	assert.equal(rasterized, true);
	const preview = new Uint8Array(await (await fetch(url)).arrayBuffer());
	assert.notDeepEqual(preview, original);
	assert.deepEqual(preview, pngLike);
	URL.revokeObjectURL(url);
});

test("resolveImagePreviewUrl: повторный вызов не зовёт loadBytes", async () => {
	clearPlaintextCache();
	const bytes = new Uint8Array([1, 2, 3, 4, 5]);
	let loads = 0;
	const adapters = {
		createImageBitmap: async () => ({ width: 1, height: 1, close() {} }),
		convertBitmap: async () => new Blob([new Uint8Array([9, 9])], { type: "image/png" }),
	};
	const first = await resolveImagePreviewUrl("digest-a", "image/jpeg", async () => {
		loads += 1;
		return bytes;
	}, adapters);
	const second = await resolveImagePreviewUrl("digest-a", "image/jpeg", async () => {
		loads += 1;
		return bytes;
	}, adapters);
	assert.equal(loads, 1);
	assert.equal(first.url, second.url);
	assert.ok(getPlaintextBytes("digest-a"));
	clearPlaintextCache();
});
