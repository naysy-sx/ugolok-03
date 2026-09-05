import { test } from "node:test";
import assert from "node:assert/strict";
import { loadRuntimeConfig, getRuntimeConfig, resetRuntimeConfig } from "../src/domain/settings/runtime-config.js";

function fakeFetch(handler) {
	return async (url, init) => handler(url, init);
}

function jsonResponse(body, { ok = true } = {}) {
	return { ok, json: async () => body };
}

test("loadRuntimeConfig: валидный config.json — все поля парсятся и попадают в кэш", async () => {
	resetRuntimeConfig();
	const raw = {
		instanceName: "test.ugolok.tech",
		relays: ["wss://relay.test.ugolok.tech"],
		bootstrapRelays: ["wss://relay.test.ugolok.tech"],
		blossomServers: ["https://blossom.test.ugolok.tech"],
		iceServers: [{ urls: "turn:ugolok.tech:3478", username: "u", credential: "p" }],
	};
	const result = await loadRuntimeConfig({ fetchImpl: fakeFetch(() => jsonResponse(raw)) });
	assert.deepEqual(result, raw);
	assert.deepEqual(getRuntimeConfig(), raw);
});

test("loadRuntimeConfig: битый JSON -> {} (json() бросает)", async () => {
	resetRuntimeConfig();
	const fetchImpl = fakeFetch(() => ({
		ok: true,
		json: async () => {
			throw new SyntaxError("Unexpected token");
		},
	}));
	const result = await loadRuntimeConfig({ fetchImpl });
	assert.deepEqual(result, {});
	assert.deepEqual(getRuntimeConfig(), {});
});

test("loadRuntimeConfig: ответ не ok (404 — файла нет) -> {}", async () => {
	resetRuntimeConfig();
	const result = await loadRuntimeConfig({ fetchImpl: fakeFetch(() => jsonResponse({}, { ok: false })) });
	assert.deepEqual(result, {});
});

test("loadRuntimeConfig: отсутствующие/мусорные поля отбрасываются по отдельности, не всё целиком", async () => {
	resetRuntimeConfig();
	const raw = {
		instanceName: 42, // не строка — отбрасывается
		relays: ["wss://relay.example"],
		blossomServers: "не массив", // отбрасывается
		iceServers: [{ urls: "не-turn-и-не-stun" }, { urls: "turn:x.example:3478" }],
	};
	const result = await loadRuntimeConfig({ fetchImpl: fakeFetch(() => jsonResponse(raw)) });
	assert.deepEqual(result, {
		relays: ["wss://relay.example"],
		iceServers: [{ urls: "turn:x.example:3478" }],
	});
});

test("loadRuntimeConfig: пустой объект (все поля невалидны/отсутствуют) -> {}", async () => {
	resetRuntimeConfig();
	const result = await loadRuntimeConfig({ fetchImpl: fakeFetch(() => jsonResponse({ relays: "не массив" })) });
	assert.deepEqual(result, {});
});

test("loadRuntimeConfig: таймаут (fetch зависает) -> {}, не висит дольше timeoutMs", async (t) => {
	resetRuntimeConfig();
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const fetchImpl = fakeFetch(() => new Promise(() => {})); // никогда не резолвится
	const resultPromise = loadRuntimeConfig({ fetchImpl, timeoutMs: 3000 });
	t.mock.timers.tick(3000);
	const result = await resultPromise;
	assert.deepEqual(result, {});
	t.mock.timers.reset();
});

test("loadRuntimeConfig: сетевая ошибка (fetch reject) -> {}, не бросает наружу", async () => {
	resetRuntimeConfig();
	const fetchImpl = fakeFetch(() => {
		throw new Error("network down");
	});
	const result = await loadRuntimeConfig({ fetchImpl });
	assert.deepEqual(result, {});
});

test("getRuntimeConfig: до первой загрузки — {}", () => {
	resetRuntimeConfig();
	assert.deepEqual(getRuntimeConfig(), {});
});
