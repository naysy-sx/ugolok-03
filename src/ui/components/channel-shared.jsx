import { useState, useEffect, useRef } from "preact/hooks";
import { publish, fetchProfiles } from "../signals/transport.js";
import { ensureProfilesFetched, profiles } from "../signals/contacts.js";
import { shortPubkey } from "../format.js";
import { createDraftPost, publishPost, editPost } from "../../domain/content/post.js";
import { addComment } from "../../domain/content/comments.js";
import { useAttachmentTray } from "../hooks/use-attachment-tray.js";
import { useVoiceRecording } from "../hooks/use-voice-recording.js";
import { MAX_ATTACHMENTS_PER_MESSAGE } from "../../domain/files/attachment-validation.js";
import { getManifest } from "../../domain/files/content.js";
import { getFileKeyFor, projected } from "../signals/files.js";
import FilePicker from "./file-picker.jsx";
import AttachmentTray from "./media/attachment-tray.jsx";
import { ComposeAttachButtons, VoiceRecordingStatus } from "./compose-attach-tools.jsx";
import IconPaperclip from "../icons/paperclip.jsx";
import IconFolder from "../icons/folder.jsx";
import IconSend from "../icons/send.jsx";
import IconCross from "../icons/cross.jsx";
import { t, errorMessage } from "../signals/i18n.js";
import MarkdownFormatToolbar from "./markdown-format-toolbar.jsx";
import EmojiQuickSend from "./emoji-quick-send.jsx";
import PostEditor from "../editor/editor.jsx";
import { parseRich } from "../../core/markdown/parse.js";
import { toPlainText } from "../../core/markdown/to-plain.js";
import { BUILD_DEFAULT_BLOSSOM_SERVERS } from "../../config.js";

const POST_MAX_LENGTH = 10000;
const POST_SOURCE_MAX_LENGTH = 20000;
const COMMENT_MAX_LENGTH = 4000;
const BLOSSOM_SERVER_URL = BUILD_DEFAULT_BLOSSOM_SERVERS[0];

// CHANNEL-V2 часть D1 — isNpub добавлен: вызывающий код раньше не мог
// отличить настоящее имя от npub-заглушки и красил npub как обычное имя,
// из-за чего строка авторов читалась как набор ошибок.
export function commentAuthorInfo(pubkey) {
	const profile = profiles.value[pubkey];
	const name = profile?.name?.trim();
	return { name: name || shortPubkey(pubkey), avatar: profile?.picture, isNpub: !name };
}

export function PostComposer({ ownerPubkey, privKey, dbKey, channelId, limiter, onPublished, onCancel }) {
	const [text, setText] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const tray = useAttachmentTray({ maxItems: MAX_ATTACHMENTS_PER_MESSAGE });
	const fileInputRef = useRef(null);
	const [filePickerOpen, setFilePickerOpen] = useState(false);
	const author = commentAuthorInfo(ownerPubkey);
	useEffect(() => {
		ensureProfilesFetched([ownerPubkey], fetchProfiles).catch(() => {});
	}, [ownerPubkey]);

	const plainLength = text ? toPlainText(parseRich(text)).length : 0;
	const plainTooLong = plainLength > POST_MAX_LENGTH;
	const sourceTooLong = text.length > POST_SOURCE_MAX_LENGTH;
	const emptyPost = text.length === 0 && tray.items.length < 2;

	async function handleSubmit(e) {
		e.preventDefault();
		if (busy || emptyPost || plainTooLong || sourceTooLong) return;
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

	async function handleAttachmentFromStorage([nodeId]) {
		setFilePickerOpen(false);
		const node = projected.value.nodes.get(nodeId);
		if (!node || node.kind !== "file") return;
		try {
			const manifest = await getManifest(node.blob, { serverUrl: BLOSSOM_SERVER_URL });
			const fileKey = await getFileKeyFor(node.blob);
			if (!fileKey) {
				setError(t("chat.window.fileKeyNotFoundError"));
				return;
			}
			tray.addFromStorage([{ manifestDigest: node.blob, fileKey, manifest }]);
		} catch (err) {
			setError(errorMessage(err));
		}
	}

	return (
		<>
		<form class="composer-card box stack" onSubmit={handleSubmit} style={{ "--gap": "var(--space-s)", "--pad": "var(--space-s)" }}>
			{error && (
				<p role="alert" style={{ color: "var(--bad)" }}>
					{error}
				</p>
			)}
			<div class="bar" style={{ "--gap": "var(--space-m)", "--align": "flex-start" }}>
				{author.avatar ? (
					<img src={author.avatar} alt="" class="post__ava rigid" />
				) : (
					<div aria-hidden="true" class="post__ava post__ava-fallback rigid row" style={{ "--align": "center", justifyContent: "center" }}>
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
						<AttachmentTray items={tray.items} errors={tray.errors} onRemove={tray.remove} layout={tray.layout} onLayoutChange={tray.setLayout} />
					)}
					<div class="row" style={{ "--gap": "var(--space-s)", "--align": "center" }}>
						<input ref={fileInputRef} type="file" multiple style={{ display: "none" }} onChange={(e) => { tray.addFiles(e.currentTarget.files); e.currentTarget.value = ""; }} />
						<button type="button" onClick={() => fileInputRef.current?.click()}>
							<IconPaperclip /> {t("channel.composer.attachButton")}
						</button>
						<button type="button" onClick={() => setFilePickerOpen(true)}>
							<IconFolder /> {t("channel.composer.attachFromStorageButton")}
						</button>
						<button type="submit" disabled={busy || emptyPost || plainTooLong || sourceTooLong || tray.items.some((item) => item.error)}>
							<IconSend /> {busy ? t("channel.composer.publishingButton") : t("channel.composer.publishButton")}
						</button>
						<button type="button" onClick={onCancel} disabled={busy}>
							<IconCross /> {t("common.cancel")}
						</button>
					</div>
				</div>
			</div>
		</form>
		{filePickerOpen && <FilePicker predicate={() => true} multiple={false} onSelect={handleAttachmentFromStorage} onCancel={() => setFilePickerOpen(false)} />}
		</>
	);
}

export function PostEditForm({ post, ownerPubkey, privKey, dbKey, limiter, onSaved, onCancel }) {
	const [text, setText] = useState(post.text || "");
	const [title, setTitle] = useState(post.title || "");
	const [kept, setKept] = useState(() => [...(post.attachments ?? [])]);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const tray = useAttachmentTray({ maxItems: Math.max(0, MAX_ATTACHMENTS_PER_MESSAGE - kept.length) });
	const fileInputRef = useRef(null);
	const [filePickerOpen, setFilePickerOpen] = useState(false);

	const plainLength = text ? toPlainText(parseRich(text)).length : 0;
	const plainTooLong = plainLength > POST_MAX_LENGTH;
	const sourceTooLong = text.length > POST_SOURCE_MAX_LENGTH;
	const totalAttachments = kept.length + tray.items.length;
	const emptyPost = text.length === 0 && totalAttachments < 2;

	async function handleSubmit(e) {
		e.preventDefault();
		if (busy || emptyPost || plainTooLong || sourceTooLong) return;
		if (tray.items.some((item) => item.error)) return;
		if (!limiter.tryAction("post")) {
			setError(t("common.rateLimitError"));
			return;
		}
		setBusy(true);
		setError("");
		try {
			const added = tray.items.length > 0 ? await tray.uploadAll(privKey) : [];
			await editPost(ownerPubkey, privKey, dbKey, post.id, { text, attachments: [...kept, ...added], title: title.trim() || null }, publish);
			onSaved();
		} catch (err) {
			setError(errorMessage(err));
		} finally {
			setBusy(false);
		}
	}

	async function handleAttachmentFromStorage([nodeId]) {
		setFilePickerOpen(false);
		const node = projected.value.nodes.get(nodeId);
		if (!node || node.kind !== "file") return;
		try {
			const manifest = await getManifest(node.blob, { serverUrl: BLOSSOM_SERVER_URL });
			const fileKey = await getFileKeyFor(node.blob);
			if (!fileKey) {
				setError(t("chat.window.fileKeyNotFoundError"));
				return;
			}
			tray.addFromStorage([{ manifestDigest: node.blob, fileKey, manifest }]);
		} catch (err) {
			setError(errorMessage(err));
		}
	}

	return (
		<>
		<form class="composer-card box stack" onSubmit={handleSubmit} style={{ "--gap": "var(--space-s)", "--pad": "var(--space-s)" }}>
			{error && (
				<p role="alert" style={{ color: "var(--bad)" }}>
					{error}
				</p>
			)}
			<div class="stack" style={{ "--gap": "var(--space-3xs)" }}>
				<label for="edit-post-title">{t("channel.composer.titleLabel")}</label>
				<input id="edit-post-title" type="text" value={title} onInput={(e) => setTitle(e.currentTarget.value)} />
			</div>
			<label class="visually-hidden" for="edit-post-text">
				{t("channel.composer.postTextLabel")}
			</label>
			<PostEditor initialSource={post.text || ""} onChange={setText} />
			{(plainTooLong || sourceTooLong) && (
				<p role="alert" style={{ color: "var(--bad)" }}>
					{t("channel.composer.tooLongError", { max: POST_MAX_LENGTH })}
				</p>
			)}
			{kept.length > 0 && (
				<ul class="stack" style={{ "--gap": "var(--space-2xs)", listStyle: "none", padding: 0, margin: 0 }}>
					{kept.map((a, i) => (
						<li key={a.manifestDigest || i} class="bar" style={{ "--gap": "var(--space-2xs)", "--align": "center" }}>
							<span class="truncate grow">{a.name || a.mime || t("postCard.noTextFallback")}</span>
							<button type="button" class="icon-btn" onClick={() => setKept((prev) => prev.filter((_, j) => j !== i))} aria-label={t("common.delete")}>
								<IconCross />
							</button>
						</li>
					))}
				</ul>
			)}
			{(tray.items.length > 0 || tray.errors.length > 0) && (
				<AttachmentTray items={tray.items} errors={tray.errors} onRemove={tray.remove} layout={tray.layout} onLayoutChange={tray.setLayout} />
			)}
			<div class="row" style={{ "--gap": "var(--space-s)", "--align": "center" }}>
				<input ref={fileInputRef} type="file" multiple style={{ display: "none" }} onChange={(e) => { tray.addFiles(e.currentTarget.files); e.currentTarget.value = ""; }} />
				<button type="button" onClick={() => fileInputRef.current?.click()}>
					<IconPaperclip /> {t("channel.composer.attachButton")}
				</button>
				<button type="button" onClick={() => setFilePickerOpen(true)}>
					<IconFolder /> {t("channel.composer.attachFromStorageButton")}
				</button>
				<button type="submit" disabled={busy || emptyPost || plainTooLong || sourceTooLong || tray.items.some((item) => item.error)}>
					<IconSend /> {busy ? t("common.saving") : t("common.save")}
				</button>
				<button type="button" onClick={onCancel} disabled={busy}>
					<IconCross /> {t("common.cancel")}
				</button>
			</div>
		</form>
		{filePickerOpen && <FilePicker predicate={() => true} multiple={false} onSelect={handleAttachmentFromStorage} onCancel={() => setFilePickerOpen(false)} />}
		</>
	);
}

export function CommentComposer({ ownerPubkey, privKey, dbKey, channelId, postId, parentId, limiter, onSubmitted, onCancel, autoFocus }) {
	const [text, setText] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const tray = useAttachmentTray({ maxItems: MAX_ATTACHMENTS_PER_MESSAGE });
	const voice = useVoiceRecording();
	const textareaRef = useRef(null);
	const author = commentAuthorInfo(ownerPubkey);
	useEffect(() => {
		ensureProfilesFetched([ownerPubkey], fetchProfiles).catch(() => {});
	}, [ownerPubkey]);

	async function handleSubmit(e) {
		e.preventDefault();
		if (busy || (text.length === 0 && tray.items.length === 0 && !voice.hasRecording)) return;
		if (tray.items.some((item) => item.error)) return;
		if (!limiter.tryAction("comment")) {
			setError(t("common.rateLimitError"));
			return;
		}
		setBusy(true);
		setError("");
		try {
			let attachments = [];
			if (tray.items.length > 0) attachments = await tray.uploadAll(privKey);
			else if (voice.hasRecording) {
				const descriptor = await voice.buildAttachment(privKey);
				if (descriptor) attachments = [descriptor];
			}
			await addComment(ownerPubkey, privKey, dbKey, channelId, postId, parentId, text, attachments, publish);
			// Живой фидбег: найден попутно — текст не очищался после успешной
			// отправки (setText("") не звалось нигде), в отличие от остальных
			// композиторов (PostComposer/ChatComposer/ChannelComposer).
			setText("");
			tray.reset();
			voice.reset();
			onSubmitted();
		} catch (err) {
			setError(errorMessage(err));
		} finally {
			setBusy(false);
		}
	}

	// Смайл (EmojiQuickSend) — комментарий сразу, минуя черновик text/tray.
	async function handleSendEmoji(char) {
		if (busy) return;
		if (!limiter.tryAction("comment")) {
			setError(t("common.rateLimitError"));
			return;
		}
		setBusy(true);
		setError("");
		try {
			await addComment(ownerPubkey, privKey, dbKey, channelId, postId, parentId, char, [], publish);
			onSubmitted();
		} catch (err) {
			setError(errorMessage(err));
		} finally {
			setBusy(false);
		}
	}

	return (
		// Живой фидбег: аватар отправителя убран (это всегда сам автор — свой
		// аватар в форме ввода избыточен). Правка "новый блок под полем ввода":
		// прикрепление+форматирование+смайлы переехали в общий .compose-tools
		// (тот же блок, что ChatWindow/ChannelComposer), composer__row теперь
		// несёт только отправить/отменить.
		<form class="composer stack" style={{ "--gap": "var(--space-2xs)" }} onSubmit={handleSubmit} aria-label={t("channel.commentComposer.ariaLabel")}>
			{error && (
				<p role="alert" style={{ color: "var(--bad)" }}>
					{error}
				</p>
			)}
			<label class="visually-hidden" for={`comment-text-${parentId}`}>
				{t("channel.commentComposer.label")}
			</label>
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
				<AttachmentTray items={tray.items} errors={tray.errors} onRemove={tray.remove} layout={tray.layout} onLayoutChange={tray.setLayout} />
			)}
			<VoiceRecordingStatus voice={voice} />
			<div class="compose-tools row" style={{ "--gap": "var(--space-2xs)", "--align": "center" }}>
				<div class="compose-tools__attach row" style={{ "--gap": "var(--space-2xs)" }}>
					<ComposeAttachButtons tray={tray} voice={voice} disabled={busy} onError={setError} />
				</div>
				<MarkdownFormatToolbar textareaRef={textareaRef} value={text} onChange={setText} />
				<div class="compose-tools__emoji">
					<EmojiQuickSend onSend={handleSendEmoji} disabled={busy} />
				</div>
			</div>
			<div class="composer__row row" style={{ "--gap": "var(--space-2xs)", "--align": "center" }}>
				<button type="submit" disabled={busy || (text.length === 0 && tray.items.length === 0 && !voice.hasRecording) || tray.items.some((item) => item.error)}>
					{busy ? t("channel.commentComposer.sendingButton") : t("common.send")}
				</button>
				{onCancel && (
					<button type="button" class="btn--ghost" onClick={onCancel} disabled={busy}>
						{t("common.cancel")}
					</button>
				)}
			</div>
		</form>
	);
}
