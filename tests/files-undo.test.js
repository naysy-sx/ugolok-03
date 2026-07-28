import { test } from "node:test";
import assert from "node:assert/strict";
import { createInitialState, applyOp, merge, ROOT_ID, TRASH_ID } from "../src/domain/files/tree.js";
import { createFolder, move, rename } from "../src/domain/files/ops.js";
import { createUndoStack, pushUndo, popUndo, canUndo, recordMove, recordRename, recordCreate } from "../src/domain/files/undo.js";

let counter = 100;
function makeLabel() {
	counter += 1;
	return { counter, deviceId: "device-a" };
}

test("отмена move: обратная операция — move(n, b→a), с НОВОЙ меткой", () => {
	let S = createInitialState();
	let a, b, x;
	[S, a] = create(S, ROOT_ID, "A");
	[S, b] = create(S, ROOT_ID, "B");
	[S, x] = create(S, a, "X");

	const previousParent = S.nodes.get(x).par.value; // = a, ДО перемещения
	const moveOp = move(S, x, b, makeLabel());
	S = applyOp(S, moveOp);
	assert.equal(S.nodes.get(x).par.value, b);

	const stack = createUndoStack();
	pushUndo(stack, [recordMove(x, previousParent)]);
	const inverseOps = popUndo(stack, makeLabel);
	S = merge(S, inverseOps);

	assert.equal(S.nodes.get(x).par.value, a, "узел вернулся в исходную папку");
	assert.ok(S.nodes.get(x).par.label.counter > moveOp.label.counter, "метка отмены НОВЕЕ, не переиспользована");
});

test("отмена rename: обратная операция — прежнее имя", () => {
	let S = createInitialState();
	let x;
	[S, x] = create(S, ROOT_ID, "Старое имя");
	const previousName = S.nodes.get(x).name.value;
	S = applyOp(S, rename(S, x, "Новое имя", makeLabel()));

	const stack = createUndoStack();
	pushUndo(stack, [recordRename(x, previousName)]);
	S = merge(S, popUndo(stack, makeLabel));

	assert.equal(S.nodes.get(x).name.value, "Старое имя");
});

test("отмена create: узел уходит в корзину (не 'исчезает' — id/kind/blob неизменяемы)", () => {
	let S = createInitialState();
	let x;
	[S, x] = create(S, ROOT_ID, "Новая папка");

	const stack = createUndoStack();
	pushUndo(stack, [recordCreate(x)]);
	S = merge(S, popUndo(stack, makeLabel));

	assert.equal(S.nodes.get(x).par.value, TRASH_ID);
});

test("групповое действие — одна запись в стеке, разворачивается в НЕСКОЛЬКО обратных операций", () => {
	let S = createInitialState();
	let a, b, x, y;
	[S, a] = create(S, ROOT_ID, "A");
	[S, b] = create(S, ROOT_ID, "B");
	[S, x] = create(S, a, "X");
	[S, y] = create(S, a, "Y");
	const prevX = S.nodes.get(x).par.value;
	const prevY = S.nodes.get(y).par.value;
	S = applyOp(S, move(S, x, b, makeLabel()));
	S = applyOp(S, move(S, y, b, makeLabel()));

	const stack = createUndoStack();
	pushUndo(stack, [recordMove(x, prevX), recordMove(y, prevY)]); // ОДНА запись, 2 records
	assert.equal(stack.length, 1);
	const inverseOps = popUndo(stack, makeLabel);
	assert.equal(inverseOps.length, 2);
	S = merge(S, inverseOps);
	assert.equal(S.nodes.get(x).par.value, a);
	assert.equal(S.nodes.get(y).par.value, a);
});

test("глубина стека ограничена maxDepth", () => {
	const stack = createUndoStack();
	for (let i = 0; i < 60; i++) {
		pushUndo(stack, [recordRename(`id-${i}`, "имя")], { maxDepth: 50 });
	}
	assert.equal(stack.length, 50);
});

test("canUndo: false для записи старше maxAgeMs (время инъецируется, не ждём реальных минут)", () => {
	const stack = createUndoStack();
	const t0 = 1000;
	pushUndo(stack, [recordRename("x", "имя")], { now: t0 });

	assert.equal(canUndo(stack, { now: t0 + 1000, maxAgeMs: 5 * 60 * 1000 }), true, "прошла 1 секунда — ещё можно");
	assert.equal(canUndo(stack, { now: t0 + 6 * 60 * 1000, maxAgeMs: 5 * 60 * 1000 }), false, "прошло 6 минут — уже нельзя");
});

test("canUndo: false на пустом стеке", () => {
	assert.equal(canUndo(createUndoStack()), false);
});

function create(S, parentId, name) {
	const newId = `n-${Math.random().toString(36).slice(2, 8)}`;
	const op = createFolder(S, parentId, name, newId, makeLabel());
	return [applyOp(S, op), newId];
}
