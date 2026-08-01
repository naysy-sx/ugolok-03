import { test } from "node:test";
import assert from "node:assert/strict";
import { BUILD_HASH, BUILD_DEFAULT_RELAYS, BUILD_DEFAULT_ICE_SERVERS, BUILD_BOOTSTRAP_RELAYS } from "../src/config.js";

// Под node --test нет Vite `define`, поэтому __BUILD_HASH__ /
// __BUILD_DEFAULT_RELAYS__ не объявлены — проверяем именно фоллбэк-ветку.
// Реальная build-time подстановка проверяется отдельно по dist/index.html.

test("BUILD_HASH — непустая строка (фоллбэк 'dev' вне сборки)", () => {
	assert.equal(typeof BUILD_HASH, "string");
	assert.ok(BUILD_HASH.length > 0);
	assert.equal(BUILD_HASH, "dev");
});

test("BUILD_DEFAULT_RELAYS — массив (фоллбэк [] вне сборки)", () => {
	assert.ok(Array.isArray(BUILD_DEFAULT_RELAYS));
	assert.deepEqual(BUILD_DEFAULT_RELAYS, []);
});

test("BUILD_DEFAULT_ICE_SERVERS — массив (фоллбэк [] вне сборки, этап 48)", () => {
	assert.ok(Array.isArray(BUILD_DEFAULT_ICE_SERVERS));
	assert.deepEqual(BUILD_DEFAULT_ICE_SERVERS, []);
});

test("BUILD_BOOTSTRAP_RELAYS — массив (фоллбэк [] вне сборки, этап 61)", () => {
	assert.ok(Array.isArray(BUILD_BOOTSTRAP_RELAYS));
	assert.deepEqual(BUILD_BOOTSTRAP_RELAYS, []);
});
