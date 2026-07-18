import { test } from "node:test";
import assert from "node:assert/strict";
import { rebuildCache, can } from "../src/domain/auth/engine.js";
import { createPermissionRecord } from "../src/domain/auth/permissions.js";
import { ACTIONS } from "../src/domain/auth/bitset.js";

function rec(overrides) {
	return createPermissionRecord({
		subject: "alice",
		resource: "channel-1",
		allowMask: 0,
		denyMask: 0,
		lamportTs: 0,
		eventId: "e0",
		...overrides,
	});
}

function shuffle(arr) {
	const a = arr.slice();
	for (let i = a.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[a[i], a[j]] = [a[j], a[i]];
	}
	return a;
}

test("критерий PLAN.md: allow=VIEW|COMMENT, deny=COMMENT -> effective=VIEW (одна запись)", () => {
	const records = [rec({ allowMask: ACTIONS.VIEW | ACTIONS.COMMENT, denyMask: ACTIONS.COMMENT, lamportTs: 1, eventId: "e1" })];
	const cache = rebuildCache(records);
	assert.equal(can(cache, "alice", "channel-1", ACTIONS.VIEW), true);
	assert.equal(can(cache, "alice", "channel-1", ACTIONS.COMMENT), false);
});

test("undefined (subject/resource без записей в журнале) -> can=false, fail-closed", () => {
	const cache = rebuildCache([]);
	assert.equal(can(cache, "bob", "channel-2", ACTIONS.VIEW), false);
});

test("undefined -> can=false даже когда журнал непустой для ДРУГОЙ пары subject/resource", () => {
	const records = [rec({ allowMask: ACTIONS.ADMIN, lamportTs: 1, eventId: "e1" })];
	const cache = rebuildCache(records);
	assert.equal(can(cache, "someone-else", "channel-1", ACTIONS.ADMIN), false);
	assert.equal(can(cache, "alice", "other-resource", ACTIONS.ADMIN), false);
});

test("R6-5 следствие 1: revoke (позже по Lamport) побеждает более ранний grant", () => {
	const records = [
		rec({ allowMask: ACTIONS.VIEW, lamportTs: 1, eventId: "e1" }),
		rec({ denyMask: ACTIONS.VIEW, lamportTs: 2, eventId: "e2" }),
	];
	const cache = rebuildCache(records);
	assert.equal(can(cache, "alice", "channel-1", ACTIONS.VIEW), false);
});

test("R6-5 следствие 1: результат не зависит от порядка ПОСТУПЛЕНИЯ записей (порядок-независимость)", () => {
	const records = [
		rec({ allowMask: ACTIONS.VIEW, lamportTs: 1, eventId: "e1" }),
		rec({ denyMask: ACTIONS.VIEW, lamportTs: 2, eventId: "e2" }),
	];
	for (let i = 0; i < 20; i++) {
		const cache = rebuildCache(shuffle(records));
		assert.equal(can(cache, "alice", "channel-1", ACTIONS.VIEW), false, `итерация ${i}: shuffle сломал детерминизм`);
	}
});

test("R6-5 следствие 2: более поздний grant ПОБЕЖДАЕТ более ранний revoke (revoke не абсолютен навсегда)", () => {
	const records = [
		rec({ allowMask: ACTIONS.VIEW, lamportTs: 1, eventId: "e1" }),
		rec({ denyMask: ACTIONS.VIEW, lamportTs: 2, eventId: "e2" }),
		rec({ allowMask: ACTIONS.VIEW, lamportTs: 3, eventId: "e3" }),
	];
	const cache = rebuildCache(shuffle(records));
	assert.equal(can(cache, "alice", "channel-1", ACTIONS.VIEW), true);
});

test("тайбрейкер eventId при равном lamportTs — детерминирован, не зависит от порядка поступления", () => {
	const records = [
		rec({ allowMask: ACTIONS.VIEW, lamportTs: 5, eventId: "aaa" }),
		rec({ denyMask: ACTIONS.VIEW, lamportTs: 5, eventId: "zzz" }),
	];
	const cacheA = rebuildCache(records);
	const cacheB = rebuildCache(shuffle(records));
	assert.equal(can(cacheA, "alice", "channel-1", ACTIONS.VIEW), can(cacheB, "alice", "channel-1", ACTIONS.VIEW));
	// zzz > aaa лексикографически -> deny применяется последним -> VIEW отозван
	assert.equal(can(cacheA, "alice", "channel-1", ACTIONS.VIEW), false);
});

test("идемпотентность: дубль записи (тот же eventId дважды) не меняет результат", () => {
	const withoutDup = [
		rec({ allowMask: ACTIONS.VIEW, lamportTs: 1, eventId: "e1" }),
		rec({ denyMask: ACTIONS.VIEW, lamportTs: 2, eventId: "e2" }),
	];
	const withDup = [...withoutDup, rec({ denyMask: ACTIONS.VIEW, lamportTs: 2, eventId: "e2" })];
	const cacheA = rebuildCache(withoutDup);
	const cacheB = rebuildCache(withDup);
	assert.equal(can(cacheA, "alice", "channel-1", ACTIONS.VIEW), can(cacheB, "alice", "channel-1", ACTIONS.VIEW));
});

test("несколько независимых пар (subject, resource) не влияют друг на друга", () => {
	const records = [
		createPermissionRecord({ subject: "alice", resource: "chan-1", allowMask: ACTIONS.VIEW, lamportTs: 1, eventId: "e1" }),
		createPermissionRecord({ subject: "bob", resource: "chan-1", allowMask: ACTIONS.ADMIN, lamportTs: 1, eventId: "e2" }),
		createPermissionRecord({ subject: "alice", resource: "chan-2", denyMask: ACTIONS.VIEW, lamportTs: 1, eventId: "e3" }),
	];
	const cache = rebuildCache(records);
	assert.equal(can(cache, "alice", "chan-1", ACTIONS.VIEW), true);
	assert.equal(can(cache, "bob", "chan-1", ACTIONS.ADMIN), true);
	assert.equal(can(cache, "bob", "chan-1", ACTIONS.VIEW), false);
	assert.equal(can(cache, "alice", "chan-2", ACTIONS.VIEW), false);
});

test("AC-PERM-AUDIT: rebuildCache на 10000 правил < 100мс", () => {
	const records = [];
	for (let i = 0; i < 10000; i++) {
		records.push(
			createPermissionRecord({
				subject: `subject-${i % 500}`,
				resource: `resource-${i % 50}`,
				allowMask: ACTIONS.VIEW | ACTIONS.COMMENT,
				denyMask: i % 7 === 0 ? ACTIONS.COMMENT : 0,
				lamportTs: i,
				eventId: `event-${i}`,
			}),
		);
	}
	const t0 = performance.now();
	rebuildCache(records);
	const elapsedMs = performance.now() - t0;
	assert.ok(elapsedMs < 100, `rebuildCache занял ${elapsedMs.toFixed(2)}мс, порог AC-PERM-AUDIT — 100мс`);
});
