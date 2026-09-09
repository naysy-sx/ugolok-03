import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("fetchDiscoveryProfiles не делает bulkDelete по снимку EOSE (регрессия T3)", () => {
	const src = readFileSync(join(root, "src/ui/signals/transport.js"), "utf8");
	const start = src.indexOf("export async function fetchDiscoveryProfiles");
	assert.ok(start >= 0);
	const end = src.indexOf("let discoveryLiveSubscriber", start);
	const fn = src.slice(start, end);
	assert.equal(fn.includes(".bulkDelete("), false, "T3: реконсиляция удалением по первому EOSE запрещена");
	assert.match(fn, /\.put\(/);
});
