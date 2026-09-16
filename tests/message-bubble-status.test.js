import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveStatusLabelKey, resolveReceiptKind } from "../src/ui/components/message-bubble-status.js";

// Этап 5 (MESSAGE-DELIVERY-TZ.md, З5.6) — "заявка не принята" обязана
// перекрывать обычную галочку "отправлено" ТОЛЬКО для status==="sent" и
// ТОЛЬКО когда pendingAcceptance истинен (chat.jsx: собеседник не в
// contacts.value И ни разу не писал в этом чате) — остальные статусы не
// затрагиваются вовсе, чтобы не сломать read/failed/queued/etc.

test("resolveStatusLabelKey: status='sent' + pendingAcceptance=true -> message.status.awaitingAcceptance", () => {
	assert.equal(resolveStatusLabelKey("sent", true), "message.status.awaitingAcceptance");
});

test("resolveStatusLabelKey: status='sent' + pendingAcceptance=false -> обычный message.status.sent", () => {
	assert.equal(resolveStatusLabelKey("sent", false), "message.status.sent");
});

test("resolveStatusLabelKey: status='read' + pendingAcceptance=true -> read (уже подтверждено — заявка явно принята) остаётся read", () => {
	assert.equal(resolveStatusLabelKey("read", true), "message.status.read");
});

test("resolveStatusLabelKey: status='queued' + pendingAcceptance=true -> queued (сообщение ещё не покидало устройство, ни при чём)", () => {
	assert.equal(resolveStatusLabelKey("queued", true), "message.status.queued");
});

test("resolveStatusLabelKey: status='failed' + pendingAcceptance=true -> failed (реальный сбой важнее эвристики)", () => {
	assert.equal(resolveStatusLabelKey("failed", true), "message.status.failed");
});

test("resolveStatusLabelKey: неизвестный статус -> undefined (как и раньше, компонент ничего не показывает)", () => {
	assert.equal(resolveStatusLabelKey("bogus", false), undefined);
	assert.equal(resolveStatusLabelKey("bogus", true), undefined);
});

test("resolveReceiptKind: курсоры delivered/read поверх sent", () => {
	assert.equal(resolveReceiptKind({ status: "sent", lamportTs: 2, deliveredUpTo: 2, readUpTo: 0 }), "delivered");
	assert.equal(resolveReceiptKind({ status: "sent", lamportTs: 2, deliveredUpTo: 3, readUpTo: 2 }), "read");
	assert.equal(resolveReceiptKind({ status: "sent", lamportTs: 4, deliveredUpTo: 3, readUpTo: 2 }), "sent");
	assert.equal(resolveReceiptKind({ status: "failed", lamportTs: 1, deliveredUpTo: 9, readUpTo: 9 }), "failed");
});
