import ActionsMenu from "./actions-menu.jsx";
import IconSmiley from "../icons/smiley.jsx";
import { STICKER_ICONS } from "./sticker-view.jsx";
import { STICKER_KEYS, stickerMarker } from "../../domain/content/sticker.js";
import { t } from "../signals/i18n.js";

// Живой фидбег — кнопка со смайликами (набор Phosphor): клик по иконке
// ОТПРАВЛЯЕТ отдельное сообщение-стикер (см. domain/content/sticker.js —
// content = `:sticker:<ключ>:`), не вставляет ничего в черновик. Композитор
// (onSend) шлёт этот текст ТЕМ ЖЕ путём, что обычное сообщение — рендер
// стороны получателя (StickerView, тот же STICKER_ICONS) показывает его
// крупной SVG-иконкой вместо markdown. aria-label — читаемая форма ключа
// (`hand fist`, не переводимый ключ ×18×12 локалей — технический лейбл).
export default function EmojiQuickSend({ onSend, disabled }) {
	return (
		<ActionsMenu label={t("emojiPicker.toggleAria")} icon={IconSmiley} summaryClass="message-compose-tool-btn" popClass="emoji-picker-pop">
			{STICKER_KEYS.map((key) => {
				const Icon = STICKER_ICONS[key];
				return (
					<button key={key} type="button" onClick={() => onSend(stickerMarker(key))} aria-label={key.replace(/-/g, " ")} disabled={disabled}>
						<Icon />
					</button>
				);
			})}
		</ActionsMenu>
	);
}
