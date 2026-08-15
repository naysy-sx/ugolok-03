// Спайк C.0 (MARKDOWN-TASK.md §4) — ГОЛЫЙ EditorView с минимальной схемой,
// проверка на реальном телефоне ДО написания кода полного редактора (C.1-C.7).
// Временный файл: если спайк проходит — переиспользовать логику при написании
// src/ui/editor/schema.js (C.2), не переносить этот файл как есть (схема здесь
// сознательно уже, без node/image-исключений, без input-rules/markdown-сериализации
// — минимум, нужный только чтобы проверить IME/клавиатуру/paste).
import { EditorState } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { Schema } from "prosemirror-model";
import { baseKeymap, toggleMark } from "prosemirror-commands";
import { history, undo, redo } from "prosemirror-history";
import { keymap } from "prosemirror-keymap";

const schema = new Schema({
	nodes: {
		doc: { content: "paragraph+" },
		paragraph: {
			content: "text*",
			toDOM: () => ["p", 0],
			parseDOM: [{ tag: "p" }],
		},
		text: { inline: true },
	},
	marks: {
		strong: {
			toDOM: () => ["strong", 0],
			parseDOM: [{ tag: "strong" }, { tag: "b" }],
		},
		em: {
			toDOM: () => ["em", 0],
			parseDOM: [{ tag: "em" }, { tag: "i" }],
		},
	},
});

const logEl = document.getElementById("log");
const logLines = [];
function log(line) {
	const time = new Date().toISOString().slice(11, 19);
	logLines.push(`[${time}] ${line}`);
	if (logLines.length > 30) logLines.shift();
	logEl.textContent = logLines.join("\n");
}

const editorEl = document.getElementById("editor");

// IME-композиция (русская раскладка на некоторых мобильных клавиатурах, свайп-
// ввод) — самая частая причина "текст задваивается/теряется" в contenteditable-
// редакторах. Логируем события, чтобы увидеть их порядок вживую на телефоне.
editorEl.addEventListener("compositionstart", () => log("compositionstart"));
editorEl.addEventListener("compositionupdate", (e) => log(`compositionupdate: ${JSON.stringify(e.data)}`));
editorEl.addEventListener("compositionend", (e) => log(`compositionend: ${JSON.stringify(e.data)}`));

const state = EditorState.create({
	schema,
	plugins: [
		history(),
		keymap({
			"Mod-b": toggleMark(schema.marks.strong),
			"Mod-i": toggleMark(schema.marks.em),
			"Mod-z": undo,
			"Mod-y": redo,
			"Mod-Shift-z": redo,
		}),
		keymap(baseKeymap),
	],
});

const view = new EditorView(editorEl, {
	state,
	dispatchTransaction(tr) {
		const newState = view.state.apply(tr);
		view.updateState(newState);
		if (tr.docChanged) {
			const text = newState.doc.textBetween(0, newState.doc.content.size, " ");
			log(`doc: ${JSON.stringify(text)}`);
		}
	},
});

// Для ручной проверки через remote devtools консоль, если понадобится.
window.__pmView = view;
log("EditorView создан, можно печатать");
