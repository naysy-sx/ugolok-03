import { test } from "node:test";
import assert from "node:assert/strict";
import { createPermissionRecord } from "../src/domain/auth/permissions.js";
import { ACTIONS } from "../src/domain/auth/bitset.js";

test("createPermissionRecord: собирает полную запись", () => {
	const record = createPermissionRecord({
		subject: "alice-pubkey",
		resource: "channel-1",
		allowMask: ACTIONS.VIEW | ACTIONS.COMMENT,
		denyMask: ACTIONS.COMMENT,
		lamportTs: 5,
		eventId: "event-abc",
	});
	assert.deepEqual(record, {
		subject: "alice-pubkey",
		resource: "channel-1",
		allowMask: ACTIONS.VIEW | ACTIONS.COMMENT,
		denyMask: ACTIONS.COMMENT,
		lamportTs: 5,
		eventId: "event-abc",
	});
});

test("createPermissionRecord: allowMask/denyMask по умолчанию 0", () => {
	const record = createPermissionRecord({
		subject: "alice-pubkey",
		resource: "channel-1",
		lamportTs: 1,
		eventId: "event-abc",
	});
	assert.equal(record.allowMask, 0);
	assert.equal(record.denyMask, 0);
});

test("createPermissionRecord: throw без subject", () => {
	assert.throws(() => createPermissionRecord({ resource: "r", lamportTs: 1, eventId: "e" }));
});

test("createPermissionRecord: throw без resource", () => {
	assert.throws(() => createPermissionRecord({ subject: "s", lamportTs: 1, eventId: "e" }));
});

test("createPermissionRecord: throw без lamportTs", () => {
	assert.throws(() => createPermissionRecord({ subject: "s", resource: "r", eventId: "e" }));
});

test("createPermissionRecord: throw без eventId", () => {
	assert.throws(() => createPermissionRecord({ subject: "s", resource: "r", lamportTs: 1 }));
});

test("createPermissionRecord: throw на нечисловой lamportTs", () => {
	assert.throws(() => createPermissionRecord({ subject: "s", resource: "r", lamportTs: "1", eventId: "e" }));
});
