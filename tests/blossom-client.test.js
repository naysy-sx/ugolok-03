import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { getPublicKey } from "../src/core/crypto/keys.js";
import { verify } from "../src/core/crypto/sign.js";
import { uploadBlob, downloadBlob, deleteBlob, checkBlossomReachable, checkUploadRequirements, resolveUploadTimeoutMs, UPLOAD_TIMEOUT_FLOOR_MS, UPLOAD_TIMEOUT_CEIL_MS } from "../src/core/transport/blossom-client.js";

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
// HEAD /stats (BUD, на нашем форке 200). Любой ОТВЕТ = сервер жив, даже 404/405.
test("checkBlossomReachable: HEAD {serverUrl}/stats, ответ (даже не ok) -> true", async () => {
	const calls = [];
	const fetchImpl = async (url, opts) => {
		calls.push({ url, opts });
		return { ok: false, status: 405 }; // HEAD не поддержан сервером — всё равно означает "жив"
	};
	const result = await checkBlossomReachable("https://blossom.test", { fetchImpl });
	assert.equal(result, true);
	assert.equal(calls[0].url, "https://blossom.test/stats");
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
	assert.equal(calls[0], "https://blossom.test/stats");
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

// FILES-FIX-SPEC.md §7.1 / TZ-FIX-FILES-MEDIA-STATIC.md 5.1 — retry на
// транзиентных сетевых отказах (S3: "крупные файлы не долетают вовсе").
test("uploadBlob: первая попытка 503, вторая 200 -> успех, 2 вызова fetch, backoff соблюдён", async () => {
	const calls = [];
	let n = 0;
	const fetchImpl = async (url, opts) => {
		calls.push({ url, opts, t: Date.now() });
		n += 1;
		if (n === 1) return fakeResponse({ ok: false, status: 503, textBody: "busy" });
		return fakeResponse({ jsonBody: { sha256: "abc", size: 3 } });
	};
	const result = await uploadBlob("https://blossom.test", new Uint8Array([1, 2, 3]), "deadbeef", ALICE_PRIV, { fetchImpl, backoffMs: 5 });
	assert.equal(calls.length, 2);
	assert.deepEqual(result, { sha256: "abc", size: 3 });
});

test("uploadBlob: retries исчерпаны на постоянном 503 -> throw после ровно retries+1 попыток", async () => {
	const calls = [];
	const fetchImpl = async (url, opts) => {
		calls.push({ url, opts });
		return fakeResponse({ ok: false, status: 503, textBody: "busy" });
	};
	await assert.rejects(() => uploadBlob("https://blossom.test", new Uint8Array([1]), "x", ALICE_PRIV, { fetchImpl, retries: 2, backoffMs: 1 }), /503/);
	assert.equal(calls.length, 3, "1 исходная попытка + 2 ретрая");
});

test("uploadBlob: 400 (клиентская ошибка) -> НЕ повторяется, throw сразу после первой попытки", async () => {
	const calls = [];
	const fetchImpl = async () => {
		calls.push(1);
		return fakeResponse({ ok: false, status: 400, textBody: "bad request" });
	};
	await assert.rejects(() => uploadBlob("https://blossom.test", new Uint8Array([1]), "x", ALICE_PRIV, { fetchImpl, backoffMs: 1 }), /400/);
	assert.equal(calls.length, 1);
});

test("uploadBlob: сетевой TypeError на первой попытке, второй попытке успех -> retry сработал", async () => {
	const calls = [];
	let n = 0;
	const fetchImpl = async () => {
		n += 1;
		calls.push(n);
		if (n === 1) throw new TypeError("network down");
		return fakeResponse({ jsonBody: { sha256: "abc", size: 1 } });
	};
	const result = await uploadBlob("https://blossom.test", new Uint8Array([1]), "x", ALICE_PRIV, { fetchImpl, backoffMs: 1 });
	assert.equal(calls.length, 2);
	assert.deepEqual(result, { sha256: "abc", size: 1 });
});

test("uploadBlob: AbortError пользователя -> throw без единого повтора", async () => {
	const calls = [];
	const controller = new AbortController();
	const fetchImpl = async () => {
		calls.push(1);
		controller.abort();
		const err = new DOMException("aborted", "AbortError");
		throw err;
	};
	await assert.rejects(
		() => uploadBlob("https://blossom.test", new Uint8Array([1]), "x", ALICE_PRIV, { fetchImpl, signal: controller.signal, backoffMs: 1 }),
		(err) => err.name === "AbortError",
	);
	assert.equal(calls.length, 1, "AbortError не должен ретраиться");
});

test("uploadBlob: expiration tag учитывает expirationSec — expiration - created_at >= expirationSec", async () => {
	const calls = [];
	const fetchImpl = async (url, opts) => {
		calls.push(opts);
		return fakeResponse({ jsonBody: { sha256: "abc", size: 1 } });
	};
	await uploadBlob("https://blossom.test", new Uint8Array([1]), "x", ALICE_PRIV, { fetchImpl, expirationSec: 900 });
	const authHeader = calls[0].headers.Authorization;
	const event = JSON.parse(Buffer.from(authHeader.slice("Nostr ".length), "base64").toString("utf8"));
	const expirationTag = event.tags.find((t) => t[0] === "expiration");
	assert.ok(Number(expirationTag[1]) - event.created_at >= 900);
});

test("resolveUploadTimeoutMs: мелкое тело -> пол 120с (не 8мс/КиБ из TZ, который рвал 10МБ @ 30КБ/с)", () => {
	assert.equal(resolveUploadTimeoutMs(0), UPLOAD_TIMEOUT_FLOOR_MS);
	assert.equal(resolveUploadTimeoutMs(1024), UPLOAD_TIMEOUT_FLOOR_MS);
});

test("resolveUploadTimeoutMs: 10 МиБ переживает канал 30 КБ/с (≈6 мин) с запасом", () => {
	const tenMib = 10 * 1024 * 1024;
	const ms = resolveUploadTimeoutMs(tenMib);
	assert.ok(ms >= 6 * 60 * 1000, `${ms}мс должно покрывать 6 мин @ 30КБ/с`);
	assert.ok(ms < UPLOAD_TIMEOUT_CEIL_MS);
});

test("resolveUploadTimeoutMs: потолок час, даже на лимите upload 300МБ", () => {
	assert.equal(resolveUploadTimeoutMs(300 * 1024 * 1024), UPLOAD_TIMEOUT_CEIL_MS);
});

test("uploadBlob: без expirationSec явного — дефолт растёт вместе с timeoutMs (крупный файл не протухает раньше PUT)", async () => {
	const calls = [];
	const fetchImpl = async (url, opts) => {
		calls.push(opts);
		return fakeResponse({ jsonBody: { sha256: "abc", size: 1 } });
	};
	// timeoutMs достаточно большой, чтобы дефолт expirationSec (>= timeoutMs/1000+60) превысил 300
	await uploadBlob("https://blossom.test", new Uint8Array([1]), "x", ALICE_PRIV, { fetchImpl, timeoutMs: 400_000 });
	const authHeader = calls[0].headers.Authorization;
	const event = JSON.parse(Buffer.from(authHeader.slice("Nostr ".length), "base64").toString("utf8"));
	const expirationTag = event.tags.find((t) => t[0] === "expiration");
	assert.ok(Number(expirationTag[1]) - event.created_at > 300, "expiration обязан быть длиннее старого жёсткого 300с");
});

test("uploadBlob: 10 МиБ без явного timeoutMs — expiration покрывает PUT на 30 КБ/с + запас", async () => {
	const calls = [];
	const fetchImpl = async (url, opts) => {
		calls.push(opts);
		return fakeResponse({ jsonBody: { sha256: "abc", size: 1 } });
	};
	await uploadBlob("https://blossom.test", new Uint8Array(10 * 1024 * 1024), "x", ALICE_PRIV, { fetchImpl });
	const authHeader = calls[0].headers.Authorization;
	const event = JSON.parse(Buffer.from(authHeader.slice("Nostr ".length), "base64").toString("utf8"));
	const expirationTag = event.tags.find((t) => t[0] === "expiration");
	const ttl = Number(expirationTag[1]) - event.created_at;
	assert.ok(ttl >= 6 * 60 + 60, `ttl=${ttl}с, нужно ≥7 мин (6 мин передачи + 60с запаса)`);
});

test("uploadBlob: fetchImpl подставлен (Node/тест) -> onUploadProgress зовётся один раз со всеми байтами, не ломает контракт", async () => {
	const progressEvents = [];
	const fetchImpl = async () => fakeResponse({ jsonBody: { sha256: "abc", size: 5 } });
	await uploadBlob("https://blossom.test", new Uint8Array([1, 2, 3, 4, 5]), "x", ALICE_PRIV, {
		fetchImpl,
		onUploadProgress: (p) => progressEvents.push(p),
	});
	assert.equal(progressEvents.length, 1);
	assert.equal(progressEvents[0].loaded, 5);
	assert.equal(progressEvents[0].total, 5);
});

test("checkUploadRequirements: первая попытка 502, вторая ok -> retry сработал на предпроверке", async () => {
	const calls = [];
	let n = 0;
	const fetchImpl = async (url, opts) => {
		calls.push(opts);
		n += 1;
		if (n === 1) return { ok: false, status: 502, headers: { get: () => null } };
		return { ok: true, status: 200, headers: { get: () => null } };
	};
	const result = await checkUploadRequirements("https://blossom.test", { sha256Hex: "x", mime: "video/mp4", size: 1 }, ALICE_PRIV, { fetchImpl, backoffMs: 1 });
	assert.equal(calls.length, 2);
	assert.deepEqual(result, { ok: true });
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
