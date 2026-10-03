import { useState, useEffect } from "preact/hooks";
import { signal } from "@preact/signals";
import AttachmentView from "./attachment-view.jsx";
import { t, currentLocale } from "../signals/i18n.js";
import MarkdownView from "./markdown-view.jsx";
import StickerView from "./sticker-view.jsx";
import { parseStickerKey } from "../../domain/content/sticker.js";
import { planBubbleAttachments } from "./bubble-attachment-plan.js";
import BubbleAttachmentCluster, { BubbleFileChips } from "./bubble-attachment-cluster.jsx";
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

// На сенсорных экранах (hover: none) наведения нет, а кнопки «Изменить»/«Удалить» всё время
// на виду загромождали пузыри. Теперь их показывает тап по тексту или пустому месту пузыря
// (не по вложению, ссылке или кнопке — те делают своё). Раскрыт может быть один пузырь:
// тап по другому или мимо закрывает предыдущий.
const toolsOpenId = signal(null);
const TAP_IGNORE = "a, button, input, textarea, video, audio, img, summary, .bubble-media, .bubble-chips, .bubble-tools";

export default function MessageBubble({ message, isOwn, onDeleteForMe, onDeleteForBoth, onEdit, maxLength, senderName, onOpenAttachment, originKind = "message", pendingAcceptance = false, deliveredUpTo = 0, readUpTo = 0 }) {
	const [mode, setMode] = useState(null);
	const [editText, setEditText] = useState(message.text);
	const toolsOpen = toolsOpenId.value === message.msgId;

	useEffect(() => {
		if (!toolsOpen) return;
		// Тап мимо пузыря закрывает кнопки; тап по самому пузырю разбирает handleBubbleTap.
		function onOutside(e) {
			if (!e.target.closest?.(".message-bubble")) toolsOpenId.value = null;
		}
		document.addEventListener("pointerdown", onOutside);
		return () => document.removeEventListener("pointerdown", onOutside);
	}, [toolsOpen]);

	function handleBubbleTap(e) {
		if (!window.matchMedia?.("(hover: none)").matches) return; // с мышью работает наведение
		if (e.target.closest(TAP_IGNORE)) return;
		if (window.getSelection?.()?.toString()) return; // человек выделяет текст — не мешаем
		toolsOpenId.value = toolsOpen ? null : message.msgId;
	}

	const bubbleClass = `message-bubble msg stack box ${isOwn ? "message-bubble-own msg--out self-end" : "message-bubble-other msg--in self-start"}`;
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
	const open = (a) => onOpenAttachment?.(message, a);

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
		<div class={bubbleClass + (toolsOpen ? " is-tools-open" : "")} style={bubbleStyle} onClick={handleBubbleTap}>
			{/* Действия по наведению (на сенсорных — по тапу на текст пузыря): «Изменить» и «Удалить» —
			    компактные круглые кнопки в верхнем углу пузыря вместо меню «⋯». Скачать и
			    «сохранить к себе» вложения — в полноэкранном просмотре (media-overlay). */}
			{mode !== "confirming-delete" && (typeof onDeleteForMe === "function" || (isOwn && typeof onEdit === "function")) && (
				<div class="bubble-tools">
					{isOwn && typeof onEdit === "function" && (
						<button type="button" class="bubble-tool" onClick={() => setMode("editing")} aria-label={t("message.editButton")} title={t("message.editButton")}>
							<IconPencil />
						</button>
					)}
					{typeof onDeleteForMe === "function" && (
						<button type="button" class="bubble-tool bubble-tool--danger" onClick={() => setMode("confirming-delete")} aria-label={t("common.delete")} title={t("common.delete")}>
							<IconTrash />
						</button>
					)}
				</div>
			)}
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
