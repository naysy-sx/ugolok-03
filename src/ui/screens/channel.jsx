import { useState, useEffect } from "preact/hooks";
import { db } from "../../core/store/database.js";
import { publish, fetchProfiles } from "../signals/transport.js";
import { messagingActivity } from "../signals/chats.js";
import { ensureProfilesFetched } from "../signals/contacts.js";
import { openChannel } from "../signals/channel-nav.js";
import { createDraftPost, publishPost, archivePost, unpublishPost, deletePost } from "../../domain/content/post.js";
import { loadPostsWindow } from "../../core/sync/lazy-channel.js";
import { addComment, getCommentsTree, countTopLevelCommentsByPost } from "../../domain/content/comments.js";
import { createRateLimiter } from "../../domain/content/rate-limiter.js";
import { usePendingAttachment, uploadPendingAttachment } from "../hooks/pending-attachment.js";
import AttachmentPreview from "../components/attachment-preview.jsx";
import AttachmentView from "../components/attachment-view.jsx";
import PostCard from "../components/post-card.jsx";
import ChannelChat from "../components/channel-chat.jsx";
import ModerationActions from "../components/moderation-actions.jsx";
import ModerationPanel from "../components/moderation-panel.jsx";
import { ContactIdentity } from "./contacts.jsx";

const POST_MAX_LENGTH = 10000; // ТЗ пользователя
const COMMENT_MAX_LENGTH = 4000;

function PostComposer({ ownerPubkey, privKey, dbKey, channelId, limiter, onPublished, onCancel }) {
	const [text, setText] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const attachment = usePendingAttachment();

	async function handleSubmit(e) {
		e.preventDefault();
		if (busy || text.length === 0) return;
		if (attachment.file && attachment.error) return;
		if (!limiter.tryAction("post")) {
			setError("Слишком быстро — подождите немного");
			return;
		}
		setBusy(true);
		setError("");
		try {
			let attachments = [];
			if (attachment.file) {
				attachments = [await uploadPendingAttachment(attachment.file, privKey)];
			}
			const { postId } = await createDraftPost(ownerPubkey, channelId, { text, attachments });
			await publishPost(ownerPubkey, privKey, dbKey, postId, publish);
			onPublished();
		} catch (err) {
			setError(err?.message || String(err));
		} finally {
			setBusy(false);
		}
	}

	return (
		<form class="flow" onSubmit={handleSubmit} style={{ "--flow-space": "var(--space-3xs)", border: "var(--border-width) solid var(--border)", padding: "var(--space-m)", borderRadius: "var(--radius)" }}>
			<h2>Новый пост</h2>
			{error && (
				<p role="alert" style={{ color: "var(--bad, oklch(0.58 0.21 25))" }}>
					{error}
				</p>
			)}
			<label class="visually-hidden" for="post-text">
				Текст поста
			</label>
			<textarea id="post-text" value={text} maxLength={POST_MAX_LENGTH} onInput={(e) => setText(e.currentTarget.value)} rows={6} />
			{attachment.file && (
				<AttachmentPreview file={attachment.file} position="below" onPositionChange={() => {}} onRemove={attachment.reset} error={attachment.error} />
			)}
			<div class="cluster">
				<input ref={attachment.inputRef} type="file" style={{ display: "none" }} onChange={attachment.handleSelect} />
				<button type="button" onClick={() => attachment.inputRef.current?.click()}>
					📎 Прикрепить
				</button>
				<button type="submit" disabled={busy || text.length === 0 || (!!attachment.file && !!attachment.error)}>
					{busy ? "Публикация…" : "Опубликовать"}
				</button>
				<button type="button" onClick={onCancel} disabled={busy}>
					Отмена
				</button>
			</div>
		</form>
	);
}

function CommentComposer({ ownerPubkey, privKey, dbKey, channelId, postId, parentId, limiter, onSubmitted, onCancel, autoFocus }) {
	const [text, setText] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const attachment = usePendingAttachment();

	async function handleSubmit(e) {
		e.preventDefault();
		if (busy || text.length === 0) return;
		if (attachment.file && attachment.error) return;
		if (!limiter.tryAction("comment")) {
			setError("Слишком быстро — подождите немного");
			return;
		}
		setBusy(true);
		setError("");
		try {
			let attachments = [];
			if (attachment.file) {
				attachments = [await uploadPendingAttachment(attachment.file, privKey)];
			}
			await addComment(ownerPubkey, privKey, dbKey, channelId, postId, parentId, text, attachments, publish);
			onSubmitted();
		} catch (err) {
			setError(err?.message || String(err));
		} finally {
			setBusy(false);
		}
	}

	return (
		<form class="flow" onSubmit={handleSubmit} style={{ "--flow-space": "var(--space-3xs)" }}>
			{error && (
				<p role="alert" style={{ color: "var(--bad, oklch(0.58 0.21 25))" }}>
					{error}
				</p>
			)}
			<label class="visually-hidden" for={`comment-text-${parentId}`}>
				Комментарий
			</label>
			<textarea
				id={`comment-text-${parentId}`}
				value={text}
				maxLength={COMMENT_MAX_LENGTH}
				onInput={(e) => setText(e.currentTarget.value)}
				rows={2}
				autoFocus={autoFocus}
			/>
			{attachment.file && (
				<AttachmentPreview file={attachment.file} position="below" onPositionChange={() => {}} onRemove={attachment.reset} error={attachment.error} />
			)}
			<div class="cluster">
				<input ref={attachment.inputRef} type="file" style={{ display: "none" }} onChange={attachment.handleSelect} />
				<button type="button" onClick={() => attachment.inputRef.current?.click()}>
					📎
				</button>
				<button type="submit" disabled={busy || text.length === 0 || (!!attachment.file && !!attachment.error)}>
					{busy ? "Отправка…" : "Отправить"}
				</button>
				{onCancel && (
					<button type="button" onClick={onCancel} disabled={busy}>
						Отмена
					</button>
				)}
			</div>
		</form>
	);
}

function CommentNode({ comment, canComment, ownerPubkey, privKey, dbKey, channelId, channelOwnerPubkey, postId, limiter, onChanged, depth }) {
	const [replying, setReplying] = useState(false);
	const isOwnComment = comment.authorPubkey === ownerPubkey;
	return (
		<li style={{ marginInlineStart: depth > 0 ? "var(--space-m)" : 0, paddingBlockStart: "var(--space-2xs)" }}>
			<p style={{ whiteSpace: "pre-wrap" }}>{comment.text}</p>
			{comment.attachments?.[0] && <AttachmentView attachment={comment.attachments[0]} />}
			<div class="cluster" style={{ alignItems: "center" }}>
				<ContactIdentity pubkey={comment.authorPubkey} />
				{canComment && (
					<button type="button" onClick={() => setReplying((v) => !v)}>
						Ответить
					</button>
				)}
				{!isOwnComment && (
					<ModerationActions
						viewerPubkey={ownerPubkey}
						viewerPrivKey={privKey}
						channelOwnerPubkey={channelOwnerPubkey}
						channelId={channelId}
						targetPubkey={comment.authorPubkey}
						contentType="comment"
						contentId={comment.id}
						contentText={comment.text}
					/>
				)}
			</div>
			{replying && (
				<CommentComposer
					ownerPubkey={ownerPubkey}
					privKey={privKey}
					dbKey={dbKey}
					channelId={channelId}
					postId={postId}
					parentId={comment.id}
					limiter={limiter}
					autoFocus
					onSubmitted={() => {
						setReplying(false);
						onChanged();
					}}
					onCancel={() => setReplying(false)}
				/>
			)}
			{comment.replies.length > 0 && (
				<ul role="list" style={{ listStyle: "none", paddingInlineStart: 0 }}>
					{comment.replies.map((reply) => (
						<CommentNode
							key={reply.id}
							comment={reply}
							canComment={canComment}
							ownerPubkey={ownerPubkey}
							privKey={privKey}
							dbKey={dbKey}
							channelId={channelId}
							channelOwnerPubkey={channelOwnerPubkey}
							postId={postId}
							limiter={limiter}
							onChanged={onChanged}
							depth={depth + 1}
						/>
					))}
				</ul>
			)}
		</li>
	);
}

function PostWithComments({ post, isOwner, canComment, ownerPubkey, privKey, dbKey, channelId, channelOwnerPubkey, limiter, commentCount, onCountChange, onPostChanged }) {
	const [expanded, setExpanded] = useState(false);
	const [tree, setTree] = useState([]);
	const [error, setError] = useState("");

	function flattenAuthors(nodes, acc = []) {
		for (const node of nodes) {
			acc.push(node.authorPubkey);
			flattenAuthors(node.replies, acc);
		}
		return acc;
	}

	async function refreshComments() {
		const fresh = await getCommentsTree(ownerPubkey, post.id);
		setTree(fresh);
		onCountChange?.(post.id, fresh.length);
		ensureProfilesFetched([...new Set(flattenAuthors(fresh))], fetchProfiles).catch(() => {});
	}

	useEffect(() => {
		if (expanded) refreshComments().catch((e) => setError(e?.message || String(e)));
	}, [expanded, ownerPubkey, post.id, messagingActivity.value]);

	async function runAction(fn) {
		try {
			await fn();
			onPostChanged();
		} catch (err) {
			setError(err?.message || String(err));
		}
	}

	return (
		<div>
			<PostCard
				post={post}
				isOwner={isOwner}
				commentCount={expanded ? tree.length : commentCount}
				onOpenComments={() => setExpanded((v) => !v)}
				onArchive={() => runAction(() => archivePost(ownerPubkey, privKey, dbKey, post.id, publish))}
				onUnpublish={() => runAction(() => unpublishPost(ownerPubkey, privKey, dbKey, post.id, publish))}
				onDelete={() => {
					if (window.confirm("Удалить пост? Действие необратимо.")) runAction(() => deletePost(ownerPubkey, privKey, post.id, publish));
				}}
			/>
			{error && (
				<p role="alert" style={{ color: "var(--bad, oklch(0.58 0.21 25))" }}>
					{error}
				</p>
			)}
			{expanded && (
				<div class="flow" style={{ "--flow-space": "var(--space-s)", paddingInlineStart: "var(--space-m)" }}>
					{canComment ? (
						<CommentComposer
							ownerPubkey={ownerPubkey}
							privKey={privKey}
							dbKey={dbKey}
							channelId={channelId}
							postId={post.id}
							parentId={post.id}
							limiter={limiter}
							onSubmitted={refreshComments}
						/>
					) : (
						<p style={{ color: "var(--muted)" }}>Только чтение — подпишитесь, чтобы комментировать.</p>
					)}
					{tree.length === 0 ? (
						<p style={{ color: "var(--muted)" }}>Пока нет комментариев.</p>
					) : (
						<ul role="list" style={{ listStyle: "none", paddingInlineStart: 0 }}>
							{tree.map((c) => (
								<CommentNode
									key={c.id}
									comment={c}
									canComment={canComment}
									ownerPubkey={ownerPubkey}
									privKey={privKey}
									dbKey={dbKey}
									channelId={channelId}
									channelOwnerPubkey={channelOwnerPubkey}
									postId={post.id}
									limiter={limiter}
									onChanged={refreshComments}
									depth={0}
								/>
							))}
						</ul>
					)}
				</div>
			)}
		</div>
	);
}

export default function ChannelDetail({ ownerPubkey, privKey, dbKey, channelId }) {
	const [channelRow, setChannelRow] = useState(null);
	const [loading, setLoading] = useState(true);
	const [posts, setPosts] = useState([]);
	const [hasMore, setHasMore] = useState(false);
	const [showComposer, setShowComposer] = useState(false);
	const [error, setError] = useState("");
	const [tab, setTab] = useState("posts");
	const [commentCounts, setCommentCounts] = useState({});
	const [limiter] = useState(() => createRateLimiter());

	async function refresh() {
		const row = await db.table("channels").get([ownerPubkey, channelId]);
		setChannelRow(row ?? null);
		setLoading(false);
		if (!row) return; // забанен владельцем (receiveBanAnnouncement) — канал исчез локально
		const { posts: freshPosts, hasMore: more } = await loadPostsWindow(ownerPubkey, channelId, { limit: 10 });
		setPosts(freshPosts);
		setHasMore(more);
		// Найдено пользователем: счётчик комментариев показывал 0 до первого клика —
		// один общий скан на все посты списка сразу, вместо getCommentsTree на каждый.
		const counts = await countTopLevelCommentsByPost(ownerPubkey, freshPosts.map((p) => p.id));
		setCommentCounts(Object.fromEntries(counts));
	}

	function handleCommentCountChange(postId, count) {
		setCommentCounts((prev) => ({ ...prev, [postId]: count }));
	}

	useEffect(() => {
		refresh().catch((e) => setError(e?.message || String(e)));
	}, [ownerPubkey, channelId, messagingActivity.value]);

	async function handleLoadMore() {
		if (posts.length === 0) return;
		const { posts: older, hasMore: more } = await loadPostsWindow(ownerPubkey, channelId, { limit: 10, beforeCreatedAt: posts[0].createdAt });
		setPosts((prev) => [...older, ...prev]);
		setHasMore(more);
	}

	if (loading) {
		return (
			<main class="flow" style={{ padding: "var(--space-m)" }}>
				<button type="button" onClick={() => openChannel(null)}>
					← Назад
				</button>
				<p style={{ color: "var(--muted)" }}>Загрузка…</p>
			</main>
		);
	}

	// Этап 33 — различать "ещё грузится" от "пропал" (тот же класс находки, что
	// onboarding/unlock, этап 32-довесок): канал исчезает локально, если владелец забанил
	// этого пользователя (receiveBanAnnouncement удаляет строку channels целиком).
	if (!channelRow) {
		return (
			<main class="flow" style={{ padding: "var(--space-m)" }}>
				<button type="button" onClick={() => openChannel(null)}>
					← Назад
				</button>
				<p role="alert" style={{ color: "var(--bad, oklch(0.58 0.21 25))" }}>
					Этот канал больше недоступен — возможно, владелец забанил вас или удалил канал.
				</p>
			</main>
		);
	}

	const isOwner = channelRow.role === "owner";
	const canComment = channelRow.role === "owner" || channelRow.role === "subscriber";

	return (
		<main class="flow" style={{ padding: "var(--space-m)", "--container": "56rem" }}>
			<header class="cluster" style={{ alignItems: "center" }}>
				<button type="button" onClick={() => openChannel(null)}>
					← Назад
				</button>
				<h1>{channelRow.name || "(без названия)"}</h1>
			</header>
			{channelRow.description && <p>{channelRow.description}</p>}
			{channelRow.rules && (
				<details>
					<summary>Правила канала</summary>
					<p style={{ whiteSpace: "pre-wrap" }}>{channelRow.rules}</p>
				</details>
			)}
			{error && (
				<p role="alert" style={{ color: "var(--bad, oklch(0.58 0.21 25))" }}>
					{error}
				</p>
			)}

			<div class="cluster" role="tablist" aria-label="Раздел канала">
				<button type="button" role="tab" aria-selected={tab === "posts"} onClick={() => setTab("posts")}>
					Посты
				</button>
				<button type="button" role="tab" aria-selected={tab === "chat"} onClick={() => setTab("chat")}>
					Чат
				</button>
				{isOwner && (
					<button type="button" role="tab" aria-selected={tab === "moderation"} onClick={() => setTab("moderation")}>
						Модерация
					</button>
				)}
			</div>

			{tab === "posts" && (
				<section role="tabpanel" class="flow" style={{ "--flow-space": "var(--space-s)" }}>
					{isOwner && !showComposer && (
						<button type="button" onClick={() => setShowComposer(true)}>
							Написать пост
						</button>
					)}
					{isOwner && showComposer && (
						<PostComposer
							ownerPubkey={ownerPubkey}
							privKey={privKey}
							dbKey={dbKey}
							channelId={channelId}
							limiter={limiter}
							onPublished={() => {
								setShowComposer(false);
								refresh();
							}}
							onCancel={() => setShowComposer(false)}
						/>
					)}

					{hasMore && (
						<button type="button" onClick={handleLoadMore}>
							Загрузить более старые посты
						</button>
					)}
					{posts.length === 0 ? (
						<p style={{ color: "var(--muted)" }}>В этом канале пока нет постов.</p>
					) : (
						<div class="flow" style={{ "--flow-space": "var(--space-s)" }}>
							{[...posts].reverse().map((post) => (
								<PostWithComments
									key={post.id}
									post={post}
									isOwner={isOwner}
									canComment={canComment}
									ownerPubkey={ownerPubkey}
									privKey={privKey}
									dbKey={dbKey}
									channelId={channelId}
									channelOwnerPubkey={channelRow.creatorPubkey}
									limiter={limiter}
									commentCount={commentCounts[post.id] ?? 0}
									onCountChange={handleCommentCountChange}
									onPostChanged={refresh}
								/>
							))}
						</div>
					)}
				</section>
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
					/>
				</section>
			)}

			{tab === "moderation" && isOwner && (
				<section role="tabpanel">
					<ModerationPanel ownerPubkey={ownerPubkey} privKey={privKey} dbKey={dbKey} channelId={channelId} />
				</section>
			)}
		</main>
	);
}
