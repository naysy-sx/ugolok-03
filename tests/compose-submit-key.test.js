import { test } from "node:test";
import assert from "node:assert/strict";
import { isComposeSubmitKey } from "../src/ui/hooks/compose-submit-key.js";

function key(partial) {
	return { key: "Enter", shiftKey: false, isComposing: false, ...partial };
}

test("Enter без Shift и без IME — отправка", () => {
	assert.equal(isComposeSubmitKey(key({})), true);
});

test("Shift+Enter — не отправка (новая строка)", () => {
	assert.equal(isComposeSubmitKey(key({ shiftKey: true })), false);
});

test("IME composing Enter — не отправка", () => {
	assert.equal(isComposeSubmitKey(key({ isComposing: true })), false);
});

test("не Enter — не отправка", () => {
	assert.equal(isComposeSubmitKey(key({ key: "a" })), false);
	assert.equal(isComposeSubmitKey(key({ key: "Escape" })), false);
});
