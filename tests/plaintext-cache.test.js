import { test } from "node:test";
import assert from "node:assert/strict";
import {
	putPlaintextBytes,
	getPlaintextBytes,
	setPreviewUrl,
	getPreviewUrl,
	clearPlaintextCache,
	PLAINTEXT_CACHE_BUDGET_BYTES,
} from "../src/domain/media/plaintext-cache.js";

test("put/get plaintext bytes и preview URL", () => {
	clearPlaintextCache();
	const bytes = new Uint8Array([1, 2, 3]);
	putPlaintextBytes("d1", bytes, "image/png");
	assert.deepEqual(getPlaintextBytes("d1"), bytes);
	setPreviewUrl("d1", "blob:preview");
	assert.equal(getPreviewUrl("d1"), "blob:preview");
	clearPlaintextCache();
	assert.equal(getPlaintextBytes("d1"), undefined);
	assert.equal(getPreviewUrl("d1"), undefined);
});

test("бюджет вытесняет старые записи", () => {
	clearPlaintextCache();
	const big = new Uint8Array(PLAINTEXT_CACHE_BUDGET_BYTES - 10);
	putPlaintextBytes("old", big, "image/jpeg");
	putPlaintextBytes("new", new Uint8Array(100), "image/jpeg");
	assert.equal(getPlaintextBytes("old"), undefined);
	assert.ok(getPlaintextBytes("new"));
	clearPlaintextCache();
});
