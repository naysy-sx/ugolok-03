import { useState, useEffect, useId, useRef } from "preact/hooks";
import { db } from "../../core/store/database.js";
import { fromEncryptedRow } from "../../core/store/encrypted-table.js";
import { publish, fetchProfiles } from "../signals/transport.js";
import { markChannelAsRead } from "../../domain/content/channel-read-status.js";
import { refreshUnreadChannelsCount } from "../signals/notifications.js";
import { messagingActivity } from "../signals/chats.js";
import { ensureProfilesFetched, profiles, groups, refreshGroups } from "../signals/contacts.js";
import { shortPubkey } from "../format.js";
import { openChannel, channelPostTarget } from "../signals/channel-nav.js";
import {
	createDraftPost,
	publishPost,
	archivePost,
	unpublishPost,
	deletePost,
	setPostDue,
	clearPostDue,
	setPostDone,
	makePostTask,
	unmakePostTask,
} from "../../domain/content/post.js";
import { editChannel, deleteChannel } from "../../domain/content/channel.js";
import { addVisibilityGroup, removeVisibilityGroup, listChannelVisibilityGroupIds } from "../../domain/content/channel-visibility.js";
import { loadPostsWindow } from "../../core/sync/lazy-channel.js";
import { addComment, getCommentsTree, countCommentsByPost, compareComments } from "../../domain/content/comments.js";
import { mediaClassesByPost } from "../../domain/content/media-index.js";
import { collectPostScope, findRefPosition } from "../../domain/media/scope.js";
import { buildPlaylist } from "../../domain/media/playlist.js";
import { refFromAttachment } from "../../domain/media/media-ref.js";
import { openMedia } from "../signals/media.js";
import MediaButtons from "../components/media/media-buttons.jsx";
import { createRateLimiter } from "../../domain/content/rate-limiter.js";
import { useAttachmentTray } from "../hooks/use-attachment-tray.js";
import { validateAttachment, MAX_ATTACHMENTS_PER_MESSAGE } from "../../domain/files/attachment-validation.js";
import { uploadMessageAttachment } from "../../domain/messaging/attachments.js";
import { BUILD_DEFAULT_BLOSSOM_SERVERS } from "../../config.js";
import AttachmentTray from "../components/media/attachment-tray.jsx";
import AttachmentView from "../components/attachment-view.jsx";
import { splitBubbleAttachments } from "../components/message-bubble-attachments.js";
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
import { t, tPlural, errorMessage } from "../signals/i18n.js";
import MarkdownView from "../components/markdown-view.jsx";
import MarkdownFormatToolbar from "../components/markdown-format-toolbar.jsx";
import PostEditor from "../editor/editor.jsx";
import { parseRich } from "../../core/markdown/parse.js";
import { toPlainText } from "../../core/markdown/to-plain.js";

const POST_MAX_LENGTH = 10000; // ТЗ пользователя — видимый лимит, считается по toPlainText (Р-4)
const POST_SOURCE_MAX_LENGTH = 20000; // Р-4 — скрытый жёсткий потолок на markdown-исходник
const COMMENT_MAX_LENGTH = 4000;
// Те же лимиты, что CreateChannelForm (channels.jsx) — редактирование обязано
// подчиняться тем же правилам, что создание.
const NAME_MAX_LENGTH = 100;
const DESCRIPTION_MAX_LENGTH = 500;
const RULES_MAX_LENGTH = 1000;
const BLOSSOM_SERVER_URL = BUILD_DEFAULT_BLOSSOM_SERVERS[0];

// VISUAL.md v2 ("Пост + комментарии") — .cmt__box раскладывает аватар/имя/
// текст отдельными областями (не единым блоком, как ContactIdentity в
// Контактах), поэтому здесь достаём имя/аватар автора комментария напрямую
// из уже закэшированных профилей, а не переиспользуем ContactIdentity целиком.
function commentAuthorInfo(pubkey) {
	const profile = profiles.value[pubkey];
	return { name: profile?.name || shortPubkey(pubkey), avatar: profile?.picture };
}

// Этап 50-довесок-2 (найдено пользователем: канал нельзя было отредактировать/
// удалить после создания) — та же вкладочная структура, что "Модерация"
// (isOwner-only), подпись буквально по формулировке пользователя.
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
	// Этап 74 — найдено живой проверкой (не баг синхронизации, реальный пробел
	// функциональности): группы видимости задавались ТОЛЬКО при createChannel,
	// эта форма не имела полей про группы вовсе (channels.js/channel-visibility.js
	// уже умели addVisibilityGroup/removeVisibilityGroup — не хватало UI-моста).
	// originalGroupIdsRef — снимок НА МОМЕНТ ОТКРЫТИЯ формы, для diff при save
	// (не сравниваем с channelRow — та не несёт список групп).
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
			// Диф против снимка НА МОМЕНТ ОТКРЫТИЯ формы — только реально изменённые
			// группы, не весь набор (addVisibilityGroup/removeVisibilityGroup сами
			// идемпотентны, но вызывать их для НЕ тронутых групп — лишние проверки).
			// Отзыв — ПЕРЕД выдачей (интуитивно: сначала убрать устаревший доступ,
			// затем выдать новый — порядок не влияет на корректность, обе операции
			// независимо читают свежее состояние ключа/версии при каждом вызове).
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

			<div class="row" style={{ "--gap": "var(--space-3xs)", alignItems: "center" }}>
				<input id="edit-channel-allow-chat-attachments" type="checkbox" checked={allowChatAttachments} onChange={(e) => setAllowChatAttachments(e.currentTarget.checked)} />
				<label for="edit-channel-allow-chat-attachments">{t("channels.create.allowChatAttachmentsLabel")}</label>
			</div>

			<fieldset class="stack" style={{ "--gap": "var(--space-3xs)", border: "none", padding: 0 }}>
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
								<span class="row" style={{ "--gap": "var(--space-3xs)", alignItems: "center" }}>
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

			<div class="row" style={{ "--gap": "var(--space-s)", alignItems: "center" }}>
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

function PostComposer({ ownerPubkey, privKey, dbKey, channelId, limiter, onPublished, onCancel }) {
	const [text, setText] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const tray = useAttachmentTray({ maxItems: MAX_ATTACHMENTS_PER_MESSAGE });
	const fileInputRef = useRef(null);
	const author = commentAuthorInfo(ownerPubkey);
	// Этап 69 — свой аватар в композере рендерится ДО того, как что-либо
	// ещё в этом дереве компонентов гарантированно подтянуло profiles[ownerPubkey]
	// (PostWithComments подтягивает автора ПОСТА, но постов может ещё не
	// быть) — без этого fallback на shortPubkey (буква "N" от npub…).
	useEffect(() => {
		ensureProfilesFetched([ownerPubkey], fetchProfiles).catch(() => {});
	}, [ownerPubkey]);

	// Markdown-этап C — Р-4: видимый пользователю лимит считается по plain-тексту
	// (toPlainText), на markdown-исходник действует скрытый жёсткий потолок.
	const plainLength = text ? toPlainText(parseRich(text)).length : 0;
	const plainTooLong = plainLength > POST_MAX_LENGTH;
	const sourceTooLong = text.length > POST_SOURCE_MAX_LENGTH;

	async function handleSubmit(e) {
		e.preventDefault();
		if (busy || text.length === 0 || plainTooLong || sourceTooLong) return;
		if (tray.items.some((item) => item.error)) return;
		if (!limiter.tryAction("post")) {
			setError(t("common.rateLimitError"));
			return;
		}
		setBusy(true);
		setError("");
		try {
			const attachments = tray.items.length > 0 ? await tray.uploadAll(privKey) : [];
			const { postId } = await createDraftPost(ownerPubkey, dbKey, channelId, { text, attachments });
			await publishPost(ownerPubkey, privKey, dbKey, postId, publish);
			onPublished();
		} catch (err) {
			setError(errorMessage(err));
		} finally {
			setBusy(false);
		}
	}

	return (
		<form class="card box stack" onSubmit={handleSubmit} style={{ "--gap": "var(--space-s)", "--pad": "var(--space-m)" }}>
			{error && (
				<p role="alert" style={{ color: "var(--bad)" }}>
					{error}
				</p>
			)}
			<div class="bar" style={{ "--gap": "var(--space-m)", alignItems: "flex-start" }}>
				{author.avatar ? (
					<img src={author.avatar} alt="" class="post__ava rigid" />
				) : (
					<div aria-hidden="true" class="post__ava post__ava-fallback rigid row" style={{ alignItems: "center", justifyContent: "center" }}>
						{(author.name || "?").trim().charAt(0).toUpperCase()}
					</div>
				)}
				<div class="stack grow" style={{ "--gap": "var(--space-s)" }}>
					<label class="visually-hidden" for="post-text">
						{t("channel.composer.postTextLabel")}
					</label>
					<PostEditor initialSource={text} onChange={setText} />
					{(plainTooLong || sourceTooLong) && (
						<p role="alert" style={{ color: "var(--bad)" }}>
							{t("channel.composer.tooLongError", { max: POST_MAX_LENGTH })}
						</p>
					)}
					{(tray.items.length > 0 || tray.errors.length > 0) && (
						<AttachmentTray items={tray.items} errors={tray.errors} onRemove={tray.remove} onPositionChange={tray.setPosition} />
					)}
					<div class="row" style={{ "--gap": "var(--space-s)", alignItems: "center" }}>
						<input ref={fileInputRef} type="file" multiple style={{ display: "none" }} onChange={(e) => { tray.addFiles(e.currentTarget.files); e.currentTarget.value = ""; }} />
						<button type="button" onClick={() => fileInputRef.current?.click()}>
							<IconPaperclip /> {t("channel.composer.attachButton")}
						</button>
						<button type="submit" disabled={busy || text.length === 0 || plainTooLong || sourceTooLong || tray.items.some((item) => item.error)}>
							<IconSend /> {busy ? t("channel.composer.publishingButton") : t("channel.composer.publishButton")}
						</button>
						<button type="button" onClick={onCancel} disabled={busy}>
							<IconCross /> {t("common.cancel")}
						</button>
					</div>
				</div>
			</div>
		</form>
	);
}

function CommentComposer({ ownerPubkey, privKey, dbKey, channelId, postId, parentId, limiter, onSubmitted, onCancel, autoFocus }) {
	const [text, setText] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const tray = useAttachmentTray({ maxItems: MAX_ATTACHMENTS_PER_MESSAGE });
	const fileInputRef = useRef(null);
	const textareaRef = useRef(null);
	const author = commentAuthorInfo(ownerPubkey);
	// Этап 69 — тот же приём, что PostComposer: свой аватар может отрисоваться
	// раньше, чем profiles[ownerPubkey] окажется в кэше.
	useEffect(() => {
		ensureProfilesFetched([ownerPubkey], fetchProfiles).catch(() => {});
	}, [ownerPubkey]);

	async function handleSubmit(e) {
		e.preventDefault();
		if (busy || text.length === 0) return;
		if (tray.items.some((item) => item.error)) return;
		if (!limiter.tryAction("comment")) {
			setError(t("common.rateLimitError"));
			return;
		}
		setBusy(true);
		setError("");
		try {
			const attachments = tray.items.length > 0 ? await tray.uploadAll(privKey) : [];
			await addComment(ownerPubkey, privKey, dbKey, channelId, postId, parentId, text, attachments, publish);
			onSubmitted();
		} catch (err) {
			setError(errorMessage(err));
		} finally {
			setBusy(false);
		}
	}

	return (
		<form class="composer bar" style={{ "--gap": "var(--space-s)", alignItems: "flex-start" }} onSubmit={handleSubmit} aria-label={t("channel.commentComposer.ariaLabel")}>
			{author.avatar ? (
				<img src={author.avatar} alt="" class="cmt__ava rigid" />
			) : (
				<div aria-hidden="true" class="cmt__ava cmt__ava-fallback rigid row" style={{ alignItems: "center", justifyContent: "center" }}>
					{(author.name || "?").trim().charAt(0).toUpperCase()}
				</div>
			)}
			<div class="stack grow" style={{ "--gap": "var(--space-2xs)" }}>
				{error && (
					<p role="alert" style={{ color: "var(--bad)" }}>
						{error}
					</p>
				)}
				<label class="visually-hidden" for={`comment-text-${parentId}`}>
					{t("channel.commentComposer.label")}
				</label>
				<MarkdownFormatToolbar textareaRef={textareaRef} value={text} onChange={setText} />
				<textarea
					class="comment-text-field"
					id={`comment-text-${parentId}`}
					ref={textareaRef}
					value={text}
					maxLength={COMMENT_MAX_LENGTH}
					onInput={(e) => setText(e.currentTarget.value)}
					rows={2}
					placeholder={t("channel.commentComposer.placeholder")}
					autoFocus={autoFocus}
				/>
				{(tray.items.length > 0 || tray.errors.length > 0) && (
					<AttachmentTray items={tray.items} errors={tray.errors} onRemove={tray.remove} onPositionChange={tray.setPosition} />
				)}
				<div class="composer__row row" style={{ "--gap": "var(--space-2xs)", alignItems: "center" }}>
					<input ref={fileInputRef} type="file" multiple style={{ display: "none" }} onChange={(e) => { tray.addFiles(e.currentTarget.files); e.currentTarget.value = ""; }} />
					<button type="button" class="icon-btn" onClick={() => fileInputRef.current?.click()} aria-label={t("channel.commentComposer.attachAria")}>
						<IconPaperclip />
					</button>
					<span class="grow" />
					<button type="submit" disabled={busy || text.length === 0 || tray.items.some((item) => item.error)}>
						{busy ? t("channel.commentComposer.sendingButton") : t("common.send")}
					</button>
					{onCancel && (
						<button type="button" class="btn--ghost" onClick={onCancel} disabled={busy}>
							{t("common.cancel")}
						</button>
					)}
				</div>
			</div>
		</form>
	);
}

function CommentNode({ comment, canComment, ownerPubkey, privKey, dbKey, channelId, channelOwnerPubkey, postId, postAuthorPubkey, limiter, onChanged, depth, highlightCommentId, onOpenAttachment }) {
	const [replying, setReplying] = useState(false);
	const isOwnComment = comment.authorPubkey === ownerPubkey;
	const isTarget = comment.id === highlightCommentId;
	const isOP = comment.authorPubkey === postAuthorPubkey;
	const author = commentAuthorInfo(comment.authorPubkey);
	const { above, below } = splitBubbleAttachments(comment.attachments);

	return (
		<li id={`comment-${comment.id}`} class={`cmt${isTarget ? " is-target-comment" : ""}`}>
			<article class="cmt__box bar" style={{ "--gap": "var(--space-m)", alignItems: "flex-start" }}>
				{author.avatar ? (
					<img src={author.avatar} alt="" class="cmt__ava rigid" />
				) : (
					<div aria-hidden="true" class="cmt__ava cmt__ava-fallback rigid row" style={{ alignItems: "center", justifyContent: "center" }}>
						{(author.name || "?").trim().charAt(0).toUpperCase()}
					</div>
				)}
				<div class="stack grow" style={{ "--gap": "var(--space-2xs)" }}>
					<header class="cmt__head row" style={{ "--gap": "var(--space-2xs)", alignItems: "baseline" }}>
						<span class="cmt__name">{author.name}</span>
						{isOP && <span class="cmt__op">{t("channel.comment.authorBadge")}</span>}
					</header>
					{above && (
						<div class="cmt__media">
							<AttachmentView attachment={above} onOpen={(a) => onOpenAttachment?.(a, { commentId: comment.id })} />
						</div>
					)}
					<div class="cmt__text">
					<MarkdownView source={comment.text} profile="lite" />
				</div>
					{below.length > 0 && (
						<div class="cmt__media">
							{below.map((a, i) => (
								<AttachmentView key={i} attachment={a} onOpen={(a) => onOpenAttachment?.(a, { commentId: comment.id })} />
							))}
						</div>
					)}
					<footer class="cmt__actions row" style={{ "--gap": "var(--space-s)", alignItems: "center" }}>
						<time class="cmt__time">{formatDateTime(comment.createdAt)}</time>
						{canComment && (
							<button type="button" class="btn--ghost" onClick={() => setReplying((v) => !v)}>
								<IconChatBubble /> {t("channel.comment.replyButton")}
							</button>
						)}
						{!isOwnComment && (
							<ActionsMenu label={t("channel.comment.moreActionsAria", { name: author.name })}>
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
					</footer>
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
			    теперь можно свернуть длинный тред вручную. Класс .replies —
			    имя из эталона REGLAMENT.md, раздел 4 ("Дерево ответов —
			    рекурсия, не новый примитив"), этап 69: было .thread,
			    разошедшееся с уже принятым в регламенте словарём. */}
			{comment.replies.length > 0 && (
				<details class="replies" open>
					<summary class="row" style={{ "--gap": "var(--space-3xs)", alignItems: "center" }}>
						<IconChevronRight class="icon replies__chev" aria-hidden="true" />
						{t("channel.threadLabel", { count: tPlural("channel.repliesCount", comment.replies.length) })}
					</summary>
					<ul role="list" class="cmt-list stack" style={{ "--gap": "var(--space-m)" }}>
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
								onOpenAttachment={onOpenAttachment}
							/>
						))}
					</ul>
				</details>
			)}
		</li>
	);
}

function PostWithComments({ post, isOwner, canComment, ownerPubkey, privKey, dbKey, channelId, channelOwnerPubkey, limiter, commentCount, mediaCounts, onCountChange, onPostChanged, autoExpand, highlightCommentId }) {
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
		if (expanded) refreshComments().catch((e) => setError(errorMessage(e)));
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
			setError(errorMessage(err));
		}
	}

	// Этап E, E3 (DESIGN.md "Этап E") — mediaCounts (кнопка) посчитан по ВСЕМ
	// комментариям поста, а не только по раскрытым (tree заполняется лениво,
	// только при expanded). Клик форсирует СВЕЖИЙ getCommentsTree независимо
	// от expanded — иначе плейлист разошёлся бы со счётчиком на кнопке.
	async function handleOpenMediaClass(cls) {
		try {
			const commentsTree = await getCommentsTree(ownerPubkey, dbKey, post.id);
			const refs = collectPostScope({ post, commentsTree, compareSiblings: compareComments });
			const playlist = buildPlaylist(refs);
			const position = playlist.idx[cls]?.[0];
			if (position === undefined) return;
			openMedia({ refs, position });
		} catch (err) {
			setError(errorMessage(err));
		}
	}

	// Этап F, F1/F2 (CONTRACTS.md/DESIGN.md "Этап F") — в отличие от кнопки
	// (handleOpenMediaClass выше) клик по КОНКРЕТНОМУ вложению НЕ форсирует
	// свежий getCommentsTree: если comment.attachments рендерятся вообще, tree
	// уже загружен (CommentNode рисуется только внутри {expanded && ...}),
	// а клик по post.attachments (всегда видимым) остаётся мгновенным, как
	// было до этого этапа — без сетевого ожидания на каждый клик по картинке.
	function openAttachment(attachment, sourceMeta) {
		const refs = collectPostScope({ post, commentsTree: tree, compareSiblings: compareComments });
		const target = refFromAttachment(attachment, sourceMeta);
		const position = findRefPosition(refs, target.digest, target.sourceMeta);
		if (position === -1) return;
		openMedia({ refs, position });
	}

	// Редизайн интерфейса, этап 2 (CONTRACTS.md) — setPostDue/setPostDone и
	// производные ЛОКАЛЬНЫЕ (не публикуют, этап 1) — runAction всё равно
	// оборачивает их тем же приёмом, что архивацию/удаление: онлайновый
	// путь до relay доедет окольно, при следующем статусном переходе
	// (post.js, республикация несёт актуальные dueAt/done), а onPostChanged
	// (runAction) обновляет ленту сразу, локально.
	function handleSetDue() {
		const input = window.prompt(t("postCard.setDuePrompt"));
		if (input === null) return; // отменено
		const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input.trim());
		const dueAt = match ? Math.floor(new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).getTime() / 1000) : NaN;
		if (!match || Number.isNaN(dueAt)) {
			window.alert(t("postCard.setDueInvalid"));
			return;
		}
		runAction(() => setPostDue(ownerPubkey, post.id, dueAt));
	}

	return (
		<div id={`post-${post.id}`} class="stack" style={{ "--gap": 0 }}>
			<PostCard
				post={post}
				isOwner={isOwner}
				commentCount={expanded ? countNodes(tree) : commentCount}
				onOpenComments={() => setExpanded((v) => !v)}
				mediaCounts={mediaCounts}
				onOpenMediaClass={handleOpenMediaClass}
				onOpenAttachment={(a) => openAttachment(a, { postId: post.id })}
				onToggleDone={(done) => runAction(() => setPostDone(ownerPubkey, post.id, done))}
				onMakeTask={() => runAction(() => makePostTask(ownerPubkey, post.id))}
				onUnmakeTask={() => runAction(() => unmakePostTask(ownerPubkey, post.id))}
				onSetDue={handleSetDue}
				onClearDue={() => runAction(() => clearPostDue(ownerPubkey, post.id))}
				onArchive={() => runAction(() => archivePost(ownerPubkey, privKey, dbKey, post.id, publish))}
				onUnpublish={() => runAction(() => unpublishPost(ownerPubkey, privKey, dbKey, post.id, publish))}
				onDelete={() => {
					if (window.confirm(t("channel.deletePostConfirm"))) runAction(() => deletePost(ownerPubkey, privKey, post.id, publish));
				}}
			/>
			{error && (
				<p role="alert" class="box" style={{ "--pad": "var(--space-m)", color: "var(--bad)" }}>
					{error}
				</p>
			)}
			{expanded && (
				<div class="stack box comment-section" style={{ "--gap": "var(--space-s)", "--pad": "var(--space-m)" }}>
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
						<p style={{ color: "var(--muted)" }}>{t("channel.readOnlyNotice")}</p>
					)}
					<h3 class="section-label">{t("channel.commentsTitle")}</h3>
					{tree.length === 0 ? (
						<p style={{ color: "var(--muted)" }}>{t("channel.noComments")}</p>
					) : (
						<ul role="list" class="cmt-list stack" style={{ "--gap": "var(--space-m)" }}>
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
									onOpenAttachment={openAttachment}
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
	const [mediaClasses, setMediaClasses] = useState({});
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
		// Этап E, E2/E3 — один общий скан на ВСЮ ленту владельца (не только этот
		// канал, MEDIA-SPEC.md §3.10 буквально), тот же приём, что commentCounts
		// выше. PostCard читает по своему post.id, Θ(1) на карточку.
		const classes = await mediaClassesByPost(ownerPubkey, dbKey);
		setMediaClasses(Object.fromEntries(classes));
	}

	function handleCommentCountChange(postId, count) {
		setCommentCounts((prev) => ({ ...prev, [postId]: count }));
	}

	useEffect(() => {
		refresh().catch((e) => setError(errorMessage(e)));
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
			<Screen breadcrumb={{ label: t("nav.channels"), onBack: () => openChannel(null) }} title={t("channel.defaultTitle")}>
				<p style={{ color: "var(--muted)" }}>{t("common.loading")}</p>
			</Screen>
		);
	}

	// Этап 33 — различать "ещё грузится" от "пропал" (тот же класс находки, что
	// onboarding/unlock, этап 32-довесок): канал исчезает локально, если владелец забанил
	// этого пользователя (receiveBanAnnouncement удаляет строку channels целиком).
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

	return (
		<Screen breadcrumb={{ label: t("nav.channels"), onBack: () => openChannel(null) }} title={channelRow.name || t("channels.card.untitled")}>
			{/* Markdown-этап E — описание/правила канала намеренно plain, разметка
			    в них не вводится (CONTRACTS.md, "Markdown — Этап E", п.6). */}
			{channelRow.description && <p class="channel-description">{channelRow.description}</p>}
			{channelRow.rules && (
				<details class="req">
					<summary class="row" style={{ "--gap": "var(--space-2xs)", alignItems: "center" }}>
						{t("channels.create.rulesLabel")}
						<IconChevronRight class="icon req__chev" aria-hidden="true" />
					</summary>
					<p class="req__body" style={{ whiteSpace: "pre-wrap" }}>
						{channelRow.rules}
					</p>
				</details>
			)}
			{error && (
				<p role="alert" style={{ color: "var(--bad)" }}>
					{error}
				</p>
			)}

			<nav class="tabs row" style={{ "--gap": "var(--space-2xs)", alignItems: "center" }} aria-label={t("channel.tabsAriaLabel")}>
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
						{t("channel.tabs.editChannelWithName", { name: channelRow.name || t("channels.card.untitled") })}
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
				<section role="tabpanel" class="stack" style={{ "--gap": "var(--space-s)" }}>
					{isOwner && !showComposer && (
						<button type="button" class="channel-post-cta" onClick={() => setShowComposer(true)}>
							<IconPencil /> {t("channel.writePostButton")}
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
							{t("channel.loadOlderButton")}
						</button>
					)}
					{posts.length === 0 ? (
						<p style={{ color: "var(--muted)" }}>{t("channel.noPosts")}</p>
					) : (
						<div class="stack" style={{ "--gap": "var(--space-s)" }}>
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
									mediaCounts={mediaClasses[post.id]}
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
