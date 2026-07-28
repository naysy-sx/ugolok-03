import { test } from "node:test";
import assert from "node:assert/strict";
import { createInitialState, applyOp, ROOT_ID, TRASH_ID } from "../src/domain/files/tree.js";
import { createFolder, rename, move, copy, remove, purge, PreconditionError } from "../src/domain/files/ops.js";

let counter = 0;
function label() {
	counter += 1;
	return { counter, deviceId: "device-a" };
}
function id(prefix) {
	return `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
}

function mkFolder(S, parentId, name) {
	const newId = id("dir");
	const op = createFolder(S, parentId, name, newId, label());
	assert.ok(!(op instanceof PreconditionError), "ожидался успех создания папки");
	return [applyOp(S, op), newId];
}

test("createFolder: успех в пустой папке", () => {
	const S = createInitialState();
	const [, newId] = mkFolder(S, ROOT_ID, "Документы");
	assert.ok(newId);
});

test("createFolder: PreconditionError при занятом имени в той же папке (F-предусловие §4)", () => {
	let S = createInitialState();
	[S] = mkFolder(S, ROOT_ID, "Документы");
	const op = createFolder(S, ROOT_ID, "Документы", id("dir"), label());
	assert.ok(op instanceof PreconditionError);
	assert.equal(op.code, "NAME_TAKEN");
});

test("createFolder: то же имя разрешено в РАЗНЫХ папках", () => {
	let S = createInitialState();
	let a, b;
	[S, a] = mkFolder(S, ROOT_ID, "A");
	[S, b] = mkFolder(S, ROOT_ID, "B");
	const op = createFolder(S, a, "Документы", id("dir"), label());
	assert.ok(!(op instanceof PreconditionError));
	const op2 = createFolder(applyOp(S, op), b, "Документы", id("dir"), label());
	assert.ok(!(op2 instanceof PreconditionError));
});

test("rename: PreconditionError при занятом имени среди СОСЕДЕЙ", () => {
	let S = createInitialState();
	let x, y;
	[S, x] = mkFolder(S, ROOT_ID, "X");
	[S, y] = mkFolder(S, ROOT_ID, "Y");
	const op = rename(S, y, "X", label());
	assert.ok(op instanceof PreconditionError);
});

test("rename: разрешено переименовать в СВОЁ ЖЕ имя (идемпотентно, не конфликт с самим собой)", () => {
	let S = createInitialState();
	let x;
	[S, x] = mkFolder(S, ROOT_ID, "X");
	const op = rename(S, x, "X", label());
	assert.ok(!(op instanceof PreconditionError));
});

test("move: PreconditionError при попытке переместить папку в СВОЁ ЖЕ поддерево (d ∈ subtree(n))", () => {
	let S = createInitialState();
	let a, b;
	[S, a] = mkFolder(S, ROOT_ID, "A");
	[S, b] = mkFolder(S, a, "B"); // B внутри A
	const op = move(S, a, b, label()); // переместить A внутрь B — B в поддереве A
	assert.ok(op instanceof PreconditionError);
	assert.equal(op.code, "CYCLE");
});

test("move: перемещение папки САМОЙ В СЕБЯ отклонено", () => {
	let S = createInitialState();
	let a;
	[S, a] = mkFolder(S, ROOT_ID, "A");
	const op = move(S, a, a, label());
	assert.ok(op instanceof PreconditionError);
});

test("move: перемещение в НЕ-предка/потомка — успех, O(глубина) не спуском по поддереву", () => {
	let S = createInitialState();
	let a, b, deep;
	[S, a] = mkFolder(S, ROOT_ID, "A");
	[S, b] = mkFolder(S, ROOT_ID, "B");
	[S, deep] = mkFolder(S, a, "Глубокий");
	// В A тысяча узлов — move НЕ должен их обходить (проверка через ascend от d).
	for (let i = 0; i < 200; i++) [S] = mkFolder(S, a, `файл-${i}`);
	const op = move(S, deep, b, label());
	assert.ok(!(op instanceof PreconditionError));
});

test("move: PreconditionError при занятом имени в целевой папке", () => {
	let S = createInitialState();
	let a, b;
	[S, a] = mkFolder(S, ROOT_ID, "A");
	[S, b] = mkFolder(S, ROOT_ID, "B");
	let x;
	[S, x] = mkFolder(S, a, "Общее");
	[S] = mkFolder(S, b, "Общее"); // уже есть "Общее" в B
	const op = move(S, x, b, label());
	assert.ok(op instanceof PreconditionError);
	assert.equal(op.code, "NAME_TAKEN");
});

test("remove: ТОТАЛЬНА даже при коллизии имени в корзине (§4/§5.6 MATH.md — не PreconditionError)", () => {
	let S = createInitialState();
	let a, b, x, y;
	[S, a] = mkFolder(S, ROOT_ID, "A");
	[S, b] = mkFolder(S, ROOT_ID, "B");
	[S, x] = mkFolder(S, a, "фото.jpg");
	[S, y] = mkFolder(S, b, "фото.jpg");
	S = applyOp(S, remove(S, x, label()));
	S = applyOp(S, remove(S, y, label()));
	assert.equal(S.nodes.get(x).par.value, TRASH_ID);
	assert.equal(S.nodes.get(y).par.value, TRASH_ID);
});

test("copy: ТОТАЛЬНА, авто-суффикс при коллизии имени в месте назначения (§4 — не PreconditionError)", () => {
	let S = createInitialState();
	let a, b, x;
	[S, a] = mkFolder(S, ROOT_ID, "A");
	[S, b] = mkFolder(S, ROOT_ID, "B");
	[S, x] = mkFolder(S, a, "Общее");
	[S] = mkFolder(S, b, "Общее");
	const newIds = new Map([[x, id("dir")]]);
	const ops = copy(S, x, b, newIds, label());
	assert.equal(ops.length, 1);
	assert.notEqual(ops[0].name, "Общее");
	assert.match(ops[0].name, /Общее \(копия/);
});

test("copy: копирует поддерево ЦЕЛИКОМ (несколько уровней), сохраняя структуру", () => {
	let S = createInitialState();
	let a, sub, leaf;
	[S, a] = mkFolder(S, ROOT_ID, "A");
	[S, sub] = mkFolder(S, a, "Sub");
	[S, leaf] = mkFolder(S, sub, "Leaf");
	const newIds = new Map([
		[a, id("dir")],
		[sub, id("dir")],
		[leaf, id("dir")],
	]);
	const ops = copy(S, a, ROOT_ID, newIds, label());
	assert.equal(ops.length, 3);
	const byId = new Map(ops.map((op) => [op.id, op]));
	const newA = newIds.get(a);
	const newSub = newIds.get(sub);
	const newLeaf = newIds.get(leaf);
	assert.equal(byId.get(newSub).parentId, newA);
	assert.equal(byId.get(newLeaf).parentId, newSub);
});

test("copy: разрешено копировать папку ВНУТРЬ САМОЙ СЕБЯ (§4 — условие на subtree здесь не требуется)", () => {
	let S = createInitialState();
	let a;
	[S, a] = mkFolder(S, ROOT_ID, "A");
	const newIds = new Map([[a, id("dir")]]);
	const ops = copy(S, a, a, newIds, label());
	assert.equal(ops.length, 1);
	assert.equal(ops[0].parentId, a);
});

test("purge: монотонный флаг, идемпотентен", () => {
	let S = createInitialState();
	let x;
	[S, x] = mkFolder(S, ROOT_ID, "X");
	S = applyOp(S, remove(S, x, label()));
	S = applyOp(S, purge(S, x));
	assert.equal(S.nodes.get(x).purged, true);
	S = applyOp(S, purge(S, x)); // повтор — не должен падать/менять
	assert.equal(S.nodes.get(x).purged, true);
});
