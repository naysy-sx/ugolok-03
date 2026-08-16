import { test } from "node:test";
import assert from "node:assert/strict";
import { schema } from "../src/ui/editor/schema.js";

// --- узлы: ровно то, что нужно, ничего лишнего (архитектурный запрет image/hard_break) ---

test("schema: узлы верхнего уровня — ровно ожидаемый набор, без image/hard_break", () => {
	const nodeNames = Object.keys(schema.nodes).sort();
	assert.deepEqual(nodeNames, ["blockquote", "bullet_list", "code_block", "doc", "heading", "horizontal_rule", "list_item", "ordered_list", "paragraph", "text"].sort());
});

test("schema: image узла нет вообще", () => {
	assert.equal(schema.nodes.image, undefined);
});

test("schema: hard_break узла нет вообще", () => {
	assert.equal(schema.nodes.hard_break, undefined);
});

// --- марки: ровно ожидаемый набор ---

test("schema: марки — ровно strong/em/code/link, ничего лишнего", () => {
	const markNames = Object.keys(schema.marks).sort();
	assert.deepEqual(markNames, ["code", "em", "link", "strong"].sort());
});

test("schema: heading допускает level 1-3 через parseDOM", () => {
	const levels = schema.nodes.heading.spec.parseDOM.map((rule) => rule.attrs.level);
	assert.deepEqual(levels.sort(), [1, 2, 3]);
});

// --- документ строится и валиден ---

test("schema: минимальный валидный doc — один пустой paragraph", () => {
	const doc = schema.node("doc", null, [schema.node("paragraph")]);
	assert.doesNotThrow(() => doc.check());
});

test("schema: doc с heading level=2 корректен", () => {
	const doc = schema.node("doc", null, [schema.node("heading", { level: 2 }, schema.text("H"))]);
	assert.doesNotThrow(() => doc.check());
	assert.equal(doc.firstChild.attrs.level, 2);
});

test("schema: bullet_list/ordered_list/list_item создаются и валидны (prosemirror-schema-list)", () => {
	const item = schema.node("list_item", null, [schema.node("paragraph", null, schema.text("x"))]);
	const bulletDoc = schema.node("doc", null, [schema.node("bullet_list", null, [item])]);
	assert.doesNotThrow(() => bulletDoc.check());
	const orderedDoc = schema.node("doc", null, [schema.node("ordered_list", { order: 3 }, [item])]);
	assert.doesNotThrow(() => orderedDoc.check());
	assert.equal(orderedDoc.firstChild.attrs.order, 3);
});

test("schema: blockquote с несколькими paragraph валиден", () => {
	const doc = schema.node("doc", null, [
		schema.node("blockquote", null, [schema.node("paragraph", null, schema.text("a")), schema.node("paragraph", null, schema.text("b"))]),
	]);
	assert.doesNotThrow(() => doc.check());
});

test("schema: code_block не допускает марки на своём тексте (marks: '')", () => {
	assert.equal(schema.nodes.code_block.spec.marks, "");
});

test("schema: horizontal_rule — блочный узел без содержимого", () => {
	const doc = schema.node("doc", null, [schema.node("paragraph"), schema.node("horizontal_rule"), schema.node("paragraph")]);
	assert.doesNotThrow(() => doc.check());
});

// --- марки применяются корректно ---

test("schema: marks strong/em/code/link создаются", () => {
	assert.doesNotThrow(() => schema.marks.strong.create());
	assert.doesNotThrow(() => schema.marks.em.create());
	assert.doesNotThrow(() => schema.marks.code.create());
	assert.doesNotThrow(() => schema.marks.link.create({ href: "https://example.com" }));
});

test("schema: text с несколькими марками одновременно (strong+em) валиден", () => {
	const strongMark = schema.marks.strong.create();
	const emMark = schema.marks.em.create();
	const textNode = schema.text("bi", [strongMark, emMark]);
	const doc = schema.node("doc", null, [schema.node("paragraph", null, textNode)]);
	assert.doesNotThrow(() => doc.check());
});
