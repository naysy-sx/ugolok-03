import { parseRich, parseLite } from "./parse.js";
import { toPlainText } from "./to-plain.js";

export function toPreviewText(source, { profile = "lite", maxLength = 120 } = {}) {
    if (!source) return '';
    const tree = (profile === 'rich' ? parseRich : parseLite)(source);
    const plain = toPlainText(tree);
    return plain.length > maxLength ? plain.slice(0, maxLength) + '\u2026' : plain;
}
