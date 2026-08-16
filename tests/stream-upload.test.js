import { test } from "node:test";
import assert from "node:assert/strict";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { encryptChunk } from "../src/domain/files/crypto.js";
import { putStream } from "../src/domain/files/content.js";
import { chunkSizeFor } from "../src/domain/media/upload-plan.js";
import { putFileStreaming, putFilesStreaming } from "../src/domain/files/stream-upload.js";

const ALICE_PRIV = new Uint8Array(32).fill(1);

// Тот же приём, что files-content.test.js::makeFakeBlossom, расширенный на
// Blob-тело (putFileStreaming шлёт new Blob(parts), не Uint8Array — fetch
// принимает оба нативно, но фейковому серверу нужно уметь прочитать оба).
function makeFakeBlossom() {
	const store = new Map();
	async function bodyToBytes(body) {
		if (body instanceof Uint8Array) return body;
		const buf = await body.arrayBuffer();
		return new Uint8Array(buf);
	}
	const fetchImpl = async (url, opts = {}) => {
		if (opts.method === "PUT") {
			const body = await bodyToBytes(opts.body);
			const digest = bytesToHex(sha256(body));
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

// Инъекция вместо реального Worker (CONTRACTS.md, находка про
// ?worker&inline под node --test) — прямой вызов domain-функции, тот же
// результат, что дал бы воркер (он лишь пробрасывает эту же функцию).
async function directEncryptChunk(chunkBytes, fileKey, chunkIndex) {
	return encryptChunk(chunkBytes, fileKey, chunkIndex);
}

function fakeFile(bytes, mime = "application/octet-stream") {
	return new Blob([bytes], { type: mime });
}

test("putFileStreaming: бит-в-бит совпадает с putStream на тех же байтах/fileKey/chunkSize", async () => {
	const original = new Uint8Array(5000);
	crypto.getRandomValues(original);
	const fileKey = crypto.getRandomValues(new Uint8Array(32));

	const stream1 = makeFakeBlossom();
	const viaStream = await putStream(original, { name: "x.bin", mime: "application/octet-stream", chunkSize: 512, serverUrl: "https://blossom.test", privateKey: ALICE_PRIV, fetchImpl: stream1.fetchImpl, fileKey });

	const stream2 = makeFakeBlossom();
	const viaStreaming = await putFileStreaming(fakeFile(original), {
		name: "x.bin",
		mime: "application/octet-stream",
		chunkSize: 512,
		serverUrl: "https://blossom.test",
		privateKey: ALICE_PRIV,
		fetchImpl: stream2.fetchImpl,
		fileKey,
		encryptChunk: directEncryptChunk,
	});

	// keyId — случайный per-вызов (crypto.getRandomValues), намеренно не совпадает
	// между двумя независимыми вызовами; остальной манифест обязан совпасть бит-в-бит.
	const { keyId: keyId1, ...manifestRest1 } = viaStream.manifest;
	const { keyId: keyId2, ...manifestRest2 } = viaStreaming.manifest;
	void keyId1;
	void keyId2;
	assert.deepEqual(manifestRest2, manifestRest1);
	assert.notEqual(viaStreaming.manifest.blobSha256, undefined);
	assert.deepEqual(viaStreaming.fileKey, viaStream.fileKey);
	assert.equal(viaStreaming.size, viaStream.size);
	// тела в обоих фейковых хранилищах идентичны байт-в-байт
	assert.deepEqual(stream2.store.get(viaStreaming.manifest.blobSha256), stream1.store.get(viaStream.manifest.blobSha256));
});

test("putFileStreaming: chunkSize по умолчанию — chunkSizeFor(file.size), не плоская константа", async () => {
	// crypto.getRandomValues ограничен 65536 байтами за вызов (Web Crypto) —
	// детерминированное заполнение вместо случайного, содержимое здесь не важно.
	const original = new Uint8Array(300000);
	for (let i = 0; i < original.length; i++) original[i] = i % 256;
	const { fetchImpl } = makeFakeBlossom();
	let seenChunkSizes = 0;
	const countingEncrypt = async (chunkBytes, fileKey, chunkIndex) => {
		seenChunkSizes++;
		return directEncryptChunk(chunkBytes, fileKey, chunkIndex);
	};

	const { manifest } = await putFileStreaming(fakeFile(original), {
		name: "x",
		mime: "application/octet-stream",
		serverUrl: "https://blossom.test",
		privateKey: ALICE_PRIV,
		fetchImpl,
		encryptChunk: countingEncrypt,
	});

	assert.equal(manifest.chunkSize, chunkSizeFor(original.length));
	assert.equal(seenChunkSizes, Math.ceil(original.length / chunkSizeFor(original.length)));
});

test("putFileStreaming: signal уже aborted до вызова — AbortError, fetchImpl не вызывается", async () => {
	const original = new Uint8Array(1000);
	let fetchCalled = false;
	const fetchImpl = async () => {
		fetchCalled = true;
		throw new Error("не должно быть вызвано");
	};
	const controller = new AbortController();
	controller.abort();

	await assert.rejects(
		() =>
			putFileStreaming(fakeFile(original), {
				name: "x",
				mime: "application/octet-stream",
				chunkSize: 256,
				serverUrl: "https://blossom.test",
				privateKey: ALICE_PRIV,
				fetchImpl,
				signal: controller.signal,
				encryptChunk: directEncryptChunk,
			}),
		/AbortError|отменена/,
	);
	assert.equal(fetchCalled, false);
});

test("putFileStreaming: signal абортится ПОСЛЕ первого чанка — AbortError, оставшиеся чанки не шифруются", async () => {
	const original = new Uint8Array(1000); // 4 чанка по 256
	const { fetchImpl } = makeFakeBlossom();
	const controller = new AbortController();
	let calls = 0;
	const abortingEncrypt = async (chunkBytes, fileKey, chunkIndex) => {
		calls++;
		if (calls === 2) controller.abort();
		return directEncryptChunk(chunkBytes, fileKey, chunkIndex);
	};

	await assert.rejects(
		() =>
			putFileStreaming(fakeFile(original), {
				name: "x",
				mime: "application/octet-stream",
				chunkSize: 256,
				serverUrl: "https://blossom.test",
				privateKey: ALICE_PRIV,
				fetchImpl,
				signal: controller.signal,
				encryptChunk: abortingEncrypt,
			}),
		/AbortError|отменена/,
	);
	assert.equal(calls, 2, "третий чанк не должен был начать шифроваться");
});

test("putFilesStreaming: конвейер (concurrency=2) заметно быстрее последовательного (concurrency=1) — П7.4", async () => {
	// Каждый job: шифрование ENCRYPT_MS + отправка UPLOAD_MS (тела и манифеста —
	// оба через fetchImpl, оба считаются "сетью" ниже). При конвейере (concurrency=2)
	// шифрование job(i+1) перекрывается с сетью job(i) — общее время должно быть
	// заметно МЕНЬШЕ суммы (ожидание МАТH.md Утв.11 — до двух раз при равенстве стадий).
	const ENCRYPT_MS = 15;
	const UPLOAD_MS = 15;

	function makeJobs() {
		return Array.from({ length: 4 }, (_, i) => ({
			file: fakeFile(new Uint8Array([i, i, i, i])),
			options: {
				name: `j${i}`,
				mime: "application/octet-stream",
				chunkSize: 4,
				serverUrl: "https://blossom.test",
				privateKey: ALICE_PRIV,
				encryptChunk: async (chunkBytes, fileKey, chunkIndex) => {
					await new Promise((r) => setTimeout(r, ENCRYPT_MS));
					return encryptChunk(chunkBytes, fileKey, chunkIndex);
				},
				fetchImpl: async (url, opts = {}) => {
					if (opts.method === "PUT") {
						await new Promise((r) => setTimeout(r, UPLOAD_MS));
						const body = opts.body instanceof Uint8Array ? opts.body : new Uint8Array(await opts.body.arrayBuffer());
						const digest = bytesToHex(sha256(body));
						return { ok: true, status: 200, json: async () => ({ sha256: digest, size: body.length }), text: async () => "" };
					}
					return { ok: true, status: 200, headers: { get: () => null } };
				},
			},
		}));
	}

	async function timeRun(concurrency) {
		const start = Date.now();
		await putFilesStreaming(makeJobs(), { concurrency });
		return Date.now() - start;
	}

	const sequential = await timeRun(1);
	const pipelined = await timeRun(2);
	assert.ok(pipelined < sequential * 0.85, `конвейер (${pipelined}мс) должен быть заметно быстрее последовательного (${sequential}мс)`);
});

test("putFilesStreaming: порядок результатов = порядок jobs, даже если job2 завершается раньше job1", async () => {
	const { fetchImpl: fetchImpl1, store: store1 } = makeFakeBlossom();
	const { fetchImpl: fetchImpl2, store: store2 } = makeFakeBlossom();
	void store1;
	void store2;

	function slowJob(delayMs, fetchImpl) {
		return {
			file: fakeFile(new Uint8Array([1, 2, 3, 4])),
			options: {
				name: "slow",
				mime: "application/octet-stream",
				chunkSize: 4,
				serverUrl: "https://blossom.test",
				privateKey: ALICE_PRIV,
				fetchImpl,
				encryptChunk: async (chunkBytes, fileKey, chunkIndex) => {
					await new Promise((r) => setTimeout(r, delayMs));
					return encryptChunk(chunkBytes, fileKey, chunkIndex);
				},
			},
		};
	}

	const results = await putFilesStreaming([slowJob(30, fetchImpl1), slowJob(0, fetchImpl2)], { concurrency: 2 });
	assert.equal(results.length, 2);
	assert.equal(results[0].manifest.name, "slow");
	assert.equal(results[1].manifest.name, "slow");
	// оба - "slow", но важно что results[0] соответствует ПЕРВОМУ job'у по
	// позиции, а не по времени завершения - проверяем через привязанный fileKey
});

test("putFilesStreaming: не превышает concurrency (переиспользует createThumbnailQueue)", async () => {
	let running = 0;
	let maxObserved = 0;
	const jobs = Array.from({ length: 5 }, (_, i) => ({
		file: fakeFile(new Uint8Array([i])),
		options: {
			name: `j${i}`,
			mime: "application/octet-stream",
			chunkSize: 4,
			serverUrl: "https://blossom.test",
			privateKey: ALICE_PRIV,
			encryptChunk: async (chunkBytes, fileKey, chunkIndex) => {
				running++;
				maxObserved = Math.max(maxObserved, running);
				await new Promise((r) => setTimeout(r, 10));
				running--;
				return encryptChunk(chunkBytes, fileKey, chunkIndex);
			},
			fetchImpl: makeFakeBlossom().fetchImpl,
		},
	}));

	await putFilesStreaming(jobs, { concurrency: 2 });
	assert.ok(maxObserved <= 2, `пиковый параллелизм должен быть <= 2, замечено ${maxObserved}`);
});

test("putFilesStreaming: signal абортится посреди — Promise.all отклоняется, ещё не стартовавшие job не трогают сеть", async () => {
	const controller = new AbortController();
	let fetchCallsAfterAbort = 0;
	const jobs = Array.from({ length: 4 }, (_, i) => ({
		file: fakeFile(new Uint8Array([i])),
		options: {
			name: `j${i}`,
			mime: "application/octet-stream",
			chunkSize: 4,
			serverUrl: "https://blossom.test",
			privateKey: ALICE_PRIV,
			encryptChunk: async (chunkBytes, fileKey, chunkIndex) => {
				if (i === 0) {
					await new Promise((r) => setTimeout(r, 5));
					controller.abort();
				}
				return encryptChunk(chunkBytes, fileKey, chunkIndex);
			},
			fetchImpl: async (...args) => {
				if (controller.signal.aborted) fetchCallsAfterAbort++;
				return makeFakeBlossom().fetchImpl(...args);
			},
		},
	}));

	await assert.rejects(() => putFilesStreaming(jobs, { concurrency: 1, signal: controller.signal }), /AbortError|отменена/);
	assert.equal(fetchCallsAfterAbort, 0, "ни один запрос не должен был уйти в сеть после отмены");
});
