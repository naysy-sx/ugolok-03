import { test } from "node:test";
import assert from "node:assert/strict";
import { kindOf, attachmentPlacement, GUTTER_THUMBNAIL_TEXT_THRESHOLD } from "../src/domain/content/record-kind.js";

function post(overrides = {}) {
	return {
		text: "",
		attachments: [],
		title: null,
		linkUrl: null,
		dueAt: null,
		done: null,
		tags: [],
		...overrides,
	};
}

// --- kindOf: 5 исходов, порядок жёсткий (REDESIGN-SPEC.md, этап 2)

test("kindOf: done !== null -> task (высший приоритет)", () => {
	assert.equal(kindOf(post({ done: false })), "task");
	assert.equal(kindOf(post({ done: true })), "task");
});

test("kindOf: linkUrl непустой -> link", () => {
	assert.equal(kindOf(post({ linkUrl: "https://example.com" })), "link");
});

test("kindOf: title непустой (без linkUrl/done) -> article", () => {
	assert.equal(kindOf(post({ title: "Заголовок" })), "article");
});

test("kindOf: пустой текст + >1 вложения (без title/linkUrl/done) -> collection", () => {
	assert.equal(kindOf(post({ text: "", attachments: [{ type: "audio" }, { type: "audio" }] })), "collection");
});

test("kindOf: иначе -> note", () => {
	assert.equal(kindOf(post({ text: "просто текст" })), "note");
	assert.equal(kindOf(post()), "note", "пустой текст без вложений — тоже note, не collection (нужно >1 вложения)");
});

test("kindOf: пустой текст + РОВНО одно вложение -> note, не collection", () => {
	assert.equal(kindOf(post({ text: "", attachments: [{ type: "image" }] })), "note");
});

// --- Приоритет: первое совпадение выигрывает, остальные условия игнорируются

test("kindOf: done!==null побеждает linkUrl/title/collection одновременно", () => {
	assert.equal(
		kindOf(post({ done: true, linkUrl: "https://x", title: "T", text: "", attachments: [{ type: "audio" }, { type: "audio" }] })),
		"task",
	);
});

test("kindOf: linkUrl побеждает title/collection (но не done)", () => {
	assert.equal(kindOf(post({ linkUrl: "https://x", title: "T", text: "", attachments: [{ type: "audio" }, { type: "audio" }] })), "link");
});

test("kindOf: title побеждает collection (но не done/linkUrl)", () => {
	assert.equal(kindOf(post({ title: "T", text: "", attachments: [{ type: "audio" }, { type: "audio" }] })), "article");
});

// --- attachmentPlacement: правило единственного вложения

test("GUTTER_THUMBNAIL_TEXT_THRESHOLD === 280", () => {
	assert.equal(GUTTER_THUMBNAIL_TEXT_THRESHOLD, 280);
});

test("attachmentPlacement: 0 вложений -> inline", () => {
	assert.equal(attachmentPlacement(post({ text: "x".repeat(300), attachments: [] })), "inline");
});

test("attachmentPlacement: >1 вложений -> inline, даже с длинным текстом и image", () => {
	assert.equal(
		attachmentPlacement(post({ text: "x".repeat(300), attachments: [{ type: "image" }, { type: "image" }] })),
		"inline",
	);
});

test("attachmentPlacement: одно image, текст короче порога -> inline", () => {
	assert.equal(attachmentPlacement(post({ text: "x".repeat(279), attachments: [{ type: "image" }] })), "inline");
});

test("attachmentPlacement: одно image, текст РОВНО на пороге (280) -> gutter", () => {
	assert.equal(attachmentPlacement(post({ text: "x".repeat(280), attachments: [{ type: "image" }] })), "gutter");
});

test("attachmentPlacement: одно video, текст >= порога -> gutter", () => {
	assert.equal(attachmentPlacement(post({ text: "x".repeat(300), attachments: [{ type: "video" }] })), "gutter");
});

test("attachmentPlacement: одно file, текст >= порога -> inline (правило только про image/video)", () => {
	assert.equal(attachmentPlacement(post({ text: "x".repeat(300), attachments: [{ type: "file" }] })), "inline");
});

test("АДВЕРСАРНО: одно audio, текст ЛЮБОЙ длины -> ВСЕГДА inline, никогда не в gutter", () => {
	assert.equal(attachmentPlacement(post({ text: "", attachments: [{ type: "audio" }] })), "inline");
	assert.equal(attachmentPlacement(post({ text: "x".repeat(1000), attachments: [{ type: "audio" }] })), "inline");
});
