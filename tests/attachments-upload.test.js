import { test } from "node:test";
import assert from "node:assert/strict";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { getPublicKey } from "../src/core/crypto/keys.js";
import { uploadAttachment, downloadAttachment } from "../src/domain/attachments/upload.js";

const ALICE_PRIV = new Uint8Array(32).fill(1);

function fakeResponse({ ok = true, status = 200, jsonBody = {}, arrayBuffer } = {}) {
	return { ok, status, json: async () => jsonBody, text: async () => "", arrayBuffer: async () => arrayBuffer ?? new ArrayBuffer(0) };
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

test("uploadAttachment: валидирует ДО шифрования/сети — недопустимый MIME не вызывает fetch вовсе", async () => {
	let called = false;
	const fetchImpl = async () => {
		called = true;
		return fakeResponse();
	};
	await assert.rejects(
		() => uploadAttachment("https://blossom.test", new Uint8Array([1, 2, 3]), { mime: "application/x-msdownload", name: "virus.exe" }, ALICE_PRIV, { fetchImpl }),
		/тип/,
	);
	assert.equal(called, false, "validateAttachment должен отклонить ДО сетевого вызова");
});

test("uploadAttachment: превышение размера -> throw, fetch не вызывается", async () => {
	let called = false;
	const fetchImpl = async () => {
		called = true;
		return fakeResponse();
	};
	const big = new Uint8Array(25 * 1024 * 1024);
	await assert.rejects(() => uploadAttachment("https://blossom.test", big, { mime: "image/jpeg", name: "big.jpg" }, ALICE_PRIV, { fetchImpl }));
	assert.equal(called, false);
});

test("uploadAttachment: шифрует файл перед отправкой (сервер не получает исходные байты)", async () => {
	const store = new Map();
	let sentBody;
	const fetchImpl = async (url, opts) => {
		sentBody = opts.body;
		return makeUploadFetch(store)(url, opts);
	};
	const original = new TextEncoder().encode("секретное содержимое файла");
	await uploadAttachment("https://blossom.test", original, { mime: "image/png", name: "secret.png" }, ALICE_PRIV, { fetchImpl });

	assert.notDeepEqual(new Uint8Array(sentBody), original, "на сервер должен уйти ШИФРОТЕКСТ, не оригинал");
});

test("uploadAttachment: дескриптор — буквально поля F-AT-02 (CONTRACTS.md, этап 28)", async () => {
	const store = new Map();
	const fetchImpl = makeUploadFetch(store);
	const original = new TextEncoder().encode("картинка (условно)");
	const descriptor = await uploadAttachment("https://blossom.test", original, { mime: "image/jpeg", name: "photo.jpg" }, ALICE_PRIV, { fetchImpl });

	assert.equal(descriptor.type, "image");
	assert.equal(descriptor.mime, "image/jpeg");
	assert.equal(descriptor.name, "photo.jpg");
	assert.equal(descriptor.blossomUrl, "https://blossom.test", "БАЗОВЫЙ URL сервера, не response.url целиком");
	assert.equal(typeof descriptor.sha256, "string");
	assert.equal(typeof descriptor.size, "number");
	assert.doesNotThrow(() => atob(descriptor.encryptionKey), "encryptionKey — валидный base64 (F-AT-02)");
	assert.equal(atob(descriptor.encryptionKey).length, 32, "ключ ChaCha20-Poly1305 — 32 байта");
});

test("type определяется по префиксу mime: video/audio/file", async () => {
	const store = new Map();
	const fetchImpl = makeUploadFetch(store);
	const bytes = new Uint8Array([1, 2, 3, 4]);
	const video = await uploadAttachment("https://blossom.test", bytes, { mime: "video/mp4", name: "v.mp4" }, ALICE_PRIV, { fetchImpl });
	const audio = await uploadAttachment("https://blossom.test", bytes, { mime: "audio/ogg", name: "a.ogg" }, ALICE_PRIV, { fetchImpl });
	const file = await uploadAttachment("https://blossom.test", bytes, { mime: "application/pdf", name: "doc.pdf" }, ALICE_PRIV, { fetchImpl });
	assert.equal(video.type, "video");
	assert.equal(audio.type, "audio");
	assert.equal(file.type, "file");
});

test("downloadAttachment: полный round-trip даёт исходные байты обратно", async () => {
	const store = new Map();
	const fetchImpl = makeUploadFetch(store);
	const original = new TextEncoder().encode("содержимое для полного цикла загрузка->скачивание");
	const descriptor = await uploadAttachment("https://blossom.test", original, { mime: "image/png", name: "x.png" }, ALICE_PRIV, { fetchImpl });

	const downloaded = await downloadAttachment(descriptor, { fetchImpl });
	assert.deepEqual(downloaded, original);
});

test("downloadAttachment: сервер вернул ПОДМЕНЁННЫЕ данные — sha256-проверка отклоняет (найдено design-фазой)", async () => {
	const store = new Map();
	const fetchImpl = makeUploadFetch(store);
	const original = new TextEncoder().encode("оригинальное содержимое");
	const descriptor = await uploadAttachment("https://blossom.test", original, { mime: "image/png", name: "x.png" }, ALICE_PRIV, { fetchImpl });

	// Подменяем контент в "хранилище" сервера, будто он скомпрометирован/отдаёт не то.
	const [storedKey] = store.keys();
	store.set(storedKey, new TextEncoder().encode("подменённые байты той же или другой длины!!"));

	await assert.rejects(() => downloadAttachment(descriptor, { fetchImpl }), /sha256|подмен|целостност/i);
});
