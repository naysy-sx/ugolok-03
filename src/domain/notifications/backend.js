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
