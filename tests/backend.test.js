import { test } from "node:test";
import assert from "node:assert/strict";
import { createWebNotificationBackend } from "../src/domain/notifications/backend.js";

function fakeNotificationImpl(permission = "granted") {
	const created = [];
	function FakeNotification(title, opts) {
		created.push({ title, ...opts });
	}
	FakeNotification.permission = permission;
	return { FakeNotification, created };
}

function fakeDocument(visibilityState) {
	return { visibilityState };
}

// Этап 47-довесок (пользователь: "всплывашки должны быть красивыми и плавными") —
// системный Notification API стилизовать нельзя, поэтому пока вкладка видна,
// показываем свой тост вместо него; нативное — fallback для свёрнутой/невидимой вкладки.

test("showPopup: вкладка ВИДНА и onToast задан -> вызывает onToast, НЕ трогает Notification", () => {
	const { FakeNotification, created } = fakeNotificationImpl("granted");
	const toasts = [];
	const backend = createWebNotificationBackend({
		NotificationImpl: FakeNotification,
		documentImpl: fakeDocument("visible"),
		onToast: (title, body) => toasts.push({ title, body }),
	});
	backend.showPopup("Заголовок", "Тело");
	assert.deepEqual(toasts, [{ title: "Заголовок", body: "Тело" }]);
	assert.equal(created.length, 0, "нативное уведомление не должно создаваться, пока есть тост");
});

test("showPopup: вкладка НЕ видна -> fallback на нативное уведомление, onToast НЕ вызывается", () => {
	const { FakeNotification, created } = fakeNotificationImpl("granted");
	let toastCalled = false;
	const backend = createWebNotificationBackend({
		NotificationImpl: FakeNotification,
		documentImpl: fakeDocument("hidden"),
		onToast: () => {
			toastCalled = true;
		},
	});
	backend.showPopup("Заголовок", "Тело");
	assert.equal(toastCalled, false);
	assert.equal(created.length, 1);
	assert.equal(created[0].title, "Заголовок");
});

test("showPopup: onToast не передан вовсе -> всегда нативное (даже если вкладка видна)", () => {
	const { FakeNotification, created } = fakeNotificationImpl("granted");
	const backend = createWebNotificationBackend({ NotificationImpl: FakeNotification, documentImpl: fakeDocument("visible") });
	backend.showPopup("t", "b");
	assert.equal(created.length, 1);
});

test("showPopup: fallback на нативное, но permission не granted -> тихо ничего", () => {
	const { FakeNotification, created } = fakeNotificationImpl("denied");
	const backend = createWebNotificationBackend({ NotificationImpl: FakeNotification, documentImpl: fakeDocument("hidden") });
	backend.showPopup("t", "b");
	assert.equal(created.length, 0);
});

test("showPopup: documentImpl отсутствует вовсе (напр. будущий Tauri-контекст без document) -> считается видимой, тост предпочтителен", () => {
	const toasts = [];
	const backend = createWebNotificationBackend({ documentImpl: undefined, onToast: (title) => toasts.push(title) });
	backend.showPopup("t", "b");
	assert.deepEqual(toasts, ["t"]);
});

// --- playSound ---

test("playSound: audioSrc задан -> создаёт Audio и вызывает play()", () => {
	const plays = [];
	function FakeAudio(src) {
		this.src = src;
		this.play = () => {
			plays.push(src);
			return Promise.resolve();
		};
	}
	const backend = createWebNotificationBackend({ AudioImpl: FakeAudio, audioSrc: "data:audio/mpeg;base64,AAA" });
	backend.playSound();
	assert.deepEqual(plays, ["data:audio/mpeg;base64,AAA"]);
});

test("playSound: audioSrc не задан (заглушка) -> no-op, не бросает", () => {
	const backend = createWebNotificationBackend({ AudioImpl: function () {}, audioSrc: null });
	assert.doesNotThrow(() => backend.playSound());
});

test("playSound: play() отклоняется (автоплей заблокирован политикой браузера) -> проглатывается, не бросает", () => {
	function FakeAudio() {
		this.play = () => Promise.reject(new Error("NotAllowedError"));
	}
	const backend = createWebNotificationBackend({ AudioImpl: FakeAudio, audioSrc: "data:audio/mpeg;base64,AAA" });
	assert.doesNotThrow(() => backend.playSound());
});

// --- setBadgeCount ---

test("setBadgeCount: без navigator.setAppBadge (окружение не поддерживает) -> no-op, не бросает", () => {
	const backend = createWebNotificationBackend({});
	assert.doesNotThrow(() => backend.setBadgeCount(5));
	assert.doesNotThrow(() => backend.setBadgeCount(0));
});
