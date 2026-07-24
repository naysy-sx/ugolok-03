import { signal } from "@preact/signals";

// Этап 47-довесок — очередь СВОИХ (не системных) уведомлений-тостов: полный
// контроль над видом/анимацией, в отличие от Notification API, которую
// стилизовать невозможно (пользователь явно попросил "красиво и плавно").
export const toasts = signal([]); // [{id, title, body, onClick, leaving}]

const AUTO_DISMISS_MS = 4500;
const LEAVE_ANIMATION_MS = 200;

let nextId = 0;

// onClick (этап 47-довесок-3) — необязательный колбэк "перейти к месту события",
// см. signals/notification-nav.js. Клик по крестику закрытия НЕ должен его
// вызывать — обрабатывается отдельно в toast-host.jsx (stopPropagation).
export function pushToast({ title, body, onClick }) {
	const id = nextId++;
	toasts.value = [...toasts.value, { id, title, body, onClick, leaving: false }];
	setTimeout(() => dismissToast(id), AUTO_DISMISS_MS);
	return id;
}

// Двухфазно: сперва помечаем "leaving" (запускает CSS-анимацию ухода), затем,
// после её длительности, реально убираем из массива — иначе тост исчезал бы
// мгновенно, без плавного выхода.
export function dismissToast(id) {
	toasts.value = toasts.value.map((t) => (t.id === id ? { ...t, leaving: true } : t));
	setTimeout(() => {
		toasts.value = toasts.value.filter((t) => t.id !== id);
	}, LEAVE_ANIMATION_MS);
}
