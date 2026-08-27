import { useState, useEffect, useId } from "preact/hooks";
import { db } from "../../core/store/database.js";
import { fromEncryptedRow } from "../../core/store/encrypted-table.js";
import { publish } from "../signals/transport.js";
import { markChannelAsRead } from "../../domain/content/channel-read-status.js";
import { refreshUnreadChannelsCount } from "../signals/notifications.js";
import { messagingActivity } from "../signals/chats.js";
import { groups, refreshGroups } from "../signals/contacts.js";
import { place, openChannel } from "../signals/place.js";
import { editChannel, deleteChannel } from "../../domain/content/channel.js";
import { addVisibilityGroup, removeVisibilityGroup, listChannelVisibilityGroupIds } from "../../domain/content/channel-visibility.js";
import { loadPostsWindow } from "../../core/sync/lazy-channel.js";
import { countCommentsByPost } from "../../domain/content/comments.js";
import { listReactionsForTargets, aggregateReactions } from "../../domain/content/reactions.js";
import { refFromAttachment, classOf } from "../../domain/media/media-ref.js";
import { buildPlaylist } from "../../domain/media/playlist.js";
import { openMedia } from "../signals/media.js";
import MediaButtons from "../components/media/media-buttons.jsx";
import { createRateLimiter } from "../../domain/content/rate-limiter.js";
import { validateAttachment } from "../../domain/files/attachment-validation.js";
import { uploadMessageAttachment } from "../../domain/messaging/attachments.js";
import { BUILD_DEFAULT_BLOSSOM_SERVERS } from "../../config.js";
import ChannelChat from "../components/channel-chat.jsx";
import ModerationPanel from "../components/moderation-panel.jsx";
import Screen from "../components/screen.jsx";
import IconTrash from "../icons/trash.jsx";
import { t, errorMessage } from "../signals/i18n.js";
import { ChannelHead, ChannelPostsTab } from "../components/channel-feed.jsx";
import ChannelPostPage from "../components/channel-post-page.jsx";

const NAME_MAX_LENGTH = 100;
const DESCRIPTION_MAX_LENGTH = 500;
const RULES_MAX_LENGTH = 1000;
const BLOSSOM_SERVER_URL = BUILD_DEFAULT_BLOSSOM_SERVERS[0];

function ChannelSettingsForm({ ownerPubkey, privKey, dbKey, channelId, channelRow, onSaved, onDeleted }) {
	const instanceId = useId();
	const [name, setName] = useState(channelRow.name || "");
	const [description, setDescription] = useState(channelRow.description || "");
	const [rules, setRules] = useState(channelRow.rules || "");
	const [allowChatAttachments, setAllowChatAttachments] = useState(channelRow.allowChatAttachments ?? true);
	const [avatarFile, setAvatarFile] = useState(null);
	const [avatarError, setAvatarError] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [selectedGroupIds, setSelectedGroupIds] = useState(() => new Set());
	const [originalGroupIds, setOriginalGroupIds] = useState(() => new Set());

	useEffect(() => {
		refreshGroups(ownerPubkey, dbKey).catch(() => {});
		listChannelVisibilityGroupIds(ownerPubkey, channelId).then((ids) => {
			const asSet = new Set(ids);
			setSelectedGroupIds(asSet);
			setOriginalGroupIds(asSet);
		});
	}, [ownerPubkey, channelId]);

	function toggleGroup(groupId) {
		setSelectedGroupIds((prev) => {
			const next = new Set(prev);
			if (next.has(groupId)) next.delete(groupId);
			else next.add(groupId);
			return next;
		});
	}

	function handleAvatarSelected(e) {
		const file = e.currentTarget.files?.[0];
		e.currentTarget.value = "";
		if (!file) return;
		setAvatarFile(file);
		try {
			validateAttachment({ mime: file.type, size: file.size });
			setAvatarError("");
		} catch (err) {
			setAvatarError(errorMessage(err));
		}
	}

	async function handleSave(e) {
		e.preventDefault();
		if (busy || name.length === 0) return;
		if (avatarFile && avatarError) return;
		setBusy(true);
		setError("");
		try {
			let avatarDescriptor;
			if (avatarFile) {
				const bytes = new Uint8Array(await avatarFile.arrayBuffer());
				avatarDescriptor = await uploadMessageAttachment(BLOSSOM_SERVER_URL, bytes, { mime: avatarFile.type, name: avatarFile.name }, privKey);
			}
			await editChannel(ownerPubkey, privKey, dbKey, channelId, { name, description, rules, avatarDescriptor, allowChatAttachments }, publish);
			for (const groupId of originalGroupIds) {
				if (!selectedGroupIds.has(groupId)) {
					await removeVisibilityGroup(ownerPubkey, privKey, dbKey, channelId, groupId, publish);
				}
			}
			for (const groupId of selectedGroupIds) {
				if (!originalGroupIds.has(groupId)) {
					await addVisibilityGroup(ownerPubkey, privKey, dbKey, channelId, groupId, publish);
				}
			}
			onSaved();
		} catch (err) {
			setError(errorMessage(err));
		} finally {
			setBusy(false);
		}
	}

	async function handleDelete() {
		if (busy) return;
		if (!window.confirm(t("channel.settings.deleteConfirm", { name: channelRow.name }))) return;
		setBusy(true);
		setError("");
		try {
			await deleteChannel(ownerPubkey, privKey, dbKey, channelId, publish);
			onDeleted();
		} catch (err) {
			setError(errorMessage(err));
			setBusy(false);
		}
	}

	return (
		<form class="stack channel-settings-form" onSubmit={handleSave} style={{ "--gap": "var(--space-s)" }}>
			{error && (
				<p role="alert" style={{ color: "var(--bad)" }}>
					{error}
				</p>
			)}

			<div class="stack" style={{ "--gap": "var(--space-3xs)" }}>
				<label for="edit-channel-name">{t("channels.create.nameLabel")}</label>
				<input id="edit-channel-name" type="text" value={name} maxLength={NAME_MAX_LENGTH} onInput={(e) => setName(e.currentTarget.value)} required />
			</div>

			<div class="stack" style={{ "--gap": "var(--space-3xs)" }}>
				<label for="edit-channel-description">{t("channels.create.descriptionLabel")}</label>
				<textarea id="edit-channel-description" value={description} maxLength={DESCRIPTION_MAX_LENGTH} onInput={(e) => setDescription(e.currentTarget.value)} rows={3} />
			</div>

			<div class="stack" style={{ "--gap": "var(--space-3xs)" }}>
				<label for="edit-channel-rules">{t("channels.create.rulesLabel")}</label>
				<textarea id="edit-channel-rules" value={rules} maxLength={RULES_MAX_LENGTH} onInput={(e) => setRules(e.currentTarget.value)} rows={4} />
			</div>

			<div class="stack" style={{ "--gap": "var(--space-3xs)" }}>
				<label for="edit-channel-avatar">{t("channel.settings.changeAvatarLabel")}</label>
				<input id="edit-channel-avatar" type="file" accept="image/*" onChange={handleAvatarSelected} />
				{avatarFile && <small style={{ color: avatarError ? "var(--bad)" : "var(--muted)" }}>{avatarError || avatarFile.name}</small>}
			</div>

			<div class="row" style={{ "--gap": "var(--space-3xs)", "--align": "center" }}>
				<input id="edit-channel-allow-chat-attachments" type="checkbox" checked={allowChatAttachments} onChange={(e) => setAllowChatAttachments(e.currentTarget.checked)} />
				<label for="edit-channel-allow-chat-attachments">{t("channels.create.allowChatAttachmentsLabel")}</label>
			</div>

			<fieldset class="stack" style={{ "--gap": "var(--space-3xs)" }}>
				<legend>{t("channel.settings.visibilityLabel")}</legend>
				<p style={{ color: "var(--muted)" }}>
					{t("channels.create.visibilityHint")}
				</p>
				{groups.value.length === 0 ? (
					<p style={{ color: "var(--muted)" }}>{t("channels.create.noGroups")}</p>
				) : (
					<ul role="list" style={{ listStyle: "none", paddingInlineStart: 0 }}>
						{groups.value.map((g) => (
							<li key={g.id}>
								<span class="row" style={{ "--gap": "var(--space-3xs)", "--align": "center" }}>
									<input
										id={`${instanceId}-group-${g.id}`}
										type="checkbox"
										checked={selectedGroupIds.has(g.id)}
										onChange={() => toggleGroup(g.id)}
									/>
									<label for={`${instanceId}-group-${g.id}`}>
										{t("channels.create.groupWithCount", { name: g.name, count: g.memberPubkeys.length })}
									</label>
								</span>
							</li>
						))}
					</ul>
				)}
			</fieldset>

			<div class="row" style={{ "--gap": "var(--space-s)", "--align": "center" }}>
				<button type="submit" disabled={busy || name.length === 0}>
					{busy ? t("common.saving") : t("common.save")}
				</button>
				<button type="button" onClick={onSaved} disabled={busy}>
					{t("common.cancel")}
				</button>
			</div>

			<div style={{ paddingBlockStart: "var(--space-m)", borderBlockStart: "var(--border-width) solid var(--border)" }}>
				<button type="button" class="btn--ghost btn--danger" disabled={busy} onClick={handleDelete}>
					<IconTrash /> {t("channel.settings.deleteButton")}
				</button>
			</div>
		</form>
	);
}

export default function ChannelDetail({ ownerPubkey, privKey, dbKey, channelId }) {
	const [channelRow, setChannelRow] = useState(null);
	const [loading, setLoading] = useState(true);
	const [posts, setPosts] = useState([]);
	const [hasMore, setHasMore] = useState(false);
	const [error, setError] = useState("");
	const [tab, setTab] = useState("posts");
	const [commentCounts, setCommentCounts] = useState({});
	const [reactionCountsByPost, setReactionCountsByPost] = useState({});
	const [limiter] = useState(() => createRateLimiter());
	const [chatSlices, setChatSlices] = useState({ counts: {}, onOpen: () => {} });

	const target = place.value;
	const onPostPage = target.kind === "channel" && target.id === channelId && !!target.postId && target.subTab !== "chat";

	async function refresh() {
		const raw = await db.table("channels").get([ownerPubkey, channelId]);
		const row = raw ? fromEncryptedRow(raw, dbKey) : undefined;
		setChannelRow(row ?? null);
		setLoading(false);
		if (!row) return;
		const { posts: freshPosts, hasMore: more } = await loadPostsWindow(ownerPubkey, dbKey, channelId, { limit: 10 });
		setPosts(freshPosts);
		setHasMore(more);
		if (freshPosts.length > 0) {
			const lastCreatedAt = Math.max(...freshPosts.map((p) => p.createdAt));
			markChannelAsRead(ownerPubkey, privKey, channelId, lastCreatedAt, publish)
				.then(() => refreshUnreadChannelsCount(ownerPubkey, dbKey))
				.catch(() => {});
		}
		const counts = await countCommentsByPost(ownerPubkey, freshPosts.map((p) => p.id));
		setCommentCounts(Object.fromEntries(counts));
		const reactionRows = await listReactionsForTargets(ownerPubkey, dbKey, freshPosts.map((p) => p.id));
		const byPost = {};
		const grouped = new Map();
		for (const r of reactionRows) {
			if (!grouped.has(r.targetId)) grouped.set(r.targetId, []);
			grouped.get(r.targetId).push(r);
		}
		for (const [id, list] of grouped) byPost[id] = aggregateReactions(list, ownerPubkey).counts;
		setReactionCountsByPost(byPost);
	}

	useEffect(() => {
		refresh().catch((e) => setError(errorMessage(e)));
	}, [ownerPubkey, channelId, messagingActivity.value]);

	async function handleLoadMore() {
		if (posts.length === 0) return;
		const { posts: older, hasMore: more } = await loadPostsWindow(ownerPubkey, dbKey, channelId, { limit: 10, beforeCreatedAt: posts[0].createdAt });
		const combined = [...older, ...posts];
		setPosts(combined);
		setHasMore(more);
		const counts = await countCommentsByPost(ownerPubkey, combined.map((p) => p.id));
		setCommentCounts(Object.fromEntries(counts));
		const reactionRows = await listReactionsForTargets(ownerPubkey, dbKey, combined.map((p) => p.id));
		const byPost = {};
		const grouped = new Map();
		for (const r of reactionRows) {
			if (!grouped.has(r.targetId)) grouped.set(r.targetId, []);
			grouped.get(r.targetId).push(r);
		}
		for (const [id, list] of grouped) byPost[id] = aggregateReactions(list, ownerPubkey).counts;
		setReactionCountsByPost(byPost);
	}

	function collectChannelPostsScope() {
		return posts.flatMap((p) => (p.attachments ?? []).map((a) => refFromAttachment(a, { postId: p.id })));
	}

	function postsSlicesCounts() {
		const present = { audio: false, video: false, image: false, other: false };
		for (const ref of collectChannelPostsScope()) {
			const c = classOf(ref.mime);
			if (c in present) present[c] = true;
		}
		return present;
	}

	function handleOpenPostsSlice(cls) {
		const refs = collectChannelPostsScope();
		const playlist = buildPlaylist(refs);
		const position = playlist.idx[cls]?.[0];
		if (position === undefined) return;
		openMedia({ refs, position });
	}

	// ТЗ редизайн канала A — postId больше не съедается. subTab чата игнорирует postId.
	useEffect(() => {
		const next = place.value;
		if (next.kind !== "channel" || next.id !== channelId) return;
		if (next.subTab) setTab(next.subTab);
	}, [place.value]);

	if (loading) {
		return (
			<Screen breadcrumb={{ label: t("nav.channels"), onBack: () => openChannel(null) }} title={t("channel.defaultTitle")}>
				<p style={{ color: "var(--muted)" }}>{t("common.loading")}</p>
			</Screen>
		);
	}

	if (!channelRow) {
		return (
			<Screen breadcrumb={{ label: t("nav.channels"), onBack: () => openChannel(null) }} title={t("channel.unavailableTitle")}>
				<p role="alert" style={{ color: "var(--bad)" }}>
					{t("channel.unavailableMessage")}
				</p>
			</Screen>
		);
	}

	const isOwner = channelRow.role === "owner";
	const canComment = channelRow.role === "owner" || channelRow.role === "subscriber";

	if (onPostPage) {
		return (
			<ChannelPostPage
				ownerPubkey={ownerPubkey}
				privKey={privKey}
				dbKey={dbKey}
				channelId={channelId}
				channelRow={channelRow}
				postId={target.postId}
				commentId={target.commentId}
				limiter={limiter}
			/>
		);
	}

	return (
		<Screen
			breadcrumb={{ label: t("nav.channels"), onBack: () => openChannel(null) }}
			title={channelRow.name || t("channels.card.untitled")}
			slices={
				tab === "posts" ? (
					<MediaButtons counts={postsSlicesCounts()} onOpen={handleOpenPostsSlice} />
				) : tab === "chat" ? (
					<MediaButtons counts={chatSlices.counts} onOpen={chatSlices.onOpen} />
				) : undefined
			}
		>
			<ChannelHead channelRow={channelRow} />
			{error && (
				<p role="alert" style={{ color: "var(--bad)" }}>
					{error}
				</p>
			)}

			<nav class="tabs row" style={{ "--gap": "var(--space-2xs)", "--align": "center" }} aria-label={t("channel.tabsAriaLabel")}>
				<button type="button" class="tab" role="tab" aria-selected={tab === "posts"} onClick={() => setTab("posts")}>
					{t("channel.tabs.posts")}
				</button>
				<button type="button" class="tab" role="tab" aria-selected={tab === "chat"} onClick={() => setTab("chat")}>
					{t("channel.tabs.chat")}
				</button>
				{isOwner && (
					<button type="button" class="tab" role="tab" aria-selected={tab === "moderation"} onClick={() => setTab("moderation")}>
						{t("channel.tabs.moderation")}
					</button>
				)}
				{isOwner && (
					<button type="button" class="tab" role="tab" aria-selected={tab === "settings"} onClick={() => setTab("settings")}>
						{t("channel.tabs.settings")}
					</button>
				)}
			</nav>

			{tab === "settings" && isOwner && (
				<section role="tabpanel">
					<ChannelSettingsForm
						ownerPubkey={ownerPubkey}
						privKey={privKey}
						dbKey={dbKey}
						channelId={channelId}
						channelRow={channelRow}
						onSaved={() => {
							setTab("posts");
							refresh();
						}}
						onDeleted={() => openChannel(null)}
					/>
				</section>
			)}

			{tab === "posts" && (
				<ChannelPostsTab
					ownerPubkey={ownerPubkey}
					privKey={privKey}
					dbKey={dbKey}
					channelId={channelId}
					isOwner={isOwner}
					limiter={limiter}
					posts={posts}
					hasMore={hasMore}
					commentCounts={commentCounts}
					reactionCountsByPost={reactionCountsByPost}
					onLoadMore={handleLoadMore}
					onPublished={refresh}
				/>
			)}

			{tab === "chat" && (
				<section role="tabpanel">
					<ChannelChat
						ownerPubkey={ownerPubkey}
						privKey={privKey}
						dbKey={dbKey}
						channelId={channelId}
						channelOwnerPubkey={channelRow.creatorPubkey}
						canWrite={canComment}
						allowAttachments={channelRow.allowChatAttachments}
						limiter={limiter}
						onSlicesChange={setChatSlices}
					/>
				</section>
			)}

			{tab === "moderation" && isOwner && (
				<section role="tabpanel">
					<ModerationPanel ownerPubkey={ownerPubkey} privKey={privKey} dbKey={dbKey} channelId={channelId} />
				</section>
			)}
		</Screen>
	);
}
