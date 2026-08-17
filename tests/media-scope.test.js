import { test } from "node:test";
import assert from "node:assert/strict";
import { collectPostScope, collectChatScope, collectFolderScope, findRefPosition } from "../src/domain/media/scope.js";

function compareSiblings(a, b) {
	return a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function attachmentFor(tag) {
	return { manifestDigest: tag, fileKey: "AAAA", mime: "image/png", name: `${tag}.png`, size: 1 };
}

function commentNode(id, createdAt, replies = [], attachments = [attachmentFor(id)]) {
	return { id, createdAt, attachments, replies };
}

test("collectPostScope: ALGO §4.1 — дерево «корень -> A,B; A -> A1,A2» даёт порядок A,A1,A2,B", () => {
	const post = { id: "post-1", attachments: [] };
	const commentsTree = [
		commentNode("A", 1, [commentNode("A1", 1), commentNode("A2", 2)]),
		commentNode("B", 2),
	];
	const refs = collectPostScope({ post, commentsTree, compareSiblings });
	assert.deepEqual(
		refs.map((r) => r.digest),
		["A", "A1", "A2", "B"],
	);
});

test("collectPostScope: вложения самого поста идут первыми, перед комментариями", () => {
	const post = { id: "post-1", attachments: [attachmentFor("P")] };
	const commentsTree = [commentNode("A", 1)];
	const refs = collectPostScope({ post, commentsTree, compareSiblings });
	assert.deepEqual(
		refs.map((r) => r.digest),
		["P", "A"],
	);
});

test("collectPostScope: sourceMeta различает пост и комментарий", () => {
	const post = { id: "post-1", attachments: [attachmentFor("P")] };
	const commentsTree = [commentNode("A", 1)];
	const refs = collectPostScope({ post, commentsTree, compareSiblings });
	assert.deepEqual(refs[0].sourceMeta, { postId: "post-1" });
	assert.deepEqual(refs[1].sourceMeta, { commentId: "A" });
});

test("collectPostScope: несколько вложений в одном комментарии сохраняют порядок внутри узла", () => {
	const post = { id: "post-1", attachments: [] };
	const commentsTree = [commentNode("A", 1, [], [attachmentFor("A-1"), attachmentFor("A-2")])];
	const refs = collectPostScope({ post, commentsTree, compareSiblings });
	assert.deepEqual(
		refs.map((r) => r.digest),
		["A-1", "A-2"],
	);
});

test("collectPostScope: глубокая цепочка ответов (10^4) не роняет стек — итеративный обход", () => {
	const depth = 10000;
	let chain = commentNode(`leaf`, depth);
	for (let i = depth - 1; i >= 0; i--) {
		chain = commentNode(`n${i}`, i, [chain]);
	}
	const post = { id: "post-1", attachments: [] };
	const refs = collectPostScope({ post, commentsTree: [chain], compareSiblings });
	assert.equal(refs.length, depth + 1);
});

test("collectPostScope: осиротевший узел (replies отсутствует) не роняет обход", () => {
	const post = { id: "post-1", attachments: [] };
	const commentsTree = [{ id: "A", createdAt: 1, attachments: [attachmentFor("A")] }]; // без replies
	const refs = collectPostScope({ post, commentsTree, compareSiblings });
	assert.deepEqual(
		refs.map((r) => r.digest),
		["A"],
	);
});

test("collectChatScope: собирает вложения сообщений уже отсортированного окна, по порядку", () => {
	const messages = [
		{ id: "m1", attachments: [attachmentFor("m1-a")] },
		{ id: "m2", attachments: [] },
		{ id: "m3", attachments: [attachmentFor("m3-a"), attachmentFor("m3-b")] },
	];
	const refs = collectChatScope(messages);
	assert.deepEqual(
		refs.map((r) => r.digest),
		["m1-a", "m3-a", "m3-b"],
	);
});

test("collectChatScope: голосовые (voice===true) не попадают в плейлист (SPEC §1.4)", () => {
	const messages = [
		{ id: "m1", attachments: [{ ...attachmentFor("voice-1"), voice: true }] },
		{ id: "m2", attachments: [attachmentFor("real")] },
	];
	const refs = collectChatScope(messages);
	assert.deepEqual(
		refs.map((r) => r.digest),
		["real"],
	);
});

test("collectChatScope: сообщение без attachments не роняет сбор", () => {
	const messages = [{ id: "m1" }, { id: "m2", attachments: [attachmentFor("x")] }];
	const refs = collectChatScope(messages);
	assert.deepEqual(
		refs.map((r) => r.digest),
		["x"],
	);
});

function folderEntry(id, kind, mime, size) {
	return { node: { id, kind, blob: `blob-${id}`, name: { value: `${id}-name` } }, mime, size };
}

test("collectFolderScope: собирает по порядку entries, ключ — через keyOf", () => {
	const entries = [folderEntry("f1", "file", "image/png", 10), folderEntry("f2", "file", "audio/webm", 20)];
	const keyOf = (e) => new Uint8Array([e.node.id.charCodeAt(0)]);
	const refs = collectFolderScope(entries, keyOf);
	assert.deepEqual(
		refs.map((r) => r.digest),
		["blob-f1", "blob-f2"],
	);
	assert.deepEqual(Array.from(refs[0].key), [102]); // "f".charCodeAt(0)
});

test("collectFolderScope: папки (kind !== 'file') исключаются даже если попали в entries", () => {
	const entries = [folderEntry("d1", "dir", null, 0), folderEntry("f1", "file", "image/png", 10)];
	const refs = collectFolderScope(entries, () => null);
	assert.deepEqual(
		refs.map((r) => r.digest),
		["blob-f1"],
	);
});

test("collectFolderScope: keyOf может вернуть null — не резолвлен пока", () => {
	const entries = [folderEntry("f1", "file", "image/png", 10)];
	const refs = collectFolderScope(entries, () => null);
	assert.equal(refs[0].key, null);
});

// Этап F — findRefPosition (DESIGN.md "Этап F, F1/F2").
test("findRefPosition: находит верную позицию по совпадению digest+sourceMeta", () => {
	const messages = [
		{ id: "m1", attachments: [attachmentFor("a")] },
		{ id: "m2", attachments: [attachmentFor("b")] },
	];
	const refs = collectChatScope(messages);
	assert.equal(findRefPosition(refs, "a", { msgId: "m1" }), 0);
	assert.equal(findRefPosition(refs, "b", { msgId: "m2" }), 1);
});

test("findRefPosition: -1, если не найдено (ни по digest, ни по sourceMeta)", () => {
	const messages = [{ id: "m1", attachments: [attachmentFor("a")] }];
	const refs = collectChatScope(messages);
	assert.equal(findRefPosition(refs, "нет-такого", { msgId: "m1" }), -1);
	assert.equal(findRefPosition(refs, "a", { msgId: "другое-сообщение" }), -1);
});

test("findRefPosition: различает элементы с ОДНИМ digest, но РАЗНЫМ sourceMeta (тот же файл в двух сообщениях)", () => {
	const messages = [
		{ id: "m1", attachments: [attachmentFor("same")] },
		{ id: "m2", attachments: [attachmentFor("same")] },
	];
	const refs = collectChatScope(messages);
	assert.equal(findRefPosition(refs, "same", { msgId: "m1" }), 0);
	assert.equal(findRefPosition(refs, "same", { msgId: "m2" }), 1);
});

test("findRefPosition: sourceMeta сравнивается по значению, не по ссылке (новый объект с теми же ключами)", () => {
	const post = { id: "post-1", attachments: [attachmentFor("P")] };
	const refs = collectPostScope({ post, commentsTree: [], compareSiblings });
	assert.equal(findRefPosition(refs, "P", { postId: "post-1" }), 0);
});
