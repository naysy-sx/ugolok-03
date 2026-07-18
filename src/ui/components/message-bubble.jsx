import { useState } from "preact/hooks";

const STATUS_LABELS = {
	created: "черновик",
	sending: "отправка…",
	sent: "отправлено",
	read: "прочитано",
	failed: "не доставлено",
	discarded: "отменено",
};

// "Удалить у обоих" технически возможно ТОЛЬКО для своих сообщений (deleteMessage
// проверяет авторство, CONTRACTS.md этап 27-довесок-5) — выбор показывается только у
// isOwn; у чужих сообщений сразу одна кнопка "Удалить у себя", без раскрывающегося меню.
export default function MessageBubble({ message, isOwn, onDeleteForMe, onDeleteForBoth }) {
	const [confirming, setConfirming] = useState(false);

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

	return (
		<div style={bubbleStyle}>
			<p>{message.text}</p>
			<footer class="cluster" style={{ alignItems: "center" }}>
				{isOwn && statusLabel && <small style={{ color: "var(--muted)" }}>{statusLabel}</small>}
				{typeof onDeleteForMe === "function" && !confirming && (
					<button type="button" onClick={() => setConfirming(true)}>
						Удалить
					</button>
				)}
				{confirming && (
					<>
						<button
							type="button"
							onClick={() => {
								setConfirming(false);
								onDeleteForMe(message.msgId);
							}}
						>
							Удалить у себя
						</button>
						{isOwn && typeof onDeleteForBoth === "function" && (
							<button
								type="button"
								onClick={() => {
									setConfirming(false);
									onDeleteForBoth(message.msgId);
								}}
							>
								Удалить у обоих
							</button>
						)}
						<button type="button" onClick={() => setConfirming(false)}>
							Отмена
						</button>
					</>
				)}
			</footer>
		</div>
	);
}
