import { test } from "node:test";
import assert from "node:assert/strict";
import { recommendedLayout, layoutFor } from "../src/domain/files/view-layout.js";
import { iconForFile } from "../src/domain/files/file-icon.js";
import { buildVisibleMediaPlaylist } from "../src/domain/files/visible-media.js";
import { fileExtLabel, joinMeta, liveChildCount } from "../src/domain/files/file-meta.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

test("recommendedLayout: image/video — плитки, остальное — список", () => {
	assert.equal(recommendedLayout("image"), "grid");
	assert.equal(recommendedLayout("video"), "grid");
	assert.equal(recommendedLayout("audio"), "list");
	assert.equal(recommendedLayout("other"), "list");
	assert.equal(recommendedLayout("all"), "list");
});

test("layoutFor: без override — рекомендация; all всегда список", () => {
	assert.equal(layoutFor("image", {}), "grid");
	assert.equal(layoutFor("all", { image: "list" }), "list");
});

test("layoutFor: override побеждает рекомендацию", () => {
	assert.equal(layoutFor("image", { image: "list" }), "list");
	assert.equal(layoutFor("audio", { audio: "grid" }), "grid");
});

test("layoutFor: сброс к all даёт список независимо от override картинок", () => {
	assert.equal(layoutFor("all", { image: "grid", video: "list" }), "list");
});

test("iconForFile: pdf/xls/docx/аудио/картинка/прочее", () => {
	assert.equal(iconForFile("application/pdf"), "file-pdf");
	assert.equal(
		iconForFile("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
		"file-xls",
	);
	assert.equal(iconForFile("application/vnd.ms-excel"), "file-xls");
	assert.equal(
		iconForFile("application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
		"file-doc",
	);
	assert.equal(iconForFile("application/msword"), "file-doc");
	assert.equal(iconForFile("audio/mpeg"), "file-audio");
	assert.equal(iconForFile("video/mp4"), "file-video");
	assert.equal(iconForFile("image/jpeg"), "file-image");
	assert.equal(iconForFile("application/zip"), "file-text");
	assert.equal(iconForFile("text/plain"), "file-text");
	assert.equal(iconForFile(null), "file-text");
	assert.equal(iconForFile(undefined), "file-text");
});

function e(id, kind, mime) {
	return { id, kind, mime };
}

test("buildVisibleMediaPlaylist: только image/video/audio, порядок входа", () => {
	const entries = [
		e("d", "dir", null),
		e("p", "file", "application/pdf"),
		e("i", "file", "image/jpeg"),
		e("a", "file", "audio/mpeg"),
		e("v", "file", "video/mp4"),
	];
	const { items, position } = buildVisibleMediaPlaylist(entries, "a");
	assert.deepEqual(
		items.map((x) => x.id),
		["i", "a", "v"],
	);
	assert.equal(position, 1);
});

test("buildVisibleMediaPlaylist: подряд (clickedId null) — position 0", () => {
	const entries = [e("i", "file", "image/png"), e("a", "file", "audio/ogg")];
	const { items, position } = buildVisibleMediaPlaylist(entries, null);
	assert.equal(items.length, 2);
	assert.equal(position, 0);
});

test("buildVisibleMediaPlaylist: pdf не входит в плейлист", () => {
	const entries = [e("p", "file", "application/pdf"), e("i", "file", "image/gif")];
	const { items } = buildVisibleMediaPlaylist(entries, "i");
	assert.deepEqual(
		items.map((x) => x.id),
		["i"],
	);
});

test("fileExtLabel: расширение из имени, без точки", () => {
	assert.equal(fileExtLabel("foo.mp3"), "MP3");
	assert.equal(fileExtLabel("Разговор 12 июня.m4a"), "M4A");
	assert.equal(fileExtLabel("a.b.PDF"), "PDF");
	assert.equal(fileExtLabel("безрасширения"), "");
	assert.equal(fileExtLabel(".hidden"), "");
	assert.equal(fileExtLabel(""), "");
	assert.equal(fileExtLabel(null), "");
});

test("joinMeta: пропускает пустые, соединяет точкой", () => {
	assert.equal(joinMeta(["MP3", "4,8 МБ"]), "MP3 · 4,8 МБ");
	assert.equal(joinMeta(["PDF", "", null]), "PDF");
	assert.equal(joinMeta([]), "");
});

test("liveChildCount: длина живых детей папки", () => {
	const children = new Map([
		["root", ["a", "b", "c"]],
		["empty", []],
	]);
	assert.equal(liveChildCount(children, "root"), 3);
	assert.equal(liveChildCount(children, "empty"), 0);
	assert.equal(liveChildCount(children, "нет"), 0);
	assert.equal(liveChildCount(null, "root"), 0);
});

test("MediaButtons по-прежнему зовёт onOpen с чипа (чат/канал не ломаем)", () => {
	const src = readFileSync(
		join(dirname(fileURLToPath(import.meta.url)), "../src/ui/components/media/media-buttons.jsx"),
		"utf8",
	);
	assert.match(src, /onClick=\{\(\) => onOpen\(cls\)\}/);
	assert.match(src, /export default function MediaButtons/);
});
