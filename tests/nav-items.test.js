import { test } from "node:test";
import assert from "node:assert/strict";
import { NAV_ITEMS, DEFAULT_ACTIVE } from "../src/ui/nav-items.js";

const REQUIRED_IDS = [
	"contacts",
	"messages",
	"subscriptions",
	"settings",
	"profile",
	"diagnostics",
];

test("NAV_ITEMS содержит обязательный минимум пунктов этапа 1", () => {
	const ids = NAV_ITEMS.map((i) => i.id);
	for (const id of REQUIRED_IDS) {
		assert.ok(ids.includes(id), `нет пункта "${id}"`);
	}
});

test("id уникальны и в формате kebab-case", () => {
	const ids = NAV_ITEMS.map((i) => i.id);
	assert.equal(new Set(ids).size, ids.length, "есть дублирующиеся id");
	for (const id of ids) {
		assert.match(id, /^[a-z][a-z0-9-]*$/, `id "${id}" не kebab-case`);
	}
});

test("label — непустая строка у каждого пункта", () => {
	for (const item of NAV_ITEMS) {
		assert.equal(typeof item.label, "string");
		assert.ok(item.label.trim().length > 0, `пустой label у "${item.id}"`);
	}
});

test("DEFAULT_ACTIVE указывает на существующий пункт", () => {
	const ids = NAV_ITEMS.map((i) => i.id);
	assert.ok(ids.includes(DEFAULT_ACTIVE));
});
