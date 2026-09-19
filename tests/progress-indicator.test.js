import { test } from "node:test";
import assert from "node:assert/strict";
import { downloadPercent, pickIndicator } from "../src/domain/media/progress-indicator.js";
import { reservedBoxStyle } from "../src/ui/components/attachment-box.js";
import { resolveImagePreviewUrl, resolveImageOverlayUrl } from "../src/domain/media/image-preview.js";
import { clearPlaintextCache } from "../src/domain/media/plaintext-cache.js";

// MEDIA-PERF-TZ-6.md §8.

test("downloadPercent: округление, зажим 0..100, null там, где считать нечего", () => {
	assert.equal(downloadPercent({ bytesDone: 1, bytesTotal: 3 }), 33);
	assert.equal(downloadPercent({ bytesDone: 5, bytesTotal: 5 }), 100);
	assert.equal(downloadPercent({ bytesDone: 9, bytesTotal: 5 }), 100);
	assert.equal(downloadPercent({ bytesDone: 0, bytesTotal: 0 }), null);
	assert.equal(downloadPercent({ bytesDone: 1 }), null);
	assert.equal(downloadPercent(undefined), null);
});

test("pickIndicator: процент только когда он число, иначе idle (волчок решает вызывающий)", () => {
	assert.deepEqual(pickIndicator({ percent: 0 }), { kind: "percent", percent: 0 });
	assert.deepEqual(pickIndicator({ percent: 42 }), { kind: "percent", percent: 42 });
	assert.deepEqual(pickIndicator({ percent: null }), { kind: "idle" });
	assert.deepEqual(pickIndicator({}), { kind: "idle" });
	assert.deepEqual(pickIndicator(), { kind: "idle" });
});

test("reservedBoxStyle §8.1: резерв по width/height, без них — undefined (без выдуманного соотношения)", () => {
	assert.equal(reservedBoxStyle({}), undefined);
	assert.equal(reservedBoxStyle({ width: 100 }), undefined);
	assert.equal(reservedBoxStyle({ width: 0, height: 10 }), undefined);
	assert.equal(reservedBoxStyle(undefined), undefined);
	const style = reservedBoxStyle({ width: 1600, height: 900 });
	assert.equal(style.aspectRatio, "1600 / 900");
	assert.match(style.maxWidth, /1024px/, "потолок ширины как у растра превью");
	assert.match(reservedBoxStyle({ width: 300, height: 200 }).maxWidth, /300px/);
});

const RASTER = {
	createImageBitmap: async () => ({ width: 1, height: 1, close() {} }),
	convertBitmap: async () => new Blob([new Uint8Array([9])], { type: "image/png" }),
};

test("resolveImagePreviewUrl §8.2: onProgress получает объекты {phase, percent}, не строки", async () => {
	clearPlaintextCache();
	const events = [];
	await resolveImagePreviewUrl(
		"progress-digest-1",
		"image/jpeg",
		async (_trace, onDownload) => {
			onDownload?.({ bytesDone: 1, bytesTotal: 4 });
			onDownload?.({ bytesDone: 4, bytesTotal: 4 });
			return new Uint8Array([1, 2, 3]);
		},
		RASTER,
		(p) => events.push(p),
	);
	for (const e of events) assert.equal(typeof e, "object");
	assert.deepEqual(events[0], { phase: "loading", percent: null });
	assert.deepEqual(
		events.filter((e) => e.percent !== null),
		[
			{ phase: "loading", percent: 25 },
			{ phase: "loading", percent: 100 },
		],
	);
	assert.deepEqual(events.at(-1), { phase: "preparing", percent: null });
	clearPlaintextCache();
});

test("resolveImagePreviewUrl §8.2: loadBytes без onDownload (старая сигнатура) — percent остаётся null, ветка не ломается", async () => {
	clearPlaintextCache();
	const events = [];
	const result = await resolveImagePreviewUrl("progress-digest-2", "image/jpeg", async () => new Uint8Array([1, 2, 3]), RASTER, (p) => events.push(p));
	assert.ok(result.url);
	assert.ok(events.length >= 2);
	assert.ok(events.every((e) => e.percent === null));
	clearPlaintextCache();
});

test("resolveImageOverlayUrl §8.2: тот же контракт, downloadPercent без totals даёт null", async () => {
	clearPlaintextCache();
	const events = [];
	await resolveImageOverlayUrl(
		"progress-digest-3",
		"image/jpeg",
		async (_trace, onDownload) => {
			onDownload?.({ bytesDone: 0, bytesTotal: 0 });
			return new Uint8Array([1, 2, 3]);
		},
		{ ...RASTER, targetWidth: 512, webpSupported: false },
		(p) => events.push(p),
	);
	assert.ok(events.every((e) => typeof e === "object" && e.percent === null));
	clearPlaintextCache();
});
