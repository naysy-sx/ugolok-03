// Отмена — обратная операция с НОВОЙ меткой, не откат состояния (§7.1
// MATH.md/§16 ALGO.MD). Стек живёт в памяти вызывающей стороны, не
// реплицируется. Ограничен по глубине И по времени (§7.1: "операции старше
// нескольких минут к отмене не предлагаются" — иначе "отмена" молча
// перезапишет чужое свежее слияние).
//
// undo.js НЕ хранит и не вычисляет метки сам (как и tree.js/ops.js — эффект
// остаётся снаружи): makeLabel()/now — инъецируются вызывающей стороной,
// тот же приём, что isIdle() в auth.js ("время инъецируется параметром —
// тесты не ждут реального времени").
import { TRASH_ID } from "./tree.js";

export const DEFAULT_MAX_DEPTH = 50;
export const DEFAULT_MAX_AGE_MS = 5 * 60 * 1000; // "несколько минут"

export function createUndoStack() {
	return [];
}

export function recordMove(nodeId, previousParentId) {
	return { kind: "move", nodeId, previousParentId };
}
export function recordRename(nodeId, previousName) {
	return { kind: "rename", nodeId, previousName };
}
// Инверсия "создания" — перемещение в корзину (полноценного "не создавать"
// не существует: id/kind/blob неизменяемы, tree.js), не purge — тот
// монотонен и никогда не должен появляться в стеке отмены.
export function recordCreate(nodeId) {
	return { kind: "create", nodeId };
}

// records — ОДНО пользовательское действие, возможно групповое (несколько
// записей за одно перетаскивание выделения) — кладётся в стек одной
// записью (§7.1: "Групповое действие кладётся в стек одной записью").
export function pushUndo(stack, records, { maxDepth = DEFAULT_MAX_DEPTH, now = Date.now() } = {}) {
	stack.push({ records, timestamp: now });
	while (stack.length > maxDepth) stack.shift();
}

export function canUndo(stack, { maxAgeMs = DEFAULT_MAX_AGE_MS, now = Date.now() } = {}) {
	if (stack.length === 0) return false;
	const top = stack[stack.length - 1];
	return now - top.timestamp <= maxAgeMs;
}

// Возвращает Op[] обратного действия и снимает запись со стека — ДАЖЕ если
// canUndo() уже вернула бы false для неё (вызывающая сторона обязана
// проверить canUndo ДО popUndo, эта функция сама возраст не проверяет —
// разделение ответственности: "можно ли предложить" vs "выполнить").
export function popUndo(stack, makeLabel) {
	const entry = stack.pop();
	if (!entry) return [];
	const ops = [];
	for (const record of entry.records) {
		if (record.kind === "move") {
			ops.push({ type: "setPar", id: record.nodeId, value: record.previousParentId, label: makeLabel() });
		} else if (record.kind === "rename") {
			ops.push({ type: "setName", id: record.nodeId, value: record.previousName, label: makeLabel() });
		} else if (record.kind === "create") {
			ops.push({ type: "setPar", id: record.nodeId, value: TRASH_ID, label: makeLabel() });
		}
	}
	return ops;
}
