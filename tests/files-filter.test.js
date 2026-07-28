import { test } from "node:test";
import assert from "node:assert/strict";
import { filterEntries, normalizeForSearch } from "../src/domain/files/filter.js";

function entry(id, name) {
	return { id, displayName: name };
}

test("filterEntries: пустой запрос -> все записи без изменений", () => {
	const entries = [entry("a", "Фото"), entry("b", "Видео")];
	assert.deepEqual(filterEntries(entries, ""), entries);
	assert.deepEqual(filterEntries(entries, "   "), entries);
});

test("filterEntries: регистронезависимо", () => {
	const entries = [entry("a", "Отчёт.pdf"), entry("b", "фото.jpg")];
	assert.deepEqual(
		filterEntries(entries, "ОТЧЁТ").map((e) => e.id),
		["a"],
	);
	assert.deepEqual(
		filterEntries(entries, "фото").map((e) => e.id),
		["b"],
	);
});

test("filterEntries: подстрока в любом месте имени", () => {
	const entries = [entry("a", "квартальный-отчёт-2026.pdf")];
	assert.equal(filterEntries(entries, "отчёт").length, 1);
	assert.equal(filterEntries(entries, "2026").length, 1);
	assert.equal(filterEntries(entries, "несуществующее").length, 0);
});

test("normalizeForSearch: НЕ ломается на юникод-нормализации разных форм (композит vs декомпозиция)", () => {
	const composed = "é"; // é единым символом
	const decomposed = "é"; // e + акцент отдельным символом
	assert.equal(normalizeForSearch(composed), normalizeForSearch(decomposed));
});

test("filterEntries: запрос с пробелами по краям обрезается", () => {
	const entries = [entry("a", "Документы")];
	assert.equal(filterEntries(entries, "  документы  ").length, 1);
});
