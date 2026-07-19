// CONTRACTS.md, этап 34 — DI для NotificationImpl, по прецеденту MediaRecorderImpl/
// WebSocketImpl. "moderation" — единственная категория, которая ИГНОРИРУЕТ settings
// целиком (найденное решение: инфо-бокс мокапа буквально "предупреждения, бан и
// удаление канала показываются всегда").
export async function requestNotificationPermission(options = {}) {
	const NotificationImpl = options.NotificationImpl ?? globalThis.Notification;
	if (!NotificationImpl) return "unsupported";
	if (NotificationImpl.permission === "granted" || NotificationImpl.permission === "denied") {
		return NotificationImpl.permission;
	}
	return NotificationImpl.requestPermission();
}

function isCategoryEnabled(settings, category, subcategory) {
	const notifications = settings.notifications;
	if (!notifications.enabled) return false;
	const categorySettings = notifications[category];
	if (!categorySettings || !categorySettings.enabled) return false;
	if (subcategory && categorySettings[subcategory] === false) return false;
	return true;
}

export function notify(settings, category, subcategory, { title, body }, options = {}) {
	const NotificationImpl = options.NotificationImpl ?? globalThis.Notification;
	if (!NotificationImpl || NotificationImpl.permission !== "granted") return null;
	if (category !== "moderation" && !isCategoryEnabled(settings, category, subcategory)) return null;
	return new NotificationImpl(title, { body });
}
