import { useEffect, useState } from "preact/hooks";
import { currentUser, dbKeySig } from "../signals/auth.js";
import { getOrDownloadMessageAttachment } from "../../domain/files/content-cache.js";
import { resolveImagePreviewUrl } from "../../domain/media/image-preview.js";
import { resolveAttachmentPreviewUrl } from "../../domain/media/attachment-preview-resolver.js";
import { getPreviewUrl } from "../../domain/media/plaintext-cache.js";
import { kindOf } from "../../domain/content/record-kind.js";
import { toPreviewText } from "../../core/markdown/preview.js";
import { CHANNEL_REACTION_SET } from "../../domain/content/reactions.js";
import { t } from "../signals/i18n.js";
import { DueChip, formatDateTime } from "./post-card.jsx";
import { videoPosterUrl } from "./video-poster-style.js";
import IconChatBubbleFill from "../icons/chat-bubble-fill.jsx";
import IconPlayerPlay from "../icons/player-play.jsx";
import { uploadTarget } from "../../domain/files/servers.js";


// До двух первых картинок/видео для сетки медиа в карточке записи (макет 99pML.jpg).
function visualsOf(attachments) {
	return (attachments ?? []).filter((a) => a.type === "image" || a.type === "video").slice(0, 2);
}

// CHANNEL-V2 часть C2 — решение отменено: было резать текст заметки без
// заголовка на 90-м символе и выдавать обрубок как title (рисуется <h3>
// жирным) — "жирные обрубки" в ленте. Первая строка КОРОТКОГО текста — это
// настоящий заголовок (автор так и написал), обрубок посреди фразы —
// НЕ заголовок: synthetic:true рисуется обычным текстом (feed-title--synthetic),
// обрезает .truncate (--lines:3), не slice (не режет слово посреди).
//
// Живой фидбег — найден баг в этой же правке: перенос строки искался в
// РЕЗУЛЬТАТЕ toPreviewText (переменная plain), а toPlainText (to-plain.js)
// схлопывает все блоки через join(' ') — переносов там никогда не бывает,
// title/excerpt не разделялись НИ РАЗУ, вся запись рисовалась одним
// synthetic-блоком. Перенос ищем в ИСХОДНОМ post.text (до парсинга), title/
// excerpt превью считаем раздельно по уже разрезанным кускам исходника.
function feedText(post) {
	const kind = kindOf(post);
	const bodyPreview = toPreviewText(post.text, { profile: "rich", maxLength: 180 });
	if (kind === "article" && post.title) return { title: post.title, excerpt: bodyPreview, synthetic: false };
	if (kind === "link") return { title: post.title || post.linkUrl || "", excerpt: bodyPreview, synthetic: false };
	if (!post.text) return { title: t(`recordKind.${kind}`), excerpt: "", synthetic: true };
	const rawNl = post.text.indexOf("\n");
	const firstLineRaw = (rawNl === -1 ? post.text : post.text.slice(0, rawNl)).trim();
	if (rawNl > 0 && firstLineRaw.length > 0 && firstLineRaw.length <= 90) {
		const restRaw = post.text.slice(rawNl + 1).trim();
		return {
			title: toPreviewText(firstLineRaw, { profile: "rich", maxLength: 90 }),
			excerpt: restRaw ? toPreviewText(restRaw, { profile: "rich", maxLength: 180 }) : "",
			synthetic: false,
		};
	}
	const plain = toPreviewText(post.text, { profile: "rich", maxLength: 400 });
	if (!plain) return { title: t(`recordKind.${kind}`), excerpt: "", synthetic: true };
	return { title: plain, excerpt: "", synthetic: true };
}

function reactionSummary(counts) {
	return CHANNEL_REACTION_SET.filter((e) => (counts?.[e] || 0) > 0)
		.map((e) => `${e}${counts[e]}`)
		.join(" ");
}

function FeedThumb({ attachment }) {
	// MEDIA-PERF-TZ-5.md §3 — previewDigest (новые вложения, оба типа) обходит
	// и старый inline poster (видео), и полную загрузку оригинала (картинки).
	const inlinePoster = attachment.type === "video" ? videoPosterUrl(attachment.poster) : null;
	const [url, setUrl] = useState(
		() => inlinePoster || (attachment.type === "image" && attachment.manifestDigest ? getPreviewUrl(attachment.manifestDigest) : null),
	);

	useEffect(() => {
		if (attachment.previewDigest) {
			let cancelled = false;
			resolveAttachmentPreviewUrl(attachment, { serverUrl: uploadTarget() }).then((previewUrl) => {
				if (!cancelled && previewUrl) setUrl(previewUrl);
			});
			return () => {
				cancelled = true;
			};
		}
		if (inlinePoster) {
			setUrl(inlinePoster);
			return;
		}
		if (attachment.type !== "image" || !attachment.manifestDigest) return;
		const preview = getPreviewUrl(attachment.manifestDigest);
		if (preview) {
			setUrl(preview);
			return;
		}
		let cancelled = false;
		resolveImagePreviewUrl(attachment.manifestDigest, attachment.mime, (trace) =>
			getOrDownloadMessageAttachment(currentUser.value.id, dbKeySig.value, attachment, { serverUrl: uploadTarget(), trace }),
		)
			.then((raster) => {
				if (!cancelled) setUrl(raster.url);
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, [attachment.manifestDigest, attachment.previewDigest, attachment.poster, attachment.mime]);

	return (
		<span class="feed-tile" aria-hidden="true">
			{url ? <img class="feed-thumb" src={url} alt="" /> : <span class="feed-thumb" />}
			{attachment.type === "video" && (
				<span class="feed-tile__play">
					<IconPlayerPlay />
				</span>
			)}
		</span>
	);
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
	const visuals = visualsOf(post.attachments);
	const reacts = reactionSummary(reactionCounts);
	const hasChips = post.dueAt !== null || (post.tags && post.tags.length > 0);

	return (
		<button type="button" class="feed-item" onClick={onOpen}>
			{/* Живой фидбег (тот же баг, что .cmt__head/.chat-msg__head): baseline
		    сажал .feed-unread (кружок) заметно ниже текстовых соседей. */}
		<span class="feed-meta row" style={{ "--gap": "var(--space-2xs)", "--align": "center" }}>
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
				{/* Живой фидбег: было буквальным emoji "💬" внутри строки перевода —
				    заменено на заливную Phosphor-иконку (chat-bubble-fill), тот же
				    язык, что остальные иконки интерфейса. */}
				<span class="feed-count row" style={{ "--gap": "var(--space-3xs)", "--align": "center" }}>
					<IconChatBubbleFill aria-hidden="true" /> {t("channel.feedCommentCount", { count: commentCount ?? 0 })}
				</span>
				{reacts ? <span class="feed-reacts">{reacts}</span> : null}
			</span>

			{visuals.length > 0 && (
				<span class="feed-media" data-count={visuals.length}>
					{visuals.map((a, i) => (
						<FeedThumb key={i} attachment={a} />
					))}
				</span>
			)}
		</button>
	);
}
