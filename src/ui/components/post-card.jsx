import AttachmentView, { CollectionGrid } from "./attachment-view.jsx";
import { splitBubbleAttachments } from "./message-bubble-attachments.js";
import { shortPubkey } from "../format.js";
import ActionsMenu from "./actions-menu.jsx";
import IconChatBubble from "../icons/chat-bubble.jsx";
import IconTrash from "../icons/trash.jsx";
import { t, tPlural, currentLocale } from "../signals/i18n.js";
import { toPreviewText } from "../../core/markdown/preview.js";
import MarkdownView from "./markdown-view.jsx";
import MediaButtons from "./media/media-buttons.jsx";
import { kindOf, attachmentPlacement } from "../../domain/content/record-kind.js";

function formatDateTime(unixSeconds) {
	return new Date(unixSeconds * 1000).toLocaleString(currentLocale.value, { dateStyle: "short", timeStyle: "short" });
}

// Редизайн интерфейса, этап 2 (CONTRACTS.md) — "до 3 сентября": день+месяц,
// без года и времени (сам срок — дата, не момент). Intl сам выбирает
// правильный падеж месяца для локали (родительный для ru — "3 сентября"),
// отдельной таблицы названий месяцев не требуется.
function formatDueDate(unixSeconds) {
	return new Date(unixSeconds * 1000).toLocaleDateString(currentLocale.value, { day: "numeric", month: "long" });
}

const DAY_SECONDS = 86400;

// Чип срока/просрочки — только когда признак реально стоит (dueAt !== null)
// и запись ещё не отмечена выполненной (done === true "гасит" срочность:
// дело сделано, спешить больше некуда). Работает и для "ссылки со сроком"
// (done === null, dueAt непустой) — признаки независимы, REDESIGN-SPEC.md.
function DueChip({ post }) {
	if (post.dueAt === null || post.done === true) return null;
	const nowSeconds = Math.floor(Date.now() / 1000);
	if (post.dueAt < nowSeconds) {
		const daysLate = Math.max(1, Math.ceil((nowSeconds - post.dueAt) / DAY_SECONDS));
		return <span class="rec-chip rec-chip--late">{t("postCard.overdueChip", { count: tPlural("postCard.overdueDays", daysLate) })}</span>;
	}
	return <span class="rec-chip rec-chip--due">{t("postCard.dueChip", { date: formatDueDate(post.dueAt) })}</span>;
}

// Карточка записи ленты канала — REDESIGN-SPEC.md, этап 2: тип выводится
// (record-kind.js, kindOf), не задаётся. Левая колонка — метка типа+время
// (+миниатюра единственного image/video при длинном тексте, правило
// attachmentPlacement); тело — по типу (чекбокс дела / карточка ссылки /
// заголовок статьи / обычный текст) + чипы срока/тегов + owner-действия.
//
// Автора (аватар+имя) карточка НЕ показывает — REDESIGN-SPEC.md/макет его
// не описывают, и это осмысленно: пост в канале ВСЕГДА от одного автора,
// creatorPubkey канала (receivePost, post.js — адверсарная проверка
// event.pubkey !== channelRow.creatorPubkey), показывать его на каждой
// карточке одного и того же канала избыточно. Было — .post__ava/
// .post__ava-fallback/.post__author (custom.css) — теперь мёртвый CSS,
// см. PROCESS-DOCS/REDESIGN-NOTES.md (правило "не рефакторить попутно").
export default function PostCard({
	post,
	isOwner,
	onArchive,
	onUnpublish,
	onDelete,
	onOpenComments,
	commentCount,
	mediaCounts,
	onOpenMediaClass,
	onOpenAttachment,
	onToggleDone,
	onMakeTask,
	onUnmakeTask,
	onSetDue,
	onClearDue,
}) {
	const kind = kindOf(post);
	const placement = attachmentPlacement(post);
	const gutterAttachment = placement === "gutter" ? post.attachments[0] : null;
	const { above, below } = placement === "inline" ? splitBubbleAttachments(post.attachments) : { above: null, below: [] };
	const hasChips = post.dueAt !== null || post.tags.length > 0;

	return (
		<article class="rec">
			<div class="rec__gutter">
				<span class="rec__kind">{t(`recordKind.${kind}`)}</span>
				<span class="rec__time">{formatDateTime(post.createdAt)}</span>
				{gutterAttachment && <AttachmentView attachment={gutterAttachment} onOpen={onOpenAttachment} />}
			</div>
			<div class="rec__body">
				{kind === "task" ? (
					<label class="task">
						<input type="checkbox" checked={post.done === true} onChange={(e) => onToggleDone(e.currentTarget.checked)} />
						<span class="rec__text">
							<MarkdownView source={post.text} profile="rich" />
						</span>
					</label>
				) : kind === "collection" ? (
					<CollectionGrid attachments={post.attachments} onOpen={onOpenAttachment} />
				) : (
					<>
						{above && <AttachmentView attachment={above} onOpen={onOpenAttachment} origin={{ kind: "post", id: post.id }} />}
						<div class="rec__text">
							<MarkdownView source={post.text} profile="rich" />
						</div>
					</>
				)}

				{kind === "link" && (
					<div class="link">
						<div class="link__fav" aria-hidden="true">
							{(post.linkUrl || "?").replace(/^https?:\/\//, "").charAt(0).toUpperCase()}
						</div>
						<div class="link__meta">
							<div class="link__t">{post.title || post.linkUrl}</div>
							<div class="link__d">{post.linkUrl}</div>
						</div>
					</div>
				)}

				{kind === "article" && <h3 class="rec__title">{post.title}</h3>}

				{placement === "inline" &&
					kind !== "collection" &&
					below.map((a, i) => <AttachmentView key={i} attachment={a} onOpen={onOpenAttachment} origin={{ kind: "post", id: post.id }} />)}

				{hasChips && (
					<div class="rec-chips">
						<DueChip post={post} />
						{post.tags.map((tag) => (
							<span class="rec-chip rec-chip--tag" key={tag}>
								{tag}
							</span>
						))}
					</div>
				)}

				<footer class="rec__foot">
					{post.status === "archived" && <span>{t("postCard.archivedLabel")}</span>}
					<button type="button" class="btn--ghost" onClick={onOpenComments}>
						<IconChatBubble /> {t("postCard.commentsButton", { count: commentCount })}
					</button>
					{/* Этап E, E3 — mediaCounts посчитан ОДНИМ сканом на всю ленту
					    (mediaClassesByPost, channel.jsx's refresh), не здесь — карточка
					    только читает готовое значение по своему post.id, Θ(1). */}
					<MediaButtons counts={mediaCounts} onOpen={onOpenMediaClass} />
					<span class="grow" />
					{isOwner && (
						<ActionsMenu label={t("postCard.actionsAria", { excerpt: toPreviewText(post.text, { profile: "rich", maxLength: 40 }) || t("postCard.noTextFallback") })}>
							{kind === "task" ? (
								<button type="button" onClick={onUnmakeTask}>{t("postCard.unmakeTaskButton")}</button>
							) : (
								<button type="button" onClick={onMakeTask}>{t("postCard.makeTaskButton")}</button>
							)}
							{post.dueAt === null ? (
								<button type="button" onClick={onSetDue}>{t("postCard.setDueButton")}</button>
							) : (
								<button type="button" onClick={onClearDue}>{t("postCard.clearDueButton")}</button>
							)}
							{post.status === "published" && <button type="button" onClick={onArchive}>{t("postCard.archiveButton")}</button>}
							{post.status === "published" && <button type="button" onClick={onUnpublish}>{t("postCard.unpublishButton")}</button>}
							<button type="button" class="danger" onClick={onDelete}>
								<IconTrash /> {t("common.delete")}
							</button>
						</ActionsMenu>
					)}
				</footer>
			</div>
		</article>
	);
}

export { formatDateTime, shortPubkey };
