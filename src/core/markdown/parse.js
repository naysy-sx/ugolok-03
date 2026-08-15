import { fromMarkdown } from "mdast-util-from-markdown";

export function parseRich(source) {
	return fromMarkdown(source ?? "");
}

export function parseLite(source) {
	return fromMarkdown(source ?? "");
}
