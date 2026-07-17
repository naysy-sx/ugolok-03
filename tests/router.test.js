import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRoute, ROUTES, DEFAULT_ROUTE } from "../src/ui/router.js";

test("ROUTES/DEFAULT_ROUTE соответствуют DoD этапа 5", () => {
	assert.deepEqual(ROUTES.sort(), ["/main", "/onboarding", "/unlock"]);
	assert.equal(DEFAULT_ROUTE, "/main");
	assert.ok(ROUTES.includes(DEFAULT_ROUTE));
});

test("parseRoute: известные маршруты с '#' распознаются", () => {
	assert.equal(parseRoute("#/onboarding"), "/onboarding");
	assert.equal(parseRoute("#/main"), "/main");
	assert.equal(parseRoute("#/unlock"), "/unlock");
});

test("parseRoute: работает и без ведущего '#'", () => {
	assert.equal(parseRoute("/onboarding"), "/onboarding");
});

test("parseRoute: пустая строка -> DEFAULT_ROUTE", () => {
	assert.equal(parseRoute(""), DEFAULT_ROUTE);
	assert.equal(parseRoute("#"), DEFAULT_ROUTE);
});

test("parseRoute: неизвестный маршрут -> DEFAULT_ROUTE (нет редиректа/auth-логики)", () => {
	assert.equal(parseRoute("#/bogus"), DEFAULT_ROUTE);
	assert.equal(parseRoute("#/settings"), DEFAULT_ROUTE);
});
