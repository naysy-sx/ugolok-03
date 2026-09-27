import { test } from "node:test";
import assert from "node:assert/strict";
import { getPlatform, resetPlatformForTests } from "../src/platform/index.js";
import { createPlatform as createWebPlatform } from "../src/platform/web.js";
import { createPlatform as createCapacitorPlatform } from "../src/platform/capacitor.js";
import { createPlatform as createTauriPlatform } from "../src/platform/tauri.js";
import { mediaSizeLimitBytes, exceedsMediaSizeLimit, getPlayableSourceUnderLimit } from "../src/platform/media-native-fallback.js";

// Э1.6 ТЗ-NATIVE-APPS — выбор адаптера по __TARGET__. Под `node --test` нет
// Vite `define` (см. tests/config.test.js) — __TARGET__ ставим/убираем сами
// через globalThis (ES-модули в Node читают его как обычную глобальную
// переменную — то же самое, что видел бы код, собранный Vite'ом с этим define).

test("getPlatform(): __TARGET__ не задан -> веб-адаптер, не бросает", () => {
	delete globalThis.__TARGET__;
	resetPlatformForTests();
	const platform = getPlatform();
	assert.equal(platform.shell, "web");
});

test("getPlatform(): __TARGET__='web' -> веб-адаптер", () => {
	globalThis.__TARGET__ = "web";
	resetPlatformForTests();
	assert.equal(getPlatform().shell, "web");
	delete globalThis.__TARGET__;
	resetPlatformForTests();
});

test("getPlatform(): __TARGET__='capacitor' -> capacitor-адаптер (Э2.1: media реализован, остальное — заготовка до Э3)", () => {
	globalThis.__TARGET__ = "capacitor";
	resetPlatformForTests();
	const platform = getPlatform();
	assert.equal(platform.shell, "capacitor");
	assert.throws(() => platform.notifications.permission(), /не реализовано/);
	delete globalThis.__TARGET__;
	resetPlatformForTests();
});

test("getPlatform(): __TARGET__='tauri' -> tauri-адаптер (Э3: config/notifications/files/links/media реализованы, lifecycle/updates/ui/call/push — ещё нет)", () => {
	globalThis.__TARGET__ = "tauri";
	resetPlatformForTests();
	const platform = getPlatform();
	assert.equal(platform.shell, "tauri");
	assert.throws(() => platform.lifecycle.onResume(), /не реализовано/);
	delete globalThis.__TARGET__;
	resetPlatformForTests();
});

test("getPlatform(): синглтон — повторный вызов без reset возвращает тот же инстанс", () => {
	delete globalThis.__TARGET__;
	resetPlatformForTests();
	assert.equal(getPlatform(), getPlatform());
});

// --- src/platform/web.js: контракт §4.3, "веб-реализация повторяет текущее
// поведение" — методы без DOM-зависимостей проверяются напрямую.

test("web: shell/os/info() — форма контракта", () => {
	const platform = createWebPlatform();
	assert.equal(platform.shell, "web");
	assert.ok(["web", "android", "ios", "windows", "macos", "linux"].includes(platform.os));
	const info = platform.info();
	assert.equal(info.shell, "web");
	assert.equal(typeof info.appVersion, "string");
	assert.equal(typeof info.buildHash, "string");
});

test("web: push — стаб, ничего не поддерживает (PUSH-DESIGN.md, реализации ещё нет)", async () => {
	const platform = createWebPlatform();
	assert.equal(platform.push.supported(), false);
	assert.equal(await platform.push.getToken(), null);
	assert.equal(typeof platform.push.onTokenChange(() => {}), "function");
	assert.equal(typeof platform.push.onWake(() => {}), "function");
});

test("web: media.getPlayableSource — бросает (Э2.4: веб навсегда остаётся на SW-плеере, метод там не вызывается)", async () => {
	const platform = createWebPlatform();
	await assert.rejects(() => platform.media.getPlayableSource());
});

test("web: ui/call — no-op на вебе (нет аналога ни у одного метода сегодня)", () => {
	const platform = createWebPlatform();
	assert.doesNotThrow(() => platform.ui.setSystemBarsTheme("dark"));
	assert.doesNotThrow(() => platform.ui.setSecureScreen(true));
	assert.doesNotThrow(() => platform.ui.keepAwake(true));
	assert.equal(typeof platform.ui.setBackHandler(() => {}), "function");
	assert.doesNotThrow(() => platform.call.begin({ peerName: "x" }));
	assert.doesNotThrow(() => platform.call.end());
});

test("web: links.openExternal — не бросает, даже если globalThis.open недоступен", () => {
	const platform = createWebPlatform();
	const savedOpen = globalThis.open;
	delete globalThis.open;
	try {
		assert.doesNotThrow(() => platform.links.openExternal("https://example.com"));
	} finally {
		if (savedOpen !== undefined) globalThis.open = savedOpen;
	}
});

test("web: links.openExternal — зовёт window.open(url, '_blank', ...) когда он есть", () => {
	const platform = createWebPlatform();
	const calls = [];
	globalThis.open = (...args) => calls.push(args);
	try {
		platform.links.openExternal("https://example.com/x");
		assert.equal(calls.length, 1);
		assert.equal(calls[0][0], "https://example.com/x");
		assert.equal(calls[0][1], "_blank");
	} finally {
		delete globalThis.open;
	}
});

function fakeAnchor() {
	return {
		attrs: {},
		set href(v) {
			this.attrs.href = v;
		},
		set download(v) {
			this.attrs.download = v;
		},
		clicked: false,
		click() {
			this.clicked = true;
		},
		remove() {},
	};
}

function fakeDocument() {
	const created = [];
	const body = { appendChild: () => {}, };
	return {
		created,
		body,
		createElement: (tag) => {
			const a = fakeAnchor();
			a.tag = tag;
			created.push(a);
			return a;
		},
	};
}

test("web: files.saveAs — Blob/ObjectURL/<a download> (тот же паттерн, что раньше был продублирован в 4 местах)", async () => {
	const platform = createWebPlatform();
	const savedDocument = globalThis.document;
	const doc = fakeDocument();
	globalThis.document = doc;
	try {
		await platform.files.saveAs({ name: "report.json", mime: "application/json", data: '{"a":1}' });
		assert.equal(doc.created.length, 1);
		assert.equal(doc.created[0].attrs.download, "report.json");
		assert.equal(doc.created[0].clicked, true);
	} finally {
		if (savedDocument === undefined) delete globalThis.document;
		else globalThis.document = savedDocument;
	}
});

function fakeNotificationImpl(permission = "granted") {
	const created = [];
	function FakeNotification(title, opts) {
		this.title = title;
		Object.assign(this, opts);
		created.push(this);
	}
	FakeNotification.permission = permission;
	FakeNotification.requestPermission = async () => permission;
	return { FakeNotification, created };
}

test("web: notifications.permission/requestPermission — читает Notification глобальный", async () => {
	const platform = createWebPlatform();
	const savedNotification = globalThis.Notification;
	const { FakeNotification } = fakeNotificationImpl("granted");
	globalThis.Notification = FakeNotification;
	try {
		assert.equal(platform.notifications.permission(), "granted");
		assert.equal(await platform.notifications.requestPermission(), "granted");
	} finally {
		if (savedNotification === undefined) delete globalThis.Notification;
		else globalThis.Notification = savedNotification;
	}
});

test("web: notifications.show/onClick — клик по нативному уведомлению зовёт зарегистрированный route-колбэк", async () => {
	const platform = createWebPlatform();
	const savedNotification = globalThis.Notification;
	const savedFocus = globalThis.focus;
	const { FakeNotification, created } = fakeNotificationImpl("granted");
	globalThis.Notification = FakeNotification;
	globalThis.focus = () => {};
	try {
		const routes = [];
		const off = platform.notifications.onClick((route) => routes.push(route));
		await platform.notifications.show({ id: "1", title: "t", body: "b", route: { screen: "messages" } });
		assert.equal(created.length, 1);
		created[0].onclick();
		assert.deepEqual(routes, [{ screen: "messages" }]);
		off();
	} finally {
		if (savedNotification === undefined) delete globalThis.Notification;
		else globalThis.Notification = savedNotification;
		if (savedFocus === undefined) delete globalThis.focus;
		else globalThis.focus = savedFocus;
	}
});

test("web: notifications.setBadge — зовёт navigator.setAppBadge/clearAppBadge", () => {
	const platform = createWebPlatform();
	const savedNavigator = globalThis.navigator;
	delete globalThis.navigator;
	const calls = [];
	globalThis.navigator = {
		setAppBadge: (n) => {
			calls.push(["set", n]);
			return Promise.resolve();
		},
		clearAppBadge: () => {
			calls.push(["clear"]);
			return Promise.resolve();
		},
	};
	try {
		platform.notifications.setBadge(3);
		platform.notifications.setBadge(0);
		assert.deepEqual(calls, [["set", 3], ["clear"]]);
	} finally {
		globalThis.navigator = savedNavigator;
	}
});

test("web: lifecycle.onNetworkChange — подписывается/отписывается на online/offline", () => {
	const platform = createWebPlatform();
	const listeners = {};
	const savedAdd = globalThis.addEventListener;
	const savedRemove = globalThis.removeEventListener;
	globalThis.addEventListener = (type, fn) => {
		listeners[type] = fn;
	};
	globalThis.removeEventListener = (type, fn) => {
		if (listeners[type] === fn) delete listeners[type];
	};
	try {
		const seen = [];
		const off = platform.lifecycle.onNetworkChange((online) => seen.push(online));
		assert.equal(typeof listeners.online, "function");
		assert.equal(typeof listeners.offline, "function");
		listeners.online();
		listeners.offline();
		assert.deepEqual(seen, [true, false]);
		off();
		assert.equal(listeners.online, undefined);
		assert.equal(listeners.offline, undefined);
	} finally {
		if (savedAdd === undefined) delete globalThis.addEventListener;
		else globalThis.addEventListener = savedAdd;
		if (savedRemove === undefined) delete globalThis.removeEventListener;
		else globalThis.removeEventListener = savedRemove;
	}
});

// --- Э2.1: media.getPlayableSource на capacitor/tauri (E1-INVENTORY.md/Р2.2) ---

test("media-native-fallback: mediaSizeLimitBytes — desktop одинаково, android/ios различаются", () => {
	assert.equal(mediaSizeLimitBytes("tauri", "windows"), 1024 * 1024 * 1024);
	assert.equal(mediaSizeLimitBytes("tauri", "macos"), 1024 * 1024 * 1024);
	assert.equal(mediaSizeLimitBytes("tauri", "linux"), 1024 * 1024 * 1024);
	assert.equal(mediaSizeLimitBytes("capacitor", "android"), 256 * 1024 * 1024);
	assert.equal(mediaSizeLimitBytes("capacitor", "ios"), 150 * 1024 * 1024);
});

test("media-native-fallback: exceedsMediaSizeLimit — размер неизвестен не блокирует вслепую", () => {
	assert.equal(exceedsMediaSizeLimit("capacitor", "android", undefined), false);
	assert.equal(exceedsMediaSizeLimit("capacitor", "android", 100), false);
	assert.equal(exceedsMediaSizeLimit("capacitor", "android", 300 * 1024 * 1024), true);
});

test("media-native-fallback: getPlayableSourceUnderLimit — url приходит от decrypt(), release() освобождает через URL.revokeObjectURL", async () => {
	const calls = [];
	const fileRef = { digest: "abc123", mime: "video/mp4" };
	const fakeUrl = URL.createObjectURL(new Blob(["x"]));
	const result = await getPlayableSourceUnderLimit(fileRef, {
		decrypt: async (ref, opts) => {
			calls.push(["decrypt", ref, opts]);
			return fakeUrl;
		},
	});
	assert.equal(result.url, fakeUrl);
	assert.equal(calls[0][0], "decrypt");
	assert.equal(calls[0][1], fileRef);
	await result.release();
});

test("capacitor: media.getPlayableSource — файл больше лимита бросает явно (владелец выбрал А, не реализовано без реального native/mobile)", async () => {
	const platform = createCapacitorPlatform();
	await assert.rejects(
		() => platform.media.getPlayableSource({ digest: "x", mime: "video/mp4" }, { size: 300 * 1024 * 1024 }),
		/больше лимита/,
	);
});

test("tauri: media.getPlayableSource — файл больше лимита бросает явно (владелец выбрал А, не реализовано без реального native/desktop)", async () => {
	const platform = createTauriPlatform();
	await assert.rejects(
		() => platform.media.getPlayableSource({ digest: "x", mime: "video/mp4" }, { size: 2 * 1024 * 1024 * 1024 }),
		/больше лимита/,
	);
});

test("capacitor/tauri: не-media методы бросают 'не реализовано' с именем метода в сообщении", () => {
	const capacitor = createCapacitorPlatform();
	const tauri = createTauriPlatform();
	// capacitor.js — всё ещё заготовка целиком, кроме media (Э2.1).
	assert.throws(() => capacitor.files.saveAs(), /files\.saveAs/);
	assert.throws(() => capacitor.links.openExternal(), /links\.openExternal/);
	assert.throws(() => capacitor.push.supported(), /push\.supported/);
	// tauri.js — Э3: config/notifications/files/links реализованы по-настоящему
	// (см. отдельные тесты ниже), lifecycle/updates/ui/call/push — ещё нет.
	assert.throws(() => tauri.lifecycle.onResume(), /lifecycle\.onResume/);
	assert.throws(() => tauri.push.supported(), /push\.supported/);
	assert.throws(() => tauri.info(), /\binfo\b/);
});
