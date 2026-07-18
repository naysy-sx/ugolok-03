import { test } from "node:test";
import assert from "node:assert/strict";
import { ACTIONS, ALL_ACTIONS, join, meet, complement, effective, can } from "../src/domain/auth/bitset.js";

test("ACTIONS: 5 непересекающихся степеней двойки (TECH.md §4.2)", () => {
	const values = Object.values(ACTIONS);
	assert.equal(values.length, 5);
	for (const v of values) {
		assert.equal(v & (v - 1), 0, `${v} не степень двойки`);
	}
	assert.equal(values.reduce((a, b) => a | b, 0), ALL_ACTIONS);
	// попарно не пересекаются
	for (let i = 0; i < values.length; i++) {
		for (let j = i + 1; j < values.length; j++) {
			assert.equal(values[i] & values[j], 0);
		}
	}
});

test("join/meet: коммутативность", () => {
	const a = ACTIONS.VIEW | ACTIONS.WRITE;
	const b = ACTIONS.COMMENT | ACTIONS.WRITE;
	assert.equal(join(a, b), join(b, a));
	assert.equal(meet(a, b), meet(b, a));
});

test("join/meet: ассоциативность", () => {
	const a = ACTIONS.VIEW;
	const b = ACTIONS.COMMENT;
	const c = ACTIONS.WRITE;
	assert.equal(join(join(a, b), c), join(a, join(b, c)));
	assert.equal(meet(meet(a, b), c), meet(a, meet(b, c)));
});

test("join/meet: идемпотентность", () => {
	const a = ACTIONS.VIEW | ACTIONS.MODERATE;
	assert.equal(join(a, a), a);
	assert.equal(meet(a, a), a);
});

test("join/meet: поглощение (absorption)", () => {
	const a = ACTIONS.VIEW | ACTIONS.COMMENT;
	const b = ACTIONS.COMMENT | ACTIONS.WRITE;
	assert.equal(join(a, meet(a, b)), a);
	assert.equal(meet(a, join(a, b)), a);
});

test("complement: де Морган относительно ALL_ACTIONS", () => {
	const a = ACTIONS.VIEW | ACTIONS.WRITE;
	const b = ACTIONS.COMMENT | ACTIONS.WRITE;
	assert.equal(complement(join(a, b)), meet(complement(a), complement(b)));
	assert.equal(complement(meet(a, b)), join(complement(a), complement(b)));
});

test("complement: двойное дополнение возвращает исходное значение", () => {
	const a = ACTIONS.VIEW | ACTIONS.ADMIN;
	assert.equal(complement(complement(a)), a);
});

test("complement: не выходит за пределы ALL_ACTIONS (не буквальный побитовый ~)", () => {
	assert.equal(complement(0), ALL_ACTIONS);
	assert.equal(complement(ALL_ACTIONS), 0);
});

test("effective: allow=VIEW|COMMENT, deny=COMMENT -> effective=VIEW (критерий PLAN.md, этап 21)", () => {
	const allow = ACTIONS.VIEW | ACTIONS.COMMENT;
	const deny = ACTIONS.COMMENT;
	assert.equal(effective(allow, deny), ACTIONS.VIEW);
});

test("effective: fail-closed — effective(0, 0) === 0", () => {
	assert.equal(effective(0, 0), 0);
});

test("effective: deny побеждает allow при пересечении бит", () => {
	const allow = ACTIONS.VIEW | ACTIONS.WRITE;
	const deny = ACTIONS.VIEW | ACTIONS.ADMIN;
	assert.equal(effective(allow, deny), ACTIONS.WRITE);
});

test("can: true когда бит присутствует в маске", () => {
	assert.equal(can(ACTIONS.VIEW | ACTIONS.COMMENT, ACTIONS.VIEW), true);
});

test("can: false когда бита нет в маске", () => {
	assert.equal(can(ACTIONS.VIEW, ACTIONS.ADMIN), false);
});

test("can: false на пустой маске (undefined-эквивалент, fail-closed)", () => {
	assert.equal(can(0, ACTIONS.VIEW), false);
});
