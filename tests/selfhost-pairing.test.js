import { test } from "node:test";
import assert from "node:assert/strict";
import { decodePairingCode, fetchAgentStatus, fetchTurnCredentials } from "../src/domain/selfhost/pairing.js";

// Кодирование, зеркальное agent/internal/pairing/pairing.go's Encode:
// JSON -> base64 RawURLEncoding (URL-safe алфавит, без padding).
function encodeLikeAgent(obj) {
	const json = JSON.stringify(obj);
	const std = btoa(json);
	return std.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const SAMPLE = { host: "203.0.113.42", port: 8443, token: "deadbeef".repeat(8), fingerprint: "cafebabe".repeat(8) };

test("decodePairingCode: раунд-трип с форматом agent/internal/pairing (base64 RawURLEncoding + JSON)", () => {
	const code = encodeLikeAgent(SAMPLE);
	const decoded = decodePairingCode(code);
	assert.deepEqual(decoded, SAMPLE);
});

test("decodePairingCode: URL-safe символы (-/_) декодируются корректно (не просто совпадение по случайности)", () => {
	// Гарантированно вставляем URL-safe символы: строка token/fingerprint такая,
	// что стандартный base64 их значения содержит и '+', и '/'.
	const sample = { host: "h", port: 1, token: "\xfb\xff\xfe", fingerprint: "f" };
	const json = JSON.stringify(sample);
	const std = btoa(json);
	assert.ok(std.includes("+") || std.includes("/"), "тест должен реально проверять +/- и //_ подстановку");
	const urlSafe = std.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
	assert.deepEqual(decodePairingCode(urlSafe), sample);
});

test("decodePairingCode: битый base64 — понятная ошибка, не молчаливый мусор", () => {
	assert.throws(() => decodePairingCode("не-base64-совсем!!!"), /пейринг-код|код/i);
});

test("decodePairingCode: валидный base64, но не JSON внутри — понятная ошибка", () => {
	const notJson = btoa("this is not json").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
	assert.throws(() => decodePairingCode(notJson), /пейринг-код|код/i);
});

test("decodePairingCode: валидный JSON, но отсутствуют обязательные поля — понятная ошибка", () => {
	const incomplete = encodeLikeAgent({ host: "h" });
	assert.throws(() => decodePairingCode(incomplete), /host|port|token|fingerprint/i);
});

test("decodePairingCode: пустая строка — понятная ошибка", () => {
	assert.throws(() => decodePairingCode(""));
});

test("fetchAgentStatus: GET https://{host}:{port}/status с Bearer-токеном", async () => {
	const calls = [];
	const fetchImpl = async (url, opts) => {
		calls.push({ url, opts });
		return { ok: true, status: 200, json: async () => ({ version: "dev", uptimeSeconds: 5, services: [] }) };
	};
	const result = await fetchAgentStatus(SAMPLE, { fetchImpl });

	assert.equal(calls.length, 1);
	assert.equal(calls[0].url, `https://${SAMPLE.host}:${SAMPLE.port}/status`);
	assert.equal(calls[0].opts.headers.Authorization, `Bearer ${SAMPLE.token}`);
	assert.deepEqual(result, { version: "dev", uptimeSeconds: 5, services: [] });
});

test("fetchAgentStatus: сервер отклонил (401/иное) -> throw с понятным сообщением", async () => {
	const fetchImpl = async () => ({ ok: false, status: 401 });
	await assert.rejects(() => fetchAgentStatus(SAMPLE, { fetchImpl }), /401/);
});

test("fetchAgentStatus: сеть недоступна (сертификат не принят и т.п.) -> throw, не глотает молча", async () => {
	const fetchImpl = async () => {
		throw new Error("Failed to fetch");
	};
	await assert.rejects(() => fetchAgentStatus(SAMPLE, { fetchImpl }), /Failed to fetch|сервер|сеть/i);
});

test("fetchTurnCredentials: GET https://{host}:{port}/turn-credentials с тем же Bearer-токеном", async () => {
	const calls = [];
	const fetchImpl = async (url, opts) => {
		calls.push({ url, opts });
		return { ok: true, status: 200, json: async () => ({ username: "123", password: "abc", ttl: 43200, uris: ["turn:1.2.3.4:3478"] }) };
	};
	const result = await fetchTurnCredentials(SAMPLE, { fetchImpl });

	assert.equal(calls.length, 1);
	assert.equal(calls[0].url, `https://${SAMPLE.host}:${SAMPLE.port}/turn-credentials`);
	assert.equal(calls[0].opts.headers.Authorization, `Bearer ${SAMPLE.token}`);
	assert.deepEqual(result, { username: "123", password: "abc", ttl: 43200, uris: ["turn:1.2.3.4:3478"] });
});

test("fetchTurnCredentials: 501 (агент без TURN, запущен без --compose-dir) -> понятная ошибка", async () => {
	const fetchImpl = async () => ({ ok: false, status: 501 });
	await assert.rejects(() => fetchTurnCredentials(SAMPLE, { fetchImpl }), /501/);
});
