import { toMarkdown } from "mdast-util-to-markdown";

function wrapInlineNode(text, marks) {
	let node;
	if (marks.some((m) => m.type.name === "code")) {
		node = { type: "inlineCode", value: text };
	} else {
		node = { type: "text", value: text };
	}
	const linkMark = marks.find((m) => m.type.name === "link");
	if (linkMark) {
		node = { type: "link", url: linkMark.attrs.href, title: null, children: [node] };
	}
	if (marks.some((m) => m.type.name === "em")) {
		node = { type: "emphasis", children: [node] };
	}
	if (marks.some((m) => m.type.name === "strong")) {
		node = { type: "strong", children: [node] };
	}
	return node;
}

function convertInlineContent(pmNode) {
	const result = [];
	pmNode.forEach((child) => {
		if (child.isText) {
			result.push(wrapInlineNode(child.text, child.marks));
		}
	});
	return result;
}

function convertBlockContent(pmNode) {
	const result = [];
	pmNode.forEach((child) => {
		result.push(convertBlockNode(child));
	});
	return result;
}

function convertBlockNode(node) {
	switch (node.type.name) {
		case "heading":
			return { type: "heading", depth: node.attrs.level, children: convertInlineContent(node) };
		case "paragraph":
			return { type: "paragraph", children: convertInlineContent(node) };
		case "blockquote":
			return { type: "blockquote", children: convertBlockContent(node) };
		case "bullet_list":
			return { type: "list", ordered: false, start: null, spread: false, children: convertBlockContent(node) };
		case "ordered_list":
			return { type: "list", ordered: true, start: node.attrs.order, spread: false, children: convertBlockContent(node) };
		case "list_item":
			return { type: "listItem", spread: false, checked: null, children: convertBlockContent(node) };
		case "code_block":
			return { type: "code", lang: node.attrs.lang || null, meta: null, value: node.textContent };
		case "horizontal_rule":
			return { type: "thematicBreak" };
		default:
			return { type: "paragraph", children: convertInlineContent(node) };
	}
}

export function toMdast(pmDoc) {
	return { type: "root", children: convertBlockContent(pmDoc) };
}

export function toMarkdownSource(pmDoc) {
	return toMarkdown(toMdast(pmDoc), { bullet: "-", emphasis: "*", strong: "*", rule: "-" }).trim();
}
