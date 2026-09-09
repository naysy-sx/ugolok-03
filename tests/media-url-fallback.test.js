import { test } from "node:test";
import assert from "node:assert/strict";
import { putStream } from "../src/domain/files/content.js";
import { acquireMediaUrl, releaseMediaUrlHandle, mediaElementSrc } from "../src/domain/media/adapters/media-url.js";
import { clearPlaintextCache } from "../src/domain/media/plaintext-cache.js";
import { clearManifestCache } from "../src/domain/files/content.js";

const ALICE_PRIV = new Uint8Array(32).fill(1);
const SERVER_URL = "https://blossom.test";

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
	return { fetchImpl };
}

// useFilesContentBridge:false — тот же путь, что canUseFilesContentBridge()
// когда navigator.serviceWorker.controller == null (мобильный Safari после
// деплоя SW). Node 22 не даёт подменить globalThis.navigator (только getter).
test("acquireMediaUrl: без SW-controller — object-url, src пригоден для <video>", async () => {
	clearPlaintextCache();
	clearManifestCache();
	const { fetchImpl } = makeFakeBlossom();
	const bytes = new Uint8Array(512);
	for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;
	const { manifest, manifestDigest, fileKey } = await putStream(bytes, {
		name: "clip.mp4",
		mime: "video/mp4",
		chunkSize: 256,
		serverUrl: SERVER_URL,
		privateKey: ALICE_PRIV,
		fetchImpl,
	});
	const ref = {
		digest: manifestDigest,
		key: fileKey,
		mime: "video/mp4",
		name: "clip.mp4",
		size: manifest.size,
		sourceKind: "attachment",
		sourceMeta: {},
	};
	const handle = await acquireMediaUrl(ref, { serverUrl: SERVER_URL, fetchImpl, useFilesContentBridge: false });
	assert.equal(handle.kind, "object-url");
	assert.ok(handle.src, "video-player ставит handle.src в <video> — пустой src = молчание на мобильном");
	assert.equal(handle.src, handle.url);
	assert.equal(mediaElementSrc(handle), handle.src);
	assert.match(handle.src, /^blob:/);
	await releaseMediaUrlHandle(ref.digest);
	clearPlaintextCache();
	clearManifestCache();
});
