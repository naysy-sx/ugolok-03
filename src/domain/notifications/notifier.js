import { createWebNotificationBackend } from "./backend.js";

// CONTRACTS.md, этап 34 — DI для NotificationImpl, по прецеденту MediaRecorderImpl/
// WebSocketImpl.
export async function requestNotificationPermission(options = {}) {
	const NotificationImpl = options.NotificationImpl ?? globalThis.Notification;
	if (!NotificationImpl) return "unsupported";
	if (NotificationImpl.permission === "granted" || NotificationImpl.permission === "denied") {
		return NotificationImpl.permission;
	}
	return NotificationImpl.requestPermission();
}

// Этап 47 — упорядоченное множество (DESIGN.md), НЕ 3 независимых булевых флага:
// каждый следующий уровень включает эффекты всех предыдущих.
export const NOTIFICATION_LEVELS = ["off", "badge", "popup", "sound"];

let defaultBackend = null;
let defaultBackendOptions = {};

// Этап 47-довесок — вызывается ОДИН раз из корня UI (app.jsx) с onToast/audioSrc,
// как только эти зависимости (сигнал тостов, звуковой ассет) становятся известны.
// До первого notify() без явного backend — использует дефолтные (без тоста/звука),
// getDefaultBackend просто ленивый синглтон поверх ЭТИХ опций.
export function configureDefaultBackend(options) {
	defaultBackendOptions = { ...defaultBackendOptions, ...options };
	defaultBackend = null; // пересоздать со свежими опциями при следующем обращении
}

function getDefaultBackend() {
	if (!defaultBackend) defaultBackend = createWebNotificationBackend(defaultBackendOptions);
	return defaultBackend;
}

// Приоритет разрешения (DESIGN.md, этап 47):
// (1) category==="moderation" && subcategory!=="reports" -> "sound" ВСЕГДА,
//     ДАЖЕ при notifications.enabled===false (бан/предупреждение/удаление
//     канала — принудительно, вне settings целиком — поведение этапа 34
//     для этих подкатегорий не меняется, "reports" — единственное
//     исключение внутри moderation, идёт по общим правилам ниже);
// (2) notifications.enabled===false -> "off" для ВСЕГО остального;
// (3) entityId и есть явный override для него -> override побеждает целиком,
//     ДАЖЕ "off" (заглушить конкретный канал/контакт насовсем);
// (4) иначе — дефолт категории/подкатегории; неизвестная категория -> "off".
export function resolveNotificationLevel(settings, category, subcategory, entityId) {
	const notifications = settings.notifications;
	if (category === "moderation" && subcategory !== "reports") return "sound";
	if (!notifications.enabled) return "off";

	if (category === "moderation") {
		return notifications.moderation?.reports ?? "off";
	}

	if (category === "contacts") {
		return notifications.contacts?.[subcategory] ?? "off";
	}

	if (category === "messages") {
		const override = entityId !== undefined && entityId !== null ? notifications.messages?.overrides?.[entityId] : undefined;
		if (override !== undefined) return override;
		return notifications.messages?.default ?? "off";
	}

	if (category === "channels") {
		const channelOverride = entityId !== undefined && entityId !== null ? notifications.channels?.overrides?.[entityId] : undefined;
		const overrideForSub = channelOverride?.[subcategory];
		if (overrideForSub !== undefined) return overrideForSub;
		return notifications.channels?.[subcategory] ?? "off";
	}

	if (category === "replies") {
		return notifications.replies ?? "off";
	}

	return "off";
}

// level="off" -> ничего, даже бейдж (счётчик непрочитанного считается ОТДЕЛЬНО, из
// фактического unread-состояния в БД — notify() не источник истины для бейджа, только
// решает показывать ли popup/играть ли звук). level∈{popup,sound} -> showPopup.
// level==="sound" -> ДОПОЛНИТЕЛЬНО playSound (sound — надмножество popup, DESIGN.md).
export function notify(settings, category, subcategory, { title, body }, entityId, backend = getDefaultBackend()) {
	const level = resolveNotificationLevel(settings, category, subcategory, entityId);
	if (level === "off") return level;
	if (level === "popup" || level === "sound") backend.showPopup(title, body);
	if (level === "sound") backend.playSound();
	return level;
}
