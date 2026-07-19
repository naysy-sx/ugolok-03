import AttachmentView from "./attachment-view.jsx";
import { shortPubkey } from "../format.js";

function formatDateTime(unixSeconds) {
	return new Date(unixSeconds * 1000).toLocaleString([], { dateStyle: "short", timeStyle: "short" });
}

// Карточка поста ленты канала — текст (plain, не Markdown-рендеринг: CONTRACTS.md,
// этап 31, сознательное упрощение — вложения уже показывают картинки/видео/аудио
// через тот же AttachmentView, что message-bubble.jsx, отдельный markdown-парсер не
// нужен для этого MVP-прохода) + одно опциональное вложение + владельческие действия.
export default function PostCard({ post, isOwner, onArchive, onUnpublish, onDelete, onOpenComments, commentCount }) {
	return (
		<article
			class="flow"
			style={{ border: "var(--border-width) solid var(--border)", padding: "var(--space-m)", borderRadius: "var(--radius)" }}
		>
			<p style={{ whiteSpace: "pre-wrap" }}>{post.text}</p>
			{post.attachments?.[0] && <AttachmentView attachment={post.attachments[0]} />}
			<footer class="cluster" style={{ alignItems: "center" }}>
				<small style={{ color: "var(--muted)" }}>{formatDateTime(post.createdAt)}</small>
				{post.status === "archived" && <small style={{ color: "var(--muted)" }}>(в архиве)</small>}
				<button type="button" onClick={onOpenComments}>
					Комментарии ({commentCount})
				</button>
				{isOwner && post.status === "published" && (
					<button type="button" onClick={onArchive}>
						Архивировать
					</button>
				)}
				{isOwner && post.status === "published" && (
					<button type="button" onClick={onUnpublish}>
						Снять с публикации
					</button>
				)}
				{isOwner && (
					<button type="button" onClick={onDelete}>
						Удалить
					</button>
				)}
			</footer>
		</article>
	);
}

export { formatDateTime, shortPubkey };
