import { test } from "node:test";
import assert from "node:assert/strict";
import { classOf, refFromAttachment, refFromNode } from "../src/domain/media/media-ref.js";

test("classOf: audio/* -> audio", () => {
	assert.equal(classOf("audio/webm"), "audio");
	assert.equal(classOf("audio/mpeg"), "audio");
});

test("classOf: video/* -> video", () => {
	assert.equal(classOf("video/mp4"), "video");
	assert.equal(classOf("video/webm"), "video");
});

test("classOf: image/* -> image", () => {
	assert.equal(classOf("image/png"), "image");
	assert.equal(classOf("image/jpeg"), "image");
});

test("classOf: всё остальное -> other", () => {
	assert.equal(classOf("application/pdf"), "other");
	assert.equal(classOf("text/plain"), "other");
	assert.equal(classOf("application/octet-stream"), "other");
});

function base64FromBytes(bytes) {
	return Buffer.from(bytes).toString("base64");
}

test("refFromAttachment: строит MediaRef из дескриптора вложения, ключ декодируется из base64", () => {
	const keyBytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
	const attachment = {
		manifestDigest: "abc123digest",
		fileKey: base64FromBytes(keyBytes),
		mime: "audio/webm",
		name: "voice.webm",
		size: 12345,
	};
	const ref = refFromAttachment(attachment, { msgId: "m1" });
	assert.equal(ref.digest, "abc123digest");
	assert.deepEqual(Array.from(ref.key), Array.from(keyBytes));
	assert.equal(ref.mime, "audio/webm");
	assert.equal(ref.name, "voice.webm");
	assert.equal(ref.size, 12345);
	assert.equal(ref.sourceKind, "attachment");
	assert.deepEqual(ref.sourceMeta, { msgId: "m1" });
});

test("refFromAttachment: sourceMeta передаётся как есть (commentId/nodeId/postId — не фиксированный список)", () => {
	const attachment = { manifestDigest: "d", fileKey: base64FromBytes(new Uint8Array([9])), mime: "image/png", name: "a.png", size: 1 };
	const ref = refFromAttachment(attachment, { commentId: "c1" });
	assert.deepEqual(ref.sourceMeta, { commentId: "c1" });
});

test("refFromNode: строит MediaRef из узла дерева файлов, mime/key/size — явные параметры", () => {
	const node = { id: "node-1", kind: "file", blob: "digest-xyz", name: { value: "report.pdf" } };
	const key = new Uint8Array([10, 20, 30]);
	const ref = refFromNode(node, "application/pdf", key, 999);
	assert.equal(ref.digest, "digest-xyz");
	assert.equal(ref.key, key);
	assert.equal(ref.mime, "application/pdf");
	assert.equal(ref.name, "report.pdf");
	assert.equal(ref.size, 999);
	assert.equal(ref.sourceKind, "node");
	assert.deepEqual(ref.sourceMeta, { nodeId: "node-1" });
});

test("refFromNode: key может быть null (ещё не резолвлен — папка, ленивое разрешение)", () => {
	const node = { id: "node-2", kind: "file", blob: "d2", name: { value: "x.bin" } };
	const ref = refFromNode(node, "application/octet-stream", null, 0);
	assert.equal(ref.key, null);
});
