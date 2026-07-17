import { test } from "node:test";
import assert from "node:assert/strict";
import {
	KIND_MLS_KEY_PACKAGE,
	KIND_MLS_WELCOME,
	KIND_MLS_GROUP_MESSAGE,
	KIND_MLS_KEY_PACKAGE_RELAYS,
} from "../src/domain/events/kinds.js";

test("NIP-EE kind-константы совпадают со спецификацией", () => {
	assert.equal(KIND_MLS_KEY_PACKAGE, 443);
	assert.equal(KIND_MLS_WELCOME, 444);
	assert.equal(KIND_MLS_GROUP_MESSAGE, 445);
	assert.equal(KIND_MLS_KEY_PACKAGE_RELAYS, 10051);
});

test("kind-константы не пересекаются с уже занятыми kind проекта (30050-30072, стандартные NIP)", () => {
	const taken = new Set([0, 3, 5, 13, 14, 1059, 10002, 22242, 24242, 30050, 30051, 30053, 30054, 30060, 30061, 30062, 30070, 30071, 30072]);
	for (const k of [KIND_MLS_KEY_PACKAGE, KIND_MLS_WELCOME, KIND_MLS_GROUP_MESSAGE, KIND_MLS_KEY_PACKAGE_RELAYS]) {
		assert.equal(taken.has(k), false, `kind ${k} пересекается с уже занятым`);
	}
});
