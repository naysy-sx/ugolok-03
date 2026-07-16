import { test } from "node:test";
import assert from "node:assert/strict";
import { BUILD_HASH, BUILD_DEFAULT_RELAYS } from "../src/config.js";

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
