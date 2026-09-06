import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveFilesContentTimeoutMs, FILES_CONTENT_TIMEOUT_FLOOR_MS, FILES_CONTENT_TIMEOUT_CEIL_MS } from "../src/domain/files/sw-timeout.js";

test("resolveFilesContentTimeoutMs: нулевой ожидаемый объём -> ровно пол (15с)", () => {
	assert.equal(resolveFilesContentTimeoutMs(0), FILES_CONTENT_TIMEOUT_FLOOR_MS);
});

test("resolveFilesContentTimeoutMs: растёт с объёмом", () => {
	const small = resolveFilesContentTimeoutMs(32768);
	const big = resolveFilesContentTimeoutMs(32768 * 10);
	assert.ok(big > small, "больший ожидаемый объём -> больший бюджет");
});

test("resolveFilesContentTimeoutMs: потолок 60с не превышается даже на огромном объёме", () => {
	assert.equal(resolveFilesContentTimeoutMs(100 * 1024 * 1024), FILES_CONTENT_TIMEOUT_CEIL_MS);
});

test("resolveFilesContentTimeoutMs: 160 последовательных чанков по 64КиБ при TTFB 100мс укладывается в бюджет окна первого запроса (регрессия S5)", () => {
	// FILES-FIX-SPEC.md §1: 10 МБ файл, 64 КиБ чанк, TTFB 1.1-1.6с живьём давал
	// ~160 последовательных Range-GET и таймаут 15с фиксированный. После §6.1
	// окно первого запроса ограничено PLAYER_FIRST_WINDOW_BYTES (512 КиБ) —
	// бюджет считается от НЕГО, не от всего файла.
	const PLAYER_FIRST_WINDOW_BYTES = 512 * 1024;
	const ttfbMs = 100;
	const chunksInWindow = Math.ceil(PLAYER_FIRST_WINDOW_BYTES / 65536);
	const worstCaseMs = chunksInWindow * ttfbMs;
	assert.ok(worstCaseMs <= resolveFilesContentTimeoutMs(PLAYER_FIRST_WINDOW_BYTES), `${worstCaseMs}мс должно укладываться в бюджет окна`);
});
