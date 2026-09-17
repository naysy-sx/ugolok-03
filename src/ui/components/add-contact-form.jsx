import { useState, useRef, useEffect, useId } from "preact/hooks";
import { sendContactRequestAction } from "../signals/contacts.js";
import IconPersonAdd from "../icons/person-add.jsx";
import { t, errorMessage } from "../signals/i18n.js";

// Вынесена из contacts.jsx (экран "Контакты") — та же форма теперь нужна
// ВТОРЫМ местом (модальное окно "Добавить контакт", см. add-contact-modal.jsx,
// вызывается из сайдбара). Одна точка правды для busy/error-логики и разметки,
// не два независимых копипаста, которые разъедутся при следующей правке.
//
// Пользователь — кнопка "Добавить" переименована в "Отправить запрос":
// нажатие не добавляет контакт немедленно, только отправляет заявку (её ещё
// нужно принять на другой стороне) — прежний текст создавал ложное
// впечатление, что контакт уже добавлен.
export default function AddContactForm({ autoFocus, onSent }) {
	const [npubInput, setNpubInput] = useState("");
	const [addError, setAddError] = useState("");
	const [busy, setBusy] = useState(false);
	// busyRef — та же синхронная защита от повторного входа, что и раньше
	// в contacts.jsx (busy-state коммитится асинхронно, второй клик до коммита
	// читал бы ещё старое значение из замыкания).
	const busyRef = useRef(false);
	const inputRef = useRef(null);
	const inputId = useId();

	useEffect(() => {
		if (autoFocus) inputRef.current?.focus();
	}, [autoFocus]);

	async function handleAddContact(e) {
		e.preventDefault();
		if (busyRef.current) return;
		busyRef.current = true;
		setAddError("");
		setBusy(true);
		try {
			await sendContactRequestAction(npubInput, "");
			setNpubInput("");
			onSent?.();
		} catch (err) {
			setAddError(errorMessage(err));
		} finally {
			busyRef.current = false;
			setBusy(false);
		}
	}

	return (
		<div class="stack" style={{ "--gap": "var(--space-3xs)" }}>
			{/* Пользователь (item 5) — раньше подпись поля жила только в aria
			    (visually-hidden), placeholder дублировал её текстом. Теперь подпись
			    видна НАД всей группой поле+кнопка (не внутри серого поля — она не
			    часть его раскладки/бордера, только заголовок над ним), а placeholder —
			    короче и не повторяет заголовок кнопки. */}
			<label class="contact-add-label" for={inputId}>
				{t("contacts.addContactHeading")}
			</label>
			<form class="row contacts-add-form" style={{ "--gap": "0", "--align": "stretch" }} onSubmit={handleAddContact}>
				<div class="row grow contact-add-field" style={{ "--gap": "var(--space-2xs)", "--align": "center" }}>
					<IconPersonAdd aria-hidden="true" />
					<input
						id={inputId}
						ref={inputRef}
						type="text"
						placeholder={t("contacts.addContactPlaceholder")}
						value={npubInput}
						onInput={(e) => setNpubInput(e.currentTarget.value)}
					/>
				</div>
				<button type="submit" disabled={busy}>
					{t("contacts.sendRequestButton")}
				</button>
			</form>
			{addError && (
				<p role="alert" style={{ color: "var(--bad)" }}>
					{addError}
				</p>
			)}
		</div>
	);
}
