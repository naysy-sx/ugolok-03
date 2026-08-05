import { publish } from "../signals/transport.js";
import { reportContent, ignoreMember } from "../../domain/content/moderation.js";
import { pushToast } from "../signals/toasts.js";
import IconFlag from "../icons/flag.jsx";
import IconLockClosed from "../icons/lock-closed.jsx";
import { t, errorMessage } from "../signals/i18n.js";

// Кнопки "Пожаловаться"/"Игнорировать" у комментария/сообщения чата (не у СВОИХ —
// проверка isOwnContent на уровне вызывающего кода, CommentNode/ChannelChat).
// DESIGN.md, этап 33: игнор необратим в этом UI (нет кнопки "снять" ни для кого).
//
// VISUAL.md v2 (интеграция "Пост+Комментарии") — в комментариях (CommentNode,
// channel.jsx) эти кнопки живут ВНУТРИ ActionsMenu (нативный <details>,
// закрывается сразу после клика по любой кнопке — actions-menu.jsx), поэтому
// статус локальным <span>-текстом внутри меню читатель уже не увидит (меню
// к тому моменту закрыто). Тост — тот же канал обратной связи, что уже
// используют уведомления (app.jsx), не зависит от того, открыт ли ещё попап.
//
// compact (пользователь, общий чат канала — channel-chat.jsx) — там кнопки
// стоят ПРЯМО в строке сообщения, не в дропдауне: раньше это был всегда
// видимый текст "Пожаловаться"/"Игнорировать", пользователь попросил
// заменить на маленькие иконки, скрытые по умолчанию и появляющиеся по
// наведению на сообщение (.msg-mod-actions, custom.css). В комментариях
// (compact не передан) кнопки остаются icon+текст — там они и так скрыты
// в ActionsMenu, прятать их ещё раз по hover незачем.
export default function ModerationActions({ viewerPubkey, viewerPrivKey, channelOwnerPubkey, channelId, targetPubkey, contentType, contentId, contentText, compact }) {
	async function handleReport() {
		const reason = window.prompt(t("moderation.reportPromptMessage"), "");
		if (reason === null) return; // отмена
		try {
			await reportContent(
				viewerPrivKey,
				channelOwnerPubkey,
				{ channelId, targetPubkey, contentType, contentId, contentText: reason || contentText, reason: "report" },
				publish,
			);
			pushToast({ title: t("moderation.reportSentToast") });
		} catch (err) {
			pushToast({ title: t("moderation.reportFailedToast"), body: errorMessage(err) });
		}
	}

	async function handleIgnore() {
		if (!window.confirm(t("moderation.ignoreConfirm"))) return;
		try {
			await ignoreMember(viewerPubkey, viewerPrivKey, channelOwnerPubkey, { channelId, targetPubkey, contentType, contentId, contentText }, publish);
			pushToast({ title: t("moderation.memberIgnoredToast") });
		} catch (err) {
			pushToast({ title: t("moderation.ignoreFailedToast"), body: errorMessage(err) });
		}
	}

	if (compact) {
		return (
			<span class="msg-mod-actions row" style={{ "--gap": "var(--space-3xs)" }}>
				<button type="button" class="icon-btn" onClick={handleReport} aria-label={t("moderation.reportButton")} title={t("moderation.reportButton")}>
					<IconFlag />
				</button>
				<button type="button" class="icon-btn icon-btn--warn" onClick={handleIgnore} aria-label={t("moderation.ignoreButton")} title={t("moderation.ignoreButton")}>
					<IconLockClosed />
				</button>
			</span>
		);
	}

	return (
		<>
			<button type="button" onClick={handleReport}>
				<IconFlag /> {t("moderation.reportButton")}
			</button>
			<button type="button" class="btn--ghost btn--warn" onClick={handleIgnore}>
				<IconLockClosed /> {t("moderation.ignoreButton")}
			</button>
		</>
	);
}
