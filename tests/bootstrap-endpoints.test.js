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
	turnHostFromServers,
	resolveIceServers,
	readBootstrapEndpoints,
	writeBootstrapEndpoints,
	resetBootstrapEndpoints,
	fetchTurnCredentials,
	resetTurnCredentialsCache,
	resolveCallIceServers,
	isTurnCredsStale,
} from "../src/domain/settings/bootstrap-endpoints.js";
import { loadRuntimeConfig, resetRuntimeConfig } from "../src/domain/settings/runtime-config.js";

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
	resetRuntimeConfig();
	resetTurnCredentialsCache();
});

test("readBootstrapEndpoints: нет записи → значения из BUILD_DEFAULT_*", () => {
	const storage = memoryStorage();
	assert.deepEqual(readBootstrapEndpoints(storage), buildTimeDefaults());
});

// Этап 4A (TZ-cicd-hardening) — приоритет трёх источников: localStorage >
// config.json > BUILD_DEFAULT_*. Предыдущий тест покрывает "нет localStorage,
// нет config.json → BUILD_DEFAULT_*"; эти два — остальные две ступени.
test("readBootstrapEndpoints: нет localStorage, ЕСТЬ config.json → значения из config.json, не BUILD_DEFAULT_*", async () => {
	await loadRuntimeConfig({
		fetchImpl: async () => ({
			ok: true,
			json: async () => ({
				relays: ["wss://relay.runtime-config.example"],
				blossomServers: ["https://blossom.runtime-config.example"],
				iceServers: [{ urls: "turn:runtime-config.example:3478", username: "ru", credential: "rp" }],
			}),
		}),
	});
	const storage = memoryStorage();
	assert.deepEqual(readBootstrapEndpoints(storage), {
		relayUrl: "wss://relay.runtime-config.example",
		blossomUrl: "https://blossom.runtime-config.example",
		iceServers: [{ urls: "turn:runtime-config.example:3478", username: "ru", credential: "rp" }],
	});
});

test("readBootstrapEndpoints: ЕСТЬ и localStorage, и config.json → localStorage побеждает", async () => {
	await loadRuntimeConfig({
		fetchImpl: async () => ({
			ok: true,
			json: async () => ({ relays: ["wss://relay.runtime-config.example"] }),
		}),
	});
	const storage = memoryStorage();
	writeBootstrapEndpoints({ relayUrl: "wss://relay.from-user.example" }, storage);
	assert.equal(readBootstrapEndpoints(storage).relayUrl, "wss://relay.from-user.example");
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

test("turnHostFromServers: первый turn/turns host, stun пропускается", () => {
	assert.equal(turnHostFromServers([]), "");
	assert.equal(turnHostFromServers([{ urls: "stun:stun.l.google.com:19302" }]), "");
	assert.equal(
		turnHostFromServers([
			{ urls: "stun:ugolok.tech:3478" },
			{ urls: "turn:ugolok.tech:3478?transport=udp", username: "u", credential: "p" },
		]),
		"ugolok.tech",
	);
	assert.equal(turnHostFromServers([{ urls: ["turns:turn.example:5349?transport=tcp"] }]), "turn.example");
});

test("resolveIceServers: тот же TURN-хост / localhost / пусто → build-time ICE (udp+tcp+креды)", () => {
	const defaults = [
		{ urls: "stun:ugolok.tech:3478" },
		{ urls: "turn:ugolok.tech:3478?transport=udp", username: "ugolok", credential: "secret" },
		{ urls: "turn:ugolok.tech:3478?transport=tcp", username: "ugolok", credential: "secret" },
	];
	assert.deepEqual(
		resolveIceServers([{ urls: "turn:ugolok.tech:3478" }], defaults),
		defaults,
	);
	assert.deepEqual(resolveIceServers([{ urls: "turn:127.0.0.1:3478" }], defaults), defaults);
	assert.deepEqual(resolveIceServers([], defaults), defaults);
	assert.deepEqual(
		resolveIceServers([{ urls: "turn:other.example:3478", username: "x", credential: "y" }], defaults),
		[{ urls: "turn:other.example:3478", username: "x", credential: "y" }],
	);
});

// Этап 6 (TZ-cicd-hardening) — fetchTurnCredentials/resolveCallIceServers.

test("fetchTurnCredentials: успех — по одной ICE-записи на uri, одни и те же username/credential", async () => {
	const fetchImpl = async () => ({
		ok: true,
		json: async () => ({
			username: "1234567890",
			credential: "base64hmac==",
			ttl: 3600,
			uris: ["turn:ugolok.tech:3478?transport=udp", "turn:ugolok.tech:3478?transport=tcp"],
		}),
	});
	const result = await fetchTurnCredentials("https://ugolok.tech/api/turn-credentials", { fetchImpl });
	assert.deepEqual(result, [
		{ urls: "turn:ugolok.tech:3478?transport=udp", username: "1234567890", credential: "base64hmac==" },
		{ urls: "turn:ugolok.tech:3478?transport=tcp", username: "1234567890", credential: "base64hmac==" },
	]);
});

test("fetchTurnCredentials: таймаут (fetch зависает) -> null, не висит дольше timeoutMs", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const fetchImpl = async () => new Promise(() => {});
	const resultPromise = fetchTurnCredentials("https://ugolok.tech/api/turn-credentials", { fetchImpl, timeoutMs: 3000 });
	t.mock.timers.tick(3000);
	assert.equal(await resultPromise, null);
	t.mock.timers.reset();
});

test("fetchTurnCredentials: битый ответ (нет credential) -> null", async () => {
	const fetchImpl = async () => ({ ok: true, json: async () => ({ username: "x", ttl: 3600, uris: ["turn:x:3478"] }) });
	assert.equal(await fetchTurnCredentials("https://x/api/turn-credentials", { fetchImpl }), null);
});

test("fetchTurnCredentials: ответ не ok -> null", async () => {
	const fetchImpl = async () => ({ ok: false, json: async () => ({}) });
	assert.equal(await fetchTurnCredentials("https://x/api/turn-credentials", { fetchImpl }), null);
});

test("fetchTurnCredentials: кэш — второй вызов ДО expiry-60с не бьёт сеть заново", async () => {
	let calls = 0;
	const fetchImpl = async () => {
		calls++;
		return { ok: true, json: async () => ({ username: "u", credential: "c", ttl: 3600, uris: ["turn:x:3478"] }) };
	};
	const now = 1_000_000;
	const first = await fetchTurnCredentials("https://x/api/turn-credentials", { fetchImpl, now });
	const second = await fetchTurnCredentials("https://x/api/turn-credentials", { fetchImpl, now: now + 1000 });
	assert.equal(calls, 1, "второй вызов внутри TTL-60с обязан взять кэш, не бить сеть");
	assert.deepEqual(first, second);
});

test("fetchTurnCredentials: кэш истёк (now >= expiry-60с) -> бьёт сеть заново", async () => {
	let calls = 0;
	const fetchImpl = async () => {
		calls++;
		return { ok: true, json: async () => ({ username: "u", credential: "c", ttl: 3600, uris: ["turn:x:3478"] }) };
	};
	const now = 1_000_000;
	await fetchTurnCredentials("https://x/api/turn-credentials", { fetchImpl, now });
	await fetchTurnCredentials("https://x/api/turn-credentials", { fetchImpl, now: now + 3600_000 });
	assert.equal(calls, 2);
});

// --- TZ-recovery-policy.md §2.3: обновление TURN-кредов при протухании ---

test("isTurnCredsStale: нет кредов в кэше вообще -> false (не 'протухли', а 'не запрашивались')", () => {
	assert.equal(isTurnCredsStale(), false);
});

test("isTurnCredsStale: больше половины TTL ещё впереди -> false", async () => {
	const now = 1_000_000;
	await fetchTurnCredentials("https://x/api/turn-credentials", {
		fetchImpl: async () => ({ ok: true, json: async () => ({ username: "u", credential: "c", ttl: 3600, uris: ["turn:x:3478"] }) }),
		now,
	});
	// TTL кэшируется как (3600-60)=3540с от now. Четверть срока прошла — не протухло.
	assert.equal(isTurnCredsStale(now + 800_000), false);
});

test("isTurnCredsStale: осталось меньше половины TTL -> true", async () => {
	const now = 1_000_000;
	await fetchTurnCredentials("https://x/api/turn-credentials", {
		fetchImpl: async () => ({ ok: true, json: async () => ({ username: "u", credential: "c", ttl: 3600, uris: ["turn:x:3478"] }) }),
		now,
	});
	// Кэш живёт 3540с; на отметке +2600с (больше половины) должно считаться протухшим.
	assert.equal(isTurnCredsStale(now + 2_600_000), true);
});

test("resolveCallIceServers({refreshIfStale:true}): протухшие больше половины креды сбрасываются и запрашиваются заново", async () => {
	await loadRuntimeConfig({
		fetchImpl: async () => ({ ok: true, json: async () => ({ turnCredentialsUrl: "https://ugolok.tech/api/turn-credentials" }) }),
	});
	let calls = 0;
	const now = 1_000_000;
	const fetchImpl = async () => {
		calls++;
		return { ok: true, json: async () => ({ username: `u${calls}`, credential: "c", ttl: 3600, uris: ["turn:x:3478"] }) };
	};
	const first = await resolveCallIceServers({ fetchImpl, now });
	assert.equal(calls, 1);
	// Внутри половины TTL — refreshIfStale не должен бить сеть повторно.
	const second = await resolveCallIceServers({ fetchImpl, now: now + 800_000, refreshIfStale: true });
	assert.equal(calls, 1, "ещё не протухло — кэш используется как есть");
	assert.deepEqual(second, first);
	// За половиной TTL — обязан сбросить кэш и запросить заново.
	const third = await resolveCallIceServers({ fetchImpl, now: now + 2_600_000, refreshIfStale: true });
	assert.equal(calls, 2, "протухло больше половины — повторный запрос");
	assert.notDeepEqual(third, first, "новые креды (другой username) — не тот же кэш");
});

test("resolveCallIceServers без refreshIfStale (обычный путь) НЕ форсирует обновление даже при протухании больше половины", async () => {
	await loadRuntimeConfig({
		fetchImpl: async () => ({ ok: true, json: async () => ({ turnCredentialsUrl: "https://ugolok.tech/api/turn-credentials" }) }),
	});
	let calls = 0;
	const now = 1_000_000;
	const fetchImpl = async () => {
		calls++;
		return { ok: true, json: async () => ({ username: "u", credential: "c", ttl: 3600, uris: ["turn:x:3478"] }) };
	};
	await resolveCallIceServers({ fetchImpl, now });
	await resolveCallIceServers({ fetchImpl, now: now + 2_600_000 }); // без refreshIfStale
	assert.equal(calls, 1, "старое поведение (ensurePc() при обычном звонке) не меняется этой задачей");
});

test("resolveCallIceServers: нет turnCredentialsUrl в config.json -> прежнее поведение (bootstrap/build-time ICE как есть)", async () => {
	resetRuntimeConfig();
	const result = await resolveCallIceServers();
	assert.deepEqual(result, BUILD_DEFAULT_ICE_SERVERS);
});

test("resolveCallIceServers: turnCredentialsUrl есть, эндпоинт отвечает -> STUN (без кредов) + свежий TURN", async () => {
	await loadRuntimeConfig({
		fetchImpl: async () => ({
			ok: true,
			json: async () => ({ turnCredentialsUrl: "https://ugolok.tech/api/turn-credentials" }),
		}),
	});
	const fetchImpl = async () => ({
		ok: true,
		json: async () => ({ username: "u", credential: "c", ttl: 3600, uris: ["turn:ugolok.tech:3478?transport=udp"] }),
	});
	const result = await resolveCallIceServers({ fetchImpl });
	assert.deepEqual(result, [
		...BUILD_DEFAULT_ICE_SERVERS.map((s) => ({ urls: s.urls })),
		{ urls: "turn:ugolok.tech:3478?transport=udp", username: "u", credential: "c" },
	]);
});

test("resolveCallIceServers: turnCredentialsUrl есть, эндпоинт недоступен -> фолбэк STUN-only (без username/credential)", async () => {
	await loadRuntimeConfig({
		fetchImpl: async () => ({
			ok: true,
			json: async () => ({ turnCredentialsUrl: "https://ugolok.tech/api/turn-credentials" }),
		}),
	});
	const fetchImpl = async () => {
		throw new Error("network down");
	};
	const result = await resolveCallIceServers({ fetchImpl });
	assert.deepEqual(result, BUILD_DEFAULT_ICE_SERVERS.map((s) => ({ urls: s.urls })));
	for (const s of result) {
		assert.equal("username" in s, false);
		assert.equal("credential" in s, false);
	}
});

// Живая проверка (прод, 2026-09-06) — config.json (этап 6) несёт turn: БЕЗ
// username/credential нарочно (креды не в бандле). RTCPeerConnection бросает
// InvalidAccessError СИНХРОННО, если хоть одна запись со схемой turn:/turns:
// в переданном массиве не несёт оба поля разом — падает КОНСТРУКТОР целиком,
// не только эта запись. Старая stripIceCredentials оставляла схему turn: как
// есть, просто без credential — combined-массив (эти "голые" turn: + свежие
// с кредами рядом) ронял ensurePc()/RTCPeerConnection на КАЖДОМ звонке.
// BUILD_DEFAULT_ICE_SERVERS в тестовом окружении пуст (нет __BUILD_*__ define
// вне vite-сборки) — предыдущие 3 теста этот сценарий не ловят вообще.
test("resolveCallIceServers: config.json несёт turn: без кредов рядом со stun: -> голые turn: не остаются в результате (иначе RTCPeerConnection бросает InvalidAccessError)", async () => {
	await loadRuntimeConfig({
		fetchImpl: async () => ({
			ok: true,
			json: async () => ({
				iceServers: [{ urls: "stun:ugolok.tech:3478" }, { urls: "turn:ugolok.tech:3478?transport=udp" }],
				turnCredentialsUrl: "https://ugolok.tech/api/turn-credentials",
			}),
		}),
	});
	const fetchImpl = async () => ({
		ok: true,
		json: async () => ({ username: "u", credential: "c", ttl: 3600, uris: ["turn:ugolok.tech:3478?transport=udp"] }),
	});
	const result = await resolveCallIceServers({ fetchImpl });
	assert.deepEqual(result, [
		{ urls: "stun:ugolok.tech:3478" },
		{ urls: "turn:ugolok.tech:3478?transport=udp", username: "u", credential: "c" },
	]);
	for (const s of result) {
		const urls = Array.isArray(s.urls) ? s.urls : [s.urls];
		const isTurn = urls.some((u) => /^turns?:/i.test(u));
		if (isTurn) {
			assert.equal(typeof s.username, "string", "turn: запись без username бы уронила RTCPeerConnection целиком");
			assert.equal(typeof s.credential, "string", "turn: запись без credential бы уронила RTCPeerConnection целиком");
		}
	}
});

test("resolveCallIceServers: config.json несёт turn: без кредов, эндпоинт недоступен -> фолбэк без turn: вообще (не голый turn:)", async () => {
	await loadRuntimeConfig({
		fetchImpl: async () => ({
			ok: true,
			json: async () => ({
				iceServers: [{ urls: "stun:ugolok.tech:3478" }, { urls: "turn:ugolok.tech:3478?transport=udp" }],
				turnCredentialsUrl: "https://ugolok.tech/api/turn-credentials",
			}),
		}),
	});
	const fetchImpl = async () => {
		throw new Error("network down");
	};
	const result = await resolveCallIceServers({ fetchImpl });
	assert.deepEqual(result, [{ urls: "stun:ugolok.tech:3478" }]);
});
