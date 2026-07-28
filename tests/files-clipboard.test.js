import { test } from "node:test";
import assert from "node:assert/strict";
import { createClipboard, copyToClipboard, cutToClipboard, paste, cancelClipboard } from "../src/domain/files/clipboard.js";

test("Empty --copy--> Copied --paste--> Empty (§4.1 MATH.md, буквально)", () => {
	let c = createClipboard();
	assert.equal(c.state, "empty");
	c = copyToClipboard(c, ["a", "b"]);
	assert.equal(c.state, "copied");
	assert.deepEqual(c.selection, ["a", "b"]);
	c = paste(c);
	assert.equal(c.state, "empty");
	assert.deepEqual(c.selection, []);
});

test("Empty --cut--> Cut --paste--> Empty (§4.1 MATH.md, буквально)", () => {
	let c = createClipboard();
	c = cutToClipboard(c, ["x"]);
	assert.equal(c.state, "cut");
	c = paste(c);
	assert.equal(c.state, "empty");
});

test("переключение выделения без paste: Copied -> Cut и наоборот разрешено", () => {
	let c = createClipboard();
	c = copyToClipboard(c, ["a"]);
	c = cutToClipboard(c, ["b"]);
	assert.equal(c.state, "cut");
	assert.deepEqual(c.selection, ["b"]);
	c = copyToClipboard(c, ["c"]);
	assert.equal(c.state, "copied");
	assert.deepEqual(c.selection, ["c"]);
});

test("paste из empty -> исключение (нет перехода, не молчаливый no-op)", () => {
	const c = createClipboard();
	assert.throws(() => paste(c));
});

test("cancel из copied/cut возвращает в empty, из empty — no-op", () => {
	let c = createClipboard();
	c = copyToClipboard(c, ["a"]);
	c = cancelClipboard(c);
	assert.equal(c.state, "empty");
	assert.deepEqual(c.selection, []);

	const stillEmpty = cancelClipboard(createClipboard());
	assert.equal(stillEmpty.state, "empty");
});
