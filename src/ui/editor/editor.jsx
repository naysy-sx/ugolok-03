import { useEffect, useRef, useState } from "preact/hooks";
import { EditorState } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { history } from "prosemirror-history";
import { schema } from "./schema.js";
import { fromMdast } from "./from-mdast.js";
import { toMarkdownSource } from "./to-mdast.js";
import { parseRich } from "../../core/markdown/parse.js";
import { postInputRules } from "./input-rules.js";
import { editorKeymap, baseKeymapPlugin } from "./keymap.js";
import PostEditorToolbar from "./toolbar.jsx";
import { t } from "../signals/i18n.js";

export default function PostEditor({ initialSource, onChange }) {
	const hostRef = useRef(null);
	const viewRef = useRef(null);
	const [, forceUpdate] = useState(0);

	useEffect(() => {
		const state = EditorState.create({
			doc: fromMdast(parseRich(initialSource ?? "")),
			schema,
			plugins: [history(), postInputRules, editorKeymap, baseKeymapPlugin],
		});
		const view = new EditorView(hostRef.current, {
			state,
			dispatchTransaction(tr) {
				const newState = view.state.apply(tr);
				view.updateState(newState);
				if (tr.docChanged) onChange(toMarkdownSource(newState.doc));
				forceUpdate((n) => n + 1);
			},
		});
		viewRef.current = view;
		forceUpdate((n) => n + 1);
		return () => {
			view.destroy();
			viewRef.current = null;
		};
	}, []);

	return (
		<div class="post-editor-wrap">
			<PostEditorToolbar view={viewRef.current} />
			<div class="post-editor" ref={hostRef} />
			<p class="post-editor-hint">{t("postEditor.syntaxHint")}</p>
		</div>
	);
}
