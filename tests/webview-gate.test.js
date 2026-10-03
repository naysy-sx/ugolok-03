import { test } from "node:test";
import assert from "node:assert/strict";
import { parseChromiumMajorVersion, isChromiumTooOld, MIN_CHROMIUM_MAJOR } from "../src/platform/webview-gate.js";

const REAL_MODERN_UA = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.6099.144 Mobile Safari/537.36";
const REAL_OLD_UA = "Mozilla/5.0 (Linux; Android 9; SM-G960F) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/87.0.4280.101 Mobile Safari/537.36";

test("parseChromiumMajorVersion: реальный современный UA", () => {
	assert.equal(parseChromiumMajorVersion(REAL_MODERN_UA), 120);
});

test("parseChromiumMajorVersion: реальный устаревший UA", () => {
	assert.equal(parseChromiumMajorVersion(REAL_OLD_UA), 87);
});

test("parseChromiumMajorVersion: граница MIN_CHROMIUM_MAJOR ровно совпадает", () => {
	assert.equal(parseChromiumMajorVersion(`Chrome/${MIN_CHROMIUM_MAJOR}.0.0.0`), MIN_CHROMIUM_MAJOR);
});

test("parseChromiumMajorVersion: нет подстроки Chrome/ вовсе -> null", () => {
	assert.equal(parseChromiumMajorVersion("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15"), null);
});

test("parseChromiumMajorVersion: пусто/undefined/null -> null, не бросает", () => {
	assert.equal(parseChromiumMajorVersion(""), null);
	assert.equal(parseChromiumMajorVersion(undefined), null);
	assert.equal(parseChromiumMajorVersion(null), null);
});

test("isChromiumTooOld: современный проходит", () => {
	assert.equal(isChromiumTooOld(REAL_MODERN_UA), false);
});

test("isChromiumTooOld: устаревший (87 < 100) блокируется", () => {
	assert.equal(isChromiumTooOld(REAL_OLD_UA), true);
});

test("isChromiumTooOld: ровно MIN_CHROMIUM_MAJOR проходит (граница включительно)", () => {
	assert.equal(isChromiumTooOld(`Chrome/${MIN_CHROMIUM_MAJOR}.0.0.0`), false);
});

test("isChromiumTooOld: на единицу меньше границы блокируется", () => {
	assert.equal(isChromiumTooOld(`Chrome/${MIN_CHROMIUM_MAJOR - 1}.0.0.0`), true);
});

test("isChromiumTooOld: нет Chrome/ вовсе -> блокируется (безопасный отказ, не тихий пропуск)", () => {
	assert.equal(isChromiumTooOld("что-то совсем другое"), true);
});
