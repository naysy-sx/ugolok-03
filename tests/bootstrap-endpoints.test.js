import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
	BUILD_DEFAULT_RELAYS,
	BUILD_DEFAULT_BLOSSOM_SERVERS,
	BUILD_DEFAULT_ICE_SERVERS,
} from "../src/config.js";
import {
	BOOTSTRAP_ENDPOINTS_KEY,
	parseRelayUrl,
	parseBlossomUrl,
	parseIceUrl,
	iceUrlFromServers,
	readBootstrapEndpoints,
	writeBootstrapEndpoints,
	resetBootstrapEndpoints,
} from "../src/domain/settings/bootstrap-endpoints.js";

function memoryStorage(initial = {}) {
	const map = new Map(Object.entries(initial));
	return {
		getItem(k) {
			return map.has(k) ? map.get(k) : null;
		},
		setItem(k, v) {
			map.set(k, String(v));
		},
		removeItem(k) {
			map.delete(k);
		},
	};
}

function buildTimeDefaults() {
	return {
		relayUrl: BUILD_DEFAULT_RELAYS[0] ?? "",
		blossomUrl: BUILD_DEFAULT_BLOSSOM_SERVERS[0] ?? "",
		iceServers: [...BUILD_DEFAULT_ICE_SERVERS],
	};
}

beforeEach(() => {
	// тесты передают storage явно — глобальный localStorage не трогаем
});

test("readBootstrapEndpoints: нет записи → значения из BUILD_DEFAULT_*", () => {
	const storage = memoryStorage();
	assert.deepEqual(readBootstrapEndpoints(storage), buildTimeDefaults());
});

test("writeBootstrapEndpoints + повторный read → round-trip", () => {
	const storage = memoryStorage();
	const written = writeBootstrapEndpoints(
		{
			relayUrl: "wss://relay.example:7777",
			blossomUrl: "https://blossom.example:8080",
			iceServers: [{ urls: "turn:turn.example:3478" }],
		},
		storage,
	);
	assert.equal(written.relayUrl, "wss://relay.example:7777");
	assert.equal(written.blossomUrl, "https://blossom.example:8080");
	assert.deepEqual(written.iceServers, [{ urls: "turn:turn.example:3478" }]);
	assert.deepEqual(readBootstrapEndpoints(storage), written);
	assert.ok(storage.getItem(BOOTSTRAP_ENDPOINTS_KEY));
});

test("resetBootstrapEndpoints → снова build-time дефолты", () => {
	const storage = memoryStorage();
	writeBootstrapEndpoints({ relayUrl: "wss://relay.example:7777" }, storage);
	resetBootstrapEndpoints(storage);
	assert.deepEqual(readBootstrapEndpoints(storage), buildTimeDefaults());
	assert.equal(storage.getItem(BOOTSTRAP_ENDPOINTS_KEY), null);
});

test("запись отбрасывает пустой/мусорный relay URL, не портит предыдущее валидное значение", () => {
	const storage = memoryStorage();
	writeBootstrapEndpoints({ relayUrl: "ws://127.0.0.1:7777" }, storage);
	const afterGarbage = writeBootstrapEndpoints({ relayUrl: "http://not-a-relay" }, storage);
	assert.equal(afterGarbage.relayUrl, "ws://127.0.0.1:7777");
	const afterEmpty = writeBootstrapEndpoints({ relayUrl: "   " }, storage);
	assert.equal(afterEmpty.relayUrl, "ws://127.0.0.1:7777");
	assert.equal(readBootstrapEndpoints(storage).relayUrl, "ws://127.0.0.1:7777");
});

test("канонизация: пробелы по краям срезаются, хвостовой / у Blossom нормализуется", () => {
	assert.equal(parseRelayUrl("  ws://127.0.0.1:7777  "), "ws://127.0.0.1:7777");
	assert.equal(parseBlossomUrl("  http://127.0.0.1:8080/  "), "http://127.0.0.1:8080");
	assert.equal(parseBlossomUrl("https://files.example/path/"), "https://files.example/path");
	const storage = memoryStorage();
	const written = writeBootstrapEndpoints(
		{
			relayUrl: "  wss://relay.example  ",
			blossomUrl: " https://blossom.example/ ",
		},
		storage,
	);
	assert.equal(written.relayUrl, "wss://relay.example");
	assert.equal(written.blossomUrl, "https://blossom.example");
});

test("валидаторы схем: http:// не принимается как relay; ws:// не принимается как blossom", () => {
	assert.equal(parseRelayUrl("http://127.0.0.1:7777"), null);
	assert.equal(parseRelayUrl("https://relay.example"), null);
	assert.equal(parseRelayUrl(""), null);
	assert.equal(parseBlossomUrl("ws://127.0.0.1:8080"), null);
	assert.equal(parseBlossomUrl("wss://files.example"), null);
	assert.equal(parseIceUrl("ws://127.0.0.1:3478"), null);
	assert.equal(parseIceUrl("http://turn.example"), null);
});

test("parseIceUrl: localhost получает dev-кредлы, чужой URL — только urls", () => {
	assert.deepEqual(parseIceUrl("turn:127.0.0.1:3478"), {
		urls: "turn:127.0.0.1:3478",
		username: "ugolok",
		credential: "ugolok-dev",
	});
	assert.deepEqual(parseIceUrl("stun:localhost:3478"), {
		urls: "stun:localhost:3478",
		username: "ugolok",
		credential: "ugolok-dev",
	});
	assert.deepEqual(parseIceUrl("turns:turn.example:3478"), {
		urls: "turns:turn.example:3478",
	});
	assert.equal(iceUrlFromServers([{ urls: "stun:stun.l.google.com:19302" }, { urls: "turn:127.0.0.1:3478" }]), "turn:127.0.0.1:3478");
});

test("битый JSON в storage → как отсутствие записи, не бросает", () => {
	const storage = memoryStorage({ [BOOTSTRAP_ENDPOINTS_KEY]: "{not-json" });
	assert.deepEqual(readBootstrapEndpoints(storage), buildTimeDefaults());
});
