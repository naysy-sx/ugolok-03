import { test } from "node:test";
import assert from "node:assert/strict";
import { applyFormat } from "../src/core/markdown/format-insert.js";

// --- bold ---

test("bold: без выделения, курсор в пустой строке -> **** с курсором посередине", () => {
	const result = applyFormat("bold", { value: "", selectionStart: 0, selectionEnd: 0 });
	assert.deepEqual(result, { text: "****", replaceStart: 0, replaceEnd: 0, selectStart: 2, selectEnd: 2 });
});

test("bold: без выделения, курсор в середине текста", () => {
	const value = "привет мир";
	const result = applyFormat("bold", { value, selectionStart: 7, selectionEnd: 7 });
	assert.deepEqual(result, { text: "****", replaceStart: 7, replaceEnd: 7, selectStart: 9, selectEnd: 9 });
});

test("bold: с выделением — оборачивает и выделяет весь новый блок", () => {
	const value = "привет мир";
	const result = applyFormat("bold", { value, selectionStart: 7, selectionEnd: 10 });
	assert.deepEqual(result, { text: "**мир**", replaceStart: 7, replaceEnd: 10, selectStart: 7, selectEnd: 14 });
});

// --- italic ---

test("italic: без выделения -> ** одиночный маркер с курсором посередине", () => {
	const result = applyFormat("italic", { value: "текст", selectionStart: 2, selectionEnd: 2 });
	assert.deepEqual(result, { text: "**", replaceStart: 2, replaceEnd: 2, selectStart: 3, selectEnd: 3 });
});

test("italic: с выделением", () => {
	const value = "текст курсив здесь";
	const result = applyFormat("italic", { value, selectionStart: 6, selectionEnd: 12 });
	assert.deepEqual(result, { text: "*курсив*", replaceStart: 6, replaceEnd: 12, selectStart: 6, selectEnd: 14 });
});

// --- link ---

test("link: без выделения -> []() с курсором между [ и ]", () => {
	const result = applyFormat("link", { value: "текст", selectionStart: 2, selectionEnd: 2 });
	assert.deepEqual(result, { text: "[]()", replaceStart: 2, replaceEnd: 2, selectStart: 3, selectEnd: 3 });
});

test("link: с выделением -> курсор между ( и ), не выделение", () => {
	const value = "click here now";
	const result = applyFormat("link", { value, selectionStart: 6, selectionEnd: 10 });
	// text = "[here]()", "[here](".length === 7 -> selectStart = 6+7 = 13
	assert.deepEqual(result, { text: "[here]()", replaceStart: 6, replaceEnd: 10, selectStart: 13, selectEnd: 13 });
});

// --- quote (построчный префикс) ---

test("quote: пустое выделение на единственной строке без \\n вокруг", () => {
	const value = "hello world";
	const result = applyFormat("quote", { value, selectionStart: 5, selectionEnd: 5 });
	assert.deepEqual(result, { text: "> hello world", replaceStart: 0, replaceEnd: 11, selectStart: 0, selectEnd: 13 });
});

test("quote: выделение охватывает две строки из трёх -> префикс на обеих, третья не тронута", () => {
	const value = "line1\nline2\nline3";
	const result = applyFormat("quote", { value, selectionStart: 0, selectionEnd: 11 });
	assert.deepEqual(result, { text: "> line1\n> line2", replaceStart: 0, replaceEnd: 11, selectStart: 0, selectEnd: 15 });
});

test("quote: курсор в средней строке из трёх (без выделения) -> префикс только на средней", () => {
	const value = "line1\nline2\nline3";
	// курсор внутри "line2" (индекс 8, между 'i' и 'n')
	const result = applyFormat("quote", { value, selectionStart: 8, selectionEnd: 8 });
	// lineStart = lastIndexOf("\n", 7) + 1 = 5 + 1 = 6; lineEnd = indexOf("\n", 8) = 11
	assert.deepEqual(result, { text: "> line2", replaceStart: 6, replaceEnd: 11, selectStart: 6, selectEnd: 13 });
});

// --- list (построчный префикс) ---

test("list: пустое выделение -> префикс - на текущей строке", () => {
	const value = "пункт";
	const result = applyFormat("list", { value, selectionStart: 0, selectionEnd: 0 });
	assert.deepEqual(result, { text: "- пункт", replaceStart: 0, replaceEnd: 5, selectStart: 0, selectEnd: 7 });
});

test("list: выделение на трёх строках -> префикс на всех трёх", () => {
	const value = "a\nb\nc";
	const result = applyFormat("list", { value, selectionStart: 0, selectionEnd: 5 });
	assert.deepEqual(result, { text: "- a\n- b\n- c", replaceStart: 0, replaceEnd: 5, selectStart: 0, selectEnd: 11 });
});

// --- граничные случаи ---

test("bold: выделение занимает весь текст", () => {
	const value = "весь текст";
	const result = applyFormat("bold", { value, selectionStart: 0, selectionEnd: value.length });
	assert.equal(result.text, "**весь текст**");
	assert.equal(result.replaceStart, 0);
	assert.equal(result.replaceEnd, value.length);
});

test("quote: выделение в последней строке без завершающего \\n -> lineEnd = value.length", () => {
	const value = "line1\nline2";
	const result = applyFormat("quote", { value, selectionStart: 6, selectionEnd: 6 });
	// lineStart = lastIndexOf("\n", 5)+1 = 5+1 = 6; lineEnd = indexOf("\n", 6) = -1 -> value.length = 11
	assert.deepEqual(result, { text: "> line2", replaceStart: 6, replaceEnd: 11, selectStart: 6, selectEnd: 13 });
});

test("bold/italic/quote/list/link: неизвестный kind не предусмотрен контрактом — функция вызывается только с валидными kind (не тестируем как ошибку намеренно)", () => {
	// Документирующий тест: применённые kind покрывают весь набор кнопок панели.
	const kinds = ["bold", "italic", "quote", "list", "link"];
	for (const kind of kinds) {
		assert.doesNotThrow(() => applyFormat(kind, { value: "x", selectionStart: 0, selectionEnd: 1 }));
	}
});
