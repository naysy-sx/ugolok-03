export const GUTTER_THUMBNAIL_TEXT_THRESHOLD = 280;

/**
 * Определяет тип записи на основе контента поста.
 * @param {Object} post - Объект поста с полями text, attachments, title, linkUrl, dueAt и done.
 * @returns {string} - Тип записи ("task", "link", "article", "collection" или "note").
 */
export function kindOf(post) {
	if (post.done !== null) return "task";
	if (post.linkUrl) return "link";
	if (post.title) return "article";
	if (!post.text && post.attachments.length > 1) return "collection";
	return "note";
}

/**
 * Определяет место размещения вложений.
 * @param {Object} post - Объект поста с полями text и attachments.
 * @returns {string} - Место размещения ("gutter" или "inline").
 */
export function attachmentPlacement(post) {
	if (post.attachments.length !== 1) return "inline";
	const att = post.attachments[0];
	return (att.type === "image" || att.type === "video") && post.text.length >= GUTTER_THUMBNAIL_TEXT_THRESHOLD ? "gutter" : "inline";
}
