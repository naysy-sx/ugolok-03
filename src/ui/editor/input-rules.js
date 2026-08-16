import { inputRules, wrappingInputRule, textblockTypeInputRule, InputRule } from "prosemirror-inputrules";
import { schema } from "./schema.js";

function markInputRule(regexp, markType) {
	return new InputRule(regexp, (state, match, start, end) => {
		const tr = state.tr;
		const textStart = start + match[0].indexOf(match[1]);
		const textEnd = textStart + match[1].length;
		if (textEnd < end) tr.delete(textEnd, end);
		if (textStart > start) tr.delete(start, textStart);
		tr.addMark(start, start + match[1].length, markType.create());
		tr.removeStoredMark(markType);
		return tr;
	});
}

const headingRule = textblockTypeInputRule(/^(#{1,3})\s$/, schema.nodes.heading, (match) => ({ level: match[1].length }));
const blockquoteRule = wrappingInputRule(/^\s*>\s$/, schema.nodes.blockquote);
const bulletListRule = wrappingInputRule(/^\s*([-*])\s$/, schema.nodes.bullet_list);
const orderedListRule = wrappingInputRule(
	/^(\d+)\.\s$/,
	schema.nodes.ordered_list,
	(match) => ({ order: +match[1] }),
	(match, node) => node.childCount + node.attrs.order === +match[1]
);
const codeBlockRule = textblockTypeInputRule(/^```$/, schema.nodes.code_block);
const boldRule = markInputRule(/(?:^|\s)\*\*([^*]+)\*\*$/, schema.marks.strong);
const italicRule = markInputRule(/(?:^|\s)\*([^*]+)\*$/, schema.marks.em);

export const postInputRules = inputRules({
	rules: [headingRule, blockquoteRule, bulletListRule, orderedListRule, codeBlockRule, boldRule, italicRule],
});
