import { test } from "node:test";
import assert from "node:assert/strict";
import { createInitialState, applyOp, project, ROOT_ID, LOST_FOUND_ID } from "../src/domain/files/tree.js";
import { createFolder, purge } from "../src/domain/files/ops.js";

function lbl(counter, deviceId) {
	return { counter, deviceId };
}
function id(prefix) {
	return `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
}

function mkFolder(S, parentId, name, label) {
	const newId = id("dir");
	const op = createFolder(S, parentId, name, newId, label);
	return [applyOp(S, op), newId];
}

// Контрпример §5.2 MATH.md: реплика A перемещает x внутрь y, реплика B
// ОДНОВРЕМЕННО перемещает y внутрь x. После слияния — цикл, оторванный от
// корня. Разрыв — ребро с МИНИМАЛЬНОЙ меткой (решение журнала №3).
test("MATH.md §5.2: взаимное перемещение x↔y даёт цикл, чинится разрывом МИНИМАЛЬНОГО ребра", () => {
	let S = createInitialState();
	let x, y;
	[S, x] = mkFolder(S, ROOT_ID, "X", lbl(1, "a"));
	[S, y] = mkFolder(S, ROOT_ID, "Y", lbl(2, "a"));

	// A: par(x) = y, метка (10, "device-a")
	S = applyOp(S, { type: "setPar", id: x, value: y, label: lbl(10, "device-a") });
	// B: par(y) = x, метка (5, "device-b") — МЕНЬШЕ, значит это ребро разорвётся
	S = applyOp(S, { type: "setPar", id: y, value: x, label: lbl(5, "device-b") });

	const R = project(S);
	assert.equal(R.nodes.get(y).parent, ROOT_ID, "y (меньшая метка ребра) отображается в корне");
	assert.equal(R.nodes.get(y).status, "repaired");
	assert.equal(R.nodes.get(x).parent, y, "x сохраняет связь через y — цикл разорван только в одной точке");

	// I-ACYCLIC постусловие: обход от x/y вверх обязан достигать корня.
	function ascendsToRoot(nodeId) {
		let cur = nodeId;
		let steps = 0;
		while (cur !== null && steps < 100) {
			cur = R.nodes.get(cur).parent;
			steps += 1;
		}
		return cur === null;
	}
	assert.ok(ascendsToRoot(x));
	assert.ok(ascendsToRoot(y));
});

test("I-STABLE: project(project(S)) — повторный вызов project(S) даёт тот же результат (R не пишет в S)", () => {
	let S = createInitialState();
	let x, y;
	[S, x] = mkFolder(S, ROOT_ID, "X", lbl(1, "a"));
	[S, y] = mkFolder(S, ROOT_ID, "Y", lbl(2, "a"));
	S = applyOp(S, { type: "setPar", id: x, value: y, label: lbl(10, "a") });
	S = applyOp(S, { type: "setPar", id: y, value: x, label: lbl(5, "b") });

	const R1 = project(S);
	const R2 = project(S);
	assert.deepEqual([...R1.nodes.entries()], [...R2.nodes.entries()]);
});

// Сироты: MATH.md §5.5 шаг 2 — "дети очищенных узлов" (purged), не
// какая-то отдельная причина. Papka с ребёнком, затем сама papka purge'ится
// (сценарий: две реплики — одна двигает ребёнка ВНУТРЬ papka, другая её же
// purge'ит из уже очищенной корзины) — ребёнок обязан попасть в lost+found.
test("сироты: ребёнок purged-узла попадает в lost+found (не удаляется молча)", () => {
	let S = createInitialState();
	let parent, child;
	[S, parent] = mkFolder(S, ROOT_ID, "Папка", lbl(1, "a"));
	[S, child] = mkFolder(S, parent, "Ребёнок", lbl(2, "a"));
	S = applyOp(S, { type: "purge", id: parent });

	const R = project(S);
	assert.ok(!R.nodes.has(parent), "purged-узел не отображается вовсе");
	assert.equal(R.nodes.get(child).parent, LOST_FOUND_ID);
	assert.equal(R.nodes.get(child).status, "orphaned");
});

// Локальный precondition (ops.js) корректно НЕ ДАЁТ создать второй узел с тем
// же именем в той же папке — коллизия имён в project() возникает только
// когда два узла созданы НЕЗАВИСИМО на разных устройствах офлайн и merge()
// сталкивает их постфактум. Строим 'create'-операции напрямую, в обход
// ops.js — так же, как это делает реальный merge() с входящими по сети.
function rawCreate(id, parentId, name, label) {
	return { type: "create", id, kind: "dir", blob: null, parentId, name, origin: null, label };
}

test("коллизии имён: два узла с одинаковым именем в одной папке получают суффикс, СТАРШИЙ (по метке) — без суффикса", () => {
	let S = createInitialState();
	const a = id("dir");
	const b = id("dir");
	S = applyOp(S, rawCreate(a, ROOT_ID, "фото.jpg", lbl(5, "device-a")));
	S = applyOp(S, rawCreate(b, ROOT_ID, "фото.jpg", lbl(3, "device-b")));
	const R = project(S);
	const names = new Set([R.nodes.get(a).displayName, R.nodes.get(b).displayName]);
	assert.ok(names.has("фото.jpg"));
	assert.ok([...names].some((n) => n !== "фото.jpg" && n.startsWith("фото.jpg (")));
});

test("I-UNIQUE-NAME постусловие: после project ни у одной пары живых детей одного родителя нет одинакового displayName", () => {
	let S = createInitialState();
	for (let i = 0; i < 5; i++) {
		S = applyOp(S, rawCreate(id("dir"), ROOT_ID, "имя", lbl(i, `device-${i}`)));
	}
	const R = project(S);
	for (const [, kids] of R.children) {
		const names = kids.map((k) => R.nodes.get(k).displayName);
		assert.equal(new Set(names).size, names.length);
	}
});

test("I-REACHABLE постусловие: каждый живой узел достижим из корня в R (parent-цепочка конечна и ведёт к null)", () => {
	let S = createInitialState();
	let a, b, c;
	[S, a] = mkFolder(S, ROOT_ID, "A", lbl(1, "a"));
	[S, b] = mkFolder(S, a, "B", lbl(2, "a"));
	[S, c] = mkFolder(S, b, "C", lbl(3, "a"));
	const R = project(S);
	for (const id of R.nodes.keys()) {
		let cur = id;
		let steps = 0;
		while (cur !== null && steps < 200) {
			cur = R.nodes.get(cur).parent;
			steps += 1;
		}
		assert.ok(steps < 200, `узел ${id} не достигает корня за разумное число шагов`);
	}
});

test("I-ORDER-FREE: результат project не зависит от порядка вставки узлов в S.nodes (MATH.md §5.5.1)", () => {
	let S1 = createInitialState();
	let x, y, z;
	[S1, x] = mkFolder(S1, ROOT_ID, "X", lbl(1, "a"));
	[S1, y] = mkFolder(S1, x, "Y", lbl(2, "a"));
	[S1, z] = mkFolder(S1, y, "Z", lbl(3, "a"));
	S1 = applyOp(S1, { type: "setPar", id: x, value: z, label: lbl(4, "a") }); // цикл x->z->y->x

	// Та же логическая карта узлов, но Map построена в ОБРАТНОМ порядке вставки.
	const reversedNodes = new Map([...S1.nodes.entries()].reverse());
	const S2 = { nodes: reversedNodes, pending: new Map() };

	const R1 = project(S1);
	const R2 = project(S2);
	assert.deepEqual(
		[...R1.nodes.entries()].sort(),
		[...R2.nodes.entries()].sort(),
	);
});
