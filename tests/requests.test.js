import { test } from "node:test";
import assert from "node:assert/strict";
import {
	CONTACT_REQUEST_KIND,
	buildContactRequestRumor,
	parseContactRequestRumor,
	ACQUAINT_CANCELLED_KIND,
	buildAcquaintCancelledRumor,
} from "../src/domain/contacts/requests.js";

test("CONTACT_REQUEST_KIND: 3001", () => {
	assert.equal(CONTACT_REQUEST_KIND, 3001);
});

test("buildContactRequestRumor: форма rumor-шаблона, kind 3001, без подписи", () => {
	const rumor = buildContactRequestRumor("привет, добавь меня");
	assert.equal(rumor.kind, 3001);
	assert.equal(rumor.content, "привет, добавь меня");
	assert.deepEqual(rumor.tags, []);
	assert.equal(rumor.sig, undefined);
	assert.equal(typeof rumor.created_at, "number");
});

test("buildContactRequestRumor: приветствие по умолчанию — пустая строка", () => {
	const rumor = buildContactRequestRumor();
	assert.equal(rumor.content, "");
});

test("parseContactRequestRumor: достаёт greeting/senderPubkey/createdAt из уже развёрнутого rumor", () => {
	const rumor = { kind: 3001, content: "хочу добавить", pubkey: "abc123", created_at: 1234 };
	const parsed = parseContactRequestRumor(rumor);
	assert.deepEqual(parsed, { greeting: "хочу добавить", senderPubkey: "abc123", createdAt: 1234 });
});

// Этап 46 — раздел "Обзор": отмена ЕЩЁ не принятой заявки, отправитель отзывает сам.
test("ACQUAINT_CANCELLED_KIND: 3005", () => {
	assert.equal(ACQUAINT_CANCELLED_KIND, 3005);
});

test("buildAcquaintCancelledRumor: минимальный шаблон (тот же, что CONTACT_ACCEPTED_KIND) — смысл несёт rumor.pubkey после unwrap, не content", () => {
	const rumor = buildAcquaintCancelledRumor();
	assert.equal(rumor.kind, 3005);
	assert.equal(rumor.content, "");
	assert.deepEqual(rumor.tags, []);
	assert.equal(rumor.sig, undefined);
	assert.equal(typeof rumor.created_at, "number");
});
