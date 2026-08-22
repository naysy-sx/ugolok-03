import { test } from "node:test";
import assert from "node:assert/strict";
import { NAV_ITEMS, DEFAULT_ACTIVE } from "../src/ui/nav-items.js";
import ru from "../src/ui/i18n/locales/ru.json" with { type: "json" };

// "subscriptions" переименован в "channels" на этапе 30 (пожелание пользователя —
// полноценный экран каналов вместо пустой заглушки-placeholder).
const REQUIRED_IDS = [
	"contacts",
	"messages",
	"channels",
	"settings",
	"profile",
	"diagnostics",
	"journal", // этап 50
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

// Этап 64 — label заменён на labelKey (dot-path в src/ui/i18n/locales/*.json),
// перевод происходит в месте рендера через t(). Проверяем, что ключ
// действительно резолвится в ru.json (источник истины), не просто непустая строка.
test("labelKey — резолвится в ru.json у каждого пункта", () => {
	for (const item of NAV_ITEMS) {
		const value = item.labelKey.split(".").reduce((node, seg) => node?.[seg], ru);
		assert.equal(typeof value, "string", `labelKey "${item.labelKey}" не резолвится в ru.json (пункт "${item.id}")`);
		assert.ok(value.trim().length > 0, `пустой перевод у "${item.id}"`);
	}
});

test("DEFAULT_ACTIVE указывает на существующий пункт", () => {
	const ids = NAV_ITEMS.map((i) => i.id);
	assert.ok(ids.includes(DEFAULT_ACTIVE));
});

// Этап 50 — "Журнал" стал стартовым экраном после логина (CONTACTS-FSM.md §7).
test("DEFAULT_ACTIVE === 'journal' (этап 50)", () => {
	assert.equal(DEFAULT_ACTIVE, "journal");
});
