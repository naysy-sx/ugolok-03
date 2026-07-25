import { useState } from "preact/hooks";
import AttachmentView from "./attachment-view.jsx";

const STATUS_LABELS = {
	created: "черновик",
	sending: "отправка…",
	sent: "отправлено",
	read: "прочитано",
	failed: "не доставлено",
	discarded: "отменено",
};

// sentAt (этап 29) — wall-clock время отправки, ОТСУТСТВУЕТ у сообщений старого формата
// (до этого этапа) — тогда просто не показываем метку, не 'Invalid Date'.
function formatTimestamp(sentAt) {
	if (typeof sentAt !== "number") return null;
	return new Date(sentAt * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// "Удалить у обоих"/"Редактировать" технически возможны ТОЛЬКО для своих сообщений
// (deleteMessage/editMessage проверяют авторство, CONTRACTS.md этап 27-довесок-5/6) —
// у чужих сообщений доступно только "Удалить у себя", без раскрывающегося меню.
// mode: null | "confirming-delete" | "editing" — один открытый режим за раз, без
// модалки/библиотеки (бюджет бандла), инлайн в самом сообщении.
export default function MessageBubble({ message, isOwn, onDeleteForMe, onDeleteForBoth, onEdit, maxLength }) {
	const [mode, setMode] = useState(null);
	const [editText, setEditText] = useState(message.text);

	// Ассиметричный "хвостик" пузыря (VISUAL.md, Claude Opus) — исходящее
	// поджато справа-снизу, входящее зеркально слева-снизу; сам скруглённый
	// радиус живёт в CSS (.message-bubble-own/-other), не инлайн-стилем —
	// нужен был класс, а не style, чтобы завязать цвета/радиус на палитру.
	const bubbleClass = `message-bubble ${isOwn ? "message-bubble-own" : "message-bubble-other"}`;

	if (message.deleted) {
		return (
			<div class={`${bubbleClass} message-bubble-deleted`}>
				<p>Сообщение удалено</p>
			</div>
		);
	}

	const statusLabel = STATUS_LABELS[message.status];
	const timestamp = formatTimestamp(message.sentAt);
	// position (F-AT-02, CONTRACTS.md этап 29) — ТОЛЬКО для type==="image"; остальные
	// типы вложений всегда рендерятся под текстом (переключатель им не показывается).
	const attachment = message.attachment;
	const attachmentAbove = attachment?.type === "image" && attachment.position === "above";
	const attachmentBelow = attachment && !attachmentAbove;

	if (mode === "editing") {
		return (
			<div class={bubbleClass}>
				<textarea value={editText} maxLength={maxLength} rows={2} onInput={(e) => setEditText(e.currentTarget.value)} />
				<footer class="cluster" style={{ alignItems: "center" }}>
					<button
						type="button"
						disabled={editText.length === 0}
						onClick={() => {
							setMode(null);
							onEdit(message.msgId, editText);
						}}
					>
						Сохранить
					</button>
					<button
						type="button"
						onClick={() => {
							setMode(null);
							setEditText(message.text);
						}}
					>
						Отмена
					</button>
				</footer>
			</div>
		);
	}

	return (
		<div class={bubbleClass}>
			{attachmentAbove && <AttachmentView attachment={attachment} />}
			{message.text && <p>{message.text}</p>}
			{attachmentBelow && <AttachmentView attachment={attachment} />}
			<footer class="cluster message-bubble-meta" style={{ alignItems: "center" }}>
				{timestamp && <small>{timestamp}</small>}
				{isOwn && statusLabel && <small>{statusLabel}</small>}
				{message.edited && <small>(изменено)</small>}
				{mode !== "confirming-delete" && (
					<>
						{isOwn && typeof onEdit === "function" && (
							<button type="button" onClick={() => setMode("editing")}>
								Редактировать
							</button>
						)}
						{typeof onDeleteForMe === "function" && (
							<button type="button" onClick={() => setMode("confirming-delete")}>
								Удалить
							</button>
						)}
					</>
				)}
				{mode === "confirming-delete" && (
					<>
						<button
							type="button"
							onClick={() => {
								setMode(null);
								onDeleteForMe(message.msgId);
							}}
						>
							Удалить у себя
						</button>
						{isOwn && typeof onDeleteForBoth === "function" && (
							<button
								type="button"
								onClick={() => {
									setMode(null);
									onDeleteForBoth(message.msgId);
								}}
							>
								Удалить у обоих
							</button>
						)}
						<button type="button" onClick={() => setMode(null)}>
							Отмена
						</button>
					</>
				)}
			</footer>
		</div>
	);
}
