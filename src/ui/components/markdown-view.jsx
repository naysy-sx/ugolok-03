import { parseMarkdown, parseInline } from "../../domain/help/markdown.js";

// Рендер parseInline()'s дерева в Preact-элементы. НИГДЕ dangerouslySetInnerHTML —
// структурная невозможность инъекции произвольного HTML (не ручная санитизация),
// см. CONTRACTS.md, "Раздел Справка".
function renderInline(nodes) {
	return nodes.map((node, i) => {
		switch (node.type) {
			case "bold":
				return <strong key={i}>{renderInline(node.children)}</strong>;
			case "italic":
				return <em key={i}>{renderInline(node.children)}</em>;
			case "code":
				return (
					<code key={i} class="md-code-inline">
						{node.value}
					</code>
				);
			case "link":
				return (
					<a key={i} href={node.href} target="_blank" rel="noopener noreferrer">
						{renderInline(node.children)}
					</a>
				);
			default:
				return node.value;
		}
	});
}

function renderBlock(block, i) {
	switch (block.type) {
		case "heading": {
			const Tag = `h${block.level}`;
			return <Tag key={i}>{renderInline(parseInline(block.text))}</Tag>;
		}
		case "paragraph":
			return <p key={i}>{renderInline(parseInline(block.text))}</p>;
		case "list": {
			const Tag = block.ordered ? "ol" : "ul";
			return (
				<Tag key={i}>
					{block.items.map((item, j) => (
						<li key={j}>{renderInline(parseInline(item))}</li>
					))}
				</Tag>
			);
		}
		case "code":
			return (
				<pre key={i} class="md-code-block">
					<code>{block.code}</code>
				</pre>
			);
		case "blockquote":
			return <blockquote key={i}>{renderInline(parseInline(block.text))}</blockquote>;
		case "hr":
			return <hr key={i} />;
		default:
			return null;
	}
}

export default function MarkdownView({ source }) {
	const blocks = parseMarkdown(source ?? "");
	return <div class="md-view">{blocks.map(renderBlock)}</div>;
}
