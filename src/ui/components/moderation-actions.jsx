import { publish } from "../signals/transport.js";
import { reportContent, ignoreMember } from "../../domain/content/moderation.js";
import { pushToast } from "../signals/toasts.js";
import { t } from "../signals/i18n.js";

// Кнопки "Пожаловаться"/"Игнорировать" у комментария/сообщения чата (не у СВОИХ —
// проверка isOwnContent на уровне вызывающего кода, CommentNode/ChannelChat).
// DESIGN.md, этап 33: игнор необратим в этом UI (нет кнопки "снять" ни для кого).
//
// VISUAL.md v2 (интеграция "Пост+Комментарии") — эти кнопки теперь живут
// ВНУТРИ ActionsMenu (нативный <details>, закрывается сразу после клика по
// любой кнопке — actions-menu.jsx), поэтому статус локальным <span>-текстом
// внутри меню читатель уже не увидит (меню к тому моменту закрыто). Тост —
// тот же канал обратной связи, что уже используют уведомления (app.jsx),
// не зависит от того, открыт ли ещё попап.
export default function ModerationActions({ viewerPubkey, viewerPrivKey, channelOwnerPubkey, channelId, targetPubkey, contentType, contentId, contentText }) {
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
			pushToast({ title: t("moderation.reportFailedToast"), body: err?.message || String(err) });
		}
	}

	async function handleIgnore() {
		if (!window.confirm(t("moderation.ignoreConfirm"))) return;
		try {
			await ignoreMember(viewerPubkey, viewerPrivKey, channelOwnerPubkey, { channelId, targetPubkey, contentType, contentId, contentText }, publish);
			pushToast({ title: t("moderation.memberIgnoredToast") });
		} catch (err) {
			pushToast({ title: t("moderation.ignoreFailedToast"), body: err?.message || String(err) });
		}
	}

	return (
		<>
			<button type="button" onClick={handleReport}>
				{t("moderation.reportButton")}
			</button>
			<button type="button" onClick={handleIgnore}>
				{t("moderation.ignoreButton")}
			</button>
		</>
	);
}
