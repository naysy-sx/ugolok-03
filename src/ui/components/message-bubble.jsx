const STATUS_LABELS = {
	created: "черновик",
	sending: "отправка…",
	sent: "отправлено",
	read: "прочитано",
	failed: "не доставлено",
	discarded: "отменено",
};

export default function MessageBubble({ message, isOwn, onDelete }) {
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
			{isOwn && (
				<footer class="cluster" style={{ alignItems: "center" }}>
					{statusLabel && <small style={{ color: "var(--muted)" }}>{statusLabel}</small>}
					{typeof onDelete === "function" && (
						<button type="button" onClick={() => onDelete(message.msgId)}>
							Удалить
						</button>
					)}
				</footer>
			)}
		</div>
	);
}
