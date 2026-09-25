import { useEffect } from "preact/hooks";
import { t } from "../signals/i18n.js";

// «Удалить контакт» — вопрос «удалить и переписку?». Три исхода: контакт и переписка,
// только контакт, отмена. Стили — .modal-* (custom.css).
export default function RemoveContactDialog({ name, busy, onCancel, onConfirm }) {
	useEffect(() => {
		function onKeyDown(e) {
			if (e.key === "Escape") onCancel();
		}
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [onCancel]);

	return (
		<div class="modal-backdrop" role="dialog" aria-modal="true" aria-label={t("contacts.removeDialog.title", { name })} onClick={onCancel}>
			<div class="modal-card stack" onClick={(e) => e.stopPropagation()} style={{ "--gap": "var(--space-s)" }}>
				<h2>{t("contacts.removeDialog.title", { name })}</h2>
				<p class="modal-card__body">{t("contacts.removeDialog.body")}</p>
				<div class="modal-card__actions">
					<button type="button" class="btn--ghost btn--danger" disabled={busy} onClick={() => onConfirm(true)}>
						{t("contacts.removeDialog.withChat")}
					</button>
					<button type="button" class="btn--ghost" disabled={busy} onClick={() => onConfirm(false)}>
						{t("contacts.removeDialog.contactOnly")}
					</button>
					<button type="button" class="link-btn" onClick={onCancel}>
						{t("common.cancel")}
					</button>
				</div>
			</div>
		</div>
	);
}
