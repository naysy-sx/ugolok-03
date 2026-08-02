import { toasts, dismissToast } from "../signals/toasts.js";
import { t } from "../signals/i18n.js";

// Этап 47-довесок — рендер очереди тостов. Монтируется один раз в корне
// (app.jsx), сама очередь — глобальный сигнал, наполняется из notifier.js's
// backend (см. domain/notifications/backend.js).
// Этап 47-довесок-3 — клик по тосту (не по крестику) переходит "к месту события"
// (t.onClick, см. signals/notification-nav.js). Крестик — stopPropagation, иначе
// закрытие тоста ТАКЖЕ триггерило бы навигацию (клик всплыл бы на контейнер).
export default function ToastHost() {
	if (toasts.value.length === 0) return null;
	return (
		<div class="toast-host" role="region" aria-label={t("toast.regionAria")} aria-live="polite">
			{toasts.value.map((toast) => (
				<div
					key={toast.id}
					class={`toast${toast.leaving ? " is-leaving" : ""}${toast.onClick ? " is-clickable" : ""}`}
					style={{ position: "relative" }}
					role={toast.onClick ? "button" : undefined}
					tabIndex={toast.onClick ? 0 : undefined}
					onClick={toast.onClick ? () => toast.onClick() : undefined}
					onKeyDown={toast.onClick ? (e) => (e.key === "Enter" || e.key === " ") && toast.onClick() : undefined}
				>
					<button
						type="button"
						class="toast-close"
						aria-label={t("toast.closeAria")}
						onClick={(e) => {
							e.stopPropagation();
							dismissToast(toast.id);
						}}
					>
						×
					</button>
					<p class="toast-title">{toast.title}</p>
					{toast.body && <p class="toast-body">{toast.body}</p>}
				</div>
			))}
		</div>
	);
}
