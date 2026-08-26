import { test } from "node:test";
import assert from "node:assert/strict";
import { filterEntries, normalizeForSearch, filterByClass } from "../src/domain/files/filter.js";

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

function file(id, name, mime) {
	return { id, displayName: name, kind: "file", mime };
}
function dir(id, name) {
	return { id, displayName: name, kind: "dir", mime: null };
}

test("filterByClass(all): все записи, включая папки", () => {
	const entries = [dir("d", "Папка"), file("a", "a.mp3", "audio/mpeg"), file("p", "a.pdf", "application/pdf")];
	assert.deepEqual(filterByClass(entries, "all"), entries);
});

test("filterByClass(audio): только audio/*, папки выкинуты", () => {
	const entries = [dir("d", "Папка"), file("a", "a.mp3", "audio/mpeg"), file("i", "i.jpg", "image/jpeg")];
	assert.deepEqual(filterByClass(entries, "audio").map((e) => e.id), ["a"]);
});

test("filterByClass: mime == null не попадает ни в один тип кроме all", () => {
	const unknown = { id: "u", displayName: "x.bin", kind: "file", mime: null };
	const entries = [unknown, file("a", "a.mp3", "audio/mpeg")];
	assert.equal(filterByClass(entries, "audio").length, 1);
	assert.equal(filterByClass(entries, "other").length, 0);
	assert.equal(filterByClass(entries, "image").length, 0);
	assert.ok(filterByClass(entries, "all").some((e) => e.id === "u"));
});

test("filterByClass ∩ поиск по имени", () => {
	const entries = [file("a", "а.mp3", "audio/mpeg"), file("i", "а.jpg", "image/jpeg")];
	const named = filterEntries(entries, "а");
	assert.equal(filterByClass(named, "image").map((e) => e.id).join(), "i");
	assert.equal(filterByClass(named, "audio").map((e) => e.id).join(), "a");
	assert.equal(filterByClass(filterEntries(entries, "а.mp3"), "image").length, 0);
});

test("filterByClass: пустая пачка типа — [] без throw", () => {
	assert.deepEqual(filterByClass([dir("d", "x")], "video"), []);
	assert.deepEqual(filterByClass([], "other"), []);
});
