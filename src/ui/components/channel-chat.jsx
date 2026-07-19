import { useState, useEffect, useRef } from "preact/hooks";
import { sendChannelMessage } from "../../domain/content/channel-chat.js";
import { loadChannelChatWindow } from "../../core/sync/lazy-channel.js";
import { publish, fetchProfiles } from "../signals/transport.js";
import { messagingActivity } from "../signals/chats.js";
import { ensureProfilesFetched } from "../signals/contacts.js";
import { usePendingAttachment, uploadPendingAttachment } from "../hooks/pending-attachment.js";
import AttachmentPreview from "./attachment-preview.jsx";
import AttachmentView from "./attachment-view.jsx";
import { ContactIdentity } from "../screens/contacts.jsx";
import ModerationActions from "./moderation-actions.jsx";
import { formatDateTime } from "./post-card.jsx";

const MESSAGE_MAX_LENGTH = 4000; // тот же лимит, что комментарии (этап 31)

function ChatComposer({ ownerPubkey, privKey, dbKey, channelId, allowAttachments, limiter, onSent }) {
	const [text, setText] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const attachment = usePendingAttachment();

	async function handleSubmit(e) {
		e.preventDefault();
		if (busy || text.length === 0) return;
		if (attachment.file && attachment.error) return;
		if (!limiter.tryAction("chat")) {
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
			await sendChannelMessage(ownerPubkey, privKey, dbKey, channelId, text, attachments, publish);
			setText("");
			attachment.reset();
			onSent();
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
			<label class="visually-hidden" for="channel-chat-text">
				Сообщение в чат канала
			</label>
			<textarea id="channel-chat-text" value={text} maxLength={MESSAGE_MAX_LENGTH} onInput={(e) => setText(e.currentTarget.value)} rows={2} />
			{attachment.file && (
				<AttachmentPreview file={attachment.file} position="below" onPositionChange={() => {}} onRemove={attachment.reset} error={attachment.error} />
			)}
			<div class="cluster">
				{allowAttachments && (
					<>
						<input ref={attachment.inputRef} type="file" style={{ display: "none" }} onChange={attachment.handleSelect} />
						<button type="button" onClick={() => attachment.inputRef.current?.click()}>
							📎
						</button>
					</>
				)}
				<button type="submit" disabled={busy || text.length === 0 || (!!attachment.file && !!attachment.error)}>
					{busy ? "Отправка…" : "Отправить"}
				</button>
			</div>
		</form>
	);
}

// Общий чат канала (этап 32) — плоская лента, свежие внизу (тот же принцип отображения,
// что личные чаты, chat.jsx), не дерево (в отличие от комментариев).
export default function ChannelChat({ ownerPubkey, privKey, dbKey, channelId, channelOwnerPubkey, canWrite, allowAttachments, limiter }) {
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
		// Найдено пользователем: авторы чата канала могут не быть контактами — профиль
		// (никнейм/аватар) всё равно нужен, ensureProfilesFetched не ограничен контактами.
		const authors = [...new Set(fresh.map((m) => m.authorPubkey))];
		ensureProfilesFetched(authors, fetchProfiles).catch(() => {});
	}

	useEffect(() => {
		refresh().catch((e) => setError(e?.message || String(e)));
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

	return (
		<div class="flow" style={{ "--flow-space": "var(--space-s)" }}>
			{error && (
				<p role="alert" style={{ color: "var(--bad, oklch(0.58 0.21 25))" }}>
					{error}
				</p>
			)}
			{hasMore && (
				<button type="button" onClick={handleLoadMore}>
					Загрузить более старые сообщения
				</button>
			)}
			{messages.length === 0 ? (
				<p style={{ color: "var(--muted)" }}>Пока нет сообщений в чате канала.</p>
			) : (
				<ul role="list" style={{ listStyle: "none", paddingInlineStart: 0 }} class="flow">
					{messages.map((m) => (
						<li key={m.id}>
							<div class="cluster" style={{ alignItems: "center" }}>
								<ContactIdentity pubkey={m.authorPubkey} />
								<small style={{ color: "var(--muted)" }}>{formatDateTime(m.createdAt)}</small>
								{m.authorPubkey !== ownerPubkey && (
									<ModerationActions
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
							<p style={{ whiteSpace: "pre-wrap" }}>{m.text}</p>
							{m.attachments?.[0] && <AttachmentView attachment={m.attachments[0]} />}
						</li>
					))}
				</ul>
			)}
			<div ref={bottomRef} />
			{canWrite ? (
				<ChatComposer ownerPubkey={ownerPubkey} privKey={privKey} dbKey={dbKey} channelId={channelId} allowAttachments={allowAttachments} limiter={limiter} onSent={refresh} />
			) : (
				<p style={{ color: "var(--muted)" }}>Только чтение — подпишитесь, чтобы писать в чат.</p>
			)}
		</div>
	);
}
