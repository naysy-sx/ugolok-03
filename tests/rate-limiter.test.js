import { test } from "node:test";
import assert from "node:assert/strict";
import { createRateLimiter } from "../src/domain/content/rate-limiter.js";

test("tryAction: первый вызов для actionType всегда true", () => {
	const limiter = createRateLimiter(5000);
	assert.equal(limiter.tryAction("post", 1000), true);
});

test("tryAction: повторный вызов в пределах окна -> false", () => {
	const limiter = createRateLimiter(5000);
	assert.equal(limiter.tryAction("post", 1000), true);
	assert.equal(limiter.tryAction("post", 1000 + 4999), false);
});

test("tryAction: вызов РОВНО на границе окна (=windowMs) -> true (граница)", () => {
	const limiter = createRateLimiter(5000);
	assert.equal(limiter.tryAction("post", 1000), true);
	assert.equal(limiter.tryAction("post", 1000 + 5000), true);
});

test("tryAction: разные actionType не блокируют друг друга", () => {
	const limiter = createRateLimiter(5000);
	assert.equal(limiter.tryAction("post", 1000), true);
	assert.equal(limiter.tryAction("comment", 1000), true, "другой actionType — своё окно");
});

test("tryAction: отклонённая попытка НЕ сдвигает окно (иначе спам-клики продлевали бы блокировку бесконечно)", () => {
	const limiter = createRateLimiter(5000);
	assert.equal(limiter.tryAction("post", 1000), true);
	assert.equal(limiter.tryAction("post", 2000), false); // отклонён, lastActionAt остаётся 1000
	assert.equal(limiter.tryAction("post", 6000), true, "окно считается от ПЕРВОГО успеха (1000), не от отклонённой попытки (2000)");
});
