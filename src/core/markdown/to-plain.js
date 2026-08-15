export function toPlainText(node) {
  if (node == null) return '';
  if (typeof node.value === 'string') return node.value;
  if (node.type === 'image') return node.alt ?? '';
  if (node.type === 'break') return ' ';
  if (Array.isArray(node.children)) {
    const parts = node.children.map(toPlainText);
    if (['root', 'blockquote', 'list', 'listItem'].includes(node.type)) {
      return parts.filter(p => p !== '').join(' ').trim();
    } else {
      return parts.join('').trim();
    }
  }
  return '';
}
