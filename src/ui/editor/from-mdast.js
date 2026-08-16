import { schema } from "./schema.js";
import { toPlainText } from "../../core/markdown/to-plain.js";

function textFallback(node) {
	return toPlainText({ type: "root", children: [node] });
}

function convertInline(nodes, marks) {
	marks = marks || [];
	const result = [];
	for (const node of nodes) {
		switch (node.type) {
			case "text":
				if (node.value) result.push(schema.text(node.value, marks));
				break;
			case "strong":
				result.push(...convertInline(node.children, marks.concat([schema.marks.strong.create()])));
				break;
			case "emphasis":
				result.push(...convertInline(node.children, marks.concat([schema.marks.em.create()])));
				break;
			case "inlineCode":
				if (node.value) result.push(schema.text(node.value, marks.concat([schema.marks.code.create()])));
				break;
			case "link":
				result.push(...convertInline(node.children, marks.concat([schema.marks.link.create({ href: node.url })])));
				break;
			case "break":
				result.push(schema.text(" ", marks));
				break;
			case "image": {
				const alt = node.alt || "";
				if (alt) result.push(schema.text(alt, marks));
				break;
			}
			default: {
				const fallback = textFallback(node);
				if (fallback) result.push(schema.text(fallback, marks));
			}
		}
	}
	return result;
}

function convertListItem(node) {
	return schema.node("list_item", null, node.children.map(convertBlock));
}

function convertBlock(node) {
	switch (node.type) {
		case "heading":
			return schema.node("heading", { level: node.depth }, convertInline(node.children));
		case "paragraph":
			return schema.node("paragraph", null, convertInline(node.children));
		case "blockquote":
			return schema.node("blockquote", null, node.children.map(convertBlock));
		case "list": {
			const listType = node.ordered ? "ordered_list" : "bullet_list";
			const attrs = node.ordered ? { order: node.start || 1 } : null;
			return schema.node(listType, attrs, node.children.map(convertListItem));
		}
		case "code":
			return schema.node("code_block", { lang: node.lang || null }, node.value ? schema.text(node.value) : undefined);
		case "thematicBreak":
			return schema.node("horizontal_rule");
		default:
			return schema.node("paragraph", null, schema.text(textFallback(node) || " "));
	}
}

export function fromMdast(mdastRoot) {
	const blocks = mdastRoot.children.map(convertBlock);
	if (blocks.length === 0) blocks.push(schema.node("paragraph"));
	return schema.node("doc", null, blocks);
}
