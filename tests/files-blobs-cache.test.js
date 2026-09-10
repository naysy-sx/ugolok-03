import "fake-indexeddb/auto";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db } from "../src/core/store/database.js";
import {
	FILES_BLOBS_BUDGET_BYTES,
	setFilesBlobsOwner,
	getCachedCipherChunk,
	putCachedCipherChunk,
	evictFilesBlobsIfNeeded,
} from "../src/domain/files/blob-cache.js";
import { putStream, getChunk, getRange } from "../src/domain/files/content.js";

const OWNER_A = "owner-a-pubkey";
const OWNER_B = "owner-b-pubkey";
const ALICE_PRIV = new Uint8Array(32).fill(1);

beforeEach(async () => {
	await db.table("files_blobs").clear();
	setFilesBlobsOwner(OWNER_A);
});

function makeFakeBlossom() {
	const store = new Map();
	let gets = 0;
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
		gets += 1;
		const digest = url.split("/").pop();
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
	return { fetchImpl, getGets: () => gets };
}

test("put/get ciphertext round-trip", async () => {
	const bytes = new Uint8Array([1, 2, 3, 4]);
	await putCachedCipherChunk("digest-a", 0, bytes);
	const got = await getCachedCipherChunk("digest-a", 0);
	assert.deepEqual(got, bytes);
});

test("owner-scope: B не видит чанки A", async () => {
	await putCachedCipherChunk("digest-a", 0, new Uint8Array([9]));
	setFilesBlobsOwner(OWNER_B);
	const got = await getCachedCipherChunk("digest-a", 0);
	assert.equal(got, undefined);
});

test("без owner IDB пропускается", async () => {
	setFilesBlobsOwner(null);
	await putCachedCipherChunk("digest-a", 0, new Uint8Array([1]));
	setFilesBlobsOwner(OWNER_A);
	assert.equal(await getCachedCipherChunk("digest-a", 0), undefined);
});

test("evict LRU по lastAccess, бюджет на owner", async () => {
	const chunk = (n) => new Uint8Array(100).fill(n);
	await putCachedCipherChunk("d", 0, chunk(1));
	await putCachedCipherChunk("d", 1, chunk(2));
	await putCachedCipherChunk("d", 2, chunk(3));
	await db.table("files_blobs").update([OWNER_A, "d", 0], { lastAccess: 1 });
	await db.table("files_blobs").update([OWNER_A, "d", 1], { lastAccess: 2 });
	await db.table("files_blobs").update([OWNER_A, "d", 2], { lastAccess: 3 });
	await evictFilesBlobsIfNeeded(OWNER_A, 0, 250);
	assert.equal(await getCachedCipherChunk("d", 0), undefined, "самый старый вытеснен");
	assert.ok(await getCachedCipherChunk("d", 2), "свежий остался");
});

test("getChunk: повтор не ходит в сеть", async () => {
	const blossom = makeFakeBlossom();
	const original = new Uint8Array(400);
	crypto.getRandomValues(original);
	const { manifest, fileKey } = await putStream(original, {
		name: "x",
		mime: "application/octet-stream",
		chunkSize: 256,
		serverUrl: "https://blossom.test",
		privateKey: ALICE_PRIV,
		fetchImpl: blossom.fetchImpl,
	});
	await getChunk(manifest, fileKey, 0, { serverUrl: "https://blossom.test", fetchImpl: blossom.fetchImpl });
	const afterFirst = blossom.getGets();
	await getChunk(manifest, fileKey, 0, { serverUrl: "https://blossom.test", fetchImpl: blossom.fetchImpl });
	assert.equal(blossom.getGets(), afterFirst, "второй getChunk не должен бить в сеть");
});

test("getRange: ciphertext оседает в files_blobs", async () => {
	const blossom = makeFakeBlossom();
	const original = new Uint8Array(500);
	crypto.getRandomValues(original);
	const { manifest, fileKey } = await putStream(original, {
		name: "x",
		mime: "image/jpeg",
		chunkSize: 256,
		serverUrl: "https://blossom.test",
		privateKey: ALICE_PRIV,
		fetchImpl: blossom.fetchImpl,
	});
	await getRange(manifest, fileKey, 0, original.length, { serverUrl: "https://blossom.test", fetchImpl: blossom.fetchImpl });
	assert.ok(await getCachedCipherChunk(manifest.blobSha256, 0));
	assert.ok(await getCachedCipherChunk(manifest.blobSha256, 1));
});

test("FILES_BLOBS_BUDGET_BYTES = 400 МиБ", () => {
	assert.equal(FILES_BLOBS_BUDGET_BYTES, 400 * 1024 * 1024);
});
