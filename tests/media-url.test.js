import { test } from "node:test";
import assert from "node:assert/strict";
import { putStream } from "../src/domain/files/content.js";
import { handleRangeRequest } from "../src/domain/files/player-bridge.js";
import { acquireMediaUrl, releaseMediaUrlHandle } from "../src/domain/media/adapters/media-url.js";

const ALICE_PRIV = new Uint8Array(32).fill(1);
const SERVER_URL = "https://blossom.test";

// Тот же приём, что files-content.test.js::makeFakeBlossom — считает PUT-вызовы,
// чтобы тесты на мемоизацию могли проверить "сеть не повторилась".
function makeFakeBlossom() {
	const store = new Map();
	let getCalls = 0;
	async function sha256Hex(bytes) {
		const { sha256 } = await import("@noble/hashes/sha2.js");
		const { bytesToHex } = await import("@noble/hashes/utils.js");
		return bytesToHex(sha256(bytes));
	}
	const fetchImpl = async (url, opts = {}) => {
		if (opts.method === "PUT") {
			const body = new Uint8Array(opts.body);
			const digest = await sha256Hex(body);
			store.set(digest, body);
			return { ok: true, status: 200, json: async () => ({ sha256: digest, size: body.length }), text: async () => "" };
		}
		getCalls++;
		const parts = url.split("/");
		const digest = parts[parts.length - 1];
		const bytes = store.get(digest);
		if (!bytes) return { ok: false, status: 404, text: async () => "not found" };
		if (opts.headers?.Range) {
			const m = /bytes=(\d+)-(\d+)/.exec(opts.headers.Range);
			const start = Number(m[1]);
			const end = Number(m[2]);
			const slice = bytes.subarray(start, end + 1);
			return { ok: true, status: 206, arrayBuffer: async () => slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength) };
		}
		return { ok: true, status: 200, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
	};
	return { fetchImpl, get getCalls() { return getCalls; } };
}

async function uploadFixture(mime, size = 2000) {
	const { fetchImpl } = makeFakeBlossom();
	const bytes = new Uint8Array(size);
	for (let i = 0; i < size; i++) bytes[i] = i % 256;
	const { manifest, manifestDigest, fileKey } = await putStream(bytes, { name: "x", mime, chunkSize: 256, serverUrl: SERVER_URL, privateKey: ALICE_PRIV, fetchImpl });
	const ref = { digest: manifestDigest, key: fileKey, mime, name: "x", size: manifest.size, sourceKind: "attachment", sourceMeta: {} };
	return { ref, fetchImpl };
}

// image() polyfill Node не имеет URL.createObjectURL/Blob revoke по умолчанию —
// глобальный URL.createObjectURL в Node 20+ существует (веб-платформенное API),
// используется как есть, без stub'а.

test("acquireMediaUrl: изображение — object-url, содержимое читается GET'ом (eager, целиком)", async () => {
	const { ref, fetchImpl } = await uploadFixture("image/png");
	const handle = await acquireMediaUrl(ref, { serverUrl: SERVER_URL, fetchImpl });
	assert.equal(handle.kind, "object-url");
	assert.ok(handle.url.startsWith("blob:") || typeof handle.url === "string");
	await releaseMediaUrlHandle(ref.digest);
});

test("acquireMediaUrl: видео/аудио — bridge, реально зарегистрировано в player-bridge (handleRangeRequest отвечает)", async () => {
	const { ref, fetchImpl } = await uploadFixture("video/mp4");
	const handle = await acquireMediaUrl(ref, { serverUrl: SERVER_URL, fetchImpl });
	assert.equal(handle.kind, "bridge");
	assert.equal(handle.src, `/files-content/${ref.digest}`);

	const res = await handleRangeRequest({ manifestDigest: ref.digest, start: 0, end: 99 });
	assert.equal(res.ok, true);
	assert.equal(res.bytes.length, 100);

	await releaseMediaUrlHandle(ref.digest);
});

test("acquireMediaUrl: releaseMediaUrlHandle снимает регистрацию моста — handleRangeRequest после release даёт unknown-digest", async () => {
	const { ref, fetchImpl } = await uploadFixture("audio/webm");
	await acquireMediaUrl(ref, { serverUrl: SERVER_URL, fetchImpl });
	await releaseMediaUrlHandle(ref.digest);

	const res = await handleRangeRequest({ manifestDigest: ref.digest, start: 0, end: 9 });
	assert.equal(res.ok, false);
	assert.equal(res.error, "unknown-digest");
});

test("acquireMediaUrl: мемоизация — повторный вызов на тот же digest НЕ повторяет сеть", async () => {
	const { ref, fetchImpl } = await uploadFixture("image/jpeg");
	const fetchSpy = { calls: 0 };
	const countingFetch = async (...args) => {
		fetchSpy.calls++;
		return fetchImpl(...args);
	};
	const h1 = await acquireMediaUrl(ref, { serverUrl: SERVER_URL, fetchImpl: countingFetch });
	const callsAfterFirst = fetchSpy.calls;
	const h2 = await acquireMediaUrl(ref, { serverUrl: SERVER_URL, fetchImpl: countingFetch });
	assert.equal(fetchSpy.calls, callsAfterFirst, "второй acquireMediaUrl на тот же digest не должен был снова ходить в сеть");
	assert.equal(h1.url, h2.url);
	await releaseMediaUrlHandle(ref.digest);
});

test("acquireMediaUrl: два конкурентных вызова на тот же digest получают ОДИН и тот же результат (нет двойной регистрации)", async () => {
	const { ref, fetchImpl } = await uploadFixture("video/webm");
	const [h1, h2] = await Promise.all([acquireMediaUrl(ref, { serverUrl: SERVER_URL, fetchImpl }), acquireMediaUrl(ref, { serverUrl: SERVER_URL, fetchImpl })]);
	assert.equal(h1.src, h2.src);
	await releaseMediaUrlHandle(ref.digest);
});

test("releaseMediaUrlHandle: после release новый acquireMediaUrl на тот же digest реально идёт в сеть заново", async () => {
	const { ref, fetchImpl } = await uploadFixture("image/gif");
	const fetchSpy = { calls: 0 };
	const countingFetch = async (...args) => {
		fetchSpy.calls++;
		return fetchImpl(...args);
	};
	await acquireMediaUrl(ref, { serverUrl: SERVER_URL, fetchImpl: countingFetch });
	const callsAfterFirst = fetchSpy.calls;
	await releaseMediaUrlHandle(ref.digest);
	await acquireMediaUrl(ref, { serverUrl: SERVER_URL, fetchImpl: countingFetch });
	assert.ok(fetchSpy.calls > callsAfterFirst, "после release новый acquire обязан снова обратиться в сеть");
	await releaseMediaUrlHandle(ref.digest);
});
