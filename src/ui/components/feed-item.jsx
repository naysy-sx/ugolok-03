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

function feedText(post) {
	const kind = kindOf(post);
	const bodyPreview = toPreviewText(post.text, { profile: "rich", maxLength: 180 });
	if (kind === "article" && post.title) return { title: post.title, excerpt: bodyPreview };
	if (kind === "link") return { title: post.title || post.linkUrl || "", excerpt: bodyPreview };
	const plain = toPreviewText(post.text, { profile: "rich", maxLength: 400 });
	if (!plain) return { title: t(`recordKind.${kind}`), excerpt: "" };
	const nl = plain.indexOf("\n");
	if (nl > 0) return { title: plain.slice(0, nl), excerpt: plain.slice(nl + 1).trim() };
	if (plain.length <= 90) return { title: plain, excerpt: "" };
	return { title: plain.slice(0, 90) + "…", excerpt: plain.slice(90).trim() };
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

// ТЗ редизайн канала A — компактный элемент ленты, без .rec и без дерева комментариев.
export default function FeedItem({ post, commentCount, reactionCounts, onOpen }) {
	const kind = kindOf(post);
	const { title, excerpt } = feedText(post);
	const visual = firstVisual(post.attachments);
	const reacts = reactionSummary(reactionCounts);
	const hasChips = post.dueAt !== null || (post.tags && post.tags.length > 0);

	return (
		<button type="button" class="feed-item" onClick={onOpen}>
			<div>
				<span class="feed-kind">{t(`recordKind.${kind}`)}</span>
				<time class="feed-time">{formatDateTime(post.createdAt)}</time>
			</div>
			<div>
				<h3 class="feed-title">{title}</h3>
				{excerpt ? <p class="feed-excerpt">{excerpt}</p> : null}
				{hasChips && (
					<div class="rec-chips">
						<DueChip post={post} />
						{(post.tags ?? []).map((tag) => (
							<span class="rec-chip rec-chip--tag" key={tag}>
								{tag}
							</span>
						))}
					</div>
				)}
			</div>
			<div class="feed-aside">
				{visual && <FeedThumb attachment={visual} />}
				<span class="feed-count">{t("channel.feedCommentCount", { count: commentCount ?? 0 })}</span>
				{reacts ? <span class="feed-reacts">{reacts}</span> : null}
			</div>
		</button>
	);
}
