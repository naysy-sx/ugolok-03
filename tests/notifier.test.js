import { test } from "node:test";
import assert from "node:assert/strict";
import { requestNotificationPermission, notify, resolveNotificationLevel, NOTIFICATION_LEVELS } from "../src/domain/notifications/notifier.js";
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

function fakeBackend() {
	const popups = [];
	let soundPlays = 0;
	return {
		backend: {
			showPopup: (title, body, onClick) => popups.push({ title, body, onClick }),
			playSound: () => {
				soundPlays++;
			},
			setBadgeCount: () => {},
		},
		popups,
		getSoundPlays: () => soundPlays,
	};
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

test("NOTIFICATION_LEVELS: упорядоченное множество off/badge/popup/sound", () => {
	assert.deepEqual(NOTIFICATION_LEVELS, ["off", "badge", "popup", "sound"]);
});

// --- resolveNotificationLevel: приоритет (DESIGN.md, этап 47) ---

test("resolveNotificationLevel: notifications.enabled=false -> 'off' для ЛЮБОЙ категории, включая messages с явным override", () => {
	const settings = {
		...DEFAULT_SETTINGS,
		notifications: {
			...DEFAULT_SETTINGS.notifications,
			enabled: false,
			messages: { default: "sound", overrides: { alice: "sound" } },
		},
	};
	assert.equal(resolveNotificationLevel(settings, "messages", null, "alice"), "off");
});

test("resolveNotificationLevel: moderation/reports идёт через обычное разрешение (настраиваемо)", () => {
	const settings = {
		...DEFAULT_SETTINGS,
		notifications: { ...DEFAULT_SETTINGS.notifications, moderation: { reports: "off" } },
	};
	assert.equal(resolveNotificationLevel(settings, "moderation", "reports"), "off");
});

test("resolveNotificationLevel: moderation/НЕ-reports (бан/warn/delete) -> ВСЕГДА 'sound', даже при enabled=false", () => {
	const settings = { ...DEFAULT_SETTINGS, notifications: { ...DEFAULT_SETTINGS.notifications, enabled: false } };
	assert.equal(resolveNotificationLevel(settings, "moderation", "ban"), "sound");
	assert.equal(resolveNotificationLevel(settings, "moderation", null), "sound");
});

test("resolveNotificationLevel: calls (этап 48) -> ВСЕГДА 'sound', даже при enabled=false — пропущенный звонок нельзя заглушить", () => {
	const settings = { ...DEFAULT_SETTINGS, notifications: { ...DEFAULT_SETTINGS.notifications, enabled: false } };
	assert.equal(resolveNotificationLevel(settings, "calls", null), "sound");
	assert.equal(resolveNotificationLevel(DEFAULT_SETTINGS, "calls", null), "sound");
});

test("resolveNotificationLevel: messages без override -> дефолт категории", () => {
	const settings = {
		...DEFAULT_SETTINGS,
		notifications: { ...DEFAULT_SETTINGS.notifications, messages: { default: "popup", overrides: {} } },
	};
	assert.equal(resolveNotificationLevel(settings, "messages", null, "bob"), "popup");
});

test("resolveNotificationLevel: messages С override -> override побеждает дефолт, ДАЖЕ 'off'", () => {
	const settings = {
		...DEFAULT_SETTINGS,
		notifications: { ...DEFAULT_SETTINGS.notifications, messages: { default: "sound", overrides: { bob: "off" } } },
	};
	assert.equal(resolveNotificationLevel(settings, "messages", null, "bob"), "off");
	assert.equal(resolveNotificationLevel(settings, "messages", null, "carol"), "sound", "у carol нет override — дефолт");
});

test("resolveNotificationLevel: channels — per-channel override по конкретной подкатегории, остальные подкатегории того же канала берут дефолт", () => {
	const settings = {
		...DEFAULT_SETTINGS,
		notifications: {
			...DEFAULT_SETTINGS.notifications,
			channels: { posts: "popup", comments: "popup", chat: "sound", overrides: { "chan-1": { chat: "off" } } },
		},
	};
	assert.equal(resolveNotificationLevel(settings, "channels", "chat", "chan-1"), "off");
	assert.equal(resolveNotificationLevel(settings, "channels", "posts", "chan-1"), "popup", "posts того же канала не переопределён — дефолт");
	assert.equal(resolveNotificationLevel(settings, "channels", "chat", "chan-2"), "sound", "другой канал — дефолт, override chan-1 его не касается");
});

test("resolveNotificationLevel: replies — глобальный уровень, без per-entity", () => {
	const settings = { ...DEFAULT_SETTINGS, notifications: { ...DEFAULT_SETTINGS.notifications, replies: "off" } };
	assert.equal(resolveNotificationLevel(settings, "replies", null), "off");
});

test("resolveNotificationLevel: inbox (заявка от незнакомца) — глобальный уровень, без per-entity", () => {
	const settings = { ...DEFAULT_SETTINGS, notifications: { ...DEFAULT_SETTINGS.notifications, inbox: "off" } };
	assert.equal(resolveNotificationLevel(settings, "inbox", null), "off");
	assert.equal(resolveNotificationLevel(DEFAULT_SETTINGS, "inbox", null), "popup", "дефолт из DEFAULT_SETTINGS");
});

test("resolveNotificationLevel: неизвестная категория -> 'off'", () => {
	assert.equal(resolveNotificationLevel(DEFAULT_SETTINGS, "unknown-category", null), "off");
});

// --- notify: побочные эффекты через backend-мок ---

test("notify: level='off' -> backend не трогается вовсе", () => {
	const { FakeNotification } = fakeNotificationImpl({ permission: "granted" });
	const { backend, popups, getSoundPlays } = fakeBackend();
	const settings = { ...DEFAULT_SETTINGS, notifications: { ...DEFAULT_SETTINGS.notifications, enabled: false } };
	const result = notify(settings, "messages", null, { title: "t", body: "b" }, "bob", backend);
	assert.equal(result, "off");
	assert.equal(popups.length, 0);
	assert.equal(getSoundPlays(), 0);
});

test("notify: level='popup' -> showPopup вызван, playSound НЕ вызван", () => {
	const { backend, popups, getSoundPlays } = fakeBackend();
	const settings = {
		...DEFAULT_SETTINGS,
		notifications: { ...DEFAULT_SETTINGS.notifications, channels: { posts: "popup", comments: "popup", chat: "popup", overrides: {} } },
	};
	const result = notify(settings, "channels", "posts", { title: "Новый пост", body: "" }, "chan-1", backend);
	assert.equal(result, "popup");
	assert.equal(popups.length, 1);
	assert.equal(popups[0].title, "Новый пост");
	assert.equal(getSoundPlays(), 0);
});

test("notify: level='sound' -> showPopup И playSound ОБА вызваны (sound — надмножество popup, DESIGN.md)", () => {
	const { backend, popups, getSoundPlays } = fakeBackend();
	const settings = {
		...DEFAULT_SETTINGS,
		notifications: { ...DEFAULT_SETTINGS.notifications, messages: { default: "sound", overrides: {} } },
	};
	const result = notify(settings, "messages", null, { title: "t", body: "b" }, "bob", backend);
	assert.equal(result, "sound");
	assert.equal(popups.length, 1);
	assert.equal(getSoundPlays(), 1);
});

test("notify: moderation/бан игнорирует settings.enabled=false, level='sound' принудительно", () => {
	const { backend, popups, getSoundPlays } = fakeBackend();
	const settings = { ...DEFAULT_SETTINGS, notifications: { ...DEFAULT_SETTINGS.notifications, enabled: false } };
	const result = notify(settings, "moderation", "ban", { title: "Бан", body: "" }, null, backend);
	assert.equal(result, "sound");
	assert.equal(popups.length, 1);
	assert.equal(getSoundPlays(), 1);
});

// Этап 47-довесок-3 — клик "к месту события".
test("notify: onClick пробрасывается в backend.showPopup как есть (для тоста/нативного клика)", () => {
	const { backend, popups } = fakeBackend();
	const onClick = () => {};
	notify(DEFAULT_SETTINGS, "messages", null, { title: "t", body: "b", onClick }, "bob", backend);
	assert.equal(popups[0].onClick, onClick);
});

test("notify: onClick не передан -> backend получает undefined, не бросает", () => {
	const { backend, popups } = fakeBackend();
	notify(DEFAULT_SETTINGS, "messages", null, { title: "t", body: "b" }, "bob", backend);
	assert.equal(popups[0].onClick, undefined);
});
