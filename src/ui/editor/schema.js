import { Schema } from "prosemirror-model";
import { addListNodes } from "prosemirror-schema-list";
import OrderedMap from "orderedmap";

const baseNodes = {
	doc: { content: "block+" },
	paragraph: { content: "inline*", group: "block", parseDOM: [{ tag: "p" }], toDOM: () => ["p", 0] },
	heading: {
		attrs: { level: { default: 1 } },
		content: "inline*",
		group: "block",
		defining: true,
		parseDOM: [{ tag: "h1", attrs: { level: 1 } }, { tag: "h2", attrs: { level: 2 } }, { tag: "h3", attrs: { level: 3 } }],
		toDOM: (node) => ["h" + node.attrs.level, 0],
	},
	blockquote: { content: "block+", group: "block", defining: true, parseDOM: [{ tag: "blockquote" }], toDOM: () => ["blockquote", 0] },
	code_block: {
		content: "text*",
		marks: "",
		group: "block",
		code: true,
		defining: true,
		attrs: { lang: { default: null } },
		parseDOM: [{ tag: "pre", preserveWhitespace: "full", getAttrs: (dom) => ({ lang: dom.querySelector("code")?.getAttribute("data-lang") ?? null }) }],
		toDOM: (node) => ["pre", ["code", { "data-lang": node.attrs.lang }, 0]],
	},
	horizontal_rule: { group: "block", parseDOM: [{ tag: "hr" }], toDOM: () => ["hr"] },
	text: { group: "inline" },
};

const nodes = addListNodes(OrderedMap.from(baseNodes), "paragraph block*", "block");

const marks = {
	strong: { parseDOM: [{ tag: "strong" }, { tag: "b" }], toDOM: () => ["strong", 0] },
	em: { parseDOM: [{ tag: "i" }, { tag: "em" }], toDOM: () => ["em", 0] },
	code: { code: true, parseDOM: [{ tag: "code" }], toDOM: () => ["code", 0] },
	link: {
		attrs: { href: {} },
		inclusive: false,
		parseDOM: [{ tag: "a[href]", getAttrs: (dom) => ({ href: dom.getAttribute("href") }) }],
		toDOM: (mark) => ["a", { href: mark.attrs.href, target: "_blank", rel: "noopener noreferrer" }, 0],
	},
};

export const schema = new Schema({ nodes, marks });
