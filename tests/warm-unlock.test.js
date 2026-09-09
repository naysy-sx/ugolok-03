import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldSkipColdBootstrap } from "../src/ui/signals/warm-unlock.js";

const A = "aa".repeat(32);
const B = "bb".repeat(32);

test("тёплый unlock: тот же pubkey и валидный lastSeen — пропускаем холодный bootstrap", () => {
	assert.equal(shouldSkipColdBootstrap(A, A, 1_700_000_000), true);
});

test("холодный путь: другой аккаунт", () => {
	assert.equal(shouldSkipColdBootstrap(A, B, 1_700_000_000), false);
});

test("холодный путь: нет lastSession (первая сессия вкладки / reload)", () => {
	assert.equal(shouldSkipColdBootstrap(null, A, 1_700_000_000), false);
	assert.equal(shouldSkipColdBootstrap(undefined, A, 1_700_000_000), false);
});

test("холодный путь: lastSeen отсутствует или 0 (Dexie сброшена / новый origin)", () => {
	assert.equal(shouldSkipColdBootstrap(A, A, 0), false);
	assert.equal(shouldSkipColdBootstrap(A, A, null), false);
	assert.equal(shouldSkipColdBootstrap(A, A, undefined), false);
	assert.equal(shouldSkipColdBootstrap(A, A, Number.NaN), false);
});
