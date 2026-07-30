// Замена tests/attachment-cache.test.js (этап 53 И7, задача 7.4 — снятие
// фасада attachments, DESIGN.md). Алгоритм кеша (LRU по объёму + TTL,
// owner-scoping) НЕ меняется — тесты тоже, кроме: ключ теперь manifestDigest
// (не sha256 целого зашифрованного блоба), промах кеша читает через
// downloadMessageAttachment (content.js's getManifest+getRange), не старый
// downloadAttachment.
import "fake-indexeddb/auto";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db } from "../src/core/store/database.js";
import { uploadMessageAttachment } from "../src/domain/messaging/attachments.js";
import { getCachedMessageAttachment, putCachedMessageAttachment, evictIfNeeded, getOrDownloadMessageAttachment } from "../src/domain/files/content-cache.js";

const OWNER_A = "owner-a-pubkey";
const OWNER_B = "owner-b-pubkey";
const DB_KEY_A = crypto.getRandomValues(new Uint8Array(32));
const DB_KEY_B = crypto.getRandomValues(new Uint8Array(32));
const ALICE_PRIV = new Uint8Array(32).fill(1);

beforeEach(async () => {
	await db.table("attachments").clear();
});

// Тот же фейковый Blossom (Range-совместимый), что messaging-attachments.test.js.
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

	return { fetchImpl, store };
}

async function backdate(ownerPubkey, digest, ageMs) {
	await db.table("attachments").update([ownerPubkey, digest], { lastAccessedAt: Date.now() - ageMs });
}

test("putCachedMessageAttachment + getCachedMessageAttachment: round-trip возвращает те же байты", async () => {
	const bytes = new TextEncoder().encode("картинка (условно)");
	const digest = "aaaa";
	await putCachedMessageAttachment(OWNER_A, DB_KEY_A, digest, "image/png", bytes);
	const got = await getCachedMessageAttachment(OWNER_A, DB_KEY_A, digest);
	assert.deepEqual(got, bytes);
});

test("getCachedMessageAttachment: промах -> undefined, не бросает", async () => {
	const got = await getCachedMessageAttachment(OWNER_A, DB_KEY_A, "нет-такого-digest");
	assert.equal(got, undefined);
});

test("owner-scoping: один и тот же manifestDigest под разными owner не пересекается", async () => {
	const bytes = new TextEncoder().encode("общий файл, два разных владельца локально");
	const digest = "bbbb";
	await putCachedMessageAttachment(OWNER_A, DB_KEY_A, digest, "image/png", bytes);
	const gotUnderB = await getCachedMessageAttachment(OWNER_B, DB_KEY_B, digest);
	assert.equal(gotUnderB, undefined, "владелец B не должен видеть кэш владельца A под тем же digest");
	const gotUnderA = await getCachedMessageAttachment(OWNER_A, DB_KEY_A, digest);
	assert.deepEqual(gotUnderA, bytes, "сам владелец A по-прежнему видит свою запись");
});

test("putCachedMessageAttachment: идемпотентна (put, не add) — повторная запись перезаписывает, не бросает", async () => {
	const digest = "cccc";
	await putCachedMessageAttachment(OWNER_A, DB_KEY_A, digest, "image/png", new Uint8Array([1, 2, 3]));
	await assert.doesNotReject(() => putCachedMessageAttachment(OWNER_A, DB_KEY_A, digest, "image/png", new Uint8Array([4, 5, 6])));
	const got = await getCachedMessageAttachment(OWNER_A, DB_KEY_A, digest);
	assert.deepEqual(got, new Uint8Array([4, 5, 6]));
});

test("evictIfNeeded: протухшая по TTL строка удаляется", async () => {
	await putCachedMessageAttachment(OWNER_A, DB_KEY_A, "old", "image/png", new Uint8Array([1]));
	await backdate(OWNER_A, "old", 10_000);
	await evictIfNeeded(OWNER_A, { budgetBytes: 1_000_000, ttlMs: 5_000 });
	assert.equal(await getCachedMessageAttachment(OWNER_A, DB_KEY_A, "old"), undefined);
});

test("evictIfNeeded: свежая строка НЕ удаляется по TTL", async () => {
	await putCachedMessageAttachment(OWNER_A, DB_KEY_A, "fresh", "image/png", new Uint8Array([1]));
	await evictIfNeeded(OWNER_A, { budgetBytes: 1_000_000, ttlMs: 5_000 });
	assert.notEqual(await getCachedMessageAttachment(OWNER_A, DB_KEY_A, "fresh"), undefined);
});

test("evictIfNeeded: превышение бюджета — вытесняет САМЫЕ СТАРЫЕ по lastAccessedAt первыми, пока не уложится", async () => {
	await putCachedMessageAttachment(OWNER_A, DB_KEY_A, "s1", "image/png", new Uint8Array(40));
	await putCachedMessageAttachment(OWNER_A, DB_KEY_A, "s2", "image/png", new Uint8Array(40));
	await putCachedMessageAttachment(OWNER_A, DB_KEY_A, "s3", "image/png", new Uint8Array(40));
	await backdate(OWNER_A, "s1", 3000);
	await backdate(OWNER_A, "s2", 2000);
	await backdate(OWNER_A, "s3", 1000);

	await evictIfNeeded(OWNER_A, { budgetBytes: 90, ttlMs: 1_000_000 });

	assert.equal(await getCachedMessageAttachment(OWNER_A, DB_KEY_A, "s1"), undefined, "самая старая (s1) вытесняется первой");
	assert.notEqual(await getCachedMessageAttachment(OWNER_A, DB_KEY_A, "s2"), undefined);
	assert.notEqual(await getCachedMessageAttachment(OWNER_A, DB_KEY_A, "s3"), undefined);
});

test("getCachedMessageAttachment: touch на чтении продлевает жизнь строки при последующем LRU-вытеснении", async () => {
	await putCachedMessageAttachment(OWNER_A, DB_KEY_A, "s1", "image/png", new Uint8Array(40));
	await putCachedMessageAttachment(OWNER_A, DB_KEY_A, "s2", "image/png", new Uint8Array(40));
	await backdate(OWNER_A, "s1", 3000);
	await backdate(OWNER_A, "s2", 2000);

	await getCachedMessageAttachment(OWNER_A, DB_KEY_A, "s1");

	await putCachedMessageAttachment(OWNER_A, DB_KEY_A, "s3", "image/png", new Uint8Array(40));

	await evictIfNeeded(OWNER_A, { budgetBytes: 90, ttlMs: 1_000_000 });

	assert.equal(await getCachedMessageAttachment(OWNER_A, DB_KEY_A, "s2"), undefined, "s2 теперь самая старая (не тронута touch'ем) — вытесняется");
	assert.notEqual(await getCachedMessageAttachment(OWNER_A, DB_KEY_A, "s1"), undefined, "s1 пережила вытеснение благодаря touch на чтении");
});

test("evictIfNeeded: одна строка больше бюджета сама по себе — не падает, самовытесняется", async () => {
	await putCachedMessageAttachment(OWNER_A, DB_KEY_A, "huge", "video/mp4", new Uint8Array(120), { budgetBytes: 90, ttlMs: 1_000_000 });
	assert.equal(await getCachedMessageAttachment(OWNER_A, DB_KEY_A, "huge"), undefined);
});

test("getOrDownloadMessageAttachment: промах кэша — скачивает через сеть (getManifest+getRange) и сохраняет в кэш", async () => {
	const { fetchImpl, store } = makeFakeBlossom();
	const original = new TextEncoder().encode("вложение для getOrDownloadMessageAttachment");
	const descriptor = await uploadMessageAttachment("https://blossom.test", original, { mime: "image/png", name: "x.png" }, ALICE_PRIV, { fetchImpl });

	let fetchCalls = 0;
	const countingFetchImpl = async (url, opts) => {
		fetchCalls++;
		return fetchImpl(url, opts);
	};
	const bytes = await getOrDownloadMessageAttachment(OWNER_A, DB_KEY_A, descriptor, { serverUrl: "https://blossom.test", fetchImpl: countingFetchImpl });
	assert.deepEqual(bytes, original);
	assert.ok(fetchCalls > 0, "промах кэша обязан сходить в сеть");

	const cached = await getCachedMessageAttachment(OWNER_A, DB_KEY_A, descriptor.manifestDigest);
	assert.deepEqual(cached, original, "результат сети должен осесть в локальном кэше");
	void store;
});

test("getOrDownloadMessageAttachment: попадание в кэш — сеть НЕ вызывается повторно", async () => {
	const { fetchImpl } = makeFakeBlossom();
	const original = new TextEncoder().encode("вложение, которое уже видели");
	const descriptor = await uploadMessageAttachment("https://blossom.test", original, { mime: "image/png", name: "x.png" }, ALICE_PRIV, { fetchImpl });

	await getOrDownloadMessageAttachment(OWNER_A, DB_KEY_A, descriptor, { serverUrl: "https://blossom.test", fetchImpl }); // первый раз — промах, наполняет кэш

	let secondCallFetchCalls = 0;
	const countingFetchImpl = async () => {
		secondCallFetchCalls++;
		throw new Error("сеть не должна вызываться на cache hit");
	};
	const bytes = await getOrDownloadMessageAttachment(OWNER_A, DB_KEY_A, descriptor, { serverUrl: "https://blossom.test", fetchImpl: countingFetchImpl });
	assert.deepEqual(bytes, original);
	assert.equal(secondCallFetchCalls, 0, "повторный запрос того же вложения обязан обслужиться из кэша");
});
