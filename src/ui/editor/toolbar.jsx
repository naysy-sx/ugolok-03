import { toggleMark, setBlockType, wrapIn } from "prosemirror-commands";
import { wrapInList } from "prosemirror-schema-list";
import { schema } from "./schema.js";
import { safeHref } from "../../core/markdown/sanitize.js";
import { t } from "../signals/i18n.js";
import IconFormatBold from "../icons/format-bold.jsx";
import IconFormatItalic from "../icons/format-italic.jsx";
import IconFormatQuote from "../icons/format-quote.jsx";
import IconFormatList from "../icons/format-list.jsx";
import IconFormatLink from "../icons/format-link.jsx";
import IconFormatHeading from "../icons/format-heading.jsx";
import IconFormatCode from "../icons/format-code.jsx";

function isMarkActive(state, markType) {
	const { from, to, empty, $from } = state.selection;
	if (empty) return !!markType.isInSet(state.storedMarks || $from.marks());
	return state.doc.rangeHasMark(from, to, markType);
}

function runCommand(view, command) {
	if (!view) return;
	command(view.state, view.dispatch, view);
	view.focus();
}

function cycleHeading(view) {
	if (!view) return;
	const parent = view.state.selection.$from.parent;
	const isHeading = parent.type === schema.nodes.heading;
	const currentLevel = isHeading ? parent.attrs.level : 0;
	const nextLevel = currentLevel >= 3 ? 0 : currentLevel + 1;
	if (nextLevel === 0) {
		runCommand(view, setBlockType(schema.nodes.paragraph));
	} else {
		runCommand(view, setBlockType(schema.nodes.heading, { level: nextLevel }));
	}
}

function toggleCodeBlock(view) {
	if (!view) return;
	const parent = view.state.selection.$from.parent;
	if (parent.type === schema.nodes.code_block) {
		runCommand(view, setBlockType(schema.nodes.paragraph));
	} else {
		runCommand(view, setBlockType(schema.nodes.code_block, { lang: null }));
	}
}

function insertLink(view) {
	if (!view) return;
	const { from, to } = view.state.selection;
	const url = window.prompt(t("postEditor.linkPrompt"));
	if (url === null) return;
	const safe = safeHref(url);
	if (safe === null) {
		window.alert(t("postEditor.linkRejected"));
		return;
	}
	const mark = schema.marks.link.create({ href: safe });
	if (from === to) {
		const tr = view.state.tr.insertText(safe, from).addMark(from, from + safe.length, mark);
		view.dispatch(tr);
	} else {
		view.dispatch(view.state.tr.addMark(from, to, mark));
	}
	view.focus();
}

export default function PostEditorToolbar({ view }) {
	if (!view) {
		return <div class="post-editor-toolbar row" style={{ "--gap": "var(--space-2xs)" }} />;
	}
	const state = view.state;
	const boldActive = isMarkActive(state, schema.marks.strong);
	const italicActive = isMarkActive(state, schema.marks.em);
	const codeActive = state.selection.$from.parent.type === schema.nodes.code_block;
	const headingActive = state.selection.$from.parent.type === schema.nodes.heading;

	return (
		<div class="post-editor-toolbar row" style={{ "--gap": "var(--space-2xs)" }}>
			<button type="button" class={"post-editor-toolbar-btn" + (headingActive ? " is-active" : "")} onClick={() => cycleHeading(view)} aria-label={t("postEditor.headingAria")}>
				<IconFormatHeading />
			</button>
			<button type="button" class={"post-editor-toolbar-btn" + (boldActive ? " is-active" : "")} onClick={() => runCommand(view, toggleMark(schema.marks.strong))} aria-label={t("markdownToolbar.boldAria")}>
				<IconFormatBold />
			</button>
			<button type="button" class={"post-editor-toolbar-btn" + (italicActive ? " is-active" : "")} onClick={() => runCommand(view, toggleMark(schema.marks.em))} aria-label={t("markdownToolbar.italicAria")}>
				<IconFormatItalic />
			</button>
			<button type="button" class={"post-editor-toolbar-btn" + (codeActive ? " is-active" : "")} onClick={() => toggleCodeBlock(view)} aria-label={t("postEditor.codeAria")}>
				<IconFormatCode />
			</button>
			<button type="button" class="post-editor-toolbar-btn" onClick={() => runCommand(view, wrapIn(schema.nodes.blockquote))} aria-label={t("markdownToolbar.quoteAria")}>
				<IconFormatQuote />
			</button>
			<button type="button" class="post-editor-toolbar-btn" onClick={() => runCommand(view, wrapInList(schema.nodes.bullet_list))} aria-label={t("postEditor.bulletListAria")}>
				<IconFormatList />
			</button>
			<button type="button" class="post-editor-toolbar-btn" onClick={() => runCommand(view, wrapInList(schema.nodes.ordered_list))} aria-label={t("postEditor.orderedListAria")}>
				<IconFormatList />
			</button>
			<button type="button" class="post-editor-toolbar-btn" onClick={() => insertLink(view)} aria-label={t("markdownToolbar.linkAria")}>
				<IconFormatLink />
			</button>
		</div>
	);
}
