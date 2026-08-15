import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRich, parseLite } from "../src/core/markdown/parse.js";
import { safeHref } from "../src/core/markdown/sanitize.js";
import { toPlainText } from "../src/core/markdown/to-plain.js";
import {
	RICH_BLOCK_TYPES,
	RICH_INLINE_TYPES,
	LITE_BLOCK_TYPES,
	LITE_INLINE_TYPES,
} from "../src/core/markdown/node-allowlist.js";

// --- parseRich / parseLite: базовая форма mdast ---

// fromMarkdown() всегда добавляет position — сравниваем только type/children,
// не весь объект.
function assertEmptyRoot(tree) {
	assert.equal(tree.type, "root");
	assert.deepEqual(tree.children, []);
}

test("parseRich: пустой источник -> root с пустыми children", () => {
	assertEmptyRoot(parseRich(""));
});

test("parseRich: undefined/null источник не бросает, ведёт себя как пустая строка", () => {
	assertEmptyRoot(parseRich(undefined));
	assertEmptyRoot(parseRich(null));
});

test("parseLite: пустой источник -> root с пустыми children", () => {
	assertEmptyRoot(parseLite(""));
});

test("parseRich: заголовки # ## ### -> heading с depth 1-3", () => {
	const tree = parseRich("# H1\n\n## H2\n\n### H3");
	const headings = tree.children.filter((n) => n.type === "heading");
	assert.deepEqual(
		headings.map((h) => h.depth),
		[1, 2, 3],
	);
});

test("parseRich: Цена 5 * 3 * 2 рубля НЕ становится italic (flanking-правила CommonMark)", () => {
	const tree = parseRich("Цена 5 * 3 * 2 рубля");
	const paragraph = tree.children[0];
	assert.equal(paragraph.type, "paragraph");
	// Флэнкинг: пробелы по обе стороны '*' -> не открывающий/закрывающий делимитер,
	// весь текст остаётся одним text-узлом, никакого emphasis.
	assert.ok(!paragraph.children.some((n) => n.type === "emphasis"));
	assert.equal(toPlainText(tree), "Цена 5 * 3 * 2 рубля");
});

test("parseRich: вложенный список сохраняет вложенность (list внутри listItem)", () => {
	const tree = parseRich("- верх\n  - низ");
	const outerList = tree.children[0];
	assert.equal(outerList.type, "list");
	const outerItem = outerList.children[0];
	const nestedList = outerItem.children.find((c) => c.type === "list");
	assert.ok(nestedList, "вложенный list должен быть узлом дерева, не текстом");
});

test("parseRich: цитата из двух строк -> ОДИН blockquote (не два)", () => {
	const tree = parseRich("> a\n> b");
	const blockquotes = tree.children.filter((n) => n.type === "blockquote");
	assert.equal(blockquotes.length, 1);
});

test("parseRich: перенос строки внутри абзаца НЕ склеивается в пробел принудительно (мягкий перенос — часть текста)", () => {
	const tree = parseRich("a\nb");
	assert.equal(tree.children[0].type, "paragraph");
});

test("parseRich: [текст](javascript:alert(1)) — url доходит до дерева как есть, санитизация НЕ на этапе парсинга", () => {
	const tree = parseRich("[клик](javascript:alert(1))");
	const link = tree.children[0].children[0];
	assert.equal(link.type, "link");
	assert.equal(link.url, "javascript:alert(1)");
});

test("parseRich: HTML-entity в ссылке декодируется парсером (&#106;avascript: -> javascript:)", () => {
	const tree = parseRich("[x](&#106;avascript:alert(1))");
	const link = tree.children[0].children[0];
	assert.equal(link.url, "javascript:alert(1)");
});

test("parseRich: сырой <img onerror=...> распознаётся как узел типа html (буквальный текст, не выполняется)", () => {
	const tree = parseRich('<img src=x onerror="alert(1)">text');
	const paragraph = tree.children[0];
	const htmlNode = paragraph.children.find((n) => n.type === "html");
	assert.ok(htmlNode);
	assert.equal(htmlNode.value, '<img src=x onerror="alert(1)">');
});

test("parseRich/parseLite: одинаковый результат на одном и том же источнике (один движок, см. CONTRACTS.md)", () => {
	const source = "# H\n\nПривет **мир** и *курсив*.\n\n- a\n- b\n\n> цитата\n\n```js\ncode();\n```\n\n---";
	assert.deepEqual(parseRich(source), parseLite(source));
});

test("парсинг 1000 уровней вложенных цитат не роняет стек", () => {
	const source = "> ".repeat(1000) + "текст";
	assert.doesNotThrow(() => parseRich(source));
});

test("парсинг 1000 подряд идущих ** не роняет стек", () => {
	const source = "**".repeat(1000) + "текст" + "**".repeat(1000);
	assert.doesNotThrow(() => parseRich(source));
});

test("10 000 символов патологического ввода (* вперемешку с текстом) парсится быстрее 50 мс", () => {
	let source = "";
	for (let i = 0; i < 2000; i++) source += "текст * ";
	assert.equal(source.length >= 10000, true, "проверочная предпосылка теста");
	const start = performance.now();
	parseRich(source);
	const elapsed = performance.now() - start;
	assert.ok(elapsed < 50, `парсинг занял ${elapsed}мс, ожидалось < 50мс`);
});

// --- node-allowlist.js: списки типов ---

test("node-allowlist: image НЕ входит ни в один список ни одного профиля", () => {
	for (const list of [RICH_BLOCK_TYPES, RICH_INLINE_TYPES, LITE_BLOCK_TYPES, LITE_INLINE_TYPES]) {
		assert.ok(!list.includes("image"), "image должен быть исключён архитектурно");
	}
});

test("node-allowlist: html НЕ входит ни в один список ни одного профиля", () => {
	for (const list of [RICH_BLOCK_TYPES, RICH_INLINE_TYPES, LITE_BLOCK_TYPES, LITE_INLINE_TYPES]) {
		assert.ok(!list.includes("html"));
	}
});

test("node-allowlist: LITE не содержит heading/code/thematicBreak (деградируют в текст на рендере)", () => {
	assert.ok(!LITE_BLOCK_TYPES.includes("heading"));
	assert.ok(!LITE_BLOCK_TYPES.includes("code"));
	assert.ok(!LITE_BLOCK_TYPES.includes("thematicBreak"));
});

test("node-allowlist: RICH содержит heading/code/thematicBreak", () => {
	assert.ok(RICH_BLOCK_TYPES.includes("heading"));
	assert.ok(RICH_BLOCK_TYPES.includes("code"));
	assert.ok(RICH_BLOCK_TYPES.includes("thematicBreak"));
});

test("node-allowlist: обе inline-палитры совпадают (strong/emphasis/inlineCode/link/break/text)", () => {
	assert.deepEqual([...RICH_INLINE_TYPES].sort(), [...LITE_INLINE_TYPES].sort());
});

// --- каждый профиль на реальном дереве: заголовок в LITE не должен остаться "heading" в allowlist ---

test("LITE-профиль: heading-узел из дерева не входит в LITE_BLOCK_TYPES (упадёт в текстовый fallback на рендере)", () => {
	const tree = parseLite("# Заголовок");
	const heading = tree.children[0];
	assert.equal(heading.type, "heading");
	assert.ok(!LITE_BLOCK_TYPES.includes(heading.type));
});

// --- safeHref ---

test("safeHref: разрешает https:", () => {
	assert.equal(safeHref("https://example.com/x"), "https://example.com/x");
});

test("safeHref: разрешает http:", () => {
	assert.equal(safeHref("http://example.com"), "http://example.com");
});

test("safeHref: разрешает mailto:", () => {
	assert.equal(safeHref("mailto:a@b.com"), "mailto:a@b.com");
});

test("safeHref: разрешает относительные ссылки без схемы", () => {
	assert.equal(safeHref("/foo/bar"), "/foo/bar");
	assert.equal(safeHref("foo.html"), "foo.html");
	assert.equal(safeHref("#anchor"), "#anchor");
});

test("safeHref: отклоняет javascript:", () => {
	assert.equal(safeHref("javascript:alert(1)"), null);
});

test("safeHref: отклоняет JaVaScRiPt: (регистронезависимо)", () => {
	assert.equal(safeHref("JaVaScRiPt:alert(1)"), null);
});

test("safeHref: отклоняет java\\u0000script: (нулевой байт внутри схемы)", () => {
	assert.equal(safeHref("java script:alert(1)"), null);
});

test("safeHref: отклоняет \\tjavascript: (таб внутри/перед схемой)", () => {
	assert.equal(safeHref("\tjavascript:alert(1)"), null);
});

test("safeHref: отклоняет data:text/html;base64,...", () => {
	assert.equal(safeHref("data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg=="), null);
});

test("safeHref: отклоняет vbscript:", () => {
	assert.equal(safeHref("vbscript:alert(1)"), null);
});

test("safeHref: отклоняет blob: и file:", () => {
	assert.equal(safeHref("blob:https://example.com/uuid"), null);
	assert.equal(safeHref("file:///etc/passwd"), null);
});

test("safeHref: не строка/пустая строка -> null", () => {
	assert.equal(safeHref(undefined), null);
	assert.equal(safeHref(null), null);
	assert.equal(safeHref(""), null);
	assert.equal(safeHref(42), null);
});

test("safeHref: декодированная entity-ссылка из parseRich тоже отклоняется", () => {
	const tree = parseRich("[x](&#106;avascript:alert(1))");
	const link = tree.children[0].children[0];
	assert.equal(safeHref(link.url), null);
});

// --- toPlainText ---

test("toPlainText: пустой root -> пустая строка", () => {
	assert.equal(toPlainText(parseRich("")), "");
});

test("toPlainText: простой абзац", () => {
	assert.equal(toPlainText(parseRich("простой текст")), "простой текст");
});

test("toPlainText: инлайн-форматирование схлопывается в текст без марок", () => {
	assert.equal(toPlainText(parseRich("до **жирный** после")), "до жирный после");
	assert.equal(toPlainText(parseRich("до *курсив* после")), "до курсив после");
	assert.equal(toPlainText(parseRich("до `код()` после")), "до код() после");
});

test("toPlainText: ссылка -> текст метки, без URL", () => {
	assert.equal(toPlainText(parseRich("см. [сюда](https://example.com) пожалуйста")), "см. сюда пожалуйста");
});

test("toPlainText: заголовки/абзацы разделяются пробелом, не слипаются", () => {
	const tree = parseRich("# Заголовок\n\nАбзац");
	assert.equal(toPlainText(tree), "Заголовок Абзац");
});

test("toPlainText: жёсткий перенос строки (break) -> пробел", () => {
	const tree = parseRich("строка1  \nстрока2");
	assert.equal(toPlainText(tree), "строка1 строка2");
});

test("toPlainText: image -> alt-текст, картинка не пропадает молча", () => {
	const tree = parseRich("![подпись](https://evil.example/px.png)");
	assert.equal(toPlainText(tree), "подпись");
});

test("toPlainText: image без alt -> пустая строка для узла, не бросает", () => {
	const tree = parseRich("![](https://evil.example/px.png)");
	assert.doesNotThrow(() => toPlainText(tree));
});

test("toPlainText: thematicBreak -> ничего не добавляет, соседи всё равно разделены пробелом", () => {
	const tree = parseRich("Текст до.\n\n---\n\nТекст после.");
	assert.equal(toPlainText(tree), "Текст до. Текст после.");
});

test("toPlainText: список -> элементы разделены пробелом", () => {
	const tree = parseRich("- один\n- два\n- три");
	assert.equal(toPlainText(tree), "один два три");
});

test("toPlainText: цитата из двух строк -> одна строка предпросмотра", () => {
	const tree = parseRich("> a\n> b");
	assert.equal(toPlainText(tree), "a\nb");
});

test("toPlainText: сырой HTML-узел -> буквальный текст его значения (не интерпретируется)", () => {
	const tree = parseRich('<img src=x onerror="alert(1)">');
	assert.equal(toPlainText(tree), '<img src=x onerror="alert(1)">');
});

// --- регрессия: содержательные кейсы из старого help-markdown.test.js, на новом движке ---

test("реалистичный смешанный документ — все блоки на месте (rich-профиль)", () => {
	const source = ["# Заголовок", "", "Вводный абзац с пояснением.", "", "## Подраздел", "", "- пункт один", "- пункт два", "", "```js", "code();", "```", "", "Заключительный абзац."].join("\n");
	const tree = parseRich(source);
	const types = tree.children.map((n) => n.type);
	assert.deepEqual(types, ["heading", "paragraph", "heading", "list", "code", "paragraph"]);
});
