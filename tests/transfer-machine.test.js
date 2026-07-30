import { test } from "node:test";
import assert from "node:assert/strict";
import { TRANSFER_TRANSITIONS, transitionTransfer } from "../src/domain/messaging/transfer-machine.js";

const STATES = ["idle", "encrypting", "uploading", "completed", "failed"];
const EVENTS = ["START", "ENCRYPTED", "UPLOADED", "ERROR", "RETRY"];

const VALID = new Set(["idle:START", "encrypting:ENCRYPTED", "uploading:UPLOADED", "uploading:ERROR", "failed:RETRY"]);

test("TECH.md §9.4: ровно 5 валидных переходов, буквально как в спецификации", () => {
	assert.equal(transitionTransfer("idle", "START"), "encrypting");
	assert.equal(transitionTransfer("encrypting", "ENCRYPTED"), "uploading");
	assert.equal(transitionTransfer("uploading", "UPLOADED"), "completed");
	assert.equal(transitionTransfer("uploading", "ERROR"), "failed");
	assert.equal(transitionTransfer("failed", "RETRY"), "encrypting");
});

test("исчерпывающий перебор всех 25 пар (state,event) — недопустимые бросают, не проглатывают молча", () => {
	let validCount = 0;
	let invalidCount = 0;
	for (const state of STATES) {
		for (const event of EVENTS) {
			const key = `${state}:${event}`;
			if (VALID.has(key)) {
				validCount++;
				assert.doesNotThrow(() => transitionTransfer(state, event), `${key} должен быть валиден`);
			} else {
				invalidCount++;
				assert.throws(() => transitionTransfer(state, event), `${key} обязан бросить`);
			}
		}
	}
	assert.equal(validCount, 5);
	assert.equal(invalidCount, 20);
});

test("completed — терминальное состояние, без исходящих переходов вообще", () => {
	for (const event of EVENTS) {
		assert.throws(() => transitionTransfer("completed", event));
	}
});

test("DESIGN.md, этап 28: encrypting+ERROR НЕ определён (сознательно, не пробел) — бросает", () => {
	assert.throws(() => transitionTransfer("encrypting", "ERROR"));
});

test("TRANSFER_TRANSITIONS не содержит wildcard-фоллбэка '*' (все переходы явные)", () => {
	assert.equal(TRANSFER_TRANSITIONS["*"], undefined);
});
