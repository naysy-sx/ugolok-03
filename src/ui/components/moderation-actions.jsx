import { publish } from "../signals/transport.js";
import { reportContent, ignoreMember } from "../../domain/content/moderation.js";
import { pushToast } from "../signals/toasts.js";
import IconFlag from "../icons/flag.jsx";
import IconLockClosed from "../icons/lock-closed.jsx";
import { t, errorMessage } from "../signals/i18n.js";

// Кнопки "Пожаловаться"/"Игнорировать" у комментария/сообщения чата (не у СВОИХ —
// проверка isOwnContent на уровне вызывающего кода, CommentNode/ChannelMessage).
// DESIGN.md, этап 33: игнор необратим в этом UI (нет кнопки "снять" ни для кого).
//
// VISUAL.md v2 (интеграция "Пост+Комментарии") — эти кнопки живут ВНУТРИ
// ActionsMenu (нативный <details>, закрывается сразу после клика по любой
// кнопке — actions-menu.jsx), поэтому статус локальным <span>-текстом внутри
// меню читатель уже не увидит (меню к тому моменту закрыто). Тост — тот же
// канал обратной связи, что уже используют уведомления (app.jsx), не
// зависит от того, открыт ли ещё попап.
//
// CHANNEL-V2 часть E2 — compact-режим (кнопки прямо в строке сообщения,
// скрытые по умолчанию, .msg-mod-actions) удалён: общий чат канала теперь
// тоже прячет их в ActionsMenu (тот же язык, что комментарии), compact
// нигде больше не вызывался.
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
