import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { getPublicKey } from "../src/core/crypto/keys.js";
import { verify } from "../src/core/crypto/sign.js";
import { uploadBlob, downloadBlob, deleteBlob, checkBlossomReachable, checkUploadRequirements } from "../src/core/transport/blossom-client.js";

const ALICE_PRIV = new Uint8Array(32).fill(1);
const ALICE_PUB = bytesToHex(getPublicKey(ALICE_PRIV));

function fakeResponse({ ok = true, status = 200, jsonBody = {}, textBody = "", arrayBuffer } = {}) {
	return {
		ok,
		status,
		json: async () => jsonBody,
		text: async () => textBody,
		arrayBuffer: async () => arrayBuffer ?? new ArrayBuffer(0),
	};
}

test("uploadBlob: PUT {serverUrl}/upload, Authorization: Nostr <base64 kind-24242 событие>", async () => {
	const calls = [];
	const fetchImpl = async (url, opts) => {
		calls.push({ url, opts });
		return fakeResponse({ jsonBody: { sha256: "abc", size: 42, type: "image/jpeg", url: "https://blossom.test/abc" } });
	};
	const body = new Uint8Array([1, 2, 3]);
	const result = await uploadBlob("https://blossom.test", body, "deadbeef", ALICE_PRIV, { fetchImpl });

	assert.equal(calls.length, 1);
	assert.equal(calls[0].url, "https://blossom.test/upload");
	assert.equal(calls[0].opts.method, "PUT");
	assert.equal(calls[0].opts.body, body);

	const authHeader = calls[0].opts.headers.Authorization;
	assert.ok(authHeader.startsWith("Nostr "));
	const event = JSON.parse(Buffer.from(authHeader.slice("Nostr ".length), "base64").toString("utf8"));
	assert.equal(event.kind, 24242);
	assert.equal(event.pubkey, ALICE_PUB);
	assert.ok(verify(event), "auth-событие обязано иметь корректную подпись");
	assert.deepEqual(
		event.tags.find((t) => t[0] === "t"),
		["t", "upload"],
	);
	assert.deepEqual(
		event.tags.find((t) => t[0] === "x"),
		["x", "deadbeef"],
	);
	const expirationTag = event.tags.find((t) => t[0] === "expiration");
	assert.ok(expirationTag, "expiration tag обязателен (F-AT-10)");
	assert.ok(Number(expirationTag[1]) > event.created_at, "expiration в будущем относительно created_at");

	assert.deepEqual(result, { sha256: "abc", size: 42, type: "image/jpeg", url: "https://blossom.test/abc" });
});

test("uploadBlob: сервер вернул ошибку -> throw с текстом ответа, не проглатывает", async () => {
	const fetchImpl = async () => fakeResponse({ ok: false, status: 413, textBody: "payload too large" });
	await assert.rejects(() => uploadBlob("https://blossom.test", new Uint8Array([1]), "x", ALICE_PRIV, { fetchImpl }), /413/);
});

// deleteBlob — этап 53, "Удалить аккаунт" (BUD-02). Тот же auth-конверт, что
// uploadBlob (buildAuthEvent уже параметризована по action) — только method
// DELETE и t-тег "delete" вместо "upload".
test("deleteBlob: DELETE {serverUrl}/{sha256}, Authorization: Nostr <base64 kind-24242 событие с t=delete>", async () => {
	const calls = [];
	const fetchImpl = async (url, opts) => {
		calls.push({ url, opts });
		return fakeResponse({ ok: true, status: 200 });
	};
	await deleteBlob("https://blossom.test", "deadbeef", ALICE_PRIV, { fetchImpl });

	assert.equal(calls.length, 1);
	assert.equal(calls[0].url, "https://blossom.test/deadbeef");
	assert.equal(calls[0].opts.method, "DELETE");

	const authHeader = calls[0].opts.headers.Authorization;
	assert.ok(authHeader.startsWith("Nostr "));
	const event = JSON.parse(Buffer.from(authHeader.slice("Nostr ".length), "base64").toString("utf8"));
	assert.equal(event.kind, 24242);
	assert.equal(event.pubkey, ALICE_PUB);
	assert.ok(verify(event), "auth-событие обязано иметь корректную подпись");
	assert.deepEqual(
		event.tags.find((t) => t[0] === "t"),
		["t", "delete"],
	);
	assert.deepEqual(
		event.tags.find((t) => t[0] === "x"),
		["x", "deadbeef"],
	);
});

test("deleteBlob: сервер вернул ошибку -> throw с текстом ответа, не проглатывает", async () => {
	const fetchImpl = async () => fakeResponse({ ok: false, status: 404, textBody: "blob not found" });
	await assert.rejects(() => deleteBlob("https://blossom.test", "x", ALICE_PRIV, { fetchImpl }), /404/);
});

test("downloadBlob: GET {serverUrl}/{sha256} БЕЗ Authorization (F-AT-10)", async () => {
	const calls = [];
	const payload = new Uint8Array([9, 8, 7]).buffer;
	const fetchImpl = async (url, opts) => {
		calls.push({ url, opts });
		return fakeResponse({ arrayBuffer: payload });
	};
	const result = await downloadBlob("https://blossom.test", "deadbeef", { fetchImpl });

	assert.equal(calls.length, 1);
	assert.equal(calls[0].url, "https://blossom.test/deadbeef");
	assert.ok(calls[0].opts === undefined || calls[0].opts.headers === undefined || calls[0].opts.headers.Authorization === undefined);
	assert.deepEqual(result, new Uint8Array([9, 8, 7]));
});

test("downloadBlob: сервер вернул ошибку -> throw", async () => {
	const fetchImpl = async () => fakeResponse({ ok: false, status: 404 });
	await assert.rejects(() => downloadBlob("https://blossom.test", "nope", { fetchImpl }), /404/);
});

test("serverUrl с завершающим '/' не даёт двойной слэш (найдено адверсарной фазой)", async () => {
	const calls = [];
	const fetchImpl = async (url) => {
		calls.push(url);
		return fakeResponse({ jsonBody: {} });
	};
	await uploadBlob("https://blossom.test/", new Uint8Array([1]), "x", ALICE_PRIV, { fetchImpl });
	await downloadBlob("https://blossom.test/", "deadbeef", { fetchImpl });
	assert.equal(calls[0], "https://blossom.test/upload");
	assert.equal(calls[1], "https://blossom.test/deadbeef");
});

// checkBlossomReachable (пользователь, item 4 — статус соединения в наве) —
// HEAD-запрос, любой ОТВЕТ = сервер жив, даже если сам HEAD не поддержан.
test("checkBlossomReachable: HEAD {serverUrl}/, ответ (даже не ok) -> true", async () => {
	const calls = [];
	const fetchImpl = async (url, opts) => {
		calls.push({ url, opts });
		return { ok: false, status: 405 }; // HEAD не поддержан сервером — всё равно означает "жив"
	};
	const result = await checkBlossomReachable("https://blossom.test", { fetchImpl });
	assert.equal(result, true);
	assert.equal(calls[0].url, "https://blossom.test/");
	assert.equal(calls[0].opts.method, "HEAD");
});

test("checkBlossomReachable: fetch бросает (сеть недоступна) -> false, не проброс исключения", async () => {
	const fetchImpl = async () => {
		throw new Error("ECONNREFUSED");
	};
	const result = await checkBlossomReachable("https://blossom.test", { fetchImpl });
	assert.equal(result, false);
});

test("checkBlossomReachable: завершающий '/' у serverUrl не даёт двойной слэш", async () => {
	const calls = [];
	const fetchImpl = async (url) => {
		calls.push(url);
		return { ok: true, status: 200 };
	};
	await checkBlossomReachable("https://blossom.test/", { fetchImpl });
	assert.equal(calls[0], "https://blossom.test/");
});

// checkUploadRequirements (этап 62, BUD-06 upload-requirements) — HEAD-предпроверка
// ДО реальной PUT-загрузки, спрашивает у сервера, примет ли он ИМЕННО этот файл
// (по факту его СОБСТВЕННОГО конфига), не полагаясь на клиентскую константу.
test("checkUploadRequirements: HEAD {serverUrl}/upload с X-SHA-256/X-Content-Type/X-Content-Length + Authorization", async () => {
	const calls = [];
	const fetchImpl = async (url, opts) => {
		calls.push({ url, opts });
		return { ok: true, status: 200, headers: { get: () => null } };
	};
	const result = await checkUploadRequirements("https://blossom.test", { sha256Hex: "deadbeef", mime: "image/jpeg", size: 12345 }, ALICE_PRIV, { fetchImpl });

	assert.equal(calls.length, 1);
	assert.equal(calls[0].url, "https://blossom.test/upload");
	assert.equal(calls[0].opts.method, "HEAD");
	assert.equal(calls[0].opts.headers["X-SHA-256"], "deadbeef");
	assert.equal(calls[0].opts.headers["X-Content-Type"], "image/jpeg");
	assert.equal(calls[0].opts.headers["X-Content-Length"], "12345");

	const authHeader = calls[0].opts.headers.Authorization;
	assert.ok(authHeader.startsWith("Nostr "));
	const event = JSON.parse(Buffer.from(authHeader.slice("Nostr ".length), "base64").toString("utf8"));
	assert.equal(event.kind, 24242);
	assert.ok(verify(event));
	assert.deepEqual(
		event.tags.find((t) => t[0] === "t"),
		["t", "upload"],
	);
	assert.deepEqual(
		event.tags.find((t) => t[0] === "x"),
		["x", "deadbeef"],
	);

	assert.deepEqual(result, { ok: true });
});

test("checkUploadRequirements: сервер вернул 413 (свой лимит превышен) -> { ok:false, status:413, reason }", async () => {
	const fetchImpl = async () => ({ ok: false, status: 413, headers: { get: (name) => (name === "X-Reason" ? "file too large" : null) } });
	const result = await checkUploadRequirements("https://blossom.test", { sha256Hex: "x", mime: "video/mp4", size: 999 }, ALICE_PRIV, { fetchImpl });
	assert.deepEqual(result, { ok: false, status: 413, reason: "file too large" });
});

test("checkUploadRequirements: сервер вернул 401/403/415/400 -> { ok:false, status, reason:null } без заголовка X-Reason", async () => {
	const fetchImpl = async () => ({ ok: false, status: 401, headers: { get: () => null } });
	const result = await checkUploadRequirements("https://blossom.test", { sha256Hex: "x", mime: "video/mp4", size: 999 }, ALICE_PRIV, { fetchImpl });
	assert.deepEqual(result, { ok: false, status: 401, reason: null });
});

test("checkUploadRequirements: сервер не поддерживает BUD-06 (404/405) -> { ok:true, unknown:true } — прогрессивное улучшение, не хардстоп", async () => {
	for (const status of [404, 405]) {
		const fetchImpl = async () => ({ ok: false, status, headers: { get: () => null } });
		const result = await checkUploadRequirements("https://blossom.test", { sha256Hex: "x", mime: "video/mp4", size: 999 }, ALICE_PRIV, { fetchImpl });
		assert.deepEqual(result, { ok: true, unknown: true }, `статус ${status} обязан трактоваться как "неизвестно", не как отказ`);
	}
});

test("checkUploadRequirements: сеть недоступна (fetch бросает) -> { ok:true, unknown:true }, не пробрасывает исключение", async () => {
	const fetchImpl = async () => {
		throw new Error("ECONNREFUSED");
	};
	const result = await checkUploadRequirements("https://blossom.test", { sha256Hex: "x", mime: "video/mp4", size: 999 }, ALICE_PRIV, { fetchImpl });
	assert.deepEqual(result, { ok: true, unknown: true });
});

test("checkUploadRequirements: serverUrl с завершающим '/' не даёт двойной слэш", async () => {
	const calls = [];
	const fetchImpl = async (url) => {
		calls.push(url);
		return { ok: true, status: 200, headers: { get: () => null } };
	};
	await checkUploadRequirements("https://blossom.test/", { sha256Hex: "x", mime: "image/png", size: 1 }, ALICE_PRIV, { fetchImpl });
	assert.equal(calls[0], "https://blossom.test/upload");
});

// Интеграционный тест на РЕАЛЬНОМ локальном HTTP-сервере (node:http, не мок функции) —
// нет готового Blossom-сервера в server/ (в отличие от strfry для relay), но реальный
// HTTP round-trip проверяет то, что мок fetchImpl выше не может: правильность самого
// протокола на транспортном уровне (заголовки, тело, статусы), не только вызов JS-функции.
test("uploadBlob/downloadBlob: реальный HTTP round-trip через локальный сервер (не мок)", async () => {
	const store = new Map();

	const server = http.createServer((req, res) => {
		const chunks = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => {
			const bodyBuf = Buffer.concat(chunks);

			if (req.method === "PUT" && req.url === "/upload") {
				const authHeader = req.headers["authorization"];
				if (!authHeader?.startsWith("Nostr ")) {
					res.writeHead(401).end("missing auth");
					return;
				}
				const event = JSON.parse(Buffer.from(authHeader.slice("Nostr ".length), "base64").toString("utf8"));
				const actualSha256 = bytesToHex(sha256(bodyBuf));
				const xTag = event.tags.find((t) => t[0] === "x")?.[1];
				if (event.kind !== 24242 || xTag !== actualSha256) {
					res.writeHead(400).end("auth mismatch");
					return;
				}
				store.set(actualSha256, bodyBuf);
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ sha256: actualSha256, size: bodyBuf.length, type: "application/octet-stream", url: `http://local/${actualSha256}` }));
				return;
			}

			if (req.method === "GET") {
				const sha256Hex = req.url.slice(1);
				if (req.headers["authorization"]) {
					res.writeHead(400).end("GET must not send Authorization");
					return;
				}
				const stored = store.get(sha256Hex);
				if (!stored) {
					res.writeHead(404).end("not found");
					return;
				}
				res.writeHead(200);
				res.end(stored);
				return;
			}

			res.writeHead(404).end();
		});
	});

	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address();
	const serverUrl = `http://127.0.0.1:${port}`;

	try {
		const body = new Uint8Array([10, 20, 30, 40, 50]);
		const sha256Hex = bytesToHex(sha256(body));
		const uploadResult = await uploadBlob(serverUrl, body, sha256Hex, ALICE_PRIV, { fetchImpl: fetch });
		assert.equal(uploadResult.sha256, sha256Hex);
		assert.equal(uploadResult.size, body.length);

		const downloaded = await downloadBlob(serverUrl, sha256Hex, { fetchImpl: fetch });
		assert.deepEqual(downloaded, body);
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
});
