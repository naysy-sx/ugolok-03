// Этап 5 (MESSAGE-DELIVERY-TZ.md, З5.6) — вынесено из message-bubble.jsx
// чистым модулем ради юнит-теста без рендера (по прецеденту
// message-bubble-attachments.js/bubble-attachment-plan.js — JSX-компоненты
// здесь не тестируются напрямую, только извлечённая из них чистая логика).
export const STATUS_LABEL_KEYS = {
	queued: "message.status.queued",
	created: "message.status.created",
	sending: "message.status.sending",
	sent: "message.status.sent",
	read: "message.status.read",
	failed: "message.status.failed",
	discarded: "message.status.discarded",
};

// "sent" здесь означает только "relay принял публикацию", НЕ "получатель
// состоит в MLS-группе". Пока статус не дошёл до read (пиггибэк/ACK, см.
// chat.js sweepPendingAcks) И собеседник ещё "незнакомец, ни разу не
// писавший" (pendingAcceptance — вычисляется в chat.jsx из contacts.value +
// истории), обычная галочка "отправлено" вводит в заблуждение: Welcome мог
// годами лежать непринятым в его inbox.
export function resolveStatusLabelKey(status, pendingAcceptance) {
	if (pendingAcceptance && status === "sent") return "message.status.awaitingAcceptance";
	return STATUS_LABEL_KEYS[status];
}
