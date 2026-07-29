import { test } from "node:test";
import assert from "node:assert/strict";
import { createInitialState, applyOp, ROOT_ID } from "../src/domain/files/tree.js";
import { createFolder } from "../src/domain/files/ops.js";
import { joinPerm, effectivePerm, effectivePermForChildren, coveringShares } from "../src/domain/files/permissions.js";

let counter = 0;
function label() {
	counter += 1;
	return { counter, deviceId: "device-a" };
}

function mkFolder(S, parentId, name) {
	const op = createFolder(S, parentId, name, `n-${name}`, label());
	return [applyOp(S, op), op.id];
}

const ALICE = "alice-pubkey";
const BOB = "bob-pubkey";

test("joinPerm: коммутативна, ассоциативна, идемпотентна (полный перебор по конечной решётке)", () => {
	const levels = ["none", "read", "write", "own"];
	for (const a of levels) {
		for (const b of levels) {
			assert.equal(joinPerm(a, b), joinPerm(b, a), `коммутативность: join(${a},${b})`);
			assert.equal(joinPerm(a, a), a, `идемпотентность: join(${a},${a})`);
			for (const c of levels) {
				assert.equal(joinPerm(joinPerm(a, b), c), joinPerm(a, joinPerm(b, c)), `ассоциативность: (${a},${b},${c})`);
			}
		}
	}
});

test("joinPerm: даёт максимум по цепи none < read < write < own", () => {
	assert.equal(joinPerm("none", "read"), "read");
	assert.equal(joinPerm("read", "write"), "write");
	assert.equal(joinPerm("write", "own"), "own");
	assert.equal(joinPerm("own", "none"), "own");
});

test("effectivePerm: без грантов -> none", () => {
	let S = createInitialState();
	let a;
	[S, a] = mkFolder(S, ROOT_ID, "A");
	const grantsIndex = new Map();
	assert.equal(effectivePerm(grantsIndex, S, ALICE, a), "none");
});

test("effectivePerm: прямой грант на сам узел -> тот уровень", () => {
	let S = createInitialState();
	let a;
	[S, a] = mkFolder(S, ROOT_ID, "A");
	const grantsIndex = new Map([[a, new Map([[ALICE, "read"]])]]);
	assert.equal(effectivePerm(grantsIndex, S, ALICE, a), "read");
});

test("effectivePerm: грант на предка наследуется потомком (аддитивная семантика)", () => {
	let S = createInitialState();
	let a, b;
	[S, a] = mkFolder(S, ROOT_ID, "A");
	[S, b] = mkFolder(S, a, "B");
	const grantsIndex = new Map([[a, new Map([[ALICE, "read"]])]]);
	assert.equal(effectivePerm(grantsIndex, S, ALICE, b), "read");
});

test("effectivePerm: грант на ПОТОМКА не поднимается к предку (наследование только вниз)", () => {
	let S = createInitialState();
	let a, b;
	[S, a] = mkFolder(S, ROOT_ID, "A");
	[S, b] = mkFolder(S, a, "B");
	const grantsIndex = new Map([[b, new Map([[ALICE, "read"]])]]);
	assert.equal(effectivePerm(grantsIndex, S, ALICE, a), "none");
	assert.equal(effectivePerm(grantsIndex, S, ALICE, b), "read");
});

test("effectivePerm: грант глубже в цепи объединяется через join (потомок может получить БОЛЬШЕ, не меньше)", () => {
	let S = createInitialState();
	let a, b;
	[S, a] = mkFolder(S, ROOT_ID, "A");
	[S, b] = mkFolder(S, a, "B");
	const grantsIndex = new Map([
		[a, new Map([[ALICE, "read"]])],
		[b, new Map([[ALICE, "write"]])],
	]);
	assert.equal(effectivePerm(grantsIndex, S, ALICE, b), "write");
});

test("effectivePerm: аддитивная семантика, не переопределение — БЛИЖНИЙ грант НИЖЕ дальнего не понижает итог (MATH.md §6.2, отклонённая альтернатива)", () => {
	let S = createInitialState();
	let grandparent, parent, child;
	[S, grandparent] = mkFolder(S, ROOT_ID, "Grandparent");
	[S, parent] = mkFolder(S, grandparent, "Parent");
	[S, child] = mkFolder(S, parent, "Child");
	// Дальний предок даёт "write", ближний — только "read". Child своего гранта не имеет.
	const grantsIndex = new Map([
		[grandparent, new Map([[ALICE, "write"]])],
		[parent, new Map([[ALICE, "read"]])],
	]);
	// Аддитивно (принято): join("write","read") = "write" — право не может УМЕНЬШИТЬСЯ вниз по дереву.
	// Переопределением (отклонено): ближайший предок с грантом (parent="read") победил бы -> "read".
	assert.equal(effectivePerm(grantsIndex, S, ALICE, child), "write");
});

test("effectivePerm: разные пользователи изолированы друг от друга", () => {
	let S = createInitialState();
	let a;
	[S, a] = mkFolder(S, ROOT_ID, "A");
	const grantsIndex = new Map([[a, new Map([[ALICE, "read"]])]]);
	assert.equal(effectivePerm(grantsIndex, S, BOB, a), "none");
});

test("effectivePermForChildren: даёт то же самое, что поэлементный effectivePerm (регрессия O(D+k) против O(k·D))", () => {
	let S = createInitialState();
	let root;
	[S, root] = mkFolder(S, ROOT_ID, "Root");
	const children = [];
	for (let i = 0; i < 5; i++) {
		let id;
		[S, id] = mkFolder(S, root, `child${i}`);
		children.push(id);
	}
	const grantsIndex = new Map([
		[root, new Map([[ALICE, "read"]])],
		[children[2], new Map([[ALICE, "write"]])],
	]);

	const viaChildren = effectivePermForChildren(grantsIndex, S, ALICE, root, children);
	const viaDirect = children.map((c) => effectivePerm(grantsIndex, S, ALICE, c));
	assert.deepEqual(viaChildren, viaDirect);
	assert.deepEqual(viaDirect, ["read", "read", "write", "read", "read"]);
});

test("coveringShares: доля, покрывающая узел через несколько уровней предков", () => {
	let S = createInitialState();
	let a, b, c;
	[S, a] = mkFolder(S, ROOT_ID, "A");
	[S, b] = mkFolder(S, a, "B");
	[S, c] = mkFolder(S, b, "C");
	const grantsIndex = new Map([[a, new Map([[ALICE, "read"]])]]);
	assert.deepEqual(coveringShares(grantsIndex, S, c), new Set([a]));
});

test("coveringShares: узел вне всех долей -> пустое множество", () => {
	let S = createInitialState();
	let a;
	[S, a] = mkFolder(S, ROOT_ID, "A");
	const grantsIndex = new Map();
	assert.deepEqual(coveringShares(grantsIndex, S, a), new Set());
});

test("coveringShares: узел покрыт НЕСКОЛЬКИМИ вложенными долями одновременно", () => {
	let S = createInitialState();
	let a, b;
	[S, a] = mkFolder(S, ROOT_ID, "A");
	[S, b] = mkFolder(S, a, "B");
	const grantsIndex = new Map([
		[a, new Map([[ALICE, "read"]])],
		[b, new Map([[BOB, "read"]])],
	]);
	assert.deepEqual(coveringShares(grantsIndex, S, b), new Set([a, b]));
});

test("move-маршрутизация: между двумя непересекающимися долями -> leaving и entering оба непусты, unchanged пуст", () => {
	let S = createInitialState();
	let shareA, shareB;
	[S, shareA] = mkFolder(S, ROOT_ID, "ShareA");
	[S, shareB] = mkFolder(S, ROOT_ID, "ShareB");
	const grantsIndex = new Map([
		[shareA, new Map([[ALICE, "read"]])],
		[shareB, new Map([[BOB, "read"]])],
	]);
	const oldCover = coveringShares(grantsIndex, S, shareA);
	const newCover = coveringShares(grantsIndex, S, shareB);
	const leaving = new Set([...oldCover].filter((x) => !newCover.has(x)));
	const entering = new Set([...newCover].filter((x) => !oldCover.has(x)));
	const unchanged = new Set([...oldCover].filter((x) => newCover.has(x)));
	assert.deepEqual(leaving, new Set([shareA]));
	assert.deepEqual(entering, new Set([shareB]));
	assert.deepEqual(unchanged, new Set());
});

test("move-маршрутизация: перемещение ВНУТРИ одной доли -> unchanged = та доля, leaving/entering пусты", () => {
	let S = createInitialState();
	let share, x, y;
	[S, share] = mkFolder(S, ROOT_ID, "Share");
	[S, x] = mkFolder(S, share, "X");
	[S, y] = mkFolder(S, share, "Y");
	const grantsIndex = new Map([[share, new Map([[ALICE, "read"]])]]);
	const oldCover = coveringShares(grantsIndex, S, x);
	const newCover = coveringShares(grantsIndex, S, y);
	const leaving = new Set([...oldCover].filter((v) => !newCover.has(v)));
	const entering = new Set([...newCover].filter((v) => !oldCover.has(v)));
	const unchanged = new Set([...oldCover].filter((v) => newCover.has(v)));
	assert.deepEqual(leaving, new Set());
	assert.deepEqual(entering, new Set());
	assert.deepEqual(unchanged, new Set([share]));
});

test("move-маршрутизация: из НЕ-доли в долю -> только entering", () => {
	let S = createInitialState();
	let outside, share;
	[S, outside] = mkFolder(S, ROOT_ID, "Outside");
	[S, share] = mkFolder(S, ROOT_ID, "Share");
	const grantsIndex = new Map([[share, new Map([[ALICE, "read"]])]]);
	const oldCover = coveringShares(grantsIndex, S, outside);
	const newCover = coveringShares(grantsIndex, S, share);
	const leaving = new Set([...oldCover].filter((v) => !newCover.has(v)));
	const entering = new Set([...newCover].filter((v) => !oldCover.has(v)));
	assert.deepEqual(leaving, new Set());
	assert.deepEqual(entering, new Set([share]));
});
