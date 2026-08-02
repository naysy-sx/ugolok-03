import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMarkdown, parseInline } from "../src/domain/help/markdown.js";

test("parseMarkdown: пустой источник -> []", () => {
	assert.deepEqual(parseMarkdown(""), []);
});

test("parseMarkdown: заголовки # ## ### по уровням", () => {
	const blocks = parseMarkdown("# Заголовок 1\n## Заголовок 2\n### Заголовок 3");
	assert.deepEqual(blocks, [
		{ type: "heading", level: 1, text: "Заголовок 1" },
		{ type: "heading", level: 2, text: "Заголовок 2" },
		{ type: "heading", level: 3, text: "Заголовок 3" },
	]);
});

test("parseMarkdown: абзацы разделяются пустой строкой", () => {
	const blocks = parseMarkdown("Первый абзац.\n\nВторой абзац.");
	assert.deepEqual(blocks, [
		{ type: "paragraph", text: "Первый абзац." },
		{ type: "paragraph", text: "Второй абзац." },
	]);
});

test("parseMarkdown: многострочный абзац склеивается в одну строку с пробелом", () => {
	const blocks = parseMarkdown("Строка один\nстрока два, продолжение.");
	assert.deepEqual(blocks, [{ type: "paragraph", text: "Строка один строка два, продолжение." }]);
});

test("parseMarkdown: маркированный список (- )", () => {
	const blocks = parseMarkdown("- один\n- два\n- три");
	assert.deepEqual(blocks, [{ type: "list", ordered: false, items: ["один", "два", "три"] }]);
});

test("parseMarkdown: маркированный список (* )", () => {
	const blocks = parseMarkdown("* alpha\n* beta");
	assert.deepEqual(blocks, [{ type: "list", ordered: false, items: ["alpha", "beta"] }]);
});

test("parseMarkdown: нумерованный список (1. 2. ...)", () => {
	const blocks = parseMarkdown("1. первый\n2. второй\n3. третий");
	assert.deepEqual(blocks, [{ type: "list", ordered: true, items: ["первый", "второй", "третий"] }]);
});

test("parseMarkdown: список закрывается обычным абзацем после себя", () => {
	const blocks = parseMarkdown("- один\n- два\n\nОбычный текст.");
	assert.deepEqual(blocks, [
		{ type: "list", ordered: false, items: ["один", "два"] },
		{ type: "paragraph", text: "Обычный текст." },
	]);
});

test("parseMarkdown: блок кода — содержимое НЕ парсится как markdown (буквальный текст)", () => {
	const blocks = parseMarkdown("```js\nconst x = 1;\n# not a heading\n```");
	assert.deepEqual(blocks, [{ type: "code", lang: "js", code: "const x = 1;\n# not a heading" }]);
});

test("parseMarkdown: блок кода без указания языка -> lang пустая строка", () => {
	const blocks = parseMarkdown("```\nplain text\n```");
	assert.deepEqual(blocks, [{ type: "code", lang: "", code: "plain text" }]);
});

test("parseMarkdown: пустые строки ВНУТРИ код-блока сохраняются буквально", () => {
	const blocks = parseMarkdown("```\nline1\n\nline3\n```");
	assert.equal(blocks[0].code, "line1\n\nline3");
});

test("parseMarkdown: цитата (> )", () => {
	const blocks = parseMarkdown("> цитата текста");
	assert.deepEqual(blocks, [{ type: "blockquote", text: "цитата текста" }]);
});

test("parseMarkdown: горизонтальная линия (---)", () => {
	const blocks = parseMarkdown("Текст до.\n\n---\n\nТекст после.");
	assert.deepEqual(blocks, [
		{ type: "paragraph", text: "Текст до." },
		{ type: "hr" },
		{ type: "paragraph", text: "Текст после." },
	]);
});

test("parseMarkdown: смешанный документ реалистичного вида", () => {
	const source = [
		"# Заголовок",
		"",
		"Вводный абзац с пояснением.",
		"",
		"## Подраздел",
		"",
		"- пункт один",
		"- пункт два",
		"",
		"```js",
		"code();",
		"```",
		"",
		"Заключительный абзац.",
	].join("\n");
	const blocks = parseMarkdown(source);
	assert.deepEqual(blocks, [
		{ type: "heading", level: 1, text: "Заголовок" },
		{ type: "paragraph", text: "Вводный абзац с пояснением." },
		{ type: "heading", level: 2, text: "Подраздел" },
		{ type: "list", ordered: false, items: ["пункт один", "пункт два"] },
		{ type: "code", lang: "js", code: "code();" },
		{ type: "paragraph", text: "Заключительный абзац." },
	]);
});

// --- parseInline ---

test("parseInline: обычный текст без форматирования", () => {
	assert.deepEqual(parseInline("простой текст"), [{ type: "text", value: "простой текст" }]);
});

test("parseInline: **bold**", () => {
	assert.deepEqual(parseInline("до **жирный** после"), [
		{ type: "text", value: "до " },
		{ type: "bold", children: [{ type: "text", value: "жирный" }] },
		{ type: "text", value: " после" },
	]);
});

test("parseInline: *italic* (одна звёздочка)", () => {
	assert.deepEqual(parseInline("до *курсив* после"), [
		{ type: "text", value: "до " },
		{ type: "italic", children: [{ type: "text", value: "курсив" }] },
		{ type: "text", value: " после" },
	]);
});

test("parseInline: `код`", () => {
	assert.deepEqual(parseInline("до `код()` после"), [
		{ type: "text", value: "до " },
		{ type: "code", value: "код()" },
		{ type: "text", value: " после" },
	]);
});

test("parseInline: [текст](ссылка)", () => {
	assert.deepEqual(parseInline("см. [сюда](https://example.com) пожалуйста"), [
		{ type: "text", value: "см. " },
		{ type: "link", href: "https://example.com", children: [{ type: "text", value: "сюда" }] },
		{ type: "text", value: " пожалуйста" },
	]);
});

test("parseInline: вложенный italic внутри bold", () => {
	assert.deepEqual(parseInline("**жирный *и курсив* внутри**"), [
		{
			type: "bold",
			children: [
				{ type: "text", value: "жирный " },
				{ type: "italic", children: [{ type: "text", value: "и курсив" }] },
				{ type: "text", value: " внутри" },
			],
		},
	]);
});

test("parseInline: несколько независимых форматирований подряд", () => {
	assert.deepEqual(parseInline("**a** и *b* и `c`"), [
		{ type: "bold", children: [{ type: "text", value: "a" }] },
		{ type: "text", value: " и " },
		{ type: "italic", children: [{ type: "text", value: "b" }] },
		{ type: "text", value: " и " },
		{ type: "code", value: "c" },
	]);
});

test("parseInline: пустая строка -> []", () => {
	assert.deepEqual(parseInline(""), []);
});

test("parseInline: незакрытый маркер -> трактуется как обычный текст, не бросает", () => {
	assert.deepEqual(parseInline("текст **без закрытия"), [{ type: "text", value: "текст **без закрытия" }]);
});
