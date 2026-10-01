import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { startKeyboardInsetTracking } from "../src/platform/keyboard-inset.js";

function fakeVisualViewport(height, offsetTop = 0) {
	const listeners = {};
	return {
		height,
		offsetTop,
		addEventListener(type, cb) {
			(listeners[type] ??= []).push(cb);
		},
		removeEventListener(type, cb) {
			listeners[type] = (listeners[type] ?? []).filter((f) => f !== cb);
		},
		fire(type) {
			for (const cb of listeners[type] ?? []) cb();
		},
	};
}

function fakeDocumentElementStyle() {
	const props = new Map();
	return {
		setProperty(name, value) {
			props.set(name, value);
		},
		removeProperty(name) {
			props.delete(name);
		},
		get(name) {
			return props.get(name);
		},
	};
}

let originalWindow;
let originalDocument;

beforeEach(() => {
	originalWindow = globalThis.window;
	originalDocument = globalThis.document;
});

afterEach(() => {
	globalThis.window = originalWindow;
	globalThis.document = originalDocument;
});

test("startKeyboardInsetTracking: нет window.visualViewport -> no-op, не бросает", () => {
	globalThis.window = { innerHeight: 800 };
	globalThis.document = { documentElement: { style: fakeDocumentElementStyle() } };
	const cleanup = startKeyboardInsetTracking();
	assert.equal(typeof cleanup, "function");
	assert.doesNotThrow(cleanup);
});

test("startKeyboardInsetTracking: клавиатура появилась -> --keyboard-inset = разница высот", () => {
	const vv = fakeVisualViewport(500);
	globalThis.window = { innerHeight: 800, visualViewport: vv };
	const style = fakeDocumentElementStyle();
	globalThis.document = { documentElement: { style } };
	startKeyboardInsetTracking();
	assert.equal(style.get("--keyboard-inset"), "300px");
});

test("startKeyboardInsetTracking: учитывает offsetTop (страница проскроллена под клавиатурой)", () => {
	const vv = fakeVisualViewport(500, 50);
	globalThis.window = { innerHeight: 800, visualViewport: vv };
	const style = fakeDocumentElementStyle();
	globalThis.document = { documentElement: { style } };
	startKeyboardInsetTracking();
	assert.equal(style.get("--keyboard-inset"), "250px");
});

test("startKeyboardInsetTracking: клавиатура скрыта (height == innerHeight) -> 0px, не отрицательное", () => {
	const vv = fakeVisualViewport(800);
	globalThis.window = { innerHeight: 800, visualViewport: vv };
	const style = fakeDocumentElementStyle();
	globalThis.document = { documentElement: { style } };
	startKeyboardInsetTracking();
	assert.equal(style.get("--keyboard-inset"), "0px");
});

test("startKeyboardInsetTracking: resize-событие пересчитывает значение", () => {
	const vv = fakeVisualViewport(800);
	globalThis.window = { innerHeight: 800, visualViewport: vv };
	const style = fakeDocumentElementStyle();
	globalThis.document = { documentElement: { style } };
	startKeyboardInsetTracking();
	assert.equal(style.get("--keyboard-inset"), "0px");
	vv.height = 450;
	vv.fire("resize");
	assert.equal(style.get("--keyboard-inset"), "350px");
});

test("startKeyboardInsetTracking: cleanup снимает слушатели и убирает переменную", () => {
	const vv = fakeVisualViewport(500);
	globalThis.window = { innerHeight: 800, visualViewport: vv };
	const style = fakeDocumentElementStyle();
	globalThis.document = { documentElement: { style } };
	const cleanup = startKeyboardInsetTracking();
	assert.equal(style.get("--keyboard-inset"), "300px");
	cleanup();
	assert.equal(style.get("--keyboard-inset"), undefined);
	vv.height = 200;
	vv.fire("resize");
	// после cleanup слушатель снят — значение не должно появиться снова
	assert.equal(style.get("--keyboard-inset"), undefined);
});
