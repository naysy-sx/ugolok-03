import { baseKeymap, toggleMark } from "prosemirror-commands";
import { undo, redo, history } from "prosemirror-history";
import { splitListItem, liftListItem, sinkListItem } from "prosemirror-schema-list";
import { keymap } from "prosemirror-keymap";
import { schema } from "./schema.js";

export const editorKeymap = keymap({
  "Mod-b": toggleMark(schema.marks.strong),
  "Mod-i": toggleMark(schema.marks.em),
  "Mod-z": undo,
  "Mod-y": redo,
  "Mod-Shift-z": redo,
  "Enter": splitListItem(schema.nodes.list_item),
  "Tab": sinkListItem(schema.nodes.list_item),
  "Shift-Tab": liftListItem(schema.nodes.list_item),
});
export const baseKeymapPlugin = keymap(baseKeymap);
