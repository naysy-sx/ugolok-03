import { test } from "node:test";
import assert from "node:assert/strict";
import { generateFileKey, encryptChunk, decryptChunk, deriveChunkNonce } from "../src/domain/files/crypto.js";
import { putStream, getManifest, getRange, getChunk, DEFAULT_CHUNK_SIZE } from "../src/domain/files/content.js";

const ALICE_PRIV = new Uint8Array(32).fill(1);

// Фейковый Blossom с поддержкой Range — тот же приём, что
// attachments-upload.test.js's makeUploadFetch, расширенный.
function makeFakeBlossom() {
	const store = new Map();
	const fetchImpl = async (url, opts = {}) => {
		if (opts.method === "PUT") {
			const body = new Uint8Array(opts.body);
			// sha256 из тега 'x' auth-события — совпадает с тем, что реально
			// передаётся телом (blossom-client.js это не проверяет само, но нам
			// достаточно ключа URL, извлечём из АВТОРИЗАЦИИ по факту хранения тела).
			const key = url.split("/").pop(); // upload URL сам не несёт digest — используем ПОРЯДОК: uploadBlob кладёт по вычисленному вызывающей стороной digest'у через content.js -> body сам себе digest не назначает, поэтому индексируем по фактическому содержимому.
			return { ok: true, status: 200, json: async () => ({ sha256: await sha256Hex(body), size: body.length }), text: async () => "" };
		}
		const parts = url.split("/");
		const sha256Hex = parts[parts.length - 1];
		const bytes = store.get(sha256Hex);
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

	async function sha256Hex(bytes) {
		const { sha256 } = await import("@noble/hashes/sha2.js");
		const { bytesToHex } = await import("@noble/hashes/utils.js");
		return bytesToHex(sha256(bytes));
	}

	// putStream вычисляет digest САМ (для авторизации PUT) и передаёт его как
	// sha256Hex в uploadBlob -> тот кладёт его в тег 'x' и URL "/upload" (не по
	// digest'у) — реальное хранение по digest'у делает ТОЛЬКО настоящий сервер.
	// Здесь эмулируем, перехватывая PUT и вычисляя digest тела САМИ, чтобы GET
	// по этому digest'у потом находил то же самое (сервер — источник истины по
	// факту сохранённого, ровно как в attachments-upload.test.js).
	const realFetch = async (url, opts = {}) => {
		if (opts.method === "PUT") {
			const body = new Uint8Array(opts.body);
			const digest = await sha256Hex(body);
			store.set(digest, body);
			return { ok: true, status: 200, json: async () => ({ sha256: digest, size: body.length }), text: async () => "" };
		}
		return fetchImpl(url, opts);
	};

	return { fetchImpl: realFetch, store };
}

test("putStream/getRange: round-trip — диапазон из СЕРЕДИНЫ файла совпадает с оригиналом (П-4/задача 2.5)", async () => {
	const { fetchImpl } = makeFakeBlossom();
	const original = new Uint8Array(5000);
	for (let i = 0; i < original.length; i++) original[i] = i % 256;

	const { manifest, fileKey } = await putStream(original, { name: "test.bin", mime: "application/octet-stream", chunkSize: 512, serverUrl: "https://blossom.test", privateKey: ALICE_PRIV, fetchImpl });

	const got = await getRange(manifest, fileKey, 1200, 1250, { serverUrl: "https://blossom.test", fetchImpl });
	assert.deepEqual(got, original.subarray(1200, 1250));
});

test("putStream/getRange: диапазон через ГРАНИЦУ чанка (учитывает 16-байтный AEAD-тег на чанк)", async () => {
	const { fetchImpl } = makeFakeBlossom();
	const original = new Uint8Array(2000);
	crypto.getRandomValues(original);

	const { manifest, fileKey } = await putStream(original, { name: "x", mime: "application/octet-stream", chunkSize: 256, serverUrl: "https://blossom.test", privateKey: ALICE_PRIV, fetchImpl });

	// [200, 400) пересекает чанк0 [0,256) и чанк1 [256,512).
	const got = await getRange(manifest, fileKey, 200, 400, { serverUrl: "https://blossom.test", fetchImpl });
	assert.deepEqual(got, original.subarray(200, 400));
});

test("putStream/getRange: ВЕСЬ файл целиком, разбитый на много чанков", async () => {
	const { fetchImpl } = makeFakeBlossom();
	const original = new Uint8Array(3000);
	crypto.getRandomValues(original);

	const { manifest, fileKey } = await putStream(original, { name: "x", mime: "application/octet-stream", chunkSize: 300, serverUrl: "https://blossom.test", privateKey: ALICE_PRIV, fetchImpl });

	const got = await getRange(manifest, fileKey, 0, original.length, { serverUrl: "https://blossom.test", fetchImpl });
	assert.deepEqual(got, original);
});

test("putStream: манифест содержит по одному дайджесту НА КАЖДЫЙ чанк, keyId не содержит сырой ключ", async () => {
	const { fetchImpl } = makeFakeBlossom();
	const original = new Uint8Array(1000);
	const { manifest, fileKey } = await putStream(original, { name: "x", mime: "text/plain", chunkSize: 300, serverUrl: "https://blossom.test", privateKey: ALICE_PRIV, fetchImpl });

	assert.equal(manifest.chunks.length, 4); // ceil(1000/300)
	assert.equal(manifest.size, 1000);
	assert.notEqual(manifest.keyId, Buffer.from(fileKey).toString("hex"), "keyId — непрозрачная ссылка, не сам ключ");
});

test("putStream: fileKey-оверрайд используется ВМЕСТО случайного (этап 53 И6, задача 6.6b — файлы доли шифруются производным ключом)", async () => {
	const { fetchImpl } = makeFakeBlossom();
	const original = new Uint8Array(2000);
	crypto.getRandomValues(original);
	const overrideKey = crypto.getRandomValues(new Uint8Array(32));

	const { manifest, fileKey } = await putStream(original, { name: "x", mime: "application/octet-stream", chunkSize: 400, serverUrl: "https://blossom.test", privateKey: ALICE_PRIV, fetchImpl, fileKey: overrideKey });

	assert.deepEqual(fileKey, overrideKey, "putStream возвращает ИМЕННО переданный ключ, не подменяет его");
	const got = await getRange(manifest, overrideKey, 0, original.length, { serverUrl: "https://blossom.test", fetchImpl });
	assert.deepEqual(got, original, "содержимое реально зашифровано ПЕРЕДАННЫМ ключом, не случайным");
});

test("putStream: signal.abort() ДО начала — прерывает немедленно, ни одного байта не уходит на сервер (§7 TASK.md — отмена загрузки)", async () => {
	const { fetchImpl, store } = makeFakeBlossom();
	const original = new Uint8Array(2000);
	const controller = new AbortController();
	controller.abort();

	await assert.rejects(
		() => putStream(original, { name: "x", mime: "text/plain", chunkSize: 300, serverUrl: "https://blossom.test", privateKey: ALICE_PRIV, fetchImpl, signal: controller.signal }),
		(err) => err.name === "AbortError",
	);
	assert.equal(store.size, 0, "ничего не залито — отмена сработала до первого чанка");
});

test("putStream: signal.abort() ПОСЛЕ нескольких чанков — прерывает на границе чанка, вызывает onProgress только до этого момента", async () => {
	const { fetchImpl } = makeFakeBlossom();
	const original = new Uint8Array(2000);
	const controller = new AbortController();
	const progressCalls = [];

	await assert.rejects(
		() =>
			putStream(original, {
				name: "x",
				mime: "text/plain",
				chunkSize: 300,
				serverUrl: "https://blossom.test",
				privateKey: ALICE_PRIV,
				fetchImpl,
				signal: controller.signal,
				onProgress: (p) => {
					progressCalls.push(p);
					if (p.chunksDone === 2) controller.abort();
				},
			}),
		(err) => err.name === "AbortError",
	);
	assert.equal(progressCalls.length, 2, "остановилось сразу после 2-го чанка, не дошло до конца (7 чанков всего)");
});

test("getManifest: подменённый манифест на сервере — отклонён по digest (тот же приём, что downloadAttachment)", async () => {
	const { fetchImpl, store } = makeFakeBlossom();
	const original = new Uint8Array(500);
	const { manifestDigest } = await putStream(original, { name: "x", mime: "text/plain", chunkSize: 256, serverUrl: "https://blossom.test", privateKey: ALICE_PRIV, fetchImpl });

	store.set(manifestDigest, new TextEncoder().encode('{"подменено":true}'));
	await assert.rejects(() => getManifest(manifestDigest, { serverUrl: "https://blossom.test", fetchImpl }), /подмен|digest/i);
});

test("getRange: подменённый чанк на сервере — отклонён по digest, не расшифровывается молча", async () => {
	const { fetchImpl, store } = makeFakeBlossom();
	const original = new Uint8Array(1000);
	crypto.getRandomValues(original);
	const { manifest, fileKey } = await putStream(original, { name: "x", mime: "application/octet-stream", chunkSize: 256, serverUrl: "https://blossom.test", privateKey: ALICE_PRIV, fetchImpl });

	// Портим байты блоба файла целиком (первый байт) — чанк 0 перестаёт совпадать с manifest.chunks[0].
	const stored = store.get(manifest.blobSha256);
	const corrupted = stored.slice();
	corrupted[0] ^= 0xff;
	store.set(manifest.blobSha256, corrupted);

	await assert.rejects(() => getRange(manifest, fileKey, 0, 10, { serverUrl: "https://blossom.test", fetchImpl }), /подмен|digest/i);
});

test("I-CHUNK-INDEP: каждый чанк расшифровывается НЕЗАВИСИМО от остальных (crypto.js)", () => {
	const key = generateFileKey();
	const chunkA = new TextEncoder().encode("чанк ноль");
	const chunkB = new TextEncoder().encode("чанк один, другой текст");
	const cipherA = encryptChunk(chunkA, key, 0);
	const cipherB = encryptChunk(chunkB, key, 1);

	// Расшифровка B НЕ требует наличия/расшифровки A — разный порядок вызовов
	// даёт тот же результат (независимость, не последовательная цепочка).
	assert.deepEqual(decryptChunk(cipherB, key, 1), chunkB);
	assert.deepEqual(decryptChunk(cipherA, key, 0), chunkA);

	// Разные индексы -> разные nonce -> разный шифротекст для ОДНОГО и того же
	// plaintext под одним и тем же ключом (иначе пара key/nonce повторилась бы).
	const same = encryptChunk(chunkA, key, 5);
	assert.notDeepEqual(same, encryptChunk(chunkA, key, 0));
});

test("deriveChunkNonce: детерминирован, различается по индексу", () => {
	assert.deepEqual(deriveChunkNonce(7), deriveChunkNonce(7));
	assert.notDeepEqual(deriveChunkNonce(7), deriveChunkNonce(8));
});

test("DEFAULT_CHUNK_SIZE — 256 КБ (ALGO.MD §9.2, компромисс до замера)", () => {
	assert.equal(DEFAULT_CHUNK_SIZE, 256 * 1024);
});

test("getChunk: чанк ЦЕЛИКОМ (не диапазон) совпадает с соответствующим срезом оригинала (этап 53 И4, задача 4.3)", async () => {
	const { fetchImpl } = makeFakeBlossom();
	const original = new Uint8Array(1000);
	crypto.getRandomValues(original);
	const { manifest, fileKey } = await putStream(original, { name: "x", mime: "application/octet-stream", chunkSize: 300, serverUrl: "https://blossom.test", privateKey: ALICE_PRIV, fetchImpl });

	// ceil(1000/300) = 4 чанка: [0,300) [300,600) [600,900) [900,1000) — последний короче.
	const chunk0 = await getChunk(manifest, fileKey, 0, { serverUrl: "https://blossom.test", fetchImpl });
	assert.deepEqual(chunk0, original.subarray(0, 300));
	const lastChunk = await getChunk(manifest, fileKey, 3, { serverUrl: "https://blossom.test", fetchImpl });
	assert.deepEqual(lastChunk, original.subarray(900, 1000));
});

test("getChunk: подменённый чанк на сервере — отклонён по digest, та же проверка, что getRange", async () => {
	const { fetchImpl, store } = makeFakeBlossom();
	const original = new Uint8Array(600);
	crypto.getRandomValues(original);
	const { manifest, fileKey } = await putStream(original, { name: "x", mime: "application/octet-stream", chunkSize: 256, serverUrl: "https://blossom.test", privateKey: ALICE_PRIV, fetchImpl });

	const stored = store.get(manifest.blobSha256);
	const corrupted = stored.slice();
	corrupted[0] ^= 0xff;
	store.set(manifest.blobSha256, corrupted);

	await assert.rejects(() => getChunk(manifest, fileKey, 0, { serverUrl: "https://blossom.test", fetchImpl }), /подмен|digest/i);
});

test("getRange поверх getChunk: результат ИДЕНТИЧЕН прямой конкатенации getChunk по вычисленным границам (регрессия рефакторинга)", async () => {
	const { fetchImpl } = makeFakeBlossom();
	const original = new Uint8Array(2000);
	crypto.getRandomValues(original);
	const { manifest, fileKey } = await putStream(original, { name: "x", mime: "application/octet-stream", chunkSize: 256, serverUrl: "https://blossom.test", privateKey: ALICE_PRIV, fetchImpl });

	const viaRange = await getRange(manifest, fileKey, 200, 400, { serverUrl: "https://blossom.test", fetchImpl });
	const chunk0 = await getChunk(manifest, fileKey, 0, { serverUrl: "https://blossom.test", fetchImpl });
	const chunk1 = await getChunk(manifest, fileKey, 1, { serverUrl: "https://blossom.test", fetchImpl });
	const manual = new Uint8Array([...chunk0, ...chunk1]).subarray(200, 400);
	assert.deepEqual(viaRange, manual);
});
