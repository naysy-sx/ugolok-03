import { useRef, useState } from "preact/hooks";
import { sendChannelMessage } from "../../domain/content/channel-chat.js";
import { publish } from "../signals/transport.js";
import { bumpMessagingActivity } from "../signals/chats.js";
import { useAttachmentTray } from "../hooks/use-attachment-tray.js";
import { useVoiceRecording } from "../hooks/use-voice-recording.js";
import { MAX_ATTACHMENTS_PER_MESSAGE } from "../../domain/files/attachment-validation.js";
import AttachmentTray from "./media/attachment-tray.jsx";
import { ComposeAttachButtons, VoiceRecordingStatus } from "./compose-attach-tools.jsx";
import IconSend from "../icons/send.jsx";
import MarkdownFormatToolbar from "./markdown-format-toolbar.jsx";
import EmojiQuickSend from "./emoji-quick-send.jsx";
import { t, errorMessage } from "../signals/i18n.js";

const MESSAGE_MAX_LENGTH = 4000; // тот же лимит, что комментарии (этап 31)

// CHANNEL-V2 часть E1 — композитор общего чата вынесен из channel-chat.jsx
// (та теперь только лента) в отдельный файл: собирается в подвале Screen
// (channel.jsx), не последним элементом прокручиваемой ленты — в длинном
// чате раньше приходилось доскроллить до поля ввода. РАЗВИЛКА (ТЗ E1):
// выбран этот вариант (не колбэк-с-нодой) — onSlicesChange уже показал,
// что такой приём плохо читается. refresh() ленты отдельно наверх не
// поднимаем: отправка бампает messagingActivity, ChannelChat и так
// перечитывает окно по этому сигналу (тот же приём, что реакции/действия
// на странице записи, channel-post-page.jsx). Живой фидбег (визуальная
// правка) — MarkdownFormatToolbar вернулся в отдельный .compose-tools блок
// ПОД полем ввода (тот же блок несёт прикрепление и смайлы, EmojiQuickSend):
// исходное решение E1 не заводить третью строку ради панели форматирования
// снято тем же блоком, который решает и вопрос места для смайлов.
export default function ChannelComposer({ ownerPubkey, privKey, dbKey, channelId, canWrite, allowAttachments, limiter }) {
	const [text, setText] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const tray = useAttachmentTray({ maxItems: MAX_ATTACHMENTS_PER_MESSAGE });
	const voice = useVoiceRecording();
	const textareaRef = useRef(null);

	async function handleSubmit(e) {
		e.preventDefault();
		if (busy || (text.length === 0 && tray.items.length === 0 && !voice.hasRecording)) return;
		if (tray.items.some((item) => item.error)) return;
		if (!limiter.tryAction("chat")) {
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
			await sendChannelMessage(ownerPubkey, privKey, dbKey, channelId, text, attachments, publish);
			setText("");
			tray.reset();
			voice.reset();
			bumpMessagingActivity();
		} catch (err) {
			setError(errorMessage(err));
		} finally {
			setBusy(false);
		}
	}

	// Смайл (EmojiQuickSend) — сообщение сразу, минуя черновик text/tray.
	async function handleSendEmoji(char) {
		if (busy) return;
		if (!limiter.tryAction("chat")) {
			setError(t("common.rateLimitError"));
			return;
		}
		setBusy(true);
		setError("");
		try {
			await sendChannelMessage(ownerPubkey, privKey, dbKey, channelId, char, [], publish);
			bumpMessagingActivity();
		} catch (err) {
			setError(errorMessage(err));
		} finally {
			setBusy(false);
		}
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
				<VoiceRecordingStatus voice={voice} />
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
					<button type="submit" class="btn--primary rigid" disabled={busy || (text.length === 0 && tray.items.length === 0 && !voice.hasRecording) || tray.items.some((item) => item.error)}>
						<IconSend /> {busy ? t("channel.commentComposer.sendingButton") : t("common.send")}
					</button>
				</div>
				<div class="compose-tools row" style={{ "--gap": "var(--space-2xs)", "--align": "center" }}>
					{allowAttachments && (
						<div class="compose-tools__attach row" style={{ "--gap": "var(--space-2xs)" }}>
							<ComposeAttachButtons tray={tray} voice={voice} disabled={busy} onError={setError} />
						</div>
					)}
					<MarkdownFormatToolbar textareaRef={textareaRef} value={text} onChange={setText} />
					<div class="compose-tools__emoji">
						<EmojiQuickSend onSend={handleSendEmoji} disabled={busy} />
					</div>
				</div>
			</form>
		</>
	);
}
