import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldForward, buildForwardPayload, forward, PUSH_RELEVANT_KINDS } from "../server/strfry/push-forward.mjs";

// Э-PUSH П0.3(Б)/П1.2 — pushbridge/matcher.go на другой стороне ожидает
// ровно {kind, tags}; эти тесты — контракт на границе JS→Go, менять оба
// файла синхронно, если формат когда-нибудь изменится.

test("shouldForward — только категории из матрицы П0.1 (gift wrap, MLS, звонки)", () => {
	assert.equal(shouldForward({ kind: 1059 }), true);
	assert.equal(shouldForward({ kind: 445 }), true);
	assert.equal(shouldForward({ kind: 20075 }), true);
});

test("shouldForward — каналы и прочее не пересылаются (В2 по умолчанию)", () => {
	assert.equal(shouldForward({ kind: 30060 }), false);
	assert.equal(shouldForward({ kind: 1 }), false);
	assert.equal(shouldForward({ kind: 30073 }), false);
});

test("PUSH_RELEVANT_KINDS содержит ровно три ожидаемых kind'а", () => {
	assert.deepEqual([...PUSH_RELEVANT_KINDS].sort((a, b) => a - b), [445, 1059, 20075]);
});

test("buildForwardPayload — только kind и tags, ничего больше (ИП3: без pubkey/content/id/sig)", () => {
	const event = {
		id: "e".repeat(64),
		pubkey: "p".repeat(64),
		kind: 1059,
		tags: [["p", "recipient-hex"]],
		content: "зашифрованная тайна",
		sig: "s".repeat(128),
		created_at: 1700000000,
	};
	const payload = buildForwardPayload(event);
	assert.deepEqual(Object.keys(payload).sort(), ["kind", "tags"]);
	assert.equal(payload.kind, 1059);
	assert.deepEqual(payload.tags, [["p", "recipient-hex"]]);
});

test("buildForwardPayload — отсутствующие tags не падают (пустой массив)", () => {
	assert.deepEqual(buildForwardPayload({ kind: 445 }).tags, []);
});

test("forward — без url/token ничего не делает (ИП6: остров без push себя не выдаёт)", () => {
	let called = false;
	forward({ kind: 1059, tags: [] }, { url: "", token: "", fetchImpl: () => { called = true; } });
	assert.equal(called, false);
});

test("forward — нерелевантный kind не вызывает fetch", () => {
	let called = false;
	forward({ kind: 1, tags: [] }, { url: "http://bridge/internal/event", token: "t", fetchImpl: () => { called = true; } });
	assert.equal(called, false);
});

test("forward — релевантный kind с настроенным мостом вызывает fetch с ожидаемым телом и заголовком", () => {
	let capturedUrl, capturedOpts;
	const fakeFetch = (url, opts) => {
		capturedUrl = url;
		capturedOpts = opts;
		return Promise.resolve({ ok: true });
	};
	forward(
		{ kind: 20075, tags: [["p", "callee"]], pubkey: "should-not-leak" },
		{ url: "http://bridge.internal/internal/event", token: "secret-token", fetchImpl: fakeFetch },
	);
	assert.equal(capturedUrl, "http://bridge.internal/internal/event");
	assert.equal(capturedOpts.method, "POST");
	assert.equal(capturedOpts.headers.Authorization, "Bearer secret-token");
	const body = JSON.parse(capturedOpts.body);
	assert.deepEqual(body, { kind: 20075, tags: [["p", "callee"]] });
	assert.equal(body.pubkey, undefined);
});

test("forward — не возвращает промис вызывающему (строго асинхронно, П0.3)", () => {
	const result = forward(
		{ kind: 1059, tags: [] },
		{ url: "http://bridge.internal/internal/event", token: "t", fetchImpl: () => Promise.resolve({ ok: true }) },
	);
	assert.equal(result, undefined);
});

test("forward — сбой fetch проглатывается, не бросает исключение синхронно (ИП7)", () => {
	assert.doesNotThrow(() => {
		forward(
			{ kind: 1059, tags: [] },
			{
				url: "http://bridge.internal/internal/event",
				token: "t",
				fetchImpl: () => Promise.reject(new Error("bridge is down")),
			},
		);
	});
});
