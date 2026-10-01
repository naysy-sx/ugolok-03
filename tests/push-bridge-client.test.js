import { test } from "node:test";
import assert from "node:assert/strict";
import { bytesToHex } from "@noble/hashes/utils.js";
import { getPublicKey } from "../src/core/crypto/keys.js";
import { verify } from "../src/core/crypto/sign.js";
import { registerPush, updatePushFilters, unregisterPush } from "../src/core/transport/push-bridge-client.js";

const ALICE_PRIV = new Uint8Array(32).fill(1);
const ALICE_PUB = bytesToHex(getPublicKey(ALICE_PRIV));
const BRIDGE = "https://relay.test.ugolok.tech/push";

function fakeResponse({ ok = true, status = 200, jsonBody = {} } = {}) {
	return { ok, status, json: async () => jsonBody };
}

test("registerPush: POST {bridge}/register, Authorization: Nostr <base64 kind-27235 событие>", async () => {
	const calls = [];
	const fetchImpl = async (url, opts) => {
		calls.push({ url, opts });
		return fakeResponse({ jsonBody: { endpoint: "https://relay.test.ugolok.tech/push/abc123", topic: "abc123", expires_at: 123 } });
	};
	const result = await registerPush(BRIDGE, ["group-1", "group-2"], ALICE_PRIV, { fetchImpl });

	assert.equal(calls.length, 1);
	assert.equal(calls[0].url, "https://relay.test.ugolok.tech/push/register");
	assert.equal(calls[0].opts.method, "POST");
	assert.deepEqual(JSON.parse(calls[0].opts.body), { groups: ["group-1", "group-2"] });

	const authHeader = calls[0].opts.headers.Authorization;
	assert.ok(authHeader.startsWith("Nostr "));
	const event = JSON.parse(Buffer.from(authHeader.slice("Nostr ".length), "base64").toString("utf8"));
	assert.equal(event.kind, 27235);
	assert.equal(event.pubkey, ALICE_PUB);
	assert.ok(verify(event), "auth-событие обязано иметь корректную подпись");
	assert.deepEqual(
		event.tags.find((t) => t[0] === "u"),
		["u", "https://relay.test.ugolok.tech/push/register"],
	);
	assert.deepEqual(
		event.tags.find((t) => t[0] === "method"),
		["method", "POST"],
	);

	assert.deepEqual(result, { endpoint: "https://relay.test.ugolok.tech/push/abc123", topic: "abc123", expires_at: 123 });
});

test("registerPush: без списка групп -> тело {groups: []}", async () => {
	const calls = [];
	const fetchImpl = async (url, opts) => {
		calls.push(opts);
		return fakeResponse({ jsonBody: { endpoint: "e", topic: "t", expires_at: 1 } });
	};
	await registerPush(BRIDGE, undefined, ALICE_PRIV, { fetchImpl });
	assert.deepEqual(JSON.parse(calls[0].body), { groups: [] });
});

test("registerPush: сервер отвечает не-2xx -> бросает", async () => {
	const fetchImpl = async () => fakeResponse({ ok: false, status: 500 });
	await assert.rejects(() => registerPush(BRIDGE, [], ALICE_PRIV, { fetchImpl }), /500/);
});

test("updatePushFilters: PUT {bridge}/register, тот же URL что и POST (метод в теге NIP-98)", async () => {
	const calls = [];
	const fetchImpl = async (url, opts) => {
		calls.push({ url, opts });
		return fakeResponse({ jsonBody: { endpoint: "e", topic: "t", expires_at: 1 } });
	};
	await updatePushFilters(BRIDGE, ["group-3"], ALICE_PRIV, { fetchImpl });

	assert.equal(calls[0].url, "https://relay.test.ugolok.tech/push/register");
	assert.equal(calls[0].opts.method, "PUT");
	const event = JSON.parse(Buffer.from(calls[0].opts.headers.Authorization.slice("Nostr ".length), "base64").toString("utf8"));
	assert.deepEqual(
		event.tags.find((t) => t[0] === "method"),
		["method", "PUT"],
	);
});

test("unregisterPush: DELETE {bridge}/register", async () => {
	const calls = [];
	const fetchImpl = async (url, opts) => {
		calls.push({ url, opts });
		return fakeResponse({ status: 204 });
	};
	await unregisterPush(BRIDGE, ALICE_PRIV, { fetchImpl });
	assert.equal(calls[0].url, "https://relay.test.ugolok.tech/push/register");
	assert.equal(calls[0].opts.method, "DELETE");
});

test("unregisterPush: 404 (уже не зарегистрирован) — не бросает, тот же итог", async () => {
	const fetchImpl = async () => fakeResponse({ ok: false, status: 404 });
	await assert.doesNotReject(() => unregisterPush(BRIDGE, ALICE_PRIV, { fetchImpl }));
});

test("unregisterPush: прочая ошибка (не 404) -> бросает", async () => {
	const fetchImpl = async () => fakeResponse({ ok: false, status: 500 });
	await assert.rejects(() => unregisterPush(BRIDGE, ALICE_PRIV, { fetchImpl }), /500/);
});

test("bridgeBaseUrl с хвостовым слэшем не даёт двойной слэш в URL", async () => {
	const calls = [];
	const fetchImpl = async (url, opts) => {
		calls.push(url);
		return fakeResponse({ jsonBody: { endpoint: "e", topic: "t", expires_at: 1 } });
	};
	await registerPush("https://relay.test.ugolok.tech/push/", [], ALICE_PRIV, { fetchImpl });
	assert.equal(calls[0], "https://relay.test.ugolok.tech/push/register");
});
