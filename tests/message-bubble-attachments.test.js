import { test } from "node:test";
import assert from "node:assert/strict";
import { splitBubbleAttachments } from "../src/ui/components/message-bubble-attachments.js";

test("splitBubbleAttachments: undefined -> {above:null, below:[]}", () => {
	assert.deepEqual(splitBubbleAttachments(undefined), { above: null, below: [] });
});

test("splitBubbleAttachments: пустой массив -> {above:null, below:[]}", () => {
	assert.deepEqual(splitBubbleAttachments([]), { above: null, below: [] });
});

test("splitBubbleAttachments: один элемент без position -> below", () => {
	const a = { type: "image", mime: "image/png" };
	assert.deepEqual(splitBubbleAttachments([a]), { above: null, below: [a] });
});

test("splitBubbleAttachments: один элемент image position=above -> above", () => {
	const a = { type: "image", position: "above" };
	assert.deepEqual(splitBubbleAttachments([a]), { above: a, below: [] });
});

test("splitBubbleAttachments: не-image с position=above игнорируется (не поднимается)", () => {
	const a = { type: "file", position: "above" };
	assert.deepEqual(splitBubbleAttachments([a]), { above: null, below: [a] });
});

test("splitBubbleAttachments: несколько вложений — только ПЕРВОЕ image position=above уходит наверх", () => {
	const text = { type: "file" };
	const img1 = { type: "image", position: "above" };
	const img2 = { type: "image", position: "above" };
	const result = splitBubbleAttachments([text, img1, img2]);
	assert.equal(result.above, img1);
	assert.deepEqual(result.below, [text, img2]);
});

test("splitBubbleAttachments: position=above у НЕ первого image в списке — первый по порядку побеждает, а не первый image вообще", () => {
	const img1 = { type: "image" }; // без above
	const img2 = { type: "image", position: "above" };
	const result = splitBubbleAttachments([img1, img2]);
	assert.equal(result.above, img2);
	assert.deepEqual(result.below, [img1]);
});

test("splitBubbleAttachments: below сохраняет исходный порядок за вычетом above-элемента", () => {
	const a = { id: "a" };
	const above = { type: "image", position: "above", id: "above" };
	const b = { id: "b" };
	const result = splitBubbleAttachments([a, above, b]);
	assert.deepEqual(result.below, [a, b]);
});
