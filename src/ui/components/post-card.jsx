import AttachmentView from "./attachment-view.jsx";
import { shortPubkey } from "../format.js";
import ActionsMenu from "./actions-menu.jsx";
import IconChatBubble from "../icons/chat-bubble.jsx";
import IconTrash from "../icons/trash.jsx";
import { t, currentLocale } from "../signals/i18n.js";

function formatDateTime(unixSeconds) {
	return new Date(unixSeconds * 1000).toLocaleString(currentLocale.value, { dateStyle: "short", timeStyle: "short" });
}

// Карточка поста ленты канала — текст (plain, не Markdown-рендеринг: CONTRACTS.md,
// этап 31, сознательное упрощение — вложения уже показывают картинки/видео/аудио
// через тот же AttachmentView, что message-bubble.jsx, отдельный markdown-парсер не
// нужен для этого MVP-прохода) + одно опциональное вложение + владельческие действия.
export default function PostCard({ post, isOwner, onArchive, onUnpublish, onDelete, onOpenComments, commentCount }) {
	return (
		<article class="flow post">
			<p style={{ whiteSpace: "pre-wrap" }}>{post.text}</p>
			{post.attachments?.[0] && <AttachmentView attachment={post.attachments[0]} />}
			<footer class="post__foot">
				<small style={{ color: "var(--muted)" }}>{formatDateTime(post.createdAt)}</small>
				{post.status === "archived" && <small style={{ color: "var(--muted)" }}>{t("postCard.archivedLabel")}</small>}
				{/* Пользователь заметил в демо-файле VISUAL.md v2: комментарии,
				    завёрнутые в кнопку, там сохраняли подчёркивание текста внутри —
				    у нас это настоящая <button> (подчёркивания браузер и не
				    добавляет), плюс .btn--ghost теперь сбрасывает его явно. */}
				<button type="button" class="btn--ghost" onClick={onOpenComments}>
					<IconChatBubble /> {t("postCard.commentsButton", { count: commentCount })}
				</button>
				<span class="grow" />
				{isOwner && (
					<ActionsMenu label={t("postCard.actionsAria", { excerpt: post.text?.slice(0, 40) || t("postCard.noTextFallback") })}>
						{post.status === "published" && <button type="button" onClick={onArchive}>{t("postCard.archiveButton")}</button>}
						{post.status === "published" && <button type="button" onClick={onUnpublish}>{t("postCard.unpublishButton")}</button>}
						<button type="button" class="danger" onClick={onDelete}>
							<IconTrash /> {t("common.delete")}
						</button>
					</ActionsMenu>
				)}
			</footer>
		</article>
	);
}

export { formatDateTime, shortPubkey };
