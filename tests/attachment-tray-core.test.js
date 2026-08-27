import { test } from "node:test";
import assert from "node:assert/strict";
import {
	emptyTrayState,
	addFiles,
	addFromStorage,
	setItemPosition,
	setTrayLayout,
	removeItem,
	planUpload,
} from "../src/ui/hooks/attachment-tray-core.js";
import { DomainError } from "../src/domain/errors.js";

function fakeFile(name, mime, size) {
	return { name, type: mime, size };
}

test("emptyTrayState: форма", () => {
	assert.deepEqual(emptyTrayState(), { items: [], errors: [], layout: null });
});

test("addFiles: валидные файлы в пределах maxItems — все добавлены, errors пуст, id уникальны, type верный", () => {
	const files = [fakeFile("a.png", "image/png", 100), fakeFile("b.mp4", "video/mp4", 200)];
	const state = addFiles(emptyTrayState(), files, 5);
	assert.equal(state.items.length, 2);
	assert.deepEqual(state.errors, []);
	assert.notEqual(state.items[0].id, state.items[1].id);
	assert.equal(state.items[0].type, "image");
	assert.equal(state.items[1].type, "video");
	assert.equal(state.items[0].error, undefined);
	assert.equal(state.items[0].position, "below");
	assert.equal(state.layout, "duo");
});

test("addFiles: неизвестный mime классифицируется как file", () => {
	const state = addFiles(emptyTrayState(), [fakeFile("a.bin", "application/x-msdownload", 10)], 5);
	assert.equal(state.items[0].type, "file");
});

test("addFiles: переполнение — срез по свободным местам + одна ошибка про лимит", () => {
	const files = [fakeFile("a.png", "image/png", 1), fakeFile("b.png", "image/png", 1), fakeFile("c.png", "image/png", 1)];
	const state = addFiles(emptyTrayState(), files, 2);
	assert.equal(state.items.length, 2);
	assert.equal(state.errors.length, 1);
	assert.ok(state.errors[0] instanceof DomainError);
	assert.equal(state.errors[0].key, "errors.tooManyAttachments");
	assert.equal(state.errors[0].params.max, 2);
});

test("addFiles: лоток уже полон — ничего не добавляется, errors содержит сообщение о лимите", () => {
	let state = addFiles(emptyTrayState(), [fakeFile("a.png", "image/png", 1)], 1);
	state = addFiles(state, [fakeFile("b.png", "image/png", 1)], 1);
	assert.equal(state.items.length, 1);
	assert.equal(state.items[0].name, "a.png");
	assert.equal(state.errors.length, 1);
});

test("addFiles: успешный вызов без переполнения стирает errors от предыдущего переполнения", () => {
	let state = addFiles(emptyTrayState(), [fakeFile("a.png", "image/png", 1), fakeFile("b.png", "image/png", 1)], 1);
	assert.equal(state.errors.length, 1);
	state = removeItem(state, state.items[0].id);
	state = addFiles(state, [fakeFile("c.png", "image/png", 1)], 1);
	assert.deepEqual(state.errors, []);
});

test("addFiles: невалидный mime — item.error заполнен DomainError'ом, item остаётся в items", () => {
	const state = addFiles(emptyTrayState(), [fakeFile("a.exe", "application/x-msdownload", 10)], 5);
	assert.equal(state.items.length, 1);
	assert.ok(state.items[0].error instanceof DomainError);
});

test("addFiles: невалидный размер — item.error заполнен, item остаётся", () => {
	const state = addFiles(emptyTrayState(), [fakeFile("a.mp4", "video/mp4", 2 * 1024 * 1024 * 1024)], 5);
	assert.equal(state.items.length, 1);
	assert.ok(state.items[0].error instanceof DomainError);
});

test("addFromStorage: та же лимит/валидация-семантика, поля из manifest", () => {
	const refs = [
		{ manifestDigest: "d1", fileKey: new Uint8Array([1]), manifest: { mime: "image/jpeg", name: "x.jpg", size: 50 } },
		{ manifestDigest: "d2", fileKey: new Uint8Array([2]), manifest: { mime: "application/x-msdownload", name: "y.exe", size: 50 } },
	];
	const state = addFromStorage(emptyTrayState(), refs, 5);
	assert.equal(state.items.length, 2);
	assert.equal(state.items[0].type, "image");
	assert.equal(state.items[0].name, "x.jpg");
	assert.equal(state.items[0].size, 50);
	assert.equal(state.items[0].storageRef, refs[0]);
	assert.equal(state.items[0].file, null);
	assert.ok(state.items[1].error instanceof DomainError);
});

test("addFromStorage: переполнение — та же семантика errors, что addFiles", () => {
	const refs = [
		{ manifestDigest: "d1", fileKey: new Uint8Array(), manifest: { mime: "image/jpeg", name: "x.jpg", size: 1 } },
		{ manifestDigest: "d2", fileKey: new Uint8Array(), manifest: { mime: "image/jpeg", name: "y.jpg", size: 1 } },
	];
	const state = addFromStorage(emptyTrayState(), refs, 1);
	assert.equal(state.items.length, 1);
	assert.equal(state.errors.length, 1);
	assert.equal(state.errors[0].key, "errors.tooManyAttachments");
});

test("setItemPosition: меняет position только у type===image", () => {
	let state = addFiles(emptyTrayState(), [fakeFile("a.png", "image/png", 1), fakeFile("b.pdf", "application/pdf", 1)], 5);
	const imageId = state.items[0].id;
	const fileId = state.items[1].id;
	state = setItemPosition(state, imageId, "above");
	assert.equal(state.items.find((i) => i.id === imageId).position, "above");
	const before = state.items.find((i) => i.id === fileId).position;
	state = setItemPosition(state, fileId, "above");
	assert.equal(state.items.find((i) => i.id === fileId).position, before);
});

test("setItemPosition: неизвестный id — no-op, ничего не бросает", () => {
	const state = addFiles(emptyTrayState(), [fakeFile("a.png", "image/png", 1)], 5);
	assert.doesNotThrow(() => setItemPosition(state, "nonexistent", "above"));
});

test("removeItem: убирает по id, остальные не задеты", () => {
	let state = addFiles(emptyTrayState(), [fakeFile("a.png", "image/png", 1), fakeFile("b.png", "image/png", 1)], 5);
	const [first, second] = state.items;
	state = removeItem(state, first.id);
	assert.equal(state.items.length, 1);
	assert.equal(state.items[0].id, second.id);
});

test("planUpload: без ошибок — возвращает Job[] в порядке items с верным kind/isImage/position", () => {
	let state = addFiles(emptyTrayState(), [fakeFile("a.png", "image/png", 1), fakeFile("b.pdf", "application/pdf", 1)], 5);
	state = addFromStorage(state, [{ manifestDigest: "d1", fileKey: new Uint8Array([9]), manifest: { mime: "video/mp4", name: "v.mp4", size: 1 } }], 5);
	state = setItemPosition(state, state.items[0].id, "above");
	const jobs = planUpload(state);
	assert.equal(jobs.length, 3);
	assert.equal(jobs[0].kind, "upload");
	assert.equal(jobs[0].isImage, true);
	assert.equal(jobs[0].position, "above");
	assert.equal(jobs[1].kind, "upload");
	assert.equal(jobs[1].isImage, false);
	assert.equal(jobs[2].kind, "reference");
	assert.equal(jobs[2].manifestDigest, "d1");
	assert.equal(jobs[2].isImage, false);
});

test("planUpload: хотя бы один item.error — бросает, ничего не возвращает", () => {
	const state = addFiles(emptyTrayState(), [fakeFile("a.png", "image/png", 1), fakeFile("bad.exe", "application/x-msdownload", 1)], 5);
	assert.throws(() => planUpload(state));
});

test("planUpload: пустой items — возвращает пустой массив", () => {
	assert.deepEqual(planUpload(emptyTrayState()), []);
});

test("addFiles: после 2 картинок layout авто duo", () => {
	const state = addFiles(emptyTrayState(), [fakeFile("a.png", "image/png", 1), fakeFile("b.png", "image/png", 1)], 5);
	assert.equal(state.layout, "duo");
});

test("setTrayLayout: hero сохраняется при visual >= 2", () => {
	let state = addFiles(emptyTrayState(), [fakeFile("a.png", "image/png", 1), fakeFile("b.png", "image/png", 1)], 5);
	state = setTrayLayout(state, "hero");
	assert.equal(state.layout, "hero");
});

test("removeItem: удаление до 1 visual сбрасывает layout", () => {
	let state = addFiles(emptyTrayState(), [fakeFile("a.png", "image/png", 1), fakeFile("b.png", "image/png", 1)], 5);
	state = setTrayLayout(state, "hero");
	state = removeItem(state, state.items[0].id);
	assert.equal(state.items.length, 1);
	assert.equal(state.layout, null);
});

test("planUpload: layout на visual, не на pdf", () => {
	let state = addFiles(emptyTrayState(), [fakeFile("a.png", "image/png", 1), fakeFile("b.pdf", "application/pdf", 1), fakeFile("c.png", "image/png", 1)], 5);
	state = setTrayLayout(state, "hero");
	const jobs = planUpload(state);
	assert.equal(jobs[0].layout, "hero");
	assert.equal(jobs[1].layout, undefined);
	assert.equal(jobs[2].layout, "hero");
});

test("planUpload: poster с item уходит в job видео, не в картинку", () => {
	let state = addFiles(emptyTrayState(), [fakeFile("a.png", "image/png", 1), fakeFile("b.mp4", "video/mp4", 1)], 5);
	state = {
		...state,
		items: state.items.map((item) => (item.type === "video" ? { ...item, poster: "data:image/jpeg;base64,xx" } : item)),
	};
	const jobs = planUpload(state);
	assert.equal(jobs[0].poster, undefined);
	assert.equal(jobs[1].poster, "data:image/jpeg;base64,xx");
	assert.equal(jobs[1].layout, "duo");
});
