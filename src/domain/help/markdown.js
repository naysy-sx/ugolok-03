// Минимальный markdown-парсер для раздела «Справка» (PROCESS-DOCS/CONTRACTS.md,
// "Раздел Справка"). НЕ полная спека markdown — контент доверенный (свой,
// не пользовательский ввод), поддержан только нужный подмножество: заголовки,
// абзацы, списки, код-блоки, цитаты, hr; инлайн — bold/italic/code/link.
// Сознательно НЕ вложенные списки/цитаты — плоский массив блоков.

const LIST_UNORDERED_RE = /^[-*]\s+(.*)$/;
const LIST_ORDERED_RE = /^\d+\.\s+(.*)$/;
const HEADING_RE = /^(#{1,3})\s+(.*)$/;
const BLOCKQUOTE_RE = /^>\s?(.*)$/;
const HR_RE = /^-{3,}$/;
const CODE_FENCE_RE = /^```(.*)$/;

export function parseMarkdown(source) {
	const lines = source.split("\n");
	const blocks = [];

	let i = 0;
	while (i < lines.length) {
		const line = lines[i];

		if (line.trim() === "") {
			i++;
			continue;
		}

		const fenceMatch = CODE_FENCE_RE.exec(line);
		if (fenceMatch) {
			const lang = fenceMatch[1].trim();
			const codeLines = [];
			i++;
			while (i < lines.length && !CODE_FENCE_RE.test(lines[i])) {
				codeLines.push(lines[i]);
				i++;
			}
			i++; // пропустить закрывающий ```
			blocks.push({ type: "code", lang, code: codeLines.join("\n") });
			continue;
		}

		const headingMatch = HEADING_RE.exec(line);
		if (headingMatch) {
			blocks.push({ type: "heading", level: headingMatch[1].length, text: headingMatch[2].trim() });
			i++;
			continue;
		}

		if (HR_RE.test(line.trim())) {
			blocks.push({ type: "hr" });
			i++;
			continue;
		}

		const blockquoteMatch = BLOCKQUOTE_RE.exec(line);
		if (blockquoteMatch) {
			blocks.push({ type: "blockquote", text: blockquoteMatch[1].trim() });
			i++;
			continue;
		}

		const unorderedMatch = LIST_UNORDERED_RE.exec(line);
		const orderedMatch = LIST_ORDERED_RE.exec(line);
		if (unorderedMatch || orderedMatch) {
			const ordered = !!orderedMatch;
			const items = [];
			while (i < lines.length) {
				const itemMatch = ordered ? LIST_ORDERED_RE.exec(lines[i]) : LIST_UNORDERED_RE.exec(lines[i]);
				if (!itemMatch) break;
				items.push(itemMatch[1].trim());
				i++;
			}
			blocks.push({ type: "list", ordered, items });
			continue;
		}

		// Абзац — накапливаем строки до пустой строки/начала другого блока,
		// склеиваем пробелом (мягкий перенос внутри абзаца, как в markdown).
		const paragraphLines = [line];
		i++;
		while (
			i < lines.length &&
			lines[i].trim() !== "" &&
			!CODE_FENCE_RE.test(lines[i]) &&
			!HEADING_RE.test(lines[i]) &&
			!HR_RE.test(lines[i].trim()) &&
			!BLOCKQUOTE_RE.test(lines[i]) &&
			!LIST_UNORDERED_RE.test(lines[i]) &&
			!LIST_ORDERED_RE.test(lines[i])
		) {
			paragraphLines.push(lines[i]);
			i++;
		}
		blocks.push({ type: "paragraph", text: paragraphLines.join(" ") });
	}

	return blocks;
}

const INLINE_MARKERS = [
	{ type: "bold", regex: /^\*\*(.+?)\*\*/ },
	{ type: "code", regex: /^`([^`]+?)`/ },
	{ type: "link", regex: /^\[([^\]]+)\]\(([^)]+)\)/ },
	{ type: "italic", regex: /^\*(.+?)\*/ },
];

export function parseInline(text) {
	if (!text) return [];

	const nodes = [];
	let buffer = "";
	let rest = text;

	function flushBuffer() {
		if (buffer) {
			nodes.push({ type: "text", value: buffer });
			buffer = "";
		}
	}

	while (rest.length > 0) {
		let matched = false;
		for (const marker of INLINE_MARKERS) {
			const m = marker.regex.exec(rest);
			if (!m) continue;
			flushBuffer();
			if (marker.type === "link") {
				nodes.push({ type: "link", href: m[2], children: parseInline(m[1]) });
			} else if (marker.type === "code") {
				nodes.push({ type: "code", value: m[1] });
			} else {
				nodes.push({ type: marker.type, children: parseInline(m[1]) });
			}
			rest = rest.slice(m[0].length);
			matched = true;
			break;
		}
		if (!matched) {
			buffer += rest[0];
			rest = rest.slice(1);
		}
	}
	flushBuffer();

	return nodes;
}
