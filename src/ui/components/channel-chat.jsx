import { useState, useEffect, useRef } from "preact/hooks";
import { sendChannelMessage } from "../../domain/content/channel-chat.js";
import { loadChannelChatWindow } from "../../core/sync/lazy-channel.js";
import { publish, fetchProfiles } from "../signals/transport.js";
import { markChannelAsRead } from "../../domain/content/channel-read-status.js";
import { refreshUnreadChannelsCount } from "../signals/notifications.js";
import { messagingActivity } from "../signals/chats.js";
import { ensureProfilesFetched } from "../signals/contacts.js";
import { useAttachmentTray } from "../hooks/use-attachment-tray.js";
import { MAX_ATTACHMENTS_PER_MESSAGE } from "../../domain/files/attachment-validation.js";
import AttachmentTray from "./media/attachment-tray.jsx";
import AttachmentView from "./attachment-view.jsx";
import { splitBubbleAttachments } from "./message-bubble-attachments.js";
import { openMedia } from "../signals/media.js";
import { collectChatScope, findRefPosition } from "../../domain/media/scope.js";
import { refFromAttachment, classOf } from "../../domain/media/media-ref.js";
import { buildPlaylist } from "../../domain/media/playlist.js";
import { getManifest } from "../../domain/files/content.js";
import { getFileKeyFor, projected } from "../signals/files.js";
import { BUILD_DEFAULT_BLOSSOM_SERVERS } from "../../config.js";
import FilePicker from "./file-picker.jsx";
import IconPaperclip from "../icons/paperclip.jsx";
import IconFolder from "../icons/folder.jsx";
import { ContactIdentity } from "../screens/contacts.jsx";
import ModerationActions from "./moderation-actions.jsx";
import { formatDateTime } from "./post-card.jsx";
import { t, errorMessage } from "../signals/i18n.js";
import MarkdownView from "./markdown-view.jsx";
import MarkdownFormatToolbar from "./markdown-format-toolbar.jsx";

const MESSAGE_MAX_LENGTH = 4000; // тот же лимит, что комментарии (этап 31)
const BLOSSOM_SERVER_URL = BUILD_DEFAULT_BLOSSOM_SERVERS[0];

function ChatComposer({ ownerPubkey, privKey, dbKey, channelId, allowAttachments, limiter, onSent }) {
	const [text, setText] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const tray = useAttachmentTray({ maxItems: MAX_ATTACHMENTS_PER_MESSAGE });
	const fileInputRef = useRef(null);
	const textareaRef = useRef(null);
	// Редизайн интерфейса, этап 9 (CONTRACTS.md) — вставка файла из хранилища,
	// 1:1 перенесено из chat.jsx (handleAttachmentFromStorage).
	const [filePickerOpen, setFilePickerOpen] = useState(false);

	async function handleSubmit(e) {
		e.preventDefault();
		if (busy || text.length === 0) return;
		if (tray.items.some((item) => item.error)) return;
		if (!limiter.tryAction("chat")) {
			setError(t("common.rateLimitError"));
			return;
		}
		setBusy(true);
		setError("");
		try {
			const attachments = tray.items.length > 0 ? await tray.uploadAll(privKey) : [];
			await sendChannelMessage(ownerPubkey, privKey, dbKey, channelId, text, attachments, publish);
			setText("");
			tray.reset();
			onSent();
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
		<form class="stack" onSubmit={handleSubmit} style={{ "--gap": "var(--space-3xs)" }}>
			{error && (
				<p role="alert" style={{ color: "var(--bad)" }}>
					{error}
				</p>
			)}
			<label class="visually-hidden" for="channel-chat-text">
				{t("channelChat.messageLabel")}
			</label>
			<MarkdownFormatToolbar textareaRef={textareaRef} value={text} onChange={setText} />
			<textarea id="channel-chat-text" ref={textareaRef} value={text} maxLength={MESSAGE_MAX_LENGTH} onInput={(e) => setText(e.currentTarget.value)} rows={2} />
			{(tray.items.length > 0 || tray.errors.length > 0) && (
				<AttachmentTray items={tray.items} errors={tray.errors} onRemove={tray.remove} onPositionChange={tray.setPosition} />
			)}
			<div class="row" style={{ "--gap": "var(--space-s)", alignItems: "center" }}>
				{allowAttachments && (
					<>
						<input ref={fileInputRef} type="file" multiple style={{ display: "none" }} onChange={(e) => { tray.addFiles(e.currentTarget.files); e.currentTarget.value = ""; }} />
						<button type="button" class="message-compose-tool-btn row" onClick={() => fileInputRef.current?.click()} aria-label={t("chat.window.attachFileAria")}>
							<IconPaperclip />
						</button>
						<button type="button" class="message-compose-tool-btn row" onClick={() => setFilePickerOpen(true)} aria-label={t("channelChat.attachFromStorageAria")}>
							<IconFolder />
						</button>
					</>
				)}
				<button type="submit" disabled={busy || text.length === 0 || tray.items.some((item) => item.error)}>
					{busy ? t("channel.commentComposer.sendingButton") : t("common.send")}
				</button>
			</div>
		</form>
		{filePickerOpen && <FilePicker predicate={() => true} multiple={false} onSelect={handleAttachmentFromStorage} onCancel={() => setFilePickerOpen(false)} />}
		</>
	);
}

// Общий чат канала (этап 32) — плоская лента, свежие внизу (тот же принцип отображения,
// что личные чаты, chat.jsx), не дерево (в отличие от комментариев).
export default function ChannelChat({ ownerPubkey, privKey, dbKey, channelId, channelOwnerPubkey, canWrite, allowAttachments, limiter, onSlicesChange }) {
	const [messages, setMessages] = useState([]);
	const [hasMore, setHasMore] = useState(false);
	const [error, setError] = useState("");
	const bottomRef = useRef(null);
	const pendingScrollRef = useRef(false);

	async function refresh() {
		const { messages: fresh, hasMore: more } = await loadChannelChatWindow(ownerPubkey, dbKey, channelId, { limit: 15 });
		setMessages(fresh);
		setHasMore(more);
		pendingScrollRef.current = true;
		// Этап 47 — тот же общий курсор канала, что channel.jsx (посты) — см. комментарий там.
		if (fresh.length > 0) {
			const lastCreatedAt = Math.max(...fresh.map((m) => m.createdAt));
			markChannelAsRead(ownerPubkey, privKey, channelId, lastCreatedAt, publish)
				.then(() => refreshUnreadChannelsCount(ownerPubkey, dbKey))
				.catch(() => {});
		}
		// Найдено пользователем: авторы чата канала могут не быть контактами — профиль
		// (никнейм/аватар) всё равно нужен, ensureProfilesFetched не ограничен контактами.
		const authors = [...new Set(fresh.map((m) => m.authorPubkey))];
		ensureProfilesFetched(authors, fetchProfiles).catch(() => {});
	}

	useEffect(() => {
		refresh().catch((e) => setError(errorMessage(e)));
	}, [ownerPubkey, channelId, messagingActivity.value]);

	useEffect(() => {
		if (pendingScrollRef.current && messages.length > 0) {
			bottomRef.current?.scrollIntoView({ block: "end" });
			pendingScrollRef.current = false;
		}
	}, [messages]);

	async function handleLoadMore() {
		if (messages.length === 0) return;
		const { messages: older, hasMore: more } = await loadChannelChatWindow(ownerPubkey, dbKey, channelId, { limit: 15, beforeCreatedAt: messages[0].createdAt });
		setMessages((prev) => [...older, ...prev]);
		setHasMore(more);
	}

	// Этап F, F1/F2 (CONTRACTS.md/DESIGN.md "Этап F") — та же схема, что
	// chat.jsx, messages уже в локальном состоянии этого компонента.
	function openAttachment(message, attachment) {
		const refs = collectChatScope(messages);
		const target = refFromAttachment(attachment, { msgId: message.id });
		const position = findRefPosition(refs, target.digest, target.sourceMeta);
		if (position === -1) return;
		openMedia({ refs, position });
	}

	// Редизайн интерфейса, этап 3 (CONTRACTS.md) — тот же паттерн, что
	// chat.jsx's classesInMessages/openChatMediaClass, включая класс "other".
	// messages — состояние ЭТОГО компонента, наружу (channel.jsx, слот
	// Screen's slices) не поднимается — сообщается через onSlicesChange
	// (тот же приём, что onCountChange у PostWithComments).
	function classesInMessages() {
		const present = { audio: false, video: false, image: false, other: false };
		for (const ref of collectChatScope(messages)) {
			const c = classOf(ref.mime);
			if (c in present) present[c] = true;
		}
		return present;
	}

	function openChannelChatMediaClass(cls) {
		const refs = collectChatScope(messages);
		const playlist = buildPlaylist(refs);
		const position = playlist.idx[cls]?.[0];
		if (position === undefined) return;
		openMedia({ refs, position });
	}

	useEffect(() => {
		onSlicesChange?.({ counts: classesInMessages(), onOpen: openChannelChatMediaClass });
	}, [messages]);

	return (
		<div class="stack" style={{ "--gap": "var(--space-s)" }}>
			{error && (
				<p role="alert" style={{ color: "var(--bad)" }}>
					{error}
				</p>
			)}
			{hasMore && (
				<button type="button" onClick={handleLoadMore}>
					{t("chat.window.loadOlderButton")}
				</button>
			)}
			{messages.length === 0 ? (
				<p style={{ color: "var(--muted)" }}>{t("channelChat.noMessages")}</p>
			) : (
				<ul role="list" style={{ listStyle: "none", paddingInlineStart: 0, "--gap": "var(--space-m)" }} class="stack">
					{messages.map((m) => {
						const { above, below } = splitBubbleAttachments(m.attachments);
						return (
							<li key={m.id} class="channel-message-row">
								<div class="row" style={{ "--gap": "var(--space-s)", alignItems: "center" }}>
									<ContactIdentity pubkey={m.authorPubkey} />
									<small style={{ color: "var(--muted)" }}>{formatDateTime(m.createdAt)}</small>
									{m.authorPubkey !== ownerPubkey && (
										<ModerationActions
											compact
											viewerPubkey={ownerPubkey}
											viewerPrivKey={privKey}
											channelOwnerPubkey={channelOwnerPubkey}
											channelId={channelId}
											targetPubkey={m.authorPubkey}
											contentType="chat_message"
											contentId={m.id}
											contentText={m.text}
										/>
									)}
								</div>
								{above && <AttachmentView attachment={above} onOpen={(a) => openAttachment(m, a)} origin={{ kind: "channelMessage", id: m.id }} />}
								<MarkdownView source={m.text} profile="lite" />
								{below.map((a, i) => (
									<AttachmentView key={i} attachment={a} onOpen={(a) => openAttachment(m, a)} origin={{ kind: "channelMessage", id: m.id }} />
								))}
							</li>
						);
					})}
				</ul>
			)}
			<div ref={bottomRef} />
			{canWrite ? (
				<ChatComposer ownerPubkey={ownerPubkey} privKey={privKey} dbKey={dbKey} channelId={channelId} allowAttachments={allowAttachments} limiter={limiter} onSent={refresh} />
			) : (
				<p style={{ color: "var(--muted)" }}>{t("channelChat.readOnlyNotice")}</p>
			)}
		</div>
	);
}
