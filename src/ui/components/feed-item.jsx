import { useEffect, useState } from "preact/hooks";
import { currentUser, dbKeySig } from "../signals/auth.js";
import { getOrDownloadMessageAttachment } from "../../domain/files/content-cache.js";
import { getMemoryCachedUrl, putMemoryCachedAttachment } from "../attachment-memory-cache.js";
import { BUILD_DEFAULT_BLOSSOM_SERVERS } from "../../config.js";
import { kindOf } from "../../domain/content/record-kind.js";
import { toPreviewText } from "../../core/markdown/preview.js";
import { CHANNEL_REACTION_SET } from "../../domain/content/reactions.js";
import { t } from "../signals/i18n.js";
import { DueChip, formatDateTime } from "./post-card.jsx";
import { videoPosterUrl } from "./video-poster-style.js";

const BLOSSOM_SERVER_URL = BUILD_DEFAULT_BLOSSOM_SERVERS[0];

function firstVisual(attachments) {
	return (attachments ?? []).find((a) => a.type === "image" || a.type === "video") ?? null;
}

// CHANNEL-V2 часть C2 — решение отменено: было резать текст заметки без
// заголовка на 90-м символе и выдавать обрубок как title (рисуется <h3>
// жирным) — "жирные обрубки" в ленте. Первая строка КОРОТКОГО текста — это
// настоящий заголовок (автор так и написал), обрубок посреди фразы —
// НЕ заголовок: synthetic:true рисуется обычным текстом (feed-title--synthetic),
// обрезает .truncate (--lines:3), не slice (не режет слово посреди).
function feedText(post) {
	const kind = kindOf(post);
	const bodyPreview = toPreviewText(post.text, { profile: "rich", maxLength: 180 });
	if (kind === "article" && post.title) return { title: post.title, excerpt: bodyPreview, synthetic: false };
	if (kind === "link") return { title: post.title || post.linkUrl || "", excerpt: bodyPreview, synthetic: false };
	const plain = toPreviewText(post.text, { profile: "rich", maxLength: 400 });
	if (!plain) return { title: t(`recordKind.${kind}`), excerpt: "", synthetic: true };
	const nl = plain.indexOf("\n");
	if (nl > 0 && nl <= 90) return { title: plain.slice(0, nl), excerpt: plain.slice(nl + 1).trim(), synthetic: false };
	return { title: plain, excerpt: "", synthetic: true };
}

function reactionSummary(counts) {
	return CHANNEL_REACTION_SET.filter((e) => (counts?.[e] || 0) > 0)
		.map((e) => `${e}${counts[e]}`)
		.join(" ");
}

function FeedThumb({ attachment }) {
	const poster = attachment.type === "video" ? videoPosterUrl(attachment.poster) : null;
	const [url, setUrl] = useState(() => poster || (attachment.type === "image" && attachment.manifestDigest ? getMemoryCachedUrl(attachment.manifestDigest) : null));

	useEffect(() => {
		if (poster) {
			setUrl(poster);
			return;
		}
		if (attachment.type !== "image" || !attachment.manifestDigest) return;
		const memUrl = getMemoryCachedUrl(attachment.manifestDigest);
		if (memUrl) {
			setUrl(memUrl);
			return;
		}
		let cancelled = false;
		getOrDownloadMessageAttachment(currentUser.value.id, dbKeySig.value, attachment, { serverUrl: BLOSSOM_SERVER_URL })
			.then((bytes) => {
				if (!cancelled) setUrl(putMemoryCachedAttachment(attachment.manifestDigest, bytes, attachment.mime));
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, [attachment.manifestDigest, attachment.poster, attachment.mime]);

	if (!url) return <div class="feed-thumb" aria-hidden="true" />;
	return <img class="feed-thumb" src={url} alt="" />;
}

function isoOf(unixSeconds) {
	return new Date(unixSeconds * 1000).toISOString();
}

// CHANNEL-V2 часть C1 — было "5.2rem | 1fr | auto" без единого медиа- или
// контейнерного запроса: на узкой колонке фиксированные 5.2rem под вид
// записи отнимали место у заголовка, а превью/счётчик/реакции стояли в
// столбик в правой колонке. Теперь две колонки (контент/превью), вид записи
// и время — строкой над заголовком, счётчики — строкой под текстом.
export default function FeedItem({ post, commentCount, reactionCounts, unread, onOpen }) {
	const kind = kindOf(post);
	const { title, excerpt, synthetic } = feedText(post);
	const visual = firstVisual(post.attachments);
	const reacts = reactionSummary(reactionCounts);
	const hasChips = post.dueAt !== null || (post.tags && post.tags.length > 0);

	return (
		<button type="button" class="feed-item" onClick={onOpen}>
			<span class="feed-meta row" style={{ "--gap": "var(--space-2xs)", "--align": "baseline" }}>
				{unread && <span class="feed-unread" aria-label={t("channel.feedUnreadAria")} />}
				<span class="feed-kind">{t(`recordKind.${kind}`)}</span>
				<time class="feed-time" dateTime={isoOf(post.createdAt)}>{formatDateTime(post.createdAt)}</time>
			</span>

			{synthetic
				? <p class="feed-title feed-title--synthetic truncate" style={{ "--lines": "3" }}>{title}</p>
				: <h3 class="feed-title">{title}</h3>}

			{excerpt ? <p class="feed-excerpt truncate" style={{ "--lines": "2" }}>{excerpt}</p> : null}

			{hasChips && (
				<span class="feed-chips row" style={{ "--gap": "var(--space-3xs)" }}>
					<DueChip post={post} />
					{(post.tags ?? []).map((tag) => (
						<span class="rec-chip rec-chip--tag" key={tag}>
							{tag}
						</span>
					))}
				</span>
			)}

			<span class="feed-foot row" style={{ "--gap": "var(--space-s)", "--align": "center" }}>
				<span class="feed-count">{t("channel.feedCommentCount", { count: commentCount ?? 0 })}</span>
				{reacts ? <span class="feed-reacts">{reacts}</span> : null}
			</span>

			{visual && <FeedThumb attachment={visual} />}
		</button>
	);
}
