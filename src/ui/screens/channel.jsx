import { useState, useEffect } from "preact/hooks";
import { db } from "../../core/store/database.js";
import { fromEncryptedRow } from "../../core/store/encrypted-table.js";
import { publish, fetchProfiles } from "../signals/transport.js";
import { markChannelAsRead } from "../../domain/content/channel-read-status.js";
import { refreshUnreadChannelsCount } from "../signals/notifications.js";
import { messagingActivity } from "../signals/chats.js";
import { ensureProfilesFetched, profiles } from "../signals/contacts.js";
import { shortPubkey } from "../format.js";
import { openChannel, channelPostTarget } from "../signals/channel-nav.js";
import { createDraftPost, publishPost, archivePost, unpublishPost, deletePost } from "../../domain/content/post.js";
import { editChannel, deleteChannel } from "../../domain/content/channel.js";
import { loadPostsWindow } from "../../core/sync/lazy-channel.js";
import { addComment, getCommentsTree, countCommentsByPost } from "../../domain/content/comments.js";
import { createRateLimiter } from "../../domain/content/rate-limiter.js";
import { usePendingAttachment, uploadPendingAttachment } from "../hooks/pending-attachment.js";
import { validateAttachment } from "../../domain/files/attachment-validation.js";
import { uploadMessageAttachment } from "../../domain/messaging/attachments.js";
import { BUILD_DEFAULT_BLOSSOM_SERVERS } from "../../config.js";
import AttachmentPreview from "../components/attachment-preview.jsx";
import AttachmentView from "../components/attachment-view.jsx";
import PostCard, { formatDateTime } from "../components/post-card.jsx";
import ChannelChat from "../components/channel-chat.jsx";
import ModerationActions from "../components/moderation-actions.jsx";
import ModerationPanel from "../components/moderation-panel.jsx";
import Screen from "../components/screen.jsx";
import ActionsMenu from "../components/actions-menu.jsx";
import IconChevronRight from "../icons/chevron-right.jsx";
import IconTrash from "../icons/trash.jsx";
import IconChatBubble from "../icons/chat-bubble.jsx";
import IconPencil from "../icons/pencil.jsx";
import IconPaperclip from "../icons/paperclip.jsx";
import IconSend from "../icons/send.jsx";
import IconCross from "../icons/cross.jsx";

const POST_MAX_LENGTH = 10000; // ТЗ пользователя
const COMMENT_MAX_LENGTH = 4000;
// Те же лимиты, что CreateChannelForm (channels.jsx) — редактирование обязано
// подчиняться тем же правилам, что создание.
const NAME_MAX_LENGTH = 100;
const DESCRIPTION_MAX_LENGTH = 500;
const RULES_MAX_LENGTH = 1000;
const BLOSSOM_SERVER_URL = BUILD_DEFAULT_BLOSSOM_SERVERS[0];

// VISUAL.md v2 ("Пост + комментарии") — .cmt__box раскладывает аватар/имя/
// текст отдельными grid-областями (не единым блоком, как ContactIdentity в
// Контактах), поэтому здесь достаём имя/аватар автора комментария напрямую
// из уже закэшированных профилей, а не переиспользуем ContactIdentity целиком.
function commentAuthorInfo(pubkey) {
	const profile = profiles.value[pubkey];
	return { name: profile?.name || shortPubkey(pubkey), avatar: profile?.picture };
}

// "ветка · N ответов" — русское склонение (1 ответ, 2-4 ответа, 5+ ответов).
function pluralizeReplies(n) {
	const mod10 = n % 10;
	const mod100 = n % 100;
	if (mod10 === 1 && mod100 !== 11) return `${n} ответ`;
	if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return `${n} ответа`;
	return `${n} ответов`;
}

// Этап 50-довесок-2 (найдено пользователем: канал нельзя было отредактировать/
// удалить после создания) — та же вкладочная структура, что "Модерация"
// (isOwner-only), подпись буквально по формулировке пользователя.
function ChannelSettingsForm({ ownerPubkey, privKey, dbKey, channelId, channelRow, onSaved, onDeleted }) {
	const [name, setName] = useState(channelRow.name || "");
	const [description, setDescription] = useState(channelRow.description || "");
	const [rules, setRules] = useState(channelRow.rules || "");
	const [allowChatAttachments, setAllowChatAttachments] = useState(channelRow.allowChatAttachments ?? true);
	const [avatarFile, setAvatarFile] = useState(null);
	const [avatarError, setAvatarError] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");

	function handleAvatarSelected(e) {
		const file = e.currentTarget.files?.[0];
		e.currentTarget.value = "";
		if (!file) return;
		setAvatarFile(file);
		try {
			validateAttachment({ mime: file.type, size: file.size });
			setAvatarError("");
		} catch (err) {
			setAvatarError(err?.message || String(err));
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
			onSaved();
		} catch (err) {
			setError(err?.message || String(err));
		} finally {
			setBusy(false);
		}
	}

	async function handleDelete() {
		if (busy) return;
		if (!window.confirm(`Удалить канал «${channelRow.name}»? Действие необратимо — канал исчезнет у всех подписчиков.`)) return;
		setBusy(true);
		setError("");
		try {
			await deleteChannel(ownerPubkey, privKey, dbKey, channelId, publish);
			onDeleted();
		} catch (err) {
			setError(err?.message || String(err));
			setBusy(false);
		}
	}

	return (
		<form class="flow channel-settings-form" onSubmit={handleSave} style={{ "--flow-space": "var(--space-s)" }}>
			{error && (
				<p role="alert" style={{ color: "var(--bad, oklch(0.58 0.21 25))" }}>
					{error}
				</p>
			)}

			<div class="flow" style={{ "--flow-space": "var(--space-3xs)" }}>
				<label for="edit-channel-name">Название канала</label>
				<input id="edit-channel-name" type="text" value={name} maxLength={NAME_MAX_LENGTH} onInput={(e) => setName(e.currentTarget.value)} required />
			</div>

			<div class="flow" style={{ "--flow-space": "var(--space-3xs)" }}>
				<label for="edit-channel-description">Описание</label>
				<textarea id="edit-channel-description" value={description} maxLength={DESCRIPTION_MAX_LENGTH} onInput={(e) => setDescription(e.currentTarget.value)} rows={3} />
			</div>

			<div class="flow" style={{ "--flow-space": "var(--space-3xs)" }}>
				<label for="edit-channel-rules">Правила канала</label>
				<textarea id="edit-channel-rules" value={rules} maxLength={RULES_MAX_LENGTH} onInput={(e) => setRules(e.currentTarget.value)} rows={4} />
			</div>

			<div class="flow" style={{ "--flow-space": "var(--space-3xs)" }}>
				<label for="edit-channel-avatar">Сменить аватар</label>
				<input id="edit-channel-avatar" type="file" accept="image/*" onChange={handleAvatarSelected} />
				{avatarFile && <small style={{ color: avatarError ? "var(--bad, oklch(0.58 0.21 25))" : "var(--muted)" }}>{avatarError || avatarFile.name}</small>}
			</div>

			<div class="cluster" style={{ "--cluster-gap": "var(--space-3xs)", alignItems: "center" }}>
				<input id="edit-channel-allow-chat-attachments" type="checkbox" checked={allowChatAttachments} onChange={(e) => setAllowChatAttachments(e.currentTarget.checked)} />
				<label for="edit-channel-allow-chat-attachments">Разрешить вложения в общем чате канала</label>
			</div>

			<div class="cluster">
				<button type="submit" disabled={busy || name.length === 0}>
					{busy ? "Сохранение…" : "Сохранить"}
				</button>
				<button type="button" onClick={onSaved} disabled={busy}>
					Отмена
				</button>
			</div>

			<div style={{ paddingBlockStart: "var(--space-m)", borderBlockStart: "var(--border-width) solid var(--border)" }}>
				<button type="button" class="btn--ghost btn--danger" disabled={busy} onClick={handleDelete}>
					<IconTrash /> Удалить канал
				</button>
			</div>
		</form>
	);
}

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
			const { postId } = await createDraftPost(ownerPubkey, dbKey, channelId, { text, attachments });
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
			<textarea id="post-text" class="post-text-field" value={text} maxLength={POST_MAX_LENGTH} onInput={(e) => setText(e.currentTarget.value)} rows={10} />
			{attachment.file && (
				<AttachmentPreview file={attachment.file} position="below" onPositionChange={() => {}} onRemove={attachment.reset} error={attachment.error} />
			)}
			<div class="cluster">
				<input ref={attachment.inputRef} type="file" style={{ display: "none" }} onChange={attachment.handleSelect} />
				<button type="button" onClick={() => attachment.inputRef.current?.click()}>
					<IconPaperclip /> Прикрепить
				</button>
				<button type="submit" disabled={busy || text.length === 0 || (!!attachment.file && !!attachment.error)}>
					<IconSend /> {busy ? "Публикация…" : "Опубликовать"}
				</button>
				<button type="button" onClick={onCancel} disabled={busy}>
					<IconCross /> Отмена
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
		<form class="composer" onSubmit={handleSubmit} aria-label="Новый комментарий">
			{error && (
				<p role="alert" style={{ color: "var(--bad, oklch(0.58 0.21 25))" }}>
					{error}
				</p>
			)}
			<label class="visually-hidden" for={`comment-text-${parentId}`}>
				Комментарий
			</label>
			<textarea
				class="input comment-text-field"
				id={`comment-text-${parentId}`}
				value={text}
				maxLength={COMMENT_MAX_LENGTH}
				onInput={(e) => setText(e.currentTarget.value)}
				rows={2}
				placeholder="Написать комментарий…"
				autoFocus={autoFocus}
			/>
			{attachment.file && (
				<AttachmentPreview file={attachment.file} position="below" onPositionChange={() => {}} onRemove={attachment.reset} error={attachment.error} />
			)}
			<div class="composer__row">
				<input ref={attachment.inputRef} type="file" style={{ display: "none" }} onChange={attachment.handleSelect} />
				<button type="button" class="icon-btn" onClick={() => attachment.inputRef.current?.click()} aria-label="Прикрепить файл">
					<IconPaperclip />
				</button>
				<span class="grow" />
				<button type="submit" disabled={busy || text.length === 0 || (!!attachment.file && !!attachment.error)}>
					{busy ? "Отправка…" : "Отправить"}
				</button>
				{onCancel && (
					<button type="button" class="btn--ghost" onClick={onCancel} disabled={busy}>
						Отмена
					</button>
				)}
			</div>
		</form>
	);
}

function CommentNode({ comment, canComment, ownerPubkey, privKey, dbKey, channelId, channelOwnerPubkey, postId, postAuthorPubkey, limiter, onChanged, depth, highlightCommentId }) {
	const [replying, setReplying] = useState(false);
	const isOwnComment = comment.authorPubkey === ownerPubkey;
	const isTarget = comment.id === highlightCommentId;
	const isOP = comment.authorPubkey === postAuthorPubkey;
	const author = commentAuthorInfo(comment.authorPubkey);

	return (
		<li id={`comment-${comment.id}`} class={`cmt${isTarget ? " is-target-comment" : ""}`}>
			<article class="cmt__box">
				{author.avatar ? (
					<img src={author.avatar} alt="" class="cmt__ava" />
				) : (
					<div aria-hidden="true" class="cmt__ava cmt__ava-fallback">
						{(author.name || "?").trim().charAt(0).toUpperCase()}
					</div>
				)}
				<div class="cmt__head">
					<span class="cmt__name">{author.name}</span>
					{isOP && <span class="cmt__op">автор</span>}
					<span class="cmt__time">{formatDateTime(comment.createdAt)}</span>
				</div>
				<p class="cmt__text">{comment.text}</p>
				{comment.attachments?.[0] && (
					<div class="cmt__media">
						<AttachmentView attachment={comment.attachments[0]} />
					</div>
				)}
				<div class="cmt__actions">
					{canComment && (
						<button type="button" class="btn--ghost" onClick={() => setReplying((v) => !v)}>
							<IconChatBubble /> Ответить
						</button>
					)}
					{!isOwnComment && (
						<ActionsMenu label={`Ещё действия для ${author.name}`}>
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
						</ActionsMenu>
					)}
				</div>
			</article>

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

			{/* Ветка — нативное сворачивание (VISUAL.md v2 "тёплая нить треда"),
			    open по умолчанию: тот же эффект, что раньше (всегда видно), но
			    теперь можно свернуть длинный тред вручную. */}
			{comment.replies.length > 0 && (
				<details class="thread" open>
					<summary>
						<IconChevronRight class="icon thread__chev" aria-hidden="true" />
						ветка · {pluralizeReplies(comment.replies.length)}
					</summary>
					<ul role="list" class="cmt-list">
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
								postAuthorPubkey={postAuthorPubkey}
								limiter={limiter}
								onChanged={onChanged}
								depth={depth + 1}
								highlightCommentId={highlightCommentId}
							/>
						))}
					</ul>
				</details>
			)}
		</li>
	);
}

function PostWithComments({ post, isOwner, canComment, ownerPubkey, privKey, dbKey, channelId, channelOwnerPubkey, limiter, commentCount, onCountChange, onPostChanged, autoExpand, highlightCommentId }) {
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

	function flattenCreatedAt(nodes, acc = []) {
		for (const node of nodes) {
			acc.push(node.createdAt);
			flattenCreatedAt(node.replies, acc);
		}
		return acc;
	}

	// Найденный пользователем баг (живая проверка после этапа 50): "Комментарии (N)"
	// считал только корневой уровень (tree.length/fresh.length) — вложенные ответы
	// не учитывались. countNodes суммирует ВСЕ узлы дерева, включая replies.
	function countNodes(nodes) {
		return nodes.reduce((sum, node) => sum + 1 + countNodes(node.replies), 0);
	}

	async function refreshComments() {
		const fresh = await getCommentsTree(ownerPubkey, dbKey, post.id);
		setTree(fresh);
		onCountChange?.(post.id, countNodes(fresh));
		ensureProfilesFetched([...new Set(flattenAuthors(fresh))], fetchProfiles).catch(() => {});
		// НАЙДЕНО ПОЛЬЗОВАТЕЛЕМ (этап 47-довесок-3) — курсор канала продвигался при
		// загрузке постов/чата, но НЕ при просмотре комментариев: если непрочитанным
		// был именно комментарий, бейдж "Каналы [N]" не пропадал даже после его
		// открытия. Тот же приём, что refresh() в ChannelDetail — курсор один на канал.
		const createdAts = flattenCreatedAt(fresh);
		if (createdAts.length > 0) {
			markChannelAsRead(ownerPubkey, privKey, channelId, Math.max(...createdAts), publish)
				.then(() => refreshUnreadChannelsCount(ownerPubkey, dbKey))
				.catch(() => {});
		}
	}

	useEffect(() => {
		if (expanded) refreshComments().catch((e) => setError(e?.message || String(e)));
	}, [expanded, ownerPubkey, post.id, messagingActivity.value]);

	// Этап 47-довесок-3 — клик по уведомлению о посте/комментарии/ответе передаёт
	// сюда autoExpand (этот пост совпал с channelPostTarget) — раскрываем и
	// скроллим к посту сами, не дожидаясь клика "Комментарии" от пользователя.
	useEffect(() => {
		if (autoExpand) setExpanded(true);
	}, [autoExpand]);

	useEffect(() => {
		if (autoExpand) document.getElementById(`post-${post.id}`)?.scrollIntoView({ block: "center" });
	}, [autoExpand, post.id]);

	// Скролл к конкретному комментарию — только после того, как tree реально
	// загружен (иначе элемента с этим id ещё нет в DOM).
	useEffect(() => {
		if (!highlightCommentId || tree.length === 0) return;
		document.getElementById(`comment-${highlightCommentId}`)?.scrollIntoView({ block: "center" });
	}, [highlightCommentId, tree]);

	async function runAction(fn) {
		try {
			await fn();
			onPostChanged();
		} catch (err) {
			setError(err?.message || String(err));
		}
	}

	return (
		<div id={`post-${post.id}`}>
			<PostCard
				post={post}
				isOwner={isOwner}
				commentCount={expanded ? countNodes(tree) : commentCount}
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
				<div class="flow comment-section" style={{ "--flow-space": "var(--space-s)" }}>
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
					<h3 class="section-label">Комментарии</h3>
					{tree.length === 0 ? (
						<p style={{ color: "var(--muted)" }}>Пока нет комментариев.</p>
					) : (
						<ul role="list" class="cmt-list">
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
									postAuthorPubkey={post.authorPubkey}
									limiter={limiter}
									onChanged={refreshComments}
									depth={0}
									highlightCommentId={highlightCommentId}
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
	const [navTarget, setNavTarget] = useState(null); // этап 47-довесок-3 — {postId, commentId?} из уведомления

	async function refresh() {
		const raw = await db.table("channels").get([ownerPubkey, channelId]);
		const row = raw ? fromEncryptedRow(raw, dbKey) : undefined;
		setChannelRow(row ?? null);
		setLoading(false);
		if (!row) return; // забанен владельцем (receiveBanAnnouncement) — канал исчез локально
		const { posts: freshPosts, hasMore: more } = await loadPostsWindow(ownerPubkey, dbKey, channelId, { limit: 10 });
		setPosts(freshPosts);
		setHasMore(more);
		// Этап 47 — курсор ОДИН на канал (posts+comments+chat вместе, DESIGN.md), продвигаем
		// его максимумом createdAt среди РЕАЛЬНО загруженного, не Date.now() (избегает
		// рассинхрона по времени устройства, тот же принцип, что markChatReadAction).
		if (freshPosts.length > 0) {
			const lastCreatedAt = Math.max(...freshPosts.map((p) => p.createdAt));
			// НАЙДЕНО ПОЛЬЗОВАТЕЛЕМ (этап 47-довесок) — тот же класс находки, что chat.jsx:
			// локальное прочтение не бампает messagingActivity, без явного пересчёта здесь
			// "Каналы [N]" в наве не пропадал бы после открытия канала.
			markChannelAsRead(ownerPubkey, privKey, channelId, lastCreatedAt, publish)
				.then(() => refreshUnreadChannelsCount(ownerPubkey, dbKey))
				.catch(() => {});
		}
		// Найдено пользователем: счётчик комментариев показывал 0 до первого клика —
		// один общий скан на все посты списка сразу, вместо getCommentsTree на каждый.
		// (Второй найденный баг — вложенные ответы не учитывались — исправлен внутри
		// countCommentsByPost, comments.js.)
		const counts = await countCommentsByPost(ownerPubkey, freshPosts.map((p) => p.id));
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
		const { posts: older, hasMore: more } = await loadPostsWindow(ownerPubkey, dbKey, channelId, { limit: 10, beforeCreatedAt: posts[0].createdAt });
		setPosts((prev) => [...older, ...prev]);
		setHasMore(more);
	}

	// Этап 47-довесок-3 — клик по уведомлению о посте/комментарии/ответе (или по
	// "Модерация"/"Чат" через subTab) передаёт сюда цель через channelPostTarget
	// (notification-nav.js). Читаем ОДИН раз и сразу гасим сигнал — иначе повторное
	// ручное открытие того же канала снова прыгало бы к старой цели.
	useEffect(() => {
		const target = channelPostTarget.value;
		if (!target) return;
		if (target.subTab) setTab(target.subTab);
		if (target.postId) setNavTarget({ postId: target.postId, commentId: target.commentId });
		channelPostTarget.value = null;
	}, [channelPostTarget.value]);

	// Целевой пост может быть старше уже загруженного окна (loadPostsWindow грузит
	// только последние 10) — догружаем более старые страницы, пока не найдём его
	// или не кончится история (hasMore === false).
	useEffect(() => {
		if (!navTarget?.postId) return;
		if (posts.some((p) => p.id === navTarget.postId)) return;
		if (!hasMore) return;
		handleLoadMore();
	}, [navTarget, posts, hasMore]);

	if (loading) {
		return (
			<Screen breadcrumb={{ label: "Каналы", onBack: () => openChannel(null) }} title="Канал">
				<p style={{ color: "var(--muted)" }}>Загрузка…</p>
			</Screen>
		);
	}

	// Этап 33 — различать "ещё грузится" от "пропал" (тот же класс находки, что
	// onboarding/unlock, этап 32-довесок): канал исчезает локально, если владелец забанил
	// этого пользователя (receiveBanAnnouncement удаляет строку channels целиком).
	if (!channelRow) {
		return (
			<Screen breadcrumb={{ label: "Каналы", onBack: () => openChannel(null) }} title="Канал недоступен">
				<p role="alert" style={{ color: "var(--bad, oklch(0.58 0.21 25))" }}>
					Этот канал больше недоступен — возможно, владелец забанил вас или удалил канал.
				</p>
			</Screen>
		);
	}

	const isOwner = channelRow.role === "owner";
	const canComment = channelRow.role === "owner" || channelRow.role === "subscriber";

	return (
		<Screen breadcrumb={{ label: "Каналы", onBack: () => openChannel(null) }} title={channelRow.name || "(без названия)"}>
			{channelRow.description && <p class="channel-description">{channelRow.description}</p>}
			{channelRow.rules && (
				<details class="req">
					<summary>
						Правила канала
						<IconChevronRight class="icon req__chev" aria-hidden="true" />
					</summary>
					<p class="req__body" style={{ whiteSpace: "pre-wrap" }}>
						{channelRow.rules}
					</p>
				</details>
			)}
			{error && (
				<p role="alert" style={{ color: "var(--bad, oklch(0.58 0.21 25))" }}>
					{error}
				</p>
			)}

			<nav class="tabs" aria-label="Разделы канала">
				<button type="button" class="tab" role="tab" aria-selected={tab === "posts"} onClick={() => setTab("posts")}>
					Посты
				</button>
				<button type="button" class="tab" role="tab" aria-selected={tab === "chat"} onClick={() => setTab("chat")}>
					Чат
				</button>
				{isOwner && (
					<button type="button" class="tab" role="tab" aria-selected={tab === "moderation"} onClick={() => setTab("moderation")}>
						Модерация
					</button>
				)}
				{isOwner && (
					<button type="button" class="tab" role="tab" aria-selected={tab === "settings"} onClick={() => setTab("settings")}>
						Редактировать канал «{channelRow.name || "(без названия)"}»
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
				<section role="tabpanel" class="flow" style={{ "--flow-space": "var(--space-s)" }}>
					{isOwner && !showComposer && (
						<button type="button" class="channel-post-cta" onClick={() => setShowComposer(true)}>
							<IconPencil /> Написать пост
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
									autoExpand={navTarget?.postId === post.id}
									highlightCommentId={navTarget?.postId === post.id ? navTarget?.commentId : null}
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
		</Screen>
	);
}
