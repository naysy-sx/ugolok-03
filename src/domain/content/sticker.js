// Живой фидбег — «смайлы» из EmojiQuickSend уходят в чат/комментарии как
// ОТДЕЛЬНОЕ сообщение-стикер (крупная SVG-иконка в пузыре), не юникод-символ
// и не новый тип контента в БД: тот же текстовый канал, что обычное
// сообщение (никакой миграции схемы), просто зарезервированный формат
// содержимого — сообщение, ЦЕЛИКОМ равное `:sticker:<ключ>:`, рендерится
// иконкой вместо markdown. STICKER_KEYS — контракт между EmojiQuickSend
// (что можно отправить) и StickerView (что можно показать крупно):
// расширять оба списка синхронно (см. src/ui/components/sticker-view.jsx).
export const STICKER_KEYS = [
	"smiley",
	"smiley-wink",
	"smiley-meh",
	"smiley-nervous",
	"smiley-sad",
	"smiley-angry",
	"smiley-melting",
	"smiley-x-eyes",
	"heart",
	"hand-heart",
	"thumbs-up",
	"thumbs-down",
	"hand-peace",
	"hand-fist",
	"hands-clapping",
	"hands-praying",
	"handshake",
	"confetti",
];

const STICKER_PATTERN = /^:sticker:([a-z-]+):$/;

export function stickerMarker(key) {
	return `:sticker:${key}:`;
}

// null, если text не является распознанным маркером стикера — вызывающий
// код тогда рендерит text обычным образом (markdown/plain).
export function parseStickerKey(text) {
	if (typeof text !== "string") return null;
	const match = STICKER_PATTERN.exec(text.trim());
	if (!match) return null;
	return STICKER_KEYS.includes(match[1]) ? match[1] : null;
}
