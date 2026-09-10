import { test } from "node:test";
import assert from "node:assert/strict";
import {
	downloadBlobRange,
	downloadBlob,
	resolveReadTimeoutMs,
	READ_TIMEOUT_FLOOR_MS,
	READ_TIMEOUT_CEIL_MS,
} from "../src/domain/files/blob.js";
import { withRetry } from "../src/core/transport/blossom-client.js";

function fake206(bytes) {
	const body = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	return {
		ok: true,
		status: 206,
		arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
	};
}

test("resolveReadTimeoutMs: нулевой объём -> пол 8с", () => {
	assert.equal(resolveReadTimeoutMs(0), READ_TIMEOUT_FLOOR_MS);
});

test("resolveReadTimeoutMs: потолок не превышается", () => {
	assert.equal(resolveReadTimeoutMs(100 * 1024 * 1024), READ_TIMEOUT_CEIL_MS);
});

test("downloadBlobRange: один 503, вторая попытка 206 -> успех, 2 обращения", async () => {
	const payload = new Uint8Array([1, 2, 3, 4]);
	let calls = 0;
	const fetchImpl = async () => {
		calls += 1;
		if (calls === 1) return { ok: false, status: 503, arrayBuffer: async () => new ArrayBuffer(0) };
		return fake206(payload);
	};
	const bytes = await downloadBlobRange("https://blossom.test", "abc", 0, 3, {
		fetchImpl,
		retries: 2,
		backoffMs: 1,
		timeoutMs: 5_000,
	});
	assert.equal(calls, 2);
	assert.deepEqual(bytes, payload);
});

test("downloadBlobRange: три 502 подряд -> network-failed, ровно 3 обращения", async () => {
	let calls = 0;
	const fetchImpl = async () => {
		calls += 1;
		return { ok: false, status: 502, arrayBuffer: async () => new ArrayBuffer(0) };
	};
	await assert.rejects(
		() =>
			downloadBlobRange("https://blossom.test", "abc", 0, 3, {
				fetchImpl,
				retries: 2,
				backoffMs: 1,
				timeoutMs: 5_000,
			}),
		(err) => {
			assert.equal(err.code, "network-failed");
			assert.equal(err.status, 502);
			return true;
		},
	);
	assert.equal(calls, 3);
});

test("downloadBlobRange: 404 -> без повторов, ровно 1 обращение", async () => {
	let calls = 0;
	const fetchImpl = async () => {
		calls += 1;
		return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
	};
	await assert.rejects(() =>
		downloadBlobRange("https://blossom.test", "abc", 0, 3, { fetchImpl, retries: 2, backoffMs: 1, timeoutMs: 5_000 }),
	);
	assert.equal(calls, 1);
});

test("downloadBlob: один сетевой TypeError, вторая попытка успех", async () => {
	let calls = 0;
	const payload = new Uint8Array([9, 8]);
	const fetchImpl = async () => {
		calls += 1;
		if (calls === 1) throw new TypeError("failed to fetch");
		return {
			ok: true,
			status: 200,
			arrayBuffer: async () => payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength),
		};
	};
	const bytes = await downloadBlob("https://blossom.test", "deadbeef", { fetchImpl, retries: 2, backoffMs: 1, timeoutMs: 5_000 });
	assert.equal(calls, 2);
	assert.deepEqual(bytes, payload);
});

test("withRetry: AbortError не повторяется", async () => {
	let calls = 0;
	const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
	await assert.rejects(
		() =>
			withRetry(
				async () => {
					calls += 1;
					throw abort;
				},
				{ retries: 2, backoffMs: 1 },
			),
		(err) => err.name === "AbortError",
	);
	assert.equal(calls, 1);
});
