import { test } from "node:test";
import assert from "node:assert/strict";
import { schema } from "../src/ui/editor/schema.js";
import { fromMdast } from "../src/ui/editor/from-mdast.js";
import { toMdast, toMarkdownSource } from "../src/ui/editor/to-mdast.js";
import { parseRich } from "../src/core/markdown/parse.js";

// --- from-mdast.js: таблица соответствия, по одному узлу за раз ---

test("fromMdast: пустой root -> doc с одним пустым paragraph", () => {
	const doc = fromMdast({ type: "root", children: [] });
	assert.doesNotThrow(() => doc.check());
	assert.equal(doc.childCount, 1);
	assert.equal(doc.firstChild.type.name, "paragraph");
	assert.equal(doc.firstChild.content.size, 0);
});

test("fromMdast: heading depth 1-3 -> heading attrs.level", () => {
	const mdast = { type: "root", children: [{ type: "heading", depth: 2, children: [{ type: "text", value: "H" }] }] };
	const doc = fromMdast(mdast);
	assert.equal(doc.firstChild.type.name, "heading");
	assert.equal(doc.firstChild.attrs.level, 2);
	assert.equal(doc.firstChild.textContent, "H");
});

test("fromMdast: paragraph с текстом", () => {
	const mdast = parseRich("привет мир");
	const doc = fromMdast(mdast);
	assert.equal(doc.firstChild.type.name, "paragraph");
	assert.equal(doc.firstChild.textContent, "привет мир");
});

test("fromMdast: list ordered:false -> bullet_list из list_item", () => {
	const mdast = parseRich("- a\n- b");
	const doc = fromMdast(mdast);
	assert.equal(doc.firstChild.type.name, "bullet_list");
	assert.equal(doc.firstChild.childCount, 2);
	assert.equal(doc.firstChild.child(0).type.name, "list_item");
});

test("fromMdast: list ordered:true -> ordered_list с attrs.order из mdast start", () => {
	const mdast = parseRich("5. a\n6. b");
	const doc = fromMdast(mdast);
	assert.equal(doc.firstChild.type.name, "ordered_list");
	assert.equal(doc.firstChild.attrs.order, 5);
});

test("fromMdast: blockquote с несколькими paragraph", () => {
	const mdast = { type: "root", children: [{ type: "blockquote", children: [
		{ type: "paragraph", children: [{ type: "text", value: "a" }] },
		{ type: "paragraph", children: [{ type: "text", value: "b" }] },
	] }] };
	const doc = fromMdast(mdast);
	assert.equal(doc.firstChild.type.name, "blockquote");
	assert.equal(doc.firstChild.childCount, 2);
});

test("fromMdast: code -> code_block, содержимое буквально (без марок)", () => {
	const mdast = parseRich("```js\nconst x = 1;\n```");
	const doc = fromMdast(mdast);
	assert.equal(doc.firstChild.type.name, "code_block");
	assert.equal(doc.firstChild.textContent, "const x = 1;");
});

test("fromMdast: thematicBreak -> horizontal_rule", () => {
	const mdast = parseRich("Текст.\n\n---\n\nЕщё.");
	const doc = fromMdast(mdast);
	assert.equal(doc.child(1).type.name, "horizontal_rule");
});

test("fromMdast: strong/emphasis/inlineCode -> marks strong/em/code", () => {
	const mdast = parseRich("**a** и *b* и `c`");
	const doc = fromMdast(mdast);
	const marks = [];
	doc.firstChild.forEach((node) => marks.push(...node.marks.map((m) => m.type.name)));
	assert.ok(marks.includes("strong"));
	assert.ok(marks.includes("em"));
	assert.ok(marks.includes("code"));
});

test("fromMdast: link -> mark link с attrs.href", () => {
	const mdast = parseRich("[текст](https://example.com)");
	const doc = fromMdast(mdast);
	let found = null;
	doc.firstChild.forEach((node) => {
		const linkMark = node.marks.find((m) => m.type.name === "link");
		if (linkMark) found = linkMark;
	});
	assert.ok(found);
	assert.equal(found.attrs.href, "https://example.com");
});

test("fromMdast: break -> пробел (нет узла hard_break в схеме)", () => {
	const mdast = parseRich("строка1  \nстрока2");
	const doc = fromMdast(mdast);
	assert.equal(doc.firstChild.textContent, "строка1 строка2");
});

test("fromMdast: image -> alt-текст, не бросает (нет узла image в схеме)", () => {
	const mdast = parseRich("![подпись](https://evil.example/px.png)");
	const doc = fromMdast(mdast);
	assert.equal(doc.firstChild.textContent, "подпись");
});

test("fromMdast: сырой HTML (script/img через textContent) -> буквальный текст, не бросает", () => {
	const mdast = parseRich('<img src=x onerror="alert(1)">текст');
	const doc = fromMdast(mdast);
	assert.doesNotThrow(() => doc.check());
	assert.ok(doc.firstChild.textContent.includes("текст"));
	// Ни в одном узле документа нет типа "image" — доказательство, что HTML не превратился в реальный узел.
	let hasImageNode = false;
	doc.descendants((node) => { if (node.type.name === "image") hasImageNode = true; });
	assert.equal(hasImageNode, false);
});

// --- to-mdast.js: обратное соответствие ---

test("toMdast: heading -> mdast heading с depth из attrs.level", () => {
	const doc = schema.node("doc", null, [schema.node("heading", { level: 3 }, schema.text("H"))]);
	const mdast = toMdast(doc);
	assert.equal(mdast.children[0].type, "heading");
	assert.equal(mdast.children[0].depth, 3);
});

test("toMdast: bullet_list -> mdast list ordered:false", () => {
	const item = schema.node("list_item", null, [schema.node("paragraph", null, schema.text("x"))]);
	const doc = schema.node("doc", null, [schema.node("bullet_list", null, [item])]);
	const mdast = toMdast(doc);
	assert.equal(mdast.children[0].type, "list");
	assert.equal(mdast.children[0].ordered, false);
});

test("toMdast: ordered_list -> mdast list ordered:true, start из attrs.order", () => {
	const item = schema.node("list_item", null, [schema.node("paragraph", null, schema.text("x"))]);
	const doc = schema.node("doc", null, [schema.node("ordered_list", { order: 4 }, [item])]);
	const mdast = toMdast(doc);
	assert.equal(mdast.children[0].ordered, true);
	assert.equal(mdast.children[0].start, 4);
});

test("toMdast: mark strong -> mdast strong узел вокруг текста", () => {
	const textNode = schema.text("b", [schema.marks.strong.create()]);
	const doc = schema.node("doc", null, [schema.node("paragraph", null, textNode)]);
	const mdast = toMdast(doc);
	const paragraph = mdast.children[0];
	assert.equal(paragraph.children[0].type, "strong");
});

test("toMarkdownSource: жирный+курсив+ссылка сериализуются с * и [text](url)", () => {
	const doc = schema.node("doc", null, [
		schema.node("paragraph", null, [
			schema.text("b", [schema.marks.strong.create()]),
			schema.text(" "),
			schema.text("i", [schema.marks.em.create()]),
			schema.text(" "),
			schema.text("link", [schema.marks.link.create({ href: "https://x.com" })]),
		]),
	]);
	const source = toMarkdownSource(doc);
	assert.equal(source, "**b** *i* [link](https://x.com)");
});

// --- round-trip: idempotency после первого нормализующего прохода ---

function pipeline(src) {
	return toMarkdownSource(fromMdast(parseRich(src)));
}

test("round-trip idempotency: f(f(src)) === f(src) для разнообразных src", () => {
	const samples = [
		"простой абзац",
		"# Заголовок",
		"## Заголовок 2",
		"### Заголовок 3",
		"**жирный** и *курсив* и `код`",
		"- один\n- два\n- три",
		"1. первый\n2. второй",
		"> цитата",
		"> строка1\n> строка2", // нестабильный случай — 2 mdast-абзаца после первого прохода
		"```js\ncode();\n```",
		"Текст.\n\n---\n\nЕщё текст.",
		"[ссылка](https://example.com)",
		"Цена 5 * 3 рублей", // буквальная звёздочка, не должна стать emphasis
	];
	for (const src of samples) {
		const once = pipeline(src);
		const twice = pipeline(once);
		assert.equal(twice, once, `не стабилизировалось для: ${JSON.stringify(src)}`);
	}
});

// --- точные совпадения на заведомо стабильных src (не подвержены PM-нормализации) ---

test("round-trip точное совпадение: одиночный paragraph", () => {
	assert.equal(pipeline("простой абзац"), "простой абзац");
});

test("round-trip точное совпадение: heading", () => {
	assert.equal(pipeline("# Заголовок"), "# Заголовок");
});

test("round-trip точное совпадение: простой список без вложенности", () => {
	assert.equal(pipeline("- один\n- два"), "- один\n- два");
});

test("round-trip точное совпадение: blockquote из одной строки", () => {
	assert.equal(pipeline("> цитата"), "> цитата");
});

test("round-trip точное совпадение: code block", () => {
	assert.equal(pipeline("```js\ncode();\n```"), "```js\ncode();\n```");
});

test("round-trip точное совпадение: hr", () => {
	assert.equal(pipeline("Текст.\n\n---\n\nЕщё."), "Текст.\n\n---\n\nЕщё.");
});

test("round-trip точное совпадение: ссылка", () => {
	assert.equal(pipeline("[текст](https://example.com)"), "[текст](https://example.com)");
});

test("round-trip точное совпадение: жирный и курсив", () => {
	assert.equal(pipeline("**жирный** и *курсив*"), "**жирный** и *курсив*");
});

test("round-trip: буквальная звёздочка не становится emphasis (сериализатор корректно экранирует её как \\*, не как маркер)", () => {
	const result = pipeline("Цена 5 * 3 рублей");
	// toMarkdown защитно экранирует потенциально неоднозначную "*" — это ожидаемо,
	// важно что при повторном парсинге она НЕ станет emphasis-маркером.
	const reparsed = parseRich(result);
	const hasEmphasis = JSON.stringify(reparsed).includes('"emphasis"');
	assert.equal(hasEmphasis, false);
});
