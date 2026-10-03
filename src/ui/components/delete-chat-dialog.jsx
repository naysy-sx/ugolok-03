import { useEffect } from "preact/hooks";
import { createPortal } from "preact/compat";
import { t } from "../signals/i18n.js";

// «Удалить переписку» из списка чатов: подтверждение перед необратимым действием.
// Удаляет переписку только на этом устройстве (deleteChatForeverAction) — собеседник
// ничего не узнаёт, а новый разговор от него снова появится в списке. Стили — .modal-*.
export default function DeleteChatDialog({ name, busy, onCancel, onConfirm }) {
	useEffect(() => {
		function onKeyDown(e) {
			if (e.key === "Escape") onCancel();
		}
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [onCancel]);

	return createPortal(
		<div class="modal-backdrop" role="dialog" aria-modal="true" aria-label={t("chat.list.deleteDialog.title", { name })} onClick={onCancel}>
			<div class="modal-card stack" onClick={(e) => e.stopPropagation()} style={{ "--gap": "var(--space-s)" }}>
				<h2>{t("chat.list.deleteDialog.title", { name })}</h2>
				<p class="modal-card__body">{t("chat.list.deleteDialog.body")}</p>
				<div class="modal-card__actions">
					<button type="button" class="btn--ghost btn--danger" disabled={busy} onClick={onConfirm}>
						{t("chat.list.deleteDialog.confirm")}
					</button>
					<button type="button" class="link-btn" onClick={onCancel}>
						{t("common.cancel")}
					</button>
				</div>
			</div>
		</div>,
		document.body,
	);
}
