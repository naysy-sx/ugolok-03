// Мост между чистым domain/files и UI (CONTRACTS.md, этап 53) — тот же
// простой паттерн, что ui/signals/journal.js: сигнал пересчитывается из
// текущего состояния, действия пользователя вызывают domain-функции, потом
// пересохраняют и обновляют сигнал. Здесь чуть сложнее (собственный
// Lamport-счётчик, undo-стек) — но принцип тот же.
import { signal, computed } from "@preact/signals";
import { createInitialState, merge, project, ROOT_ID, TRASH_ID } from "../../domain/files/tree.js";
import { createFolder as opCreateFolder, rename as opRename, move as opMove, copy as opCopy, remove as opRemove, purge as opPurge, PreconditionError } from "../../domain/files/ops.js";
import { saveTreeState, loadTreeState, loadFilesClockValue, saveFilesClockValue } from "../../domain/files/store.js";
import { createClipboard, copyToClipboard, cutToClipboard, paste as pasteClipboard, cancelClipboard } from "../../domain/files/clipboard.js";
import { createUndoStack, pushUndo, popUndo, canUndo as canUndoNow, recordMove, recordRename, recordCreate } from "../../domain/files/undo.js";
import { createLamportClock } from "../../core/sync/lamport.js";
import { getOrCreateDeviceId } from "../../domain/identity/device.js";

export const treeState = signal(createInitialState());
export const currentFolderId = signal(ROOT_ID);
export const clipboard = signal(createClipboard());
export const selectedIds = signal(new Set());
export const canUndo = signal(false);

export const projected = computed(() => project(treeState.value));

// currentEntries — живые (не purged) дети текущей папки, разыменованные из
// projected.nodes. Компонент сам сортирует (sort.js) — здесь только состав.
export const currentEntries = computed(() => {
	const R = projected.value;
	const ids = R.children.get(currentFolderId.value) ?? [];
	return ids.map((id) => ({ id, ...R.nodes.get(id) }));
});

export const breadcrumbPath = computed(() => {
	const R = projected.value;
	const path = [];
	let cur = currentFolderId.value;
	let steps = 0;
	while (cur !== null && steps < 128) {
		const node = R.nodes.get(cur);
		if (!node) break;
		path.unshift({ id: cur, name: cur === ROOT_ID ? "Файлы" : node.displayName });
		cur = node.parent;
		steps += 1;
	}
	return path;
});

let undoStack = createUndoStack();
let lamportClock = null;
let cachedDeviceId = null;
let cachedOwnerPubkey = null;

async function label() {
	if (!lamportClock) throw new Error("files: initFiles() ещё не вызван");
	const counter = lamportClock.tick();
	await saveFilesClockValue(cachedOwnerPubkey, counter);
	return { counter, deviceId: cachedDeviceId };
}

export async function initFiles(ownerPubkey) {
	cachedOwnerPubkey = ownerPubkey;
	cachedDeviceId = await getOrCreateDeviceId();
	const initialCounter = await loadFilesClockValue(ownerPubkey);
	lamportClock = createLamportClock(initialCounter);

	const loaded = await loadTreeState(ownerPubkey);
	if (loaded.nodes.has(ROOT_ID)) {
		treeState.value = loaded;
	} else {
		// Первое обращение этого владельца к разделу "Файлы" — loadTreeState
		// на пустой БД возвращает пустую карту (store.js хранит РОВНО то, что
		// сохранено, системные узлы не подразумевает сам). createInitialState()
		// даёт их — сразу же персистируем, иначе следующий initFiles() снова
		// попадёт сюда же.
		treeState.value = createInitialState();
		await saveTreeState(ownerPubkey, treeState.value);
	}
	currentFolderId.value = ROOT_ID;
	undoStack = createUndoStack();
	canUndo.value = false;
}

async function applyAndPersist(ops) {
	treeState.value = merge(treeState.value, ops);
	await saveTreeState(cachedOwnerPubkey, treeState.value);
}

function randomNodeId() {
	return crypto.getRandomValues(new Uint8Array(16)).reduce((acc, b) => acc + b.toString(16).padStart(2, "0"), "n-");
}

export async function createFolder(name) {
	const op = opCreateFolder(treeState.value, currentFolderId.value, name, randomNodeId(), await label());
	if (op instanceof PreconditionError) return op;
	await applyAndPersist([op]);
	pushUndo(undoStack, [recordCreate(op.id)]);
	canUndo.value = canUndoNow(undoStack);
	return op;
}

export async function renameNode(id, name) {
	const previousName = treeState.value.nodes.get(id).name.value;
	const op = opRename(treeState.value, id, name, await label());
	if (op instanceof PreconditionError) return op;
	await applyAndPersist([op]);
	pushUndo(undoStack, [recordRename(id, previousName)]);
	canUndo.value = canUndoNow(undoStack);
	return op;
}

export async function moveNode(id, newParentId) {
	const previousParentId = treeState.value.nodes.get(id).par.value;
	const op = opMove(treeState.value, id, newParentId, await label());
	if (op instanceof PreconditionError) return op;
	await applyAndPersist([op]);
	pushUndo(undoStack, [recordMove(id, previousParentId)]);
	canUndo.value = canUndoNow(undoStack);
	return op;
}

export async function removeNode(id) {
	const previousParentId = treeState.value.nodes.get(id).par.value;
	const op = opRemove(treeState.value, id, await label());
	await applyAndPersist([op]);
	pushUndo(undoStack, [recordMove(id, previousParentId)]); // "удалить" = move, отмена — обратный move (§5.6 MATH.md)
	canUndo.value = canUndoNow(undoStack);
}

export async function purgeNode(id) {
	const op = opPurge(treeState.value, id);
	await applyAndPersist([op]); // НЕ кладём в undo-стек — purge монотонен, необратим (§5.6 MATH.md)
}

export async function copySelectionHere(nodeIds) {
	const ops = [];
	const createdRootIds = [];
	for (const nodeId of nodeIds) {
		const newIds = collectNewIds(treeState.value, nodeId);
		const subtreeOps = opCopy(treeState.value, nodeId, currentFolderId.value, newIds, await label());
		ops.push(...subtreeOps);
		createdRootIds.push(newIds.get(nodeId));
	}
	await applyAndPersist(ops);
	pushUndo(undoStack, createdRootIds.map((id) => recordCreate(id)));
	canUndo.value = canUndoNow(undoStack);
}

function collectNewIds(S, rootId) {
	const map = new Map();
	const stack = [rootId];
	while (stack.length > 0) {
		const cur = stack.pop();
		map.set(cur, randomNodeId());
		for (const [id, node] of S.nodes) {
			if (!node.purged && node.par.value === cur) stack.push(id);
		}
	}
	return map;
}

export function copySelection(nodeIds) {
	clipboard.value = copyToClipboard(clipboard.value, [...nodeIds]);
}
export function cutSelection(nodeIds) {
	clipboard.value = cutToClipboard(clipboard.value, [...nodeIds]);
}
export function cancelSelection() {
	clipboard.value = cancelClipboard(clipboard.value);
}

// Инвариант §4.1 MATH.md: узел из Cut(S), удалённый другой репликой до
// paste — no-op для него, не ошибка (остальные из выделения обрабатываются
// нормально). Проверяем существование (живой узел в ТЕКУЩЕМ дереве) здесь,
// перед конструированием операций.
export async function pasteHere() {
	const c = clipboard.value;
	const liveIds = c.selection.filter((id) => treeState.value.nodes.get(id) && !treeState.value.nodes.get(id).purged);
	if (c.state === "cut") {
		for (const id of liveIds) {
			await moveNode(id, currentFolderId.value);
		}
	} else if (c.state === "copied") {
		await copySelectionHere(liveIds);
	}
	clipboard.value = pasteClipboard(c);
	selectedIds.value = new Set();
}

export async function undo() {
	if (!canUndoNow(undoStack)) return;
	const ops = popUndo(undoStack, () => {
		const counter = lamportClock.tick();
		saveFilesClockValue(cachedOwnerPubkey, counter);
		return { counter, deviceId: cachedDeviceId };
	});
	await applyAndPersist(ops);
	canUndo.value = canUndoNow(undoStack);
}

export function openFolder(id) {
	currentFolderId.value = id;
	selectedIds.value = new Set();
}
