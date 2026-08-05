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
//
// Этап 69 — шапка автора (аватар+имя) добавлена по образцу .cmt__box/.bar
// (channel.jsx), но крупнее (.post__ava, не .cmt__ava) — визуальная иерархия
// "пост важнее комментария". Рамку/фон/тень несёт теперь общий .card на
// обёртке PostWithComments (channel.jsx), не сама карточка — второй уровень
// той же поверхности, а не отдельный вложенный блок.
export default function PostCard({ post, authorName, authorAvatar, isOwner, onArchive, onUnpublish, onDelete, onOpenComments, commentCount }) {
	return (
		<article class="stack post box" style={{ "--gap": "var(--space-m)", "--pad": "var(--space-m)" }}>
			<header class="bar" style={{ "--gap": "var(--space-s)", alignItems: "center" }}>
				{authorAvatar ? (
					<img src={authorAvatar} alt="" class="post__ava rigid" />
				) : (
					<div aria-hidden="true" class="post__ava post__ava-fallback rigid row" style={{ alignItems: "center", justifyContent: "center" }}>
						{(authorName || "?").trim().charAt(0).toUpperCase()}
					</div>
				)}
				<span class="post__author">{authorName}</span>
			</header>
			<p style={{ whiteSpace: "pre-wrap" }}>{post.text}</p>
			{post.attachments?.[0] && <AttachmentView attachment={post.attachments[0]} />}
			<footer class="post__foot row" style={{ "--gap": "var(--space-2xs)", alignItems: "center" }}>
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
