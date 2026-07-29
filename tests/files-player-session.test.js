import { test } from "node:test";
import assert from "node:assert/strict";
import { putStream, getRange } from "../src/domain/files/content.js";
import { createChunkCache } from "../src/domain/files/chunk-cache.js";
import { createPlayerSession } from "../src/domain/files/player-session.js";

const ALICE_PRIV = new Uint8Array(32).fill(1);

// Тот же фейковый Blossom, что files-content.test.js (продублирован намеренно —
// player-session.test.js не должен зависеть от порядка запуска/внутренностей
// соседнего файла теста, только от публичного content.js).
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
		const sha256HexKey = parts[parts.length - 1];
		const bytes = store.get(sha256HexKey);
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

	return { fetchImpl, store, getCalls: () => getCalls };
}

async function setupFile(fetchImpl, size, chunkSize) {
	const original = new Uint8Array(size);
	crypto.getRandomValues(original);
	const { manifest, fileKey } = await putStream(original, {
		name: "video.bin",
		mime: "video/mp4",
		chunkSize,
		serverUrl: "https://blossom.test",
		privateKey: ALICE_PRIV,
		fetchImpl,
	});
	return { original, manifest, fileKey };
}

test("readRange: побитово совпадает с прямым content.getRange на тех же входах", async () => {
	const blossom = makeFakeBlossom();
	const { original, manifest, fileKey } = await setupFile(blossom.fetchImpl, 3000, 300);

	const expected = await getRange(manifest, fileKey, 500, 900, { serverUrl: "https://blossom.test", fetchImpl: blossom.fetchImpl });

	const session = createPlayerSession({ manifest, fileKey, serverUrl: "https://blossom.test", cache: createChunkCache(10_000_000), fetchImpl: blossom.fetchImpl });
	const got = await session.readRange(500, 900);
	assert.deepEqual(got, expected);
	assert.deepEqual(got, original.subarray(500, 900));
});

test("readRange: повторный запрос ТОГО ЖЕ диапазона не бьёт в сеть повторно (кэш-попадание)", async () => {
	const blossom = makeFakeBlossom();
	const { manifest, fileKey } = await setupFile(blossom.fetchImpl, 2000, 256);
	const session = createPlayerSession({ manifest, fileKey, serverUrl: "https://blossom.test", cache: createChunkCache(10_000_000), fetchImpl: blossom.fetchImpl });

	await session.readRange(100, 300);
	const callsAfterFirst = blossom.getCalls();
	await new Promise((r) => setTimeout(r, 10)); // дать фоновому prefetch (если есть) устояться
	const callsAfterPrefetchSettle = blossom.getCalls();

	await session.readRange(100, 300); // тот же диапазон — оба чанка уже в кэше
	assert.equal(blossom.getCalls(), callsAfterPrefetchSettle, "повторный readRange не должен вызывать сеть — все нужные чанки уже в кэше");
	assert.ok(callsAfterFirst >= 1);
});

test("упреждающая подкачка: следующий чанк оказывается в кэше ПОСЛЕ разрешения readRange, не блокируя его", async () => {
	const blossom = makeFakeBlossom();
	const { manifest, fileKey } = await setupFile(blossom.fetchImpl, 3000, 256); // несколько чанков
	const cache = createChunkCache(10_000_000);
	const namespace = manifest.blobSha256;

	const session = createPlayerSession({ manifest, fileKey, serverUrl: "https://blossom.test", cache, fetchImpl: blossom.fetchImpl });

	// Первый чанк [0,256) — lastIdx=0, readRange не должен ждать prefetch чанка 1.
	const readPromise = session.readRange(0, 100);
	// Сразу после (до микротаска сети) чанк 1 ещё не обязан быть в кэше —
	// проверяем именно "не блокирует", не "мгновенно готово".
	assert.equal(cache.get(`${namespace}:1`), undefined, "readRange не должен синхронно ждать завершения prefetch");
	await readPromise;

	await new Promise((r) => setTimeout(r, 20)); // дать фоновому prefetch (fire-and-forget) осесть
	assert.notEqual(cache.get(`${namespace}:1`), undefined, "чанк 1 должен оказаться в кэше после того, как prefetch устоялся");

	// Диапазон, целиком лежащий в уже прогретом чанке 1, не должен запросить
	// СЕТЕВОЙ диапазон именно чанка 1 (bytes=272-543, cipherChunkOffset(1,256)).
	// readRange САМ каскадно запускает fire-and-forget prefetch следующего
	// чанка (bytes=544-815) — это ожидаемо и не повод для провала теста,
	// поэтому проверяем конкретный Range, не сам факт вызова fetchImpl.
	const chunk1RangeRequested = { value: false };
	const spyFetch = async (url, opts = {}) => {
		if (opts.headers?.Range === "bytes=272-543") chunk1RangeRequested.value = true;
		return blossom.fetchImpl(url, opts);
	};
	const before = cache.get(`${namespace}:1`);
	const sessionSpy = createPlayerSession({ manifest, fileKey, serverUrl: "https://blossom.test", cache, fetchImpl: spyFetch });
	await sessionSpy.readRange(256, 300);
	assert.equal(chunk1RangeRequested.value, false, "чтение уже прогретого чанка 1 не должно запрашивать его диапазон по сети повторно");
	assert.notEqual(before, undefined);
});

test("ошибка prefetch не пробрасывается наружу и не роняет основной readRange", async () => {
	const blossom = makeFakeBlossom();
	const { manifest, fileKey } = await setupFile(blossom.fetchImpl, 3000, 256);

	// fetchImpl, который рвётся на ЛЮБОМ запросе ПОСЛЕ первого успешного —
	// имитирует сбой сети именно на фоновом prefetch следующего чанка.
	let calls = 0;
	const flakyFetch = async (...args) => {
		calls++;
		if (calls > 1) throw new Error("сеть недоступна (симуляция)");
		return blossom.fetchImpl(...args);
	};

	const session = createPlayerSession({ manifest, fileKey, serverUrl: "https://blossom.test", cache: createChunkCache(10_000_000), fetchImpl: flakyFetch });

	// Основной вызов обязан УСПЕШНО завершиться, даже если фоновый prefetch
	// следующего чанка (уйдёт во ВТОРОЙ вызов flakyFetch и упадёт) — не связан с ним.
	const got = await session.readRange(0, 100);
	assert.ok(got.length === 100);

	await new Promise((r) => setTimeout(r, 20)); // дать упавшему prefetch раствориться, не должно быть unhandledRejection
});
