import { toasts, dismissToast } from "../signals/toasts.js";

// Этап 47-довесок — рендер очереди тостов. Монтируется один раз в корне
// (app.jsx), сама очередь — глобальный сигнал, наполняется из notifier.js's
// backend (см. domain/notifications/backend.js).
// Этап 47-довесок-3 — клик по тосту (не по крестику) переходит "к месту события"
// (t.onClick, см. signals/notification-nav.js). Крестик — stopPropagation, иначе
// закрытие тоста ТАКЖЕ триггерило бы навигацию (клик всплыл бы на контейнер).
export default function ToastHost() {
	if (toasts.value.length === 0) return null;
	return (
		<div class="toast-host" role="region" aria-label="Уведомления" aria-live="polite">
			{toasts.value.map((t) => (
				<div
					key={t.id}
					class={`toast${t.leaving ? " is-leaving" : ""}${t.onClick ? " is-clickable" : ""}`}
					style={{ position: "relative" }}
					role={t.onClick ? "button" : undefined}
					tabIndex={t.onClick ? 0 : undefined}
					onClick={t.onClick ? () => t.onClick() : undefined}
					onKeyDown={t.onClick ? (e) => (e.key === "Enter" || e.key === " ") && t.onClick() : undefined}
				>
					<button
						type="button"
						class="toast-close"
						aria-label="Закрыть уведомление"
						onClick={(e) => {
							e.stopPropagation();
							dismissToast(t.id);
						}}
					>
						×
					</button>
					<p class="toast-title">{t.title}</p>
					{t.body && <p class="toast-body">{t.body}</p>}
				</div>
			))}
		</div>
	);
}
