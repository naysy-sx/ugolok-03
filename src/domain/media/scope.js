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
