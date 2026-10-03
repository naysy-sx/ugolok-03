import { useEffect } from "preact/hooks";
import { createPortal } from "preact/compat";
import AddContactForm from "./add-contact-form.jsx";
import IconCross from "../icons/cross.jsx";
import { t } from "../signals/i18n.js";

// Пользователь (item 2) — "Добавить контакт" в сайдборе раньше вёл на весь
// экран "Контакты" (та же цель, что уже есть у "Люди - все" — два элемента на
// одно и то же место). Теперь ссылка открывает МОДАЛЬНОЕ окно прямо с формой
// заявки (та же AddContactForm, что и на самом экране "Контакты") — тот же
// приём "белая карточка + затемнение + Escape/крестик", что уже есть в
// file-info-dialog.jsx/image-modal.jsx, не отдельная новая обвязка.
export default function AddContactModal({ onClose }) {
	useEffect(() => {
		function onKeyDown(e) {
			if (e.key === "Escape") onClose();
		}
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [onClose]);

	// Портал в <body>: на телефоне сайдбар — выезжающая панель с transform, а transform
	// делает предка контейнером для position:fixed. Модалка внутри панели рисовалась в
	// её границах и исчезала вместе с ней, когда панель закрывалась по клику.
	return createPortal(
		<div class="modal-backdrop" role="dialog" aria-modal="true" aria-label={t("shell.addContact")} onClick={onClose}>
			<div class="modal-card stack" onClick={(e) => e.stopPropagation()} style={{ "--gap": "var(--space-s)" }}>
				<div class="row" style={{ "--align": "center", "--gap": "var(--space-s)" }}>
					<h2 class="grow">{t("shell.addContact")}</h2>
					<button type="button" class="icon-btn" onClick={onClose} aria-label={t("common.close")}>
						<IconCross />
					</button>
				</div>
				<div class="add-contact-modal-form">
					<AddContactForm autoFocus onSent={onClose} />
				</div>
			</div>
		</div>,
		document.body,
	);
}
