import "fake-indexeddb/auto";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db } from "../src/core/store/database.js";
import { uploadAttachment } from "../src/domain/attachments/upload.js";
import {
	getCachedAttachment,
	putCachedAttachment,
	evictIfNeeded,
	getOrDownloadAttachment,
} from "../src/domain/attachments/cache.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

const OWNER_A = "owner-a-pubkey";
const OWNER_B = "owner-b-pubkey";
const DB_KEY_A = crypto.getRandomValues(new Uint8Array(32));
const DB_KEY_B = crypto.getRandomValues(new Uint8Array(32));
const ALICE_PRIV = new Uint8Array(32).fill(1);

beforeEach(async () => {
	await db.table("attachments").clear();
});

function fakeResponse({ jsonBody = {}, arrayBuffer } = {}) {
	return { ok: true, status: 200, json: async () => jsonBody, text: async () => "", arrayBuffer: async () => arrayBuffer ?? new ArrayBuffer(0) };
}

function makeUploadFetch(store) {
	return async (url, opts) => {
		if (opts?.method === "PUT") {
			const body = new Uint8Array(opts.body);
			const sha256Hex = bytesToHex(sha256(body));
			store.set(sha256Hex, body);
			return fakeResponse({ jsonBody: { sha256: sha256Hex, size: body.length, type: "application/octet-stream", url: `https://blossom.test/${sha256Hex}` } });
		}
		const sha256Hex = url.split("/").pop();
		const stored = store.get(sha256Hex);
		return fakeResponse({ arrayBuffer: stored.buffer.slice(stored.byteOffset, stored.byteOffset + stored.byteLength) });
	};
}

async function backdate(ownerPubkey, sha256Hex, ageMs) {
	await db.table("attachments").update([ownerPubkey, sha256Hex], { lastAccessedAt: Date.now() - ageMs });
}

test("putCachedAttachment + getCachedAttachment: round-trip возвращает те же байты", async () => {
	const bytes = new TextEncoder().encode("картинка (условно)");
	const sha256Hex = "aaaa";
	await putCachedAttachment(OWNER_A, DB_KEY_A, sha256Hex, "image/png", bytes);
	const got = await getCachedAttachment(OWNER_A, DB_KEY_A, sha256Hex);
	assert.deepEqual(got, bytes);
});

test("getCachedAttachment: промах -> undefined, не бросает", async () => {
	const got = await getCachedAttachment(OWNER_A, DB_KEY_A, "нет-такого-хэша");
	assert.equal(got, undefined);
});

test("owner-scoping: один и тот же sha256 под разными owner не пересекается (этап 42-довесок, тот же класс бага)", async () => {
	const bytes = new TextEncoder().encode("общий файл, два разных владельца локально");
	const sha256Hex = "bbbb";
	await putCachedAttachment(OWNER_A, DB_KEY_A, sha256Hex, "image/png", bytes);
	const gotUnderB = await getCachedAttachment(OWNER_B, DB_KEY_B, sha256Hex);
	assert.equal(gotUnderB, undefined, "владелец B не должен видеть кэш владельца A под тем же sha256");
	const gotUnderA = await getCachedAttachment(OWNER_A, DB_KEY_A, sha256Hex);
	assert.deepEqual(gotUnderA, bytes, "сам владелец A по-прежнему видит свою запись");
});

test("putCachedAttachment: идемпотентна (put, не add) — повторная запись перезаписывает, не бросает", async () => {
	const sha256Hex = "cccc";
	await putCachedAttachment(OWNER_A, DB_KEY_A, sha256Hex, "image/png", new Uint8Array([1, 2, 3]));
	await assert.doesNotReject(() => putCachedAttachment(OWNER_A, DB_KEY_A, sha256Hex, "image/png", new Uint8Array([4, 5, 6])));
	const got = await getCachedAttachment(OWNER_A, DB_KEY_A, sha256Hex);
	assert.deepEqual(got, new Uint8Array([4, 5, 6]));
});

test("evictIfNeeded: протухшая по TTL строка удаляется", async () => {
	await putCachedAttachment(OWNER_A, DB_KEY_A, "old", "image/png", new Uint8Array([1]));
	await backdate(OWNER_A, "old", 10_000);
	await evictIfNeeded(OWNER_A, { budgetBytes: 1_000_000, ttlMs: 5_000 });
	assert.equal(await getCachedAttachment(OWNER_A, DB_KEY_A, "old"), undefined);
});

test("evictIfNeeded: свежая строка НЕ удаляется по TTL", async () => {
	await putCachedAttachment(OWNER_A, DB_KEY_A, "fresh", "image/png", new Uint8Array([1]));
	await evictIfNeeded(OWNER_A, { budgetBytes: 1_000_000, ttlMs: 5_000 });
	assert.notEqual(await getCachedAttachment(OWNER_A, DB_KEY_A, "fresh"), undefined);
});

test("evictIfNeeded: превышение бюджета — вытесняет САМЫЕ СТАРЫЕ по lastAccessedAt первыми, пока не уложится", async () => {
	await putCachedAttachment(OWNER_A, DB_KEY_A, "s1", "image/png", new Uint8Array(40));
	await putCachedAttachment(OWNER_A, DB_KEY_A, "s2", "image/png", new Uint8Array(40));
	await putCachedAttachment(OWNER_A, DB_KEY_A, "s3", "image/png", new Uint8Array(40));
	// s1 — самая старая (записана первой, backdate дополнительно подчёркивает порядок).
	await backdate(OWNER_A, "s1", 3000);
	await backdate(OWNER_A, "s2", 2000);
	await backdate(OWNER_A, "s3", 1000);

	await evictIfNeeded(OWNER_A, { budgetBytes: 90, ttlMs: 1_000_000 }); // суммарно 120 > 90 -> одна строка должна уйти

	assert.equal(await getCachedAttachment(OWNER_A, DB_KEY_A, "s1"), undefined, "самая старая (s1) вытесняется первой");
	assert.notEqual(await getCachedAttachment(OWNER_A, DB_KEY_A, "s2"), undefined);
	assert.notEqual(await getCachedAttachment(OWNER_A, DB_KEY_A, "s3"), undefined);
});

test("getCachedAttachment: touch на чтении продлевает жизнь строки при последующем LRU-вытеснении", async () => {
	await putCachedAttachment(OWNER_A, DB_KEY_A, "s1", "image/png", new Uint8Array(40));
	await putCachedAttachment(OWNER_A, DB_KEY_A, "s2", "image/png", new Uint8Array(40));
	await backdate(OWNER_A, "s1", 3000);
	await backdate(OWNER_A, "s2", 2000);

	// Обращаемся к s1 (самой старой) — это должно обновить её lastAccessedAt на "сейчас",
	// сделав её теперь САМОЙ СВЕЖЕЙ, а не самой старой.
	await getCachedAttachment(OWNER_A, DB_KEY_A, "s1");

	await putCachedAttachment(OWNER_A, DB_KEY_A, "s3", "image/png", new Uint8Array(40)); // суммарно 120 > budget 90 ниже

	await evictIfNeeded(OWNER_A, { budgetBytes: 90, ttlMs: 1_000_000 });

	assert.equal(await getCachedAttachment(OWNER_A, DB_KEY_A, "s2"), undefined, "s2 теперь самая старая (не тронута touch'ем) — вытесняется");
	assert.notEqual(await getCachedAttachment(OWNER_A, DB_KEY_A, "s1"), undefined, "s1 пережила вытеснение благодаря touch на чтении");
});

test("putCachedAttachment + getCachedAttachment: реалистичный размер вложения (2 МБ) — не бросает RangeError (найдено ревью: JSON/base64-путь через toEncryptedRow ломался уже на этом размере, лимиты вложений до 50 МБ, F-AT-04)", async () => {
	const bytes = new Uint8Array(2 * 1024 * 1024).map((_, i) => i % 256); // getRandomValues лимитирован 64 КБ/вызов, детерминированное заполнение достаточно
	await putCachedAttachment(OWNER_A, DB_KEY_A, "big-realistic", "image/jpeg", bytes);
	const got = await getCachedAttachment(OWNER_A, DB_KEY_A, "big-realistic");
	assert.deepEqual(got, bytes);
});

test("evictIfNeeded: одна строка больше бюджета сама по себе — не падает, самовытесняется", async () => {
	await putCachedAttachment(OWNER_A, DB_KEY_A, "huge", "video/mp4", new Uint8Array(120), { budgetBytes: 90, ttlMs: 1_000_000 });
	assert.equal(await getCachedAttachment(OWNER_A, DB_KEY_A, "huge"), undefined);
});

test("getOrDownloadAttachment: промах кэша — скачивает через сеть и сохраняет в кэш", async () => {
	const store = new Map();
	let fetchCalls = 0;
	const fetchImpl = async (url, opts) => {
		fetchCalls++;
		return makeUploadFetch(store)(url, opts);
	};
	const original = new TextEncoder().encode("вложение для getOrDownloadAttachment");
	const descriptor = await uploadAttachment("https://blossom.test", original, { mime: "image/png", name: "x.png" }, ALICE_PRIV, { fetchImpl });

	fetchCalls = 0; // считаем только вызовы ВНУТРИ getOrDownloadAttachment
	const bytes = await getOrDownloadAttachment(OWNER_A, DB_KEY_A, descriptor, { fetchImpl });
	assert.deepEqual(bytes, original);
	assert.equal(fetchCalls, 1, "промах кэша обязан сходить в сеть ровно один раз");

	const cached = await getCachedAttachment(OWNER_A, DB_KEY_A, descriptor.sha256);
	assert.deepEqual(cached, original, "результат сети должен осесть в локальном кэше");
});

test("getOrDownloadAttachment: попадание в кэш — сеть НЕ вызывается повторно", async () => {
	const store = new Map();
	const fetchImpl = makeUploadFetch(store);
	const original = new TextEncoder().encode("вложение, которое уже видели");
	const descriptor = await uploadAttachment("https://blossom.test", original, { mime: "image/png", name: "x.png" }, ALICE_PRIV, { fetchImpl });

	await getOrDownloadAttachment(OWNER_A, DB_KEY_A, descriptor, { fetchImpl }); // первый раз — промах, наполняет кэш

	let secondCallFetchCalls = 0;
	const countingFetchImpl = async () => {
		secondCallFetchCalls++;
		throw new Error("сеть не должна вызываться на cache hit");
	};
	const bytes = await getOrDownloadAttachment(OWNER_A, DB_KEY_A, descriptor, { fetchImpl: countingFetchImpl });
	assert.deepEqual(bytes, original);
	assert.equal(secondCallFetchCalls, 0, "повторный запрос того же вложения обязан обслужиться из кэша");
});
