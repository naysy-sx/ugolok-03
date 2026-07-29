import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { putStream } from "../src/domain/files/content.js";
import { registerPlayerFile, unregisterPlayerFile, handleRangeRequest } from "../src/domain/files/player-bridge.js";

const ALICE_PRIV = new Uint8Array(32).fill(1);

function makeFakeBlossom() {
	const store = new Map();
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
		const parts = url.split("/");
		const key = parts[parts.length - 1];
		const bytes = store.get(key);
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
	return { fetchImpl };
}

async function setupFile(fetchImpl, size, mime = "video/mp4") {
	const original = new Uint8Array(size);
	crypto.getRandomValues(original);
	const { manifest, manifestDigest, fileKey } = await putStream(original, {
		name: "clip.bin",
		mime,
		chunkSize: 256,
		serverUrl: "https://blossom.test",
		privateKey: ALICE_PRIV,
		fetchImpl,
	});
	return { original, manifest, manifestDigest, fileKey };
}

beforeEach(() => {
	// player-bridge.js хранит реестр в модульном замыкании — явная очистка
	// между тестами через unregister избегает утечки состояния между ними
	// (сам registry не экспортирован намеренно, инкапсуляция).
});

test("handleRangeRequest: незарегистрированный digest -> unknown-digest", async () => {
	const res = await handleRangeRequest({ manifestDigest: "нет-такого-файла", start: 0, end: 10 });
	assert.equal(res.ok, false);
	assert.equal(res.error, "unknown-digest");
});

test("registerPlayerFile/handleRangeRequest: round-trip, байты совпадают с оригиналом (диапазон ВКЛЮЧИТЕЛЬНЫЙ, как HTTP Range)", async () => {
	const { fetchImpl } = makeFakeBlossom();
	const { original, manifest, manifestDigest, fileKey } = await setupFile(fetchImpl, 2000);

	registerPlayerFile(manifestDigest, { manifest, fileKey, serverUrl: "https://blossom.test", fetchImpl });
	const res = await handleRangeRequest({ manifestDigest, start: 100, end: 199 }); // включительно -> 100 байт
	assert.equal(res.ok, true);
	assert.equal(res.bytes.length, 100);
	assert.deepEqual(res.bytes, original.subarray(100, 200));
	assert.equal(res.mime, "video/mp4");
	assert.equal(res.size, 2000);

	unregisterPlayerFile(manifestDigest);
});

test("unregisterPlayerFile: после снятия регистрации запрос снова unknown-digest", async () => {
	const { fetchImpl } = makeFakeBlossom();
	const { manifest, manifestDigest, fileKey } = await setupFile(fetchImpl, 500);
	registerPlayerFile(manifestDigest, { manifest, fileKey, serverUrl: "https://blossom.test", fetchImpl });
	unregisterPlayerFile(manifestDigest);

	const res = await handleRangeRequest({ manifestDigest, start: 0, end: 10 });
	assert.equal(res.ok, false);
	assert.equal(res.error, "unknown-digest");
});

test("handleRangeRequest: границы диапазона — отрицательный start, end за пределами size, start>end -> range-out-of-bounds", async () => {
	const { fetchImpl } = makeFakeBlossom();
	const { manifest, manifestDigest, fileKey } = await setupFile(fetchImpl, 1000);
	registerPlayerFile(manifestDigest, { manifest, fileKey, serverUrl: "https://blossom.test", fetchImpl });

	assert.equal((await handleRangeRequest({ manifestDigest, start: -5, end: 10 })).error, "range-out-of-bounds");
	assert.equal((await handleRangeRequest({ manifestDigest, start: 0, end: 1000 })).error, "range-out-of-bounds"); // size=1000, индексы 0..999
	assert.equal((await handleRangeRequest({ manifestDigest, start: 50, end: 10 })).error, "range-out-of-bounds");

	unregisterPlayerFile(manifestDigest);
});

test("handleRangeRequest: открытый диапазон (end=null, 'bytes=X-' без верхней границы) разрешается в конец файла", async () => {
	const { fetchImpl } = makeFakeBlossom();
	const { original, manifest, manifestDigest, fileKey } = await setupFile(fetchImpl, 500);
	registerPlayerFile(manifestDigest, { manifest, fileKey, serverUrl: "https://blossom.test", fetchImpl });

	const res = await handleRangeRequest({ manifestDigest, start: 450, end: null });
	assert.equal(res.ok, true);
	assert.deepEqual(res.bytes, original.subarray(450, 500));
	assert.equal(res.size, 500);

	unregisterPlayerFile(manifestDigest);
});

test("два одновременно зарегистрированных файла не пересекаются (изоляция по digest)", async () => {
	const { fetchImpl } = makeFakeBlossom();
	const fileA = await setupFile(fetchImpl, 800, "video/mp4");
	const fileB = await setupFile(fetchImpl, 900, "audio/mpeg");
	registerPlayerFile(fileA.manifestDigest, { manifest: fileA.manifest, fileKey: fileA.fileKey, serverUrl: "https://blossom.test", fetchImpl });
	registerPlayerFile(fileB.manifestDigest, { manifest: fileB.manifest, fileKey: fileB.fileKey, serverUrl: "https://blossom.test", fetchImpl });

	const resA = await handleRangeRequest({ manifestDigest: fileA.manifestDigest, start: 0, end: 49 });
	const resB = await handleRangeRequest({ manifestDigest: fileB.manifestDigest, start: 0, end: 49 });
	assert.deepEqual(resA.bytes, fileA.original.subarray(0, 50));
	assert.deepEqual(resB.bytes, fileB.original.subarray(0, 50));
	assert.equal(resA.mime, "video/mp4");
	assert.equal(resB.mime, "audio/mpeg");

	unregisterPlayerFile(fileA.manifestDigest);
	unregisterPlayerFile(fileB.manifestDigest);
});

test("handleRangeRequest: сбой расшифровки/сети -> ok:false, decrypt-failed, не бросает исключение наружу", async () => {
	const { fetchImpl } = makeFakeBlossom();
	const { manifest, manifestDigest } = await setupFile(fetchImpl, 500);
	const wrongKey = new Uint8Array(32).fill(9); // заведомо не тот fileKey
	registerPlayerFile(manifestDigest, { manifest, fileKey: wrongKey, serverUrl: "https://blossom.test", fetchImpl });

	const res = await handleRangeRequest({ manifestDigest, start: 0, end: 10 });
	assert.equal(res.ok, false);
	assert.equal(res.error, "decrypt-failed");

	unregisterPlayerFile(manifestDigest);
});
