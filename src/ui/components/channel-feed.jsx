import { useState } from "preact/hooks";
import { t } from "../signals/i18n.js";
import { openChannelPost } from "../signals/place.js";
import { groupByDay } from "../group-by-day.js";
import ChannelAvatarThumb from "./channel-avatar-thumb.jsx";
import { PostComposer } from "./channel-shared.jsx";
import FeedItem from "./feed-item.jsx";
import IconPencil from "../icons/pencil.jsx";
import { formatDateTime } from "./post-card.jsx";

function kickerLabel(role) {
	if (role === "owner") return t("channel.kicker.owner");
	if (role === "subscriber") return t("channel.kicker.subscriber");
	return t("channel.kicker.available");
}

// CHANNEL-V2 часть B4 — ChannelHead (единый блок в прокручиваемой ленте:
// аватар/кикер/описание/всплывашка правил) заменён тремя частями, которые
// channel.jsx раскладывает по слотам Screen — шапка больше не уезжает при
// прокрутке, не съедает первый экран на телефоне.
export function ChannelLead({ channelRow }) {
	return <ChannelAvatarThumb channel={channelRow} small />;
}

export function ChannelSubtitle({ channelRow }) {
	return (
		<p class="ch-kicker truncate" style={{ "--lines": "1" }}>
			{kickerLabel(channelRow.role)}
			{channelRow.updatedAt ? ` · ${t("channel.updatedLabel", { date: formatDateTime(channelRow.updatedAt) })}` : ""}
		</p>
	);
}

// Раскрытие вместо всплывающей панели: панель была на position:absolute с
// физическими top/right, закрывалась по клику вне (два глобальных слушателя
// на document) и перекрывала первый пост. Раскрытие ничего не перекрывает,
// живёт в закреплённой шапке и не требует ни одного слушателя.
export function ChannelAbout({ channelRow }) {
	const [open, setOpen] = useState(false);
	if (!channelRow.description && !channelRow.rules) return null;
	return (
		<div class="stack" style={{ "--gap": "var(--space-2xs)" }}>
			<button type="button" class="ch-about-toggle self-start" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
				{t("channel.aboutToggle")}
			</button>
			{open && (
				<dl class="ch-about box stack" style={{ "--gap": "var(--space-s)", "--pad": "var(--space-s)" }}>
					{channelRow.description && (
						<div class="stack" style={{ "--gap": "var(--space-3xs)" }}>
							<dt>{t("channels.create.descriptionLabel")}</dt>
							<dd>{channelRow.description}</dd>
						</div>
					)}
					{channelRow.rules && (
						<div class="stack" style={{ "--gap": "var(--space-3xs)" }}>
							<dt>{t("channels.create.rulesLabel")}</dt>
							<dd>{channelRow.rules}</dd>
						</div>
					)}
				</dl>
			)}
		</div>
	);
}

// CHANNEL-V2 часть B5 — «Новая запись» переехала в шапку экрана (Screen's
// actions, channel.jsx): composerOpen/onComposerClose приходят пропами
// сверху вместо локального showComposer, кнопка-триггер здесь больше не
// рисуется. C3/C4 — разделители дней и осмысленное пустое состояние.
export function ChannelPostsTab({
	ownerPubkey,
	privKey,
	dbKey,
	channelId,
	isOwner,
	limiter,
	posts,
	hasMore,
	commentCounts,
	reactionCountsByPost,
	onLoadMore,
	onPublished,
	composerOpen,
	onComposerClose,
	onOpenComposer,
}) {
	return (
		<section role="tabpanel" class="stack" style={{ "--gap": "var(--space-s)" }}>
			<div class="ch-toolbar">
				<span class="ch-stats">{t("channel.sortNewestFirst")}</span>
			</div>
			{isOwner && composerOpen && (
				<PostComposer
					ownerPubkey={ownerPubkey}
					privKey={privKey}
					dbKey={dbKey}
					channelId={channelId}
					limiter={limiter}
					onPublished={() => {
						onComposerClose();
						onPublished();
					}}
					onCancel={onComposerClose}
				/>
			)}
			{hasMore && (
				<button type="button" onClick={onLoadMore}>
					{t("channel.loadOlderButton")}
				</button>
			)}
			{posts.length === 0 ? (
				<div class="empty stack" style={{ "--gap": "var(--space-2xs)", "--align": "center" }}>
					<h2>{t("channel.emptyPostsTitle")}</h2>
					<p>{isOwner ? t("channel.emptyPostsOwnerHint") : t("channel.emptyPostsGuestHint")}</p>
					{isOwner && (
						<button type="button" class="btn--primary" onClick={onOpenComposer}>
							<IconPencil /> {t("channel.writePostButton")}
						</button>
					)}
				</div>
			) : (
				<div class="stack" style={{ "--gap": "var(--space-m)" }}>
					{groupByDay([...posts].reverse()).map(({ key, dayLabel, items }) => (
						<section key={key} class="stack" style={{ "--gap": "0" }}>
							<h2 class="day-sep bar" style={{ "--gap": "var(--space-s)", "--align": "center" }}>
								{dayLabel}
							</h2>
							{items.map((post) => (
								<FeedItem
									key={post.id}
									post={post}
									commentCount={commentCounts[post.id] ?? 0}
									reactionCounts={reactionCountsByPost[post.id]}
									onOpen={() => openChannelPost(channelId, post.id)}
								/>
							))}
						</section>
					))}
				</div>
			)}
		</section>
	);
}
