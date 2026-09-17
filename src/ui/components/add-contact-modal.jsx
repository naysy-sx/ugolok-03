import { useEffect } from "preact/hooks";
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

	return (
		<div
			role="dialog"
			aria-modal="true"
			aria-label={t("shell.addContact")}
			onClick={onClose}
			style={{
				position: "fixed",
				inset: 0,
				background: "rgba(0, 0, 0, 0.5)",
				display: "flex",
				alignItems: "center",
				justifyContent: "center",
				zIndex: 1000,
				padding: "var(--space-m)",
			}}
		>
			<div
				onClick={(e) => e.stopPropagation()}
				class="stack"
				style={{
					background: "var(--surface, canvas)",
					borderRadius: "var(--radius)",
					padding: "var(--space-m)",
					maxWidth: "26rem",
					width: "100%",
					"--gap": "var(--space-s)",
				}}
			>
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
		</div>
	);
}
