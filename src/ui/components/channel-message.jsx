import { currentLocale, t } from "../signals/i18n.js";
import { commentAuthorInfo } from "./channel-shared.jsx";
import { planBubbleAttachments } from "./bubble-attachment-plan.js";
import BubbleAttachmentCluster, { BubbleFileChips } from "./bubble-attachment-cluster.jsx";
import AttachmentView from "./attachment-view.jsx";
import MarkdownView from "./markdown-view.jsx";
import ActionsMenu from "./actions-menu.jsx";
import ModerationActions from "./moderation-actions.jsx";

function formatTime(unixSeconds) {
	return new Date(unixSeconds * 1000).toLocaleTimeString(currentLocale.value, { hour: "2-digit", minute: "2-digit" });
}

// CHANNEL-V2 часть E2 — одно сообщение общего чата. showAuthor:false —
// продолжение группы того же автора (channel-chat.jsx группирует), тогда
// шапка (аватар/имя/бейдж/время/меню) не рисуется, но пустая ячейка
// (.chat-msg__ava-slot) держит колонку — иначе продолжение группы уехало
// бы влево под аватар. MessageBubble НЕ трогается (общий с личным чатом,
// отдельная работа по MLS) — вложения тем же способом, что и он:
// planBubbleAttachments + BubbleAttachmentCluster/BubbleFileChips.
export default function ChannelMessage({ message, showAuthor, isOwn, isChannelOwner, ownerPubkey, privKey, channelOwnerPubkey, channelId, onOpenAttachment }) {
	const author = commentAuthorInfo(message.authorPubkey);
	const plan = planBubbleAttachments(message.attachments);
	const open = (a) => onOpenAttachment?.(message, a);

	return (
		<article class={`chat-msg${isOwn ? " chat-msg--own" : ""}`}>
			{showAuthor ? (
				author.avatar ? (
					<img src={author.avatar} alt="" class="chat-msg__ava" />
				) : (
					<div aria-hidden="true" class="chat-msg__ava chat-msg__ava-fallback">
						{(author.name || "?").trim().charAt(0).toUpperCase()}
					</div>
				)
			) : (
				<div class="chat-msg__ava-slot" aria-hidden="true" />
			)}

			<div class="chat-msg__body stack" style={{ "--gap": "var(--space-3xs)" }}>
				{/* Живой фидбег (тот же баг, что .cmt__head): --align:baseline сажал
				    бейдж владельца канала заметно ниже имени/времени. */}
				{showAuthor && (
					<header class="chat-msg__head row" style={{ "--gap": "var(--space-2xs)", "--align": "center" }}>
						<span class={author.isNpub ? "chat-msg__name chat-msg__name--npub" : "chat-msg__name"}>{author.name}</span>
						{isChannelOwner && <span class="chat-msg__badge">{t("channel.kicker.owner")}</span>}
						<time class="chat-msg__time">{formatTime(message.createdAt)}</time>
						{!isOwn && (
							<span class="chat-msg__actions">
								<ActionsMenu label={t("channel.comment.moreActionsAria", { name: author.name })}>
									<ModerationActions
										viewerPubkey={ownerPubkey}
										viewerPrivKey={privKey}
										channelOwnerPubkey={channelOwnerPubkey}
										channelId={channelId}
										targetPubkey={message.authorPubkey}
										contentType="chat_message"
										contentId={message.id}
										contentText={message.text}
									/>
								</ActionsMenu>
							</span>
						)}
					</header>
				)}
				<BubbleAttachmentCluster plan={plan} onOpen={open} />
				{message.text && (
					<div class="chat-msg__text">
						<MarkdownView source={message.text} profile="lite" />
					</div>
				)}
				<BubbleFileChips plan={plan} onOpen={open} />
				{plan.voices.map((a, i) => (
					<AttachmentView key={`voice-${i}`} attachment={a} />
				))}
			</div>
		</article>
	);
}
