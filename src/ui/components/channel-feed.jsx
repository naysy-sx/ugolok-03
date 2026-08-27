import { useEffect, useRef, useState } from "preact/hooks";
import { t } from "../signals/i18n.js";
import { openChannelPost } from "../signals/place.js";
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

export function ChannelHead({ channelRow }) {
	const [rulesOpen, setRulesOpen] = useState(false);
	const popRef = useRef(null);

	useEffect(() => {
		if (!rulesOpen) return;
		function onDoc(e) {
			if (!popRef.current?.contains(e.target)) setRulesOpen(false);
		}
		function onKey(e) {
			if (e.key === "Escape") setRulesOpen(false);
		}
		document.addEventListener("mousedown", onDoc);
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("mousedown", onDoc);
			document.removeEventListener("keydown", onKey);
		};
	}, [rulesOpen]);

	return (
		<div class="ch-head">
			<ChannelAvatarThumb channel={channelRow} />
			<div class="stack" style={{ "--gap": "var(--space-2xs)" }}>
				<p class="ch-kicker">
					{kickerLabel(channelRow.role)}
					{channelRow.updatedAt ? ` · ${t("channel.updatedLabel", { date: formatDateTime(channelRow.updatedAt) })}` : ""}
				</p>
				{channelRow.description && <p class="channel-description">{channelRow.description}</p>}
			</div>
			{channelRow.rules ? (
				<div class="rules-pop" ref={popRef}>
					<button type="button" class="chip" onClick={() => setRulesOpen((v) => !v)}>
						{t("channel.rulesChip")}
					</button>
					{rulesOpen && (
						<div class="rules-panel">
							<p>{channelRow.rules}</p>
						</div>
					)}
				</div>
			) : (
				<span />
			)}
		</div>
	);
}

// ТЗ редизайн канала A — вкладка «Посты»: компактная лента без дерева комментариев.
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
}) {
	const [showComposer, setShowComposer] = useState(false);

	return (
		<section role="tabpanel" class="stack" style={{ "--gap": "var(--space-s)" }}>
			<div class="ch-toolbar">
				<span class="ch-stats">{t("channel.sortNewestFirst")}</span>
				{isOwner && !showComposer && (
					<button type="button" class="post-cta--compact" onClick={() => setShowComposer(true)}>
						<IconPencil /> {t("channel.writePostButton")}
					</button>
				)}
			</div>
			{isOwner && showComposer && (
				<PostComposer
					ownerPubkey={ownerPubkey}
					privKey={privKey}
					dbKey={dbKey}
					channelId={channelId}
					limiter={limiter}
					onPublished={() => {
						setShowComposer(false);
						onPublished();
					}}
					onCancel={() => setShowComposer(false)}
				/>
			)}
			{hasMore && (
				<button type="button" onClick={onLoadMore}>
					{t("channel.loadOlderButton")}
				</button>
			)}
			{posts.length === 0 ? (
				<p style={{ color: "var(--muted)" }}>{t("channel.noPosts")}</p>
			) : (
				<div>
					{[...posts].reverse().map((post) => (
						<FeedItem
							key={post.id}
							post={post}
							commentCount={commentCounts[post.id] ?? 0}
							reactionCounts={reactionCountsByPost[post.id]}
							onOpen={() => openChannelPost(channelId, post.id)}
						/>
					))}
				</div>
			)}
		</section>
	);
}
