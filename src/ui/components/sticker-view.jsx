import { parseStickerKey } from "../../domain/content/sticker.js";
import IconSmiley from "../icons/smiley.jsx";
import IconSmileyWink from "../icons/smiley-wink.jsx";
import IconSmileyMeh from "../icons/smiley-meh.jsx";
import IconSmileyNervous from "../icons/smiley-nervous.jsx";
import IconSmileySad from "../icons/smiley-sad.jsx";
import IconSmileyAngry from "../icons/smiley-angry.jsx";
import IconSmileyMelting from "../icons/smiley-melting.jsx";
import IconSmileyXEyes from "../icons/smiley-x-eyes.jsx";
import IconHeart from "../icons/heart.jsx";
import IconHandHeart from "../icons/hand-heart.jsx";
import IconThumbsUp from "../icons/thumbs-up.jsx";
import IconThumbsDown from "../icons/thumbs-down.jsx";
import IconHandPeace from "../icons/hand-peace.jsx";
import IconHandFist from "../icons/hand-fist.jsx";
import IconHandsClapping from "../icons/hands-clapping.jsx";
import IconHandsPraying from "../icons/hands-praying.jsx";
import IconHandshake from "../icons/handshake.jsx";
import IconConfetti from "../icons/confetti.jsx";

// Единственный источник правды "ключ стикера -> иконка" — EmojiQuickSend
// (кнопки пикера) и StickerView (рендер отправленного сообщения) переиспользуют
// этот же список, чтобы он не разъехался в двух местах.
export const STICKER_ICONS = {
	smiley: IconSmiley,
	"smiley-wink": IconSmileyWink,
	"smiley-meh": IconSmileyMeh,
	"smiley-nervous": IconSmileyNervous,
	"smiley-sad": IconSmileySad,
	"smiley-angry": IconSmileyAngry,
	"smiley-melting": IconSmileyMelting,
	"smiley-x-eyes": IconSmileyXEyes,
	heart: IconHeart,
	"hand-heart": IconHandHeart,
	"thumbs-up": IconThumbsUp,
	"thumbs-down": IconThumbsDown,
	"hand-peace": IconHandPeace,
	"hand-fist": IconHandFist,
	"hands-clapping": IconHandsClapping,
	"hands-praying": IconHandsPraying,
	handshake: IconHandshake,
	confetti: IconConfetti,
};

// text, целиком равный `:sticker:<ключ>:` (см. domain/content/sticker.js) —
// рендерится крупной SVG-иконкой вместо MarkdownView. Не распознан — null,
// вызывающий компонент (MessageBubble/CommentNode/ChannelMessage) сам решает,
// что показать вместо этого (обычно тот же text через MarkdownView).
export default function StickerView({ text }) {
	const key = parseStickerKey(text);
	const Icon = key && STICKER_ICONS[key];
	if (!Icon) return null;
	return <Icon class="icon sticker-view" aria-hidden="false" />;
}
