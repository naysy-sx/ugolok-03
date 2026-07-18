import { useState } from "preact/hooks";

const STATUS_LABELS = {
	created: "черновик",
	sending: "отправка…",
	sent: "отправлено",
	read: "прочитано",
	failed: "не доставлено",
	discarded: "отменено",
};

// "Удалить у обоих"/"Редактировать" технически возможны ТОЛЬКО для своих сообщений
// (deleteMessage/editMessage проверяют авторство, CONTRACTS.md этап 27-довесок-5/6) —
// у чужих сообщений доступно только "Удалить у себя", без раскрывающегося меню.
// mode: null | "confirming-delete" | "editing" — один открытый режим за раз, без
// модалки/библиотеки (бюджет бандла), инлайн в самом сообщении.
export default function MessageBubble({ message, isOwn, onDeleteForMe, onDeleteForBoth, onEdit, maxLength }) {
	const [mode, setMode] = useState(null);
	const [editText, setEditText] = useState(message.text);

	const bubbleStyle = {
		alignSelf: isOwn ? "flex-end" : "flex-start",
		maxWidth: "70%",
		padding: "var(--space-2xs)",
		borderRadius: "var(--radius)",
		background: isOwn ? "var(--accent, oklch(0.9 0.05 250))" : "var(--surface)",
	};

	if (message.deleted) {
		return (
			<div style={bubbleStyle}>
				<p style={{ fontStyle: "italic", color: "var(--muted)" }}>Сообщение удалено</p>
			</div>
		);
	}

	const statusLabel = STATUS_LABELS[message.status];

	if (mode === "editing") {
		return (
			<div style={bubbleStyle}>
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
		<div style={bubbleStyle}>
			<p>{message.text}</p>
			<footer class="cluster" style={{ alignItems: "center" }}>
				{isOwn && statusLabel && <small style={{ color: "var(--muted)" }}>{statusLabel}</small>}
				{message.edited && <small style={{ color: "var(--muted)" }}>(изменено)</small>}
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
