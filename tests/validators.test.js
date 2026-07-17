import { test } from "node:test";
import assert from "node:assert/strict";
import { generateSecretKey, finalizeEvent } from "nostr-tools/pure";
import { validateEventId } from "../src/domain/events/validators.js";

function realEvent(overrides = {}) {
	const sk = generateSecretKey();
	return finalizeEvent(
		{ kind: 1, created_at: 1000, tags: [], content: "hello", ...overrides },
		sk,
	);
}

test("validateEventId: true для корректно вычисленного id (nostr-tools finalizeEvent)", () => {
	const ev = realEvent();
	assert.equal(validateEventId(ev), true);
});

test("validateEventId: false если content подменён после вычисления id", () => {
	const ev = realEvent();
	const tampered = { ...ev, content: "изменённый контент" };
	assert.equal(validateEventId(tampered), false);
});

test("validateEventId: false если id — случайная строка", () => {
	const ev = realEvent();
	assert.equal(validateEventId({ ...ev, id: "0".repeat(64) }), false);
});

test("validateEventId: false (не throw) на некорректной форме события", () => {
	assert.equal(validateEventId({ id: "x" }), false);
	assert.equal(
		validateEventId({
			id: "x",
			pubkey: "pk",
			created_at: 1,
			kind: 1,
			tags: "не массив",
			content: "c",
		}),
		false,
	);
});

test("validateEventId: не проверяет sig — событие с плохой подписью, но верным id, всё равно true", () => {
	const ev = realEvent();
	assert.equal(validateEventId({ ...ev, sig: "0".repeat(128) }), true);
});
