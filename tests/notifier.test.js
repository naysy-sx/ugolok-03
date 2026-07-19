import { test } from "node:test";
import assert from "node:assert/strict";
import { requestNotificationPermission, notify } from "../src/domain/notifications/notifier.js";
import { DEFAULT_SETTINGS } from "../src/domain/settings/ui-settings.js";

function fakeNotificationImpl({ permission = "default", requestPermissionResult = "granted" } = {}) {
	const created = [];
	function FakeNotification(title, opts) {
		created.push({ title, ...opts });
	}
	FakeNotification.permission = permission;
	FakeNotification.requestPermission = async () => requestPermissionResult;
	return { FakeNotification, created };
}

test("requestNotificationPermission: без Notification API -> 'unsupported', не бросает", async () => {
	const result = await requestNotificationPermission({ NotificationImpl: undefined });
	assert.equal(result, "unsupported");
});

test("requestNotificationPermission: уже granted -> возвращает granted, requestPermission НЕ вызывается повторно", async () => {
	const { FakeNotification } = fakeNotificationImpl({ permission: "granted" });
	let calledAgain = false;
	FakeNotification.requestPermission = async () => {
		calledAgain = true;
		return "granted";
	};
	const result = await requestNotificationPermission({ NotificationImpl: FakeNotification });
	assert.equal(result, "granted");
	assert.equal(calledAgain, false);
});

test("requestNotificationPermission: default -> реально запрашивает разрешение", async () => {
	const { FakeNotification } = fakeNotificationImpl({ permission: "default", requestPermissionResult: "granted" });
	const result = await requestNotificationPermission({ NotificationImpl: FakeNotification });
	assert.equal(result, "granted");
});

test("notify: permission !== granted -> тихо null, не throw", () => {
	const { FakeNotification, created } = fakeNotificationImpl({ permission: "denied" });
	const result = notify(DEFAULT_SETTINGS, "messages", "incoming", { title: "t", body: "b" }, { NotificationImpl: FakeNotification });
	assert.equal(result, null);
	assert.equal(created.length, 0);
});

test("notify: категория moderation ВСЕГДА показывается, даже если notifications.enabled=false", () => {
	const { FakeNotification, created } = fakeNotificationImpl({ permission: "granted" });
	const settings = { ...DEFAULT_SETTINGS, notifications: { ...DEFAULT_SETTINGS.notifications, enabled: false } };
	const result = notify(settings, "moderation", null, { title: "Бан", body: "..." }, { NotificationImpl: FakeNotification });
	assert.ok(result);
	assert.equal(created.length, 1);
	assert.equal(created[0].title, "Бан");
});

test("notify: категория messages гейтится верхнеуровневым notifications.enabled", () => {
	const { FakeNotification, created } = fakeNotificationImpl({ permission: "granted" });
	const settings = { ...DEFAULT_SETTINGS, notifications: { ...DEFAULT_SETTINGS.notifications, enabled: false } };
	const result = notify(settings, "messages", "incoming", { title: "t", body: "b" }, { NotificationImpl: FakeNotification });
	assert.equal(result, null);
	assert.equal(created.length, 0);
});

test("notify: вложенный тумблер (contacts.newRequests=false) блокирует именно эту подкатегорию, остальные contacts-уведомления работают", () => {
	const { FakeNotification, created } = fakeNotificationImpl({ permission: "granted" });
	const settings = {
		...DEFAULT_SETTINGS,
		notifications: {
			...DEFAULT_SETTINGS.notifications,
			contacts: { ...DEFAULT_SETTINGS.notifications.contacts, newRequests: false },
		},
	};
	const blocked = notify(settings, "contacts", "newRequests", { title: "t", body: "b" }, { NotificationImpl: FakeNotification });
	const allowed = notify(settings, "contacts", "accepted", { title: "t2", body: "b2" }, { NotificationImpl: FakeNotification });
	assert.equal(blocked, null);
	assert.ok(allowed);
	assert.equal(created.length, 1);
});

test("notify: категория целиком выключена (channels.enabled=false) блокирует ВСЕ подкатегории этой категории", () => {
	const { FakeNotification, created } = fakeNotificationImpl({ permission: "granted" });
	const settings = {
		...DEFAULT_SETTINGS,
		notifications: {
			...DEFAULT_SETTINGS.notifications,
			channels: { ...DEFAULT_SETTINGS.notifications.channels, enabled: false },
		},
	};
	const result = notify(settings, "channels", "newPosts", { title: "t", body: "b" }, { NotificationImpl: FakeNotification });
	assert.equal(result, null);
	assert.equal(created.length, 0);
});
