import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { probeRelay, probeBlossom, probeIce, withRetry } from "../src/core/transport/endpoint-health.js";

const saved = {
	WebSocket: globalThis.WebSocket,
	fetch: globalThis.fetch,
	RTCPeerConnection: globalThis.RTCPeerConnection,
};

afterEach(() => {
	globalThis.WebSocket = saved.WebSocket;
	globalThis.fetch = saved.fetch;
	globalThis.RTCPeerConnection = saved.RTCPeerConnection;
});

test("probeRelay: мок WebSocket, onopen через 10мс → { ok: true, ms >= 0 }", async () => {
	globalThis.WebSocket = class {
		constructor() {
			this.readyState = 0;
			this.closed = false;
			setTimeout(() => {
				this.readyState = 1;
				this.onopen?.();
			}, 10);
		}
		close() {
			this.closed = true;
			this.readyState = 3;
		}
	};
	const result = await probeRelay("ws://127.0.0.1:7777");
	assert.equal(result.ok, true);
	assert.equal(typeof result.ms, "number");
	assert.ok(result.ms >= 0);
});

test("probeRelay: timeout / onerror → { ok: false, ms: null }", async () => {
	globalThis.WebSocket = class {
		constructor() {
			this.readyState = 0;
			setTimeout(() => {
				this.onerror?.(new Event("error"));
			}, 5);
		}
		close() {
			this.readyState = 3;
		}
	};
	const errored = await probeRelay("ws://127.0.0.1:7777", { timeoutMs: 200 });
	assert.equal(errored.ok, false);
	assert.equal(errored.ms, null);

	globalThis.WebSocket = class {
		constructor() {
			this.readyState = 0;
		}
		close() {
			this.readyState = 3;
		}
	};
	const timedOut = await probeRelay("ws://127.0.0.1:7777", { timeoutMs: 20 });
	assert.equal(timedOut.ok, false);
	assert.equal(timedOut.ms, null);
});

test("probeBlossom: fetch 404 → { ok: true } (сервер жив)", async () => {
	globalThis.fetch = async () => new Response("", { status: 404 });
	const result = await probeBlossom("http://127.0.0.1:8080");
	assert.equal(result.ok, true);
	assert.equal(typeof result.ms, "number");
	assert.ok(result.ms >= 0);
});

test("probeBlossom: fetch reject / abort → { ok: false }", async () => {
	globalThis.fetch = async () => {
		throw new Error("network down");
	};
	const rejected = await probeBlossom("http://127.0.0.1:8080");
	assert.equal(rejected.ok, false);
	assert.equal(rejected.ms, null);

	globalThis.fetch = (_url, opts) =>
		new Promise((_, reject) => {
			opts.signal.addEventListener("abort", () => {
				const err = new Error("aborted");
				err.name = "AbortError";
				reject(err);
			});
		});
	const aborted = await probeBlossom("http://127.0.0.1:8080", { timeoutMs: 15 });
	assert.equal(aborted.ok, false);
	assert.equal(aborted.ms, null);
});

test("probeIce: мок RTCPeerConnection, кандидат пришёл → { ok: true }", async () => {
	globalThis.RTCPeerConnection = class {
		constructor() {
			this.iceGatheringState = "gathering";
			this.onicecandidate = null;
			this.closed = false;
		}
		createDataChannel() {
			return {};
		}
		async createOffer() {
			return { type: "offer", sdp: "" };
		}
		async setLocalDescription() {
			setTimeout(() => {
				this.onicecandidate?.({ candidate: { candidate: "candidate:1 1 UDP 1 127.0.0.1 9 typ host" } });
			}, 8);
		}
		close() {
			this.closed = true;
		}
	};
	const result = await probeIce([{ urls: "stun:127.0.0.1:3478" }]);
	assert.equal(result.ok, true);
	assert.equal(typeof result.ms, "number");
	assert.ok(result.ms >= 0);
});

// Живая проверка (прод, 2026-09-06) — без iceTransportPolicy: "relay" первый
// пришедший ICE-кандидат почти всегда "typ host" (локальный интерфейс, ни
// STUN, ни TURN не нужны) — probeIce считался бы "TURN работает" мгновенно,
// даже если TURN-сервер вообще недоступен. Проверяем, что RTCPeerConnection
// действительно строится с этим полем, а не полагаемся на то, что мок его
// не читает.
test("probeIce: строит RTCPeerConnection с iceTransportPolicy: relay (иначе host-кандидат маскирует нерабочий TURN)", async () => {
	let capturedConfig = null;
	globalThis.RTCPeerConnection = class {
		constructor(config) {
			capturedConfig = config;
			this.iceGatheringState = "gathering";
			this.onicecandidate = null;
		}
		createDataChannel() {
			return {};
		}
		async createOffer() {
			return { type: "offer", sdp: "" };
		}
		async setLocalDescription() {
			setTimeout(() => {
				this.onicecandidate?.({ candidate: { candidate: "candidate:1 1 UDP 1 1.2.3.4 9 typ relay" } });
			}, 8);
		}
		close() {}
	};
	await probeIce([{ urls: "turn:127.0.0.1:3478", username: "u", credential: "c" }]);
	assert.equal(capturedConfig.iceTransportPolicy, "relay");
});

test("withRetry: первая попытка неудачна, вторая успешна → { ok: true }, ровно 2 вызова", async () => {
	let calls = 0;
	const result = await withRetry(
		async () => {
			calls += 1;
			return calls === 1 ? { ok: false, ms: null } : { ok: true, ms: 5 };
		},
		{ attempts: 3, delayMs: 1 },
	);
	assert.equal(result.ok, true);
	assert.equal(calls, 2);
});

test("withRetry: все попытки неудачны → { ok: false }, вызовов ровно attempts", async () => {
	let calls = 0;
	const result = await withRetry(
		async () => {
			calls += 1;
			return { ok: false, ms: null };
		},
		{ attempts: 3, delayMs: 1 },
	);
	assert.equal(result.ok, false);
	assert.equal(calls, 3);
});

test("withRetry: isCancelled() true между попытками → не делает следующий вызов", async () => {
	let calls = 0;
	let cancelled = false;
	const result = await withRetry(
		async () => {
			calls += 1;
			cancelled = true;
			return { ok: false, ms: null };
		},
		{ attempts: 3, delayMs: 1, isCancelled: () => cancelled },
	);
	assert.equal(result.ok, false);
	assert.equal(calls, 1);
});

test("probeIce: timeout без кандидатов → { ok: false }", async () => {
	globalThis.RTCPeerConnection = class {
		constructor() {
			this.iceGatheringState = "gathering";
			this.onicecandidate = null;
		}
		createDataChannel() {
			return {};
		}
		async createOffer() {
			return { type: "offer", sdp: "" };
		}
		async setLocalDescription() {
			return;
		}
		close() {}
	};
	const result = await probeIce([{ urls: "turn:127.0.0.1:3478" }], { timeoutMs: 25 });
	assert.equal(result.ok, false);
	assert.equal(result.ms, null);
});
