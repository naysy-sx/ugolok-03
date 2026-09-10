// MEDIA-PERF-TZ-5.md §3 — сторона показа: resolveAttachmentPreviewUrl обязана
// трогать ТОЛЬКО previewDigest/previewKey, никогда оригинал.
import { test } from "node:test";
import assert from "node:assert/strict";
import { uploadMessageAttachment } from "../src/domain/messaging/attachments.js";
import { resolveAttachmentPreviewUrl } from "../src/domain/media/attachment-preview-resolver.js";

const ALICE_PRIV = new Uint8Array(32).fill(1);
const SERVER_URL = "https://blossom.test";

function makeFakeBlossom() {
	const store = new Map();
	const fetched = [];

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
		fetched.push(digest);
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

	return { fetchImpl, store, fetched };
}

test("resolveAttachmentPreviewUrl: без previewDigest — не бьёт в сеть вовсе, возвращает null", async () => {
	const { fetchImpl, fetched } = makeFakeBlossom();
	const url = await resolveAttachmentPreviewUrl({ manifestDigest: "abc", fileKey: "xyz" }, { serverUrl: SERVER_URL, fetchImpl });
	assert.equal(url, null);
	assert.deepEqual(fetched, []);
});

test("resolveAttachmentPreviewUrl: с previewDigest — резолвит превью, ни разу не запрашивает manifestDigest оригинала", async () => {
	const { fetchImpl, fetched } = makeFakeBlossom();
	const original = new TextEncoder().encode("оригинал, ЕГО НЕЛЬЗЯ ТРОГАТЬ ЧЕРЕЗ ПРЕВЬЮ");
	const previewBytes = new Uint8Array([10, 20, 30, 40]);

	const descriptor = await uploadMessageAttachment(
		SERVER_URL,
		original,
		{ mime: "image/jpeg", name: "photo.jpg" },
		ALICE_PRIV,
		{ fetchImpl, generatePreview: async () => ({ bytes: previewBytes, mime: "image/jpeg" }) },
	);
	assert.equal(typeof descriptor.previewDigest, "string");

	fetched.length = 0; // сбрасываем — интересует только то, что запросил РЕЗОЛВЕР, не заливка
	const url = await resolveAttachmentPreviewUrl(descriptor, { serverUrl: SERVER_URL, fetchImpl });

	assert.equal(typeof url, "string");
	assert.ok(url.startsWith("blob:"), "object URL, не data:/http:");
	assert.ok(fetched.length > 0, "резолвер реально ходил в сеть за превью");
	// getManifest(previewDigest) + getRange(...) по ЧАНКАМ превью (чужой,
	// отдельный digest = manifest.blobSha256 превью) — оба НЕ совпадают с
	// digest'ом манифеста ОРИГИНАЛА. Именно это и проверяем: манифест оригинала
	// не запрошен ни разу (сами чанки оригинала тем более не запрошены бы без
	// его манифеста — не знали бы, по какому digest'у их искать).
	assert.ok(fetched.includes(descriptor.previewDigest), "манифест превью реально запрошен");
	assert.ok(!fetched.includes(descriptor.manifestDigest), "манифест ОРИГИНАЛА не запрошен ни разу");
});

test("resolveAttachmentPreviewUrl: повторный вызов с тем же previewDigest — мемоизация, второй раз в сеть не ходит", async () => {
	const { fetchImpl, fetched } = makeFakeBlossom();
	const original = new TextEncoder().encode("мемоизация превью");
	const descriptor = await uploadMessageAttachment(
		SERVER_URL,
		original,
		{ mime: "image/jpeg", name: "photo.jpg" },
		ALICE_PRIV,
		{ fetchImpl, generatePreview: async () => ({ bytes: new Uint8Array([1, 2, 3]), mime: "image/jpeg" }) },
	);

	fetched.length = 0;
	const first = await resolveAttachmentPreviewUrl(descriptor, { serverUrl: SERVER_URL, fetchImpl });
	const requestsAfterFirst = fetched.length;
	assert.ok(requestsAfterFirst > 0);

	const second = await resolveAttachmentPreviewUrl(descriptor, { serverUrl: SERVER_URL, fetchImpl });
	assert.equal(second, first, "тот же object URL — не пересоздан");
	assert.equal(fetched.length, requestsAfterFirst, "повторный вызов не породил новых сетевых запросов");
});

test("resolveAttachmentPreviewUrl: сервер вернул 404 на previewDigest — не бросает, возвращает null", async () => {
	const { fetchImpl } = makeFakeBlossom();
	const url = await resolveAttachmentPreviewUrl(
		{ manifestDigest: "orig", fileKey: "orig-key", previewDigest: "deadbeef", previewKey: btoa("not-important-ascii-only") },
		{ serverUrl: SERVER_URL, fetchImpl },
	);
	assert.equal(url, null);
});
