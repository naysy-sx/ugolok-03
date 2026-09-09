// MEDIA-PERF-TZ.md §9 — "Ловушка: рассинхрон трёх мест окна Range". service-worker.js
// не проходит сборку Vite (emitServiceWorker копирует текст как есть), импорт
// из src туда не резолвится — константы/формула ПРОДУБЛИРОВАНЫ там вручную,
// зеркалят src/domain/files/sw-timeout.js. Ничего в проекте раньше не мешало
// им незаметно разойтись при правке одного места без другого. Этот тест читает
// РЕАЛЬНЫЙ текст service-worker.js регэкспом и сверяет числа с экспортами
// sw-timeout.js — единственная защита от того, чтобы поведение в браузере
// (не воспроизводится в node --test) тихо разошлось с тем, что проверено тестами.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
	PLAYER_FIRST_WINDOW_BYTES,
	PLAYER_MAX_WINDOW_BYTES,
	FILES_CONTENT_TIMEOUT_FLOOR_MS,
	FILES_CONTENT_TIMEOUT_CEIL_MS,
	WINDOW_TARGET_SECONDS,
	SPEED_SMOOTHING_ALPHA,
	STALL_TIMEOUT_MS,
} from "../src/domain/files/sw-timeout.js";
import { PLAYER_FIRST_WINDOW_BYTES as BRIDGE_PLAYER_FIRST_WINDOW_BYTES } from "../src/domain/files/player-bridge.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const swSource = readFileSync(join(ROOT, "service-worker.js"), "utf8");

// Не eval() даже над своим же локальным файлом — просто перемножаем
// числа, разделённые "*" (единственная форма констант, которая тут
// встречается: "512 * 1024", "4 * 1024 * 1024", "150000").
function safeEvalProduct(expr) {
	const parts = expr.split("*").map((s) => Number(s.trim()));
	assert.ok(parts.every((n) => Number.isFinite(n)), `не число в выражении константы: "${expr}"`);
	return parts.reduce((a, b) => a * b, 1);
}

function extractConst(name) {
	const m = new RegExp(`const ${name}\\s*=\\s*([^;]+);`).exec(swSource);
	assert.ok(m, `service-worker.js должен объявлять const ${name}`);
	return safeEvalProduct(m[1]);
}

test("service-worker.js::PLAYER_FIRST_WINDOW_BYTES совпадает с sw-timeout.js", () => {
	assert.equal(extractConst("PLAYER_FIRST_WINDOW_BYTES"), PLAYER_FIRST_WINDOW_BYTES);
});

test("service-worker.js::PLAYER_MAX_WINDOW_BYTES совпадает с sw-timeout.js", () => {
	assert.equal(extractConst("PLAYER_MAX_WINDOW_BYTES"), PLAYER_MAX_WINDOW_BYTES);
});

test("service-worker.js::FILES_CONTENT_TIMEOUT_FLOOR_MS совпадает с sw-timeout.js", () => {
	assert.equal(extractConst("FILES_CONTENT_TIMEOUT_FLOOR_MS"), FILES_CONTENT_TIMEOUT_FLOOR_MS);
});

test("service-worker.js::FILES_CONTENT_TIMEOUT_CEIL_MS совпадает с sw-timeout.js", () => {
	assert.equal(extractConst("FILES_CONTENT_TIMEOUT_CEIL_MS"), FILES_CONTENT_TIMEOUT_CEIL_MS);
});

test("player-bridge.js::PLAYER_FIRST_WINDOW_BYTES совпадает с sw-timeout.js (третье место)", () => {
	assert.equal(BRIDGE_PLAYER_FIRST_WINDOW_BYTES, PLAYER_FIRST_WINDOW_BYTES);
});

test("service-worker.js::resolveFilesContentTimeoutMs (текст функции) присутствует и использует те же имена констант", () => {
	assert.match(swSource, /function resolveFilesContentTimeoutMs\(expectedBytes\)/);
	assert.match(swSource, /FILES_CONTENT_TIMEOUT_FLOOR_MS \+ \(expectedBytes \/ 32768\) \* 1000/);
});

test("service-worker.js::nextAdaptiveWindow (текст функции) присутствует", () => {
	assert.match(swSource, /function nextAdaptiveWindow\(state, start\)/);
	assert.match(swSource, /Math\.min\(state\.windowBytes \* 2, PLAYER_MAX_WINDOW_BYTES\)/);
});

// MEDIA-PERF-TZ-4.md §6 — рост окна по фактической скорости.
test("service-worker.js::WINDOW_TARGET_SECONDS совпадает с sw-timeout.js", () => {
	assert.equal(extractConst("WINDOW_TARGET_SECONDS"), WINDOW_TARGET_SECONDS);
});

test("service-worker.js::SPEED_SMOOTHING_ALPHA — то же значение, что sw-timeout.js (дробное, не через safeEvalProduct)", () => {
	const m = /const SPEED_SMOOTHING_ALPHA\s*=\s*([^;]+);/.exec(swSource);
	assert.ok(m, "service-worker.js должен объявлять const SPEED_SMOOTHING_ALPHA");
	assert.equal(Number(m[1].trim()), SPEED_SMOOTHING_ALPHA);
});

test("service-worker.js::updateObservedSpeed (текст функции) присутствует", () => {
	assert.match(swSource, /function updateObservedSpeed\(prevBytesPerSec, bytesTransferred, elapsedMs\)/);
});

// MEDIA-PERF-TZ-4.md §5 — детектор простоя.
test("service-worker.js::STALL_TIMEOUT_MS совпадает с sw-timeout.js", () => {
	assert.equal(extractConst("STALL_TIMEOUT_MS"), STALL_TIMEOUT_MS);
});

test("service-worker.js::createStallGuard (текст функции) присутствует, слушает files-content:range-progress", () => {
	assert.match(swSource, /function createStallGuard\(ceilingMs, stallMs, onTimeout\)/);
	assert.match(swSource, /files-content:range-progress/);
	assert.match(swSource, /pending\?\.guard\.progress\(\)/);
	assert.match(swSource, /let stallTimer = null/, "застойный таймер не стартует до первого progress()");
});

test("service-worker.js: пустой clientId — фолбэк на clients.matchAll, не сразу 404", () => {
	assert.match(swSource, /clients\.matchAll\(\{\s*type:\s*"window"\s*\}\)/);
});
