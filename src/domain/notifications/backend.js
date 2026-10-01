import { getPlatform } from "../../platform/index.js";

// Э4.8 ТЗ-NATIVE-APPS — нативный порт, предусмотренный комментарием ниже
// ("Нативный порт ПОЗЖЕ подставит СВОЮ реализацию той же формы"). Android
// WebView, в отличие от настольного/мобильного браузера, не показывает
// системные уведомления через обычный web Notification API, пока приложение
// свёрнуто (fallback-ветка createWebNotificationBackend's showPopup там
// бесполезна) — используется getPlatform().notifications.* (Э4.8,
// @capacitor/local-notifications) вместо browser API. Пока вкладка видима —
// тот же тост, что и на вебе (onToast); разница только в невидимой ветке.
// notify() (ниже в этом файле) даёт showPopup только JS-функцию onClick, не
// сериализуемый route — call site'ы (transport.js/call.js/contacts.js/
// journal.js) все построены вокруг navigateFromNotification(target)-замыканий,
// переводить их на явный route было бы отдельным, более крупным рефакторингом
// вне объёма Э4.8. Вместо этого: локальный id -> сам onClick, "route" в
// платформенном контракте (§4.3, cb(route)) — это просто наш clickId, а не
// domain-navigation-target напрямую. Работает, пока WebView не был убит
// системой между show() и кликом (typical для "свёрнуто ненадолго" — если
// процесс перезапущен, Map пуста, клик тихо ничего не делает; переживание
// полной выгрузки — задача push-инфраструктуры, Э9, вне объёма).
const pendingClickHandlers = new Map();
let clickIdCounter = 1;
let clickListenerRegistered = false;

function ensureClickListener(platform) {
	if (clickListenerRegistered) return;
	clickListenerRegistered = true;
	platform.notifications.onClick((route) => {
		const cb = pendingClickHandlers.get(route?.clickId);
		pendingClickHandlers.delete(route?.clickId);
		if (cb) cb();
	});
}

export function createCapacitorNotificationBackend(options = {}) {
	const platform = options.platform ?? getPlatform();
	const documentImpl = options.documentImpl ?? globalThis.document;
	const AudioImpl = options.AudioImpl ?? globalThis.Audio;
	const audioSrc = options.audioSrc;
	const onToast = options.onToast;

	return {
		showPopup(title, body, onClick) {
			const isVisible = documentImpl ? documentImpl.visibilityState === "visible" : true;
			if (isVisible && onToast) {
				onToast(title, body, onClick);
				return;
			}
			if (onClick) {
				const clickId = clickIdCounter++;
				pendingClickHandlers.set(clickId, onClick);
				ensureClickListener(platform);
				platform.notifications.show({ title, body, route: { clickId } }).catch(() => {});
			} else {
				platform.notifications.show({ title, body }).catch(() => {});
			}
		},
		playSound() {
			// Тот же принцип, что web-backend — best-effort, автоплей может быть
			// заблокирован политикой WebView без недавнего user-gesture.
			if (!AudioImpl || !audioSrc) return;
			try {
				new AudioImpl(audioSrc).play()?.catch(() => {});
			} catch {
				// не критично для остального notify()
			}
		},
		setBadgeCount(n) {
			platform.notifications.setBadge(n).catch(() => {});
		},
	};
}

// Этап 47 — задел под Tauri/Capacitor (CONTRACTS.md): notify() принимает backend
// явным параметром, вызывающий код (transport.js) не знает о платформе вовсе.
// Нативный порт ПОЗЖЕ подставит СВОЮ реализацию той же формы {showPopup, playSound,
// setBadgeCount} под теми же вызовами — не в скоупе этого этапа.
export function createWebNotificationBackend(options = {}) {
	const NotificationImpl = options.NotificationImpl ?? globalThis.Notification;
	const AudioImpl = options.AudioImpl ?? globalThis.Audio;
	const audioSrc = options.audioSrc;
	const onToast = options.onToast;
	const documentImpl = options.documentImpl ?? globalThis.document;

	return {
		// Этап 47-довесок (пользователь: "всплывашки должны быть красивыми и
		// плавными") — системный Notification API стилизовать нельзя (чужой UI ОС/
		// браузера), поэтому пока вкладка ВИДНА, показываем СВОЙ тост (onToast,
		// см. ui/signals/toasts.js) вместо него.Нативное уведомление — fallback
		// ИМЕННО для случая "вкладка свёрнута/не в фокусе", где тоста никто не
		// увидит (страница не рендерится видимо), а нативное продолжает работать.
		// onClick (этап 47-довесок-3) — необязательный колбэк "перейти к месту события".
		// Для тоста — прокидывается как есть (сам DOM-элемент кликабелен). Для нативного
		// Notification — вешается на .onclick; окно может быть не в фокусе (та самая
		// ветка, где нативное вообще показывается), поэтому явный window.focus() ПЕРЕД
		// колбэком — иначе навигация произойдёт в невидимой вкладке.
		showPopup(title, body, onClick) {
			const isVisible = documentImpl ? documentImpl.visibilityState === "visible" : true;
			if (isVisible && onToast) {
				onToast(title, body, onClick);
				return;
			}
			if (!NotificationImpl || NotificationImpl.permission !== "granted") return;
			const notification = new NotificationImpl(title, { body });
			if (onClick) {
				notification.onclick = () => {
					globalThis.focus?.();
					onClick();
					notification.close?.();
				};
			}
		},
		playSound() {
			// Web Notification API не поддерживает кастомный звук годами — звук
			// проигрывается отдельным <audio>, не через саму всплывашку. Автоплей
			// может быть заблокирован политикой браузера (нет недавнего user-gesture)
			// — ошибка проглатывается, звук не критичен для доставки уведомления.
			if (!AudioImpl || !audioSrc) return;
			try {
				new AudioImpl(audioSrc).play()?.catch(() => {});
			} catch {
				// AudioImpl может бросить синхронно в некоторых окружениях (напр. node
				// без polyfill) — тот же принцип, не критично для остального notify().
			}
		},
		setBadgeCount(n) {
			// Badging API — не во всех браузерах/окружениях (напр. node без DOM
			// вовсе) — globalThis.navigator, не голый navigator (иначе ReferenceError
			// там, где глобала нет совсем, до какого-либо optional chaining).
			const nav = globalThis.navigator;
			if (n > 0) {
				nav?.setAppBadge?.(n)?.catch?.(() => {});
			} else {
				nav?.clearAppBadge?.()?.catch?.(() => {});
			}
		},
	};
}
