import { toasts, dismissToast } from "../signals/toasts.js";

// Этап 47-довесок — рендер очереди тостов. Монтируется один раз в корне
// (app.jsx), сама очередь — глобальный сигнал, наполняется из notifier.js's
// backend (см. domain/notifications/backend.js).
export default function ToastHost() {
	if (toasts.value.length === 0) return null;
	return (
		<div class="toast-host" role="region" aria-label="Уведомления" aria-live="polite">
			{toasts.value.map((t) => (
				<div key={t.id} class={`toast${t.leaving ? " is-leaving" : ""}`} style={{ position: "relative" }}>
					<button type="button" class="toast-close" aria-label="Закрыть уведомление" onClick={() => dismissToast(t.id)}>
						×
					</button>
					<p class="toast-title">{t.title}</p>
					{t.body && <p class="toast-body">{t.body}</p>}
				</div>
			))}
		</div>
	);
}
