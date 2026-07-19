import { useState, useEffect, useRef } from "preact/hooks";
import { db } from "../../core/store/database.js";
import { publish } from "../signals/transport.js";
import { messagingActivity } from "../signals/chats.js";
import { openChannel } from "../signals/channel-nav.js";
import { createDraftPost, publishPost, archivePost, unpublishPost, deletePost } from "../../domain/content/post.js";
import { loadPostsWindow } from "../../core/sync/lazy-channel.js";
import { addComment, getCommentsTree } from "../../domain/content/comments.js";
import { validateAttachment } from "../../domain/attachments/validation.js";
import { uploadAttachment } from "../../domain/attachments/upload.js";
import { BUILD_DEFAULT_BLOSSOM_SERVERS } from "../../config.js";
import AttachmentPreview from "../components/attachment-preview.jsx";
import PostCard from "../components/post-card.jsx";
import { shortPubkey } from "../format.js";

const POST_MAX_LENGTH = 10000; // ТЗ пользователя
const COMMENT_MAX_LENGTH = 4000;
const BLOSSOM_SERVER_URL = BUILD_DEFAULT_BLOSSOM_SERVERS[0];

// Один необязательный аттач на пост/комментарий (не до 10/5, как в исходном ТЗ) —
// CONTRACTS.md, этап 31: сознательное упрощение, та же UX-модель, что чат (этап 29),
// формат данных (attachments: []) уже поддерживает множественные без миграции схемы.
function usePendingAttachment() {
	const [file, setFile] = useState(null);
	const [error, setError] = useState("");
	const inputRef = useRef(null);

	function handleSelect(e) {
		const picked = e.currentTarget.files?.[0];
		e.currentTarget.value = "";
		if (!picked) return;
		setFile(picked);
		try {
			validateAttachment({ mime: picked.type, size: picked.size });
			setError("");
		} catch (err) {
			setError(err?.message || String(err));
		}
	}

	function reset() {
		setFile(null);
		setError("");
	}

	return { file, error, inputRef, handleSelect, reset };
}

async function uploadPendingAttachment(file, privKey) {
	const bytes = new Uint8Array(await file.arrayBuffer());
	return uploadAttachment(BLOSSOM_SERVER_URL, bytes, { mime: file.type, name: file.name }, privKey);
}

function PostComposer({ ownerPubkey, privKey, channelId, onPublished, onCancel }) {
	const [text, setText] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const attachment = usePendingAttachment();

	async function handleSubmit(e) {
		e.preventDefault();
		if (busy || text.length === 0) return;
		if (attachment.file && attachment.error) return;
		setBusy(true);
		setError("");
		try {
			let attachments = [];
			if (attachment.file) {
				attachments = [await uploadPendingAttachment(attachment.file, privKey)];
			}
			const { postId } = await createDraftPost(ownerPubkey, channelId, { text, attachments });
			await publishPost(ownerPubkey, privKey, postId, publish);
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

function CommentComposer({ ownerPubkey, privKey, channelId, postId, parentId, onSubmitted, onCancel, autoFocus }) {
	const [text, setText] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const attachment = usePendingAttachment();

	async function handleSubmit(e) {
		e.preventDefault();
		if (busy || text.length === 0) return;
		if (attachment.file && attachment.error) return;
		setBusy(true);
		setError("");
		try {
			let attachments = [];
			if (attachment.file) {
				attachments = [await uploadPendingAttachment(attachment.file, privKey)];
			}
			await addComment(ownerPubkey, privKey, channelId, postId, parentId, text, attachments, publish);
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

function CommentNode({ comment, canComment, ownerPubkey, privKey, channelId, postId, onChanged, depth }) {
	const [replying, setReplying] = useState(false);
	return (
		<li style={{ marginInlineStart: depth > 0 ? "var(--space-m)" : 0, paddingBlockStart: "var(--space-2xs)" }}>
			<p style={{ whiteSpace: "pre-wrap" }}>{comment.text}</p>
			<div class="cluster" style={{ alignItems: "center" }}>
				<small style={{ color: "var(--muted)" }}>{shortPubkey(comment.authorPubkey)}</small>
				{canComment && (
					<button type="button" onClick={() => setReplying((v) => !v)}>
						Ответить
					</button>
				)}
			</div>
			{replying && (
				<CommentComposer
					ownerPubkey={ownerPubkey}
					privKey={privKey}
					channelId={channelId}
					postId={postId}
					parentId={comment.id}
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
							channelId={channelId}
							postId={postId}
							onChanged={onChanged}
							depth={depth + 1}
						/>
					))}
				</ul>
			)}
		</li>
	);
}

function PostWithComments({ post, isOwner, canComment, ownerPubkey, privKey, channelId, onPostChanged }) {
	const [expanded, setExpanded] = useState(false);
	const [tree, setTree] = useState([]);
	const [error, setError] = useState("");

	async function refreshComments() {
		setTree(await getCommentsTree(ownerPubkey, post.id));
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
				commentCount={tree.length}
				onOpenComments={() => setExpanded((v) => !v)}
				onArchive={() => runAction(() => archivePost(ownerPubkey, privKey, post.id, publish))}
				onUnpublish={() => runAction(() => unpublishPost(ownerPubkey, privKey, post.id, publish))}
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
							channelId={channelId}
							postId={post.id}
							parentId={post.id}
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
									channelId={channelId}
									postId={post.id}
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

export default function ChannelDetail({ ownerPubkey, privKey, channelId }) {
	const [channelRow, setChannelRow] = useState(null);
	const [posts, setPosts] = useState([]);
	const [hasMore, setHasMore] = useState(false);
	const [showComposer, setShowComposer] = useState(false);
	const [error, setError] = useState("");

	async function refresh() {
		setChannelRow(await db.table("channels").get([ownerPubkey, channelId]));
		const { posts: freshPosts, hasMore: more } = await loadPostsWindow(ownerPubkey, channelId, { limit: 10 });
		setPosts(freshPosts);
		setHasMore(more);
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

	if (!channelRow) {
		return (
			<main class="flow" style={{ padding: "var(--space-m)" }}>
				<button type="button" onClick={() => openChannel(null)}>
					← Назад
				</button>
				<p style={{ color: "var(--muted)" }}>Загрузка…</p>
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

			{isOwner && !showComposer && (
				<button type="button" onClick={() => setShowComposer(true)}>
					Написать пост
				</button>
			)}
			{isOwner && showComposer && (
				<PostComposer
					ownerPubkey={ownerPubkey}
					privKey={privKey}
					channelId={channelId}
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
							channelId={channelId}
							onPostChanged={refresh}
						/>
					))}
				</div>
			)}
		</main>
	);
}
