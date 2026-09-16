// Этап 5 (MESSAGE-DELIVERY-TZ.md, З5.6) — вынесено из message-bubble.jsx
// чистым модулем ради юнит-теста без рендера (по прецеденту
// message-bubble-attachments.js/bubble-attachment-plan.js — JSX-компоненты
// здесь не тестируются напрямую, только извлечённая из них чистая логика).
export const STATUS_LABEL_KEYS = {
	queued: "message.status.queued",
	created: "message.status.created",
	sending: "message.status.sending",
	sent: "message.status.sent",
	delivered: "message.status.delivered",
	read: "message.status.read",
	failed: "message.status.failed",
	discarded: "message.status.discarded",
};

export function resolveReceiptKind({ status, pendingAcceptance = false, lamportTs, deliveredUpTo = 0, readUpTo = 0 } = {}) {
	if (status === "failed") return "failed";
	if (status === "queued") return "queued";
	if (status === "sending" || status === "created") return "sending";
	if (pendingAcceptance && status === "sent") return "awaitingAcceptance";
	if (status === "read" || (typeof lamportTs === "number" && readUpTo > 0 && lamportTs <= readUpTo)) return "read";
	if (typeof lamportTs === "number" && deliveredUpTo > 0 && lamportTs <= deliveredUpTo) return "delivered";
	if (status === "sent") return "sent";
	return STATUS_LABEL_KEYS[status] ? status : undefined;
}

// "sent" здесь означает только "relay принял публикацию", НЕ "получатель
// состоит в MLS-группе". Пока статус не дошёл до read (пиггибэк/ACK, см.
// chat.js sweepPendingAcks) И собеседник ещё "незнакомец, ни разу не
// писавший" (pendingAcceptance — вычисляется в chat.jsx из contacts.value +
// истории), обычная галочка "отправлено" вводит в заблуждение: Welcome мог
// годами лежать непринятым в его inbox.
export function resolveStatusLabelKey(status, pendingAcceptance, extras = {}) {
	const kind = resolveReceiptKind({ status, pendingAcceptance, ...extras });
	if (kind === "awaitingAcceptance") return "message.status.awaitingAcceptance";
	return kind ? STATUS_LABEL_KEYS[kind] : undefined;
}
