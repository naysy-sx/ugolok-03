import { useState } from "preact/hooks";
import AttachmentView, { AttachmentDownloadLink, AttachmentSaveButton } from "./attachment-view.jsx";
import { t, currentLocale } from "../signals/i18n.js";
import MarkdownView from "./markdown-view.jsx";
import StickerView from "./sticker-view.jsx";
import { parseStickerKey } from "../../domain/content/sticker.js";
import { planBubbleAttachments } from "./bubble-attachment-plan.js";
import BubbleAttachmentCluster, { BubbleFileChips } from "./bubble-attachment-cluster.jsx";
import ActionsMenu from "./actions-menu.jsx";
import IconPencil from "../icons/pencil.jsx";
import IconTrash from "../icons/trash.jsx";
import IconCheck from "../icons/check.jsx";
import { resolveStatusLabelKey, resolveReceiptKind } from "./message-bubble-status.js";

function ReceiptTicks({ kind }) {
	if (kind === "queued" || kind === "sending") {
		return (
			<span class="message-receipt" data-kind={kind} aria-hidden="true">
				<svg class="icon" viewBox="0 0 256 256" width="1em" height="1em" fill="currentColor">
					<path d="M128,24A104,104,0,1,0,232,128,104.11,104.11,0,0,0,128,24Zm0,192a88,88,0,1,1,88-88A88.1,88.1,0,0,1,128,216Zm64-88a8,8,0,0,1-8,8H128a8,8,0,0,1-8-8V72a8,8,0,0,1,16,0v48h48A8,8,0,0,1,192,128Z" />
				</svg>
			</span>
		);
	}
	if (kind === "failed") {
		return (
			<span class="message-receipt" data-kind={kind} aria-hidden="true">
				<svg class="icon" viewBox="0 0 256 256" width="1em" height="1em" fill="currentColor">
					<path d="M128,24A104,104,0,1,0,232,128,104.11,104.11,0,0,0,128,24Zm-8,56a8,8,0,0,1,16,0v56a8,8,0,0,1-16,0Zm8,104a12,12,0,1,1,12-12A12,12,0,0,1,128,184Z" />
				</svg>
			</span>
		);
	}
	if (kind === "sent" || kind === "delivered" || kind === "read") {
		return (
			<span class="message-receipt" data-kind={kind} aria-hidden="true">
				<IconCheck />
				{(kind === "delivered" || kind === "read") && <IconCheck />}
			</span>
		);
	}
	return null;
}

function formatTimestamp(sentAt) {
	if (typeof sentAt !== "number") return null;
	return new Date(sentAt * 1000).toLocaleTimeString(currentLocale.value, { hour: "2-digit", minute: "2-digit" });
}

export default function MessageBubble({ message, isOwn, onDeleteForMe, onDeleteForBoth, onEdit, maxLength, senderName, onOpenAttachment, originKind = "message", pendingAcceptance = false, deliveredUpTo = 0, readUpTo = 0 }) {
	const [mode, setMode] = useState(null);
	const [editText, setEditText] = useState(message.text);

	const bubbleClass = `message-bubble stack box ${isOwn ? "message-bubble-own self-end" : "message-bubble-other self-start"}`;
	const bubbleStyle = { "--gap": "var(--space-3xs)", "--pad": "var(--space-2xs)" };

	if (message.deleted) {
		return (
			<div class={`${bubbleClass} message-bubble-deleted`} style={bubbleStyle}>
				{senderName && <small class="message-bubble-sender">{senderName}</small>}
				<p>{t("message.deletedNotice")}</p>
			</div>
		);
	}

	const receiptKind = resolveReceiptKind({
		status: message.status,
		pendingAcceptance,
		lamportTs: message.lamportTs,
		deliveredUpTo,
		readUpTo,
	});
	const statusLabelKey = resolveStatusLabelKey(message.status, pendingAcceptance, { lamportTs: message.lamportTs, deliveredUpTo, readUpTo });
	const statusLabel = statusLabelKey ? t(statusLabelKey) : undefined;
	const timestamp = formatTimestamp(message.sentAt);
	const plan = planBubbleAttachments(message.attachments);
	const origin = { kind: originKind, id: message.id };
	const open = (a) => onOpenAttachment?.(message, a);
	const attachments = message.attachments ?? [];
	const hasMenu = attachments.length > 0 || (isOwn && typeof onEdit === "function") || typeof onDeleteForMe === "function";

	if (mode === "editing") {
		return (
			<div class={bubbleClass} style={bubbleStyle}>
				<textarea value={editText} maxLength={maxLength} rows={2} onInput={(e) => setEditText(e.currentTarget.value)} />
				<footer class="row" style={{ "--gap": "var(--space-s)", "--align": "center" }}>
					<button
						type="button"
						disabled={editText.length === 0}
						onClick={() => {
							setMode(null);
							onEdit(message.msgId, editText);
						}}
					>
						{t("common.save")}
					</button>
					<button
						type="button"
						onClick={() => {
							setMode(null);
							setEditText(message.text);
						}}
					>
						{t("common.cancel")}
					</button>
				</footer>
			</div>
		);
	}

	return (
		<div class={bubbleClass} style={bubbleStyle}>
			{senderName && <small class="message-bubble-sender">{senderName}</small>}
			<BubbleAttachmentCluster plan={plan} onOpen={open} />
			{message.text && (parseStickerKey(message.text) ? <StickerView text={message.text} /> : <MarkdownView source={message.text} profile="lite" />)}
			<BubbleFileChips plan={plan} onOpen={open} />
			{plan.voices.map((a, i) => (
				<AttachmentView key={`voice-${i}`} attachment={a} />
			))}
			<footer class="row message-bubble-meta" style={{ "--gap": "var(--space-s)", "--align": "center" }}>
				{timestamp && <small>{timestamp}</small>}
				{isOwn && receiptKind === "awaitingAcceptance" && statusLabel && <small>{statusLabel}</small>}
				{isOwn && receiptKind && receiptKind !== "awaitingAcceptance" && (
					<span class="message-receipt-wrap" title={statusLabel}>
						<ReceiptTicks kind={receiptKind} />
					</span>
				)}
				{message.edited && <small>{t("message.editedLabel")}</small>}
				{mode !== "confirming-delete" && hasMenu && (
					<ActionsMenu label={t("attachment.actionsMenuAria")} popClass="menu-pop--bubble">
						{attachments.map((a, i) => (
							<AttachmentDownloadLink key={`dl-${i}`} attachment={a} menu />
						))}
						{attachments.map((a, i) => (
							<AttachmentSaveButton key={`sv-${i}`} attachment={a} origin={origin} menu />
						))}
						{isOwn && typeof onEdit === "function" && (
							<button type="button" onClick={() => setMode("editing")}>
								<IconPencil /> {t("message.editButton")}
							</button>
						)}
						{typeof onDeleteForMe === "function" && (
							<button type="button" class="danger" onClick={() => setMode("confirming-delete")}>
								<IconTrash /> {t("common.delete")}
							</button>
						)}
					</ActionsMenu>
				)}
				{mode === "confirming-delete" && (
					<>
						<button
							type="button"
							class="btn--ghost btn--danger"
							onClick={() => {
								setMode(null);
								onDeleteForMe(message.msgId);
							}}
						>
							{t("message.deleteForMeButton")}
						</button>
						{isOwn && typeof onDeleteForBoth === "function" && (
							<button
								type="button"
								class="btn--ghost btn--danger"
								onClick={() => {
									setMode(null);
									onDeleteForBoth(message.msgId);
								}}
							>
								{t("message.deleteForBothButton")}
							</button>
						)}
						<button type="button" onClick={() => setMode(null)}>
							{t("common.cancel")}
						</button>
					</>
				)}
			</footer>
		</div>
	);
}
