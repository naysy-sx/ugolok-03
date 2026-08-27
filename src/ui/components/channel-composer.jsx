import { useRef, useState } from "preact/hooks";
import { sendChannelMessage } from "../../domain/content/channel-chat.js";
import { publish } from "../signals/transport.js";
import { bumpMessagingActivity } from "../signals/chats.js";
import { useAttachmentTray } from "../hooks/use-attachment-tray.js";
import { MAX_ATTACHMENTS_PER_MESSAGE } from "../../domain/files/attachment-validation.js";
import { getManifest } from "../../domain/files/content.js";
import { getFileKeyFor, projected } from "../signals/files.js";
import { BUILD_DEFAULT_BLOSSOM_SERVERS } from "../../config.js";
import AttachmentTray from "./media/attachment-tray.jsx";
import FilePicker from "./file-picker.jsx";
import IconPaperclip from "../icons/paperclip.jsx";
import IconFolder from "../icons/folder.jsx";
import IconSend from "../icons/send.jsx";
import { t, errorMessage } from "../signals/i18n.js";

const MESSAGE_MAX_LENGTH = 4000; // тот же лимит, что комментарии (этап 31)
const BLOSSOM_SERVER_URL = BUILD_DEFAULT_BLOSSOM_SERVERS[0];

// CHANNEL-V2 часть E1 — композитор общего чата вынесен из channel-chat.jsx
// (та теперь только лента) в отдельный файл: собирается в подвале Screen
// (channel.jsx), не последним элементом прокручиваемой ленты — в длинном
// чате раньше приходилось доскроллить до поля ввода. РАЗВИЛКА (ТЗ E1):
// выбран этот вариант (не колбэк-с-нодой) — onSlicesChange уже показал,
// что такой приём плохо читается. refresh() ленты отдельно наверх не
// поднимаем: отправка бампает messagingActivity, ChannelChat и так
// перечитывает окно по этому сигналу (тот же приём, что реакции/действия
// на странице записи, channel-post-page.jsx). MarkdownFormatToolbar
// намеренно убран (см. E1 в ТЗ) — в закреплённом подвале постоянная панель
// форматирования занимает третью строку ради того, чем в чате почти не
// пользуются; в композиторе поста (PostComposer) она остаётся.
export default function ChannelComposer({ ownerPubkey, privKey, dbKey, channelId, canWrite, allowAttachments, limiter }) {
	const [text, setText] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const tray = useAttachmentTray({ maxItems: MAX_ATTACHMENTS_PER_MESSAGE });
	const fileInputRef = useRef(null);
	const textareaRef = useRef(null);
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
			bumpMessagingActivity();
		} catch (err) {
			setError(errorMessage(err));
		} finally {
			setBusy(false);
		}
	}

	async function handleAttachmentFromStorage(ids) {
		setFilePickerOpen(false);
		if (!ids || ids.length === 0) return;
		if (!window.confirm(t("chat.window.sendAttachmentConfirm"))) return;
		const refs = [];
		let lastError = "";
		for (const id of ids) {
			const node = projected.value.nodes.get(id);
			if (!node || node.kind !== "file") continue;
			try {
				const manifest = await getManifest(node.blob, { serverUrl: BLOSSOM_SERVER_URL });
				const fileKey = await getFileKeyFor(node.blob);
				if (!fileKey) {
					lastError = t("chat.window.fileKeyNotFoundError");
					continue;
				}
				refs.push({ manifestDigest: node.blob, fileKey, manifest });
			} catch (err) {
				lastError = errorMessage(err);
			}
		}
		if (lastError) setError(lastError);
		if (refs.length === 0) return;
		tray.addFromStorage(refs);
	}

	if (!canWrite) {
		return <p class="readonly-notice">{t("channelChat.readOnlyNotice")}</p>;
	}

	return (
		<>
			<form class="composer stack" onSubmit={handleSubmit} style={{ "--gap": "var(--space-2xs)" }}>
				{error && (
					<p role="alert" style={{ color: "var(--bad)" }}>
						{error}
					</p>
				)}
				{(tray.items.length > 0 || tray.errors.length > 0) && (
					<AttachmentTray items={tray.items} errors={tray.errors} onRemove={tray.remove} layout={tray.layout} onLayoutChange={tray.setLayout} />
				)}
				<label class="visually-hidden" for="channel-chat-text">
					{t("channelChat.messageLabel")}
				</label>
				<div class="composer__field bar" style={{ "--gap": "var(--space-2xs)", "--align": "end" }}>
					<textarea
						id="channel-chat-text"
						ref={textareaRef}
						class="grow"
						value={text}
						maxLength={MESSAGE_MAX_LENGTH}
						rows={1}
						placeholder={t("channelChat.placeholder")}
						onInput={(e) => setText(e.currentTarget.value)}
					/>
					<div class="composer__tools bar rigid" style={{ "--gap": "var(--space-3xs)", "--align": "center" }}>
						{allowAttachments && (
							<>
								<input ref={fileInputRef} type="file" multiple style={{ display: "none" }} onChange={(e) => { tray.addFiles(e.currentTarget.files); e.currentTarget.value = ""; }} />
								<button type="button" class="message-compose-tool-btn" onClick={() => fileInputRef.current?.click()} aria-label={t("chat.window.attachFileAria")}>
									<IconPaperclip />
								</button>
								<button type="button" class="message-compose-tool-btn" onClick={() => setFilePickerOpen(true)} aria-label={t("channelChat.attachFromStorageAria")}>
									<IconFolder />
								</button>
							</>
						)}
						<button type="submit" class="btn--primary" disabled={busy || text.length === 0 || tray.items.some((item) => item.error)}>
							<IconSend /> {busy ? t("channel.commentComposer.sendingButton") : t("common.send")}
						</button>
					</div>
				</div>
			</form>
			{filePickerOpen && <FilePicker predicate={() => true} multiple={true} onSelect={handleAttachmentFromStorage} onCancel={() => setFilePickerOpen(false)} />}
		</>
	);
}
