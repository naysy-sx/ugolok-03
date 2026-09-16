import { test } from "node:test";
import assert from "node:assert/strict";
import { MESSAGE_TRANSITIONS, transitionMessage } from "../src/domain/messaging/machine.js";

const STATES = ["queued", "created", "sending", "sent", "read", "failed", "discarded"];
const EVENTS = ["ESTABLISHED", "SEND", "ACK", "READ", "FAIL", "RETRY", "DISCARD"];

const VALID = new Set([
	"queued:ESTABLISHED",
	"created:SEND",
	"sending:ACK",
	"sending:FAIL",
	"sent:READ",
	"failed:RETRY",
	"failed:DISCARD",
]);

test("TECH.md §9.1 + Этап 1 (MESSAGE-DELIVERY-TZ.md, З1.2) — ровно 7 валидных переходов, буквально как в спецификации", () => {
	assert.equal(transitionMessage("queued", "ESTABLISHED"), "sending");
	assert.equal(transitionMessage("created", "SEND"), "sending");
	assert.equal(transitionMessage("sending", "ACK"), "sent");
	assert.equal(transitionMessage("sending", "FAIL"), "failed");
	assert.equal(transitionMessage("sent", "READ"), "read");
	assert.equal(transitionMessage("failed", "RETRY"), "sending");
	assert.equal(transitionMessage("failed", "DISCARD"), "discarded");
});

test("исчерпывающий перебор всех 49 пар (state,event) — недопустимые бросают, не проглатывают молча", () => {
	let validCount = 0;
	let invalidCount = 0;
	for (const state of STATES) {
		for (const event of EVENTS) {
			const key = `${state}:${event}`;
			if (VALID.has(key)) {
				validCount++;
				assert.doesNotThrow(() => transitionMessage(state, event), `${key} должен быть валиден`);
			} else {
				invalidCount++;
				assert.throws(() => transitionMessage(state, event), `${key} обязан бросить`);
			}
		}
	}
	assert.equal(validCount, 7);
	assert.equal(invalidCount, 42);
});

test("read и discarded — финальные состояния, без исходящих переходов вообще", () => {
	for (const event of EVENTS) {
		assert.throws(() => transitionMessage("read", event));
		assert.throws(() => transitionMessage("discarded", event));
	}
});

test("MESSAGE_TRANSITIONS не содержит wildcard-фоллбэка '*' (все переходы явные, не смазанные)", () => {
	assert.equal(MESSAGE_TRANSITIONS["*"], undefined);
});
