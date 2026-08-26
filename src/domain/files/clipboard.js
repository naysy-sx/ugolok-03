// Буфер обмена — автомат на 3 состояниях (§4.1 MATH.md), поверх уже
// существующей FSM-инфраструктуры проекта (core/fsm/machine.js), тот же
// приём, что transfer-machine.js: `transition()` двигает только дискретный
// `state`, полезная нагрузка (что именно выбрано) живёт РЯДОМ, не в FSM.
//
// Добавлено сверх буквального автомата матдока (там только copy/cut/paste):
// CANCEL из copied/cut обратно в empty — пользовательский Escape/явная
// отмена без вставки. Матдок не запрещает и не рассматривает этот путь;
// без него единственный способ покинуть copied/cut — вставить хоть куда-то.
import { transition } from "../../core/fsm/machine.js";

export const CLIPBOARD_TRANSITIONS = {
	empty: { COPY: "copied", CUT: "cut" },
	copied: { COPY: "copied", CUT: "cut", PASTE: "empty", CANCEL: "empty" },
	cut: { COPY: "copied", CUT: "cut", PASTE: "empty", CANCEL: "empty" },
};

export function createClipboard() {
	return { state: "empty", selection: [] };
}

export function copyToClipboard(clipboard, selection) {
	return { state: transition(CLIPBOARD_TRANSITIONS, clipboard.state, "COPY"), selection };
}

export function cutToClipboard(clipboard, selection) {
	return { state: transition(CLIPBOARD_TRANSITIONS, clipboard.state, "CUT"), selection };
}

// Вызывающая сторона читает clipboard.state/clipboard.selection ДО paste,
// чтобы понять, какую реальную операцию строить (copy() или move() из
// ops.js) — сам clipboard.js домена файловых операций не касается.
// Инвариант §4.1 MATH.md ("узел, попавший в Cut(S) и затем удалённый
// другой репликой, при вставке даёт no-op, а не ошибку") реализуется
// ВЫЗЫВАЮЩЕЙ стороной (она уже видит текущее дерево и фильтрует
// несуществующие id перед конструированием операций) — здесь просто
// сброс состояния автомата.
export function paste(clipboard) {
	return { state: transition(CLIPBOARD_TRANSITIONS, clipboard.state, "PASTE"), selection: [] };
}

export function cancelClipboard(clipboard) {
	if (clipboard.state === "empty") return clipboard;
	return { state: transition(CLIPBOARD_TRANSITIONS, clipboard.state, "CANCEL"), selection: [] };
}

// UI вставки (шапка / полоса / ⋯ папки) — только если в буфере есть
// хотя бы один живой узел. copied/cut с пустым или полностью purged
// выделением кнопки не показывают.
export function hasClipboardItems(clipboard, nodes) {
	if (clipboard.state !== "copied" && clipboard.state !== "cut") return false;
	if (clipboard.selection.length === 0) return false;
	return clipboard.selection.some((id) => {
		const node = nodes.get(id);
		return node && !node.purged;
	});
}
