import { test } from "node:test";
import assert from "node:assert/strict";
import { POST_TRANSITIONS, transitionPost } from "../src/domain/content/post-machine.js";

const STATES = ["draft", "published", "archived"];
const EVENTS = ["PUBLISH", "ARCHIVE", "UNPUBLISH"];
const VALID = new Set(["draft:PUBLISH", "published:ARCHIVE", "published:UNPUBLISH"]);

test("TECH.md §9.2: ровно 3 валидных перехода, буквально как в спецификации", () => {
	assert.equal(transitionPost("draft", "PUBLISH"), "published");
	assert.equal(transitionPost("published", "ARCHIVE"), "archived");
	assert.equal(transitionPost("published", "UNPUBLISH"), "draft");
});

test("исчерпывающий перебор всех 9 пар (state,event) — недопустимые бросают", () => {
	let validCount = 0;
	let invalidCount = 0;
	for (const state of STATES) {
		for (const event of EVENTS) {
			const key = `${state}:${event}`;
			if (VALID.has(key)) {
				validCount++;
				assert.doesNotThrow(() => transitionPost(state, event), `${key} должен быть валиден`);
			} else {
				invalidCount++;
				assert.throws(() => transitionPost(state, event), `${key} обязан бросить`);
			}
		}
	}
	assert.equal(validCount, 3);
	assert.equal(invalidCount, 6);
});

test("archived — финальное состояние, без исходящих переходов вообще", () => {
	for (const event of EVENTS) {
		assert.throws(() => transitionPost("archived", event));
	}
});

test("POST_TRANSITIONS не содержит wildcard-фоллбэка '*'", () => {
	assert.equal(POST_TRANSITIONS["*"], undefined);
});
