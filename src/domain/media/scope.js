import { refFromAttachment } from "./media-ref.js";
import { refFromNode } from "./media-ref.js";

export function collectChatScope(messages) {
    return messages.flatMap(message => 
        (message.attachments || []).map(a => a.voice ? null : refFromAttachment(a, { msgId: message.id })).filter(Boolean)
    );
}

export function collectFolderScope(entries, keyOf) {
    return entries.filter(entry => entry.node.kind === "file")
                  .map(entry => refFromNode(entry.node, entry.mime, keyOf(entry), entry.size));
}

// Этап F, F1/F2 (DESIGN.md "Этап F") — позиция клика в УЖЕ построенном refs,
// по (digest, sourceMeta), сравнение sourceMeta по значению (не по ссылке —
// вызывающая сторона строит sourceMeta заново, не переиспользует объект
// сборщика). Известное ограничение: тот же файл ДВАЖДЫ в ОДНОМ контейнере
// (sourceMeta совпадёт) даёт первое вхождение — не входит в объём.
export function findRefPosition(refs, digest, sourceMeta) {
	return refs.findIndex((r) => r.digest === digest && sourceMetaEquals(r.sourceMeta, sourceMeta));
}

function sourceMetaEquals(a, b) {
	const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]);
	for (const k of keys) {
		if (a?.[k] !== b?.[k]) return false;
	}
	return true;
}

export function collectPostScope({ post, commentsTree, compareSiblings }) {
    let result = [];
    if (post.attachments) {
        result.push(...post.attachments.map(a => refFromAttachment(a, { postId: post.id })));
    }
    let stack = [...commentsTree].sort(compareSiblings).reverse();
    while (stack.length > 0) {
        let x = stack.pop();
        if (x.attachments) {
            result.push(...x.attachments.map(a => refFromAttachment(a, { commentId: x.id })));
        }
        let children = [...(x.replies || [])].sort(compareSiblings).reverse();
        for (let j = 0; j < children.length; j++) {
            stack.push(children[j]);
        }
    }
    return result;
}
