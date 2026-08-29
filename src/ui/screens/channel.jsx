import { useState, useEffect, useId, useRef } from "preact/hooks";
import { db } from "../../core/store/database.js";
import { fromEncryptedRow } from "../../core/store/encrypted-table.js";
import { publish } from "../signals/transport.js";
import { markChannelAsRead, getChannelChatUnreadCount } from "../../domain/content/channel-read-status.js";
import { refreshUnreadChannelsCount } from "../signals/notifications.js";
import { messagingActivity } from "../signals/chats.js";
import { groups, refreshGroups } from "../signals/contacts.js";
import { place, goTo, openChannel } from "../signals/place.js";
import { editChannel, deleteChannel } from "../../domain/content/channel.js";
import { addVisibilityGroup, removeVisibilityGroup, listChannelVisibilityGroupIds } from "../../domain/content/channel-visibility.js";
import { loadPostsWindow } from "../../core/sync/lazy-channel.js";
import { countCommentsByPost } from "../../domain/content/comments.js";
import { listReactionsForTargets, aggregateReactions } from "../../domain/content/reactions.js";
import { refFromAttachment, classOf } from "../../domain/media/media-ref.js";
import { findRefPosition } from "../../domain/media/scope.js";
import { openMedia } from "../signals/media.js";
import AttachmentSlices from "../components/media/attachment-slices.jsx";
import { createRateLimiter } from "../../domain/content/rate-limiter.js";
import { validateAttachment } from "../../domain/files/attachment-validation.js";
import { uploadMessageAttachment } from "../../domain/messaging/attachments.js";
import { BUILD_DEFAULT_BLOSSOM_SERVERS } from "../../config.js";
import ChannelChat from "../components/channel-chat.jsx";
import ChannelComposer from "../components/channel-composer.jsx";
import ModerationPanel from "../components/moderation-panel.jsx";
import Screen from "../components/screen.jsx";
import ActionsMenu from "../components/actions-menu.jsx";
import IconTrash from "../icons/trash.jsx";
import IconPencil from "../icons/pencil.jsx";
import IconGear from "../icons/gear.jsx";
import IconShield from "../icons/shield.jsx";
import { t, errorMessage } from "../signals/i18n.js";
import { ChannelLead, ChannelSubtitle, ChannelAbout, ChannelPostsTab } from "../components/channel-feed.jsx";
import ChannelPostPage from "../components/channel-post-page.jsx";

const NAME_MAX_LENGTH = 100;
const DESCRIPTION_MAX_LENGTH = 500;
const RULES_MAX_LENGTH = 1000;
const BLOSSOM_SERVER_URL = BUILD_DEFAULT_BLOSSOM_SERVERS[0];

function sameSet(a, b) {
	if (a.size !== b.size) return false;
	for (const x of a) if (!b.has(x)) return false;
	return true;
}

// CHANNEL-V2 часть G1-G5 — было: одна сплошная форма (название/описание/
// правила, <input type="file"> без превью, чекбокс в ряду, group-список,
// «Сохранить»/«Отмена» посреди страницы, «Удалить канал» чуть ниже той же
// формой, window.confirm). Теперь: три сгруппированных fieldset, превью
// аватара + живой счётчик символов, переключатели вместо голых чекбоксов,
// сохранение — в подвале Screen'а (form={formId}, форма и кнопка физически
// разъехались, связаны нативным HTML-атрибутом), опасная зона — отдельным
// блоком с двухшаговым подтверждением вместо window.confirm.
//
// onBarChange — подвал рисует channel.jsx (слот Screen, вне этого
// компонента), поэтому dirty/busy/formId сообщаются наверх колбэком, а не
// пробрасываются пропом вниз.
function ChannelSettingsForm({ ownerPubkey, privKey, dbKey, channelId, channelRow, onSaved, onDeleted, onBarChange }) {
	const instanceId = useId();
	const formId = useId();
	const [name, setName] = useState(channelRow.name || "");
	const [description, setDescription] = useState(channelRow.description || "");
	const [rules, setRules] = useState(channelRow.rules || "");
	const [allowChatAttachments, setAllowChatAttachments] = useState(channelRow.allowChatAttachments ?? true);
	const [avatarFile, setAvatarFile] = useState(null);
	const [avatarError, setAvatarError] = useState("");
	const [avatarPreviewUrl, setAvatarPreviewUrl] = useState(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [selectedGroupIds, setSelectedGroupIds] = useState(() => new Set());
	const [originalGroupIds, setOriginalGroupIds] = useState(() => new Set());
	const [confirming, setConfirming] = useState(false);
	const [confirmText, setConfirmText] = useState("");
	const avatarInputRef = useRef(null);

	useEffect(() => {
		refreshGroups(ownerPubkey, dbKey).catch(() => {});
		listChannelVisibilityGroupIds(ownerPubkey, channelId).then((ids) => {
			const asSet = new Set(ids);
			setSelectedGroupIds(asSet);
			setOriginalGroupIds(asSet);
		});
	}, [ownerPubkey, channelId]);

	// Превью — из URL.createObjectURL(avatarFile), не из готового URL канала
	// (файл ещё не загружен на Blossom). revokeObjectURL в cleanup — иначе
	// blob: URL живёт до перезагрузки вкладки.
	useEffect(() => {
		if (!avatarFile) {
			setAvatarPreviewUrl(null);
			return;
		}
		const url = URL.createObjectURL(avatarFile);
		setAvatarPreviewUrl(url);
		return () => URL.revokeObjectURL(url);
	}, [avatarFile]);

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

	const dirty =
		name !== (channelRow.name || "") ||
		description !== (channelRow.description || "") ||
		rules !== (channelRow.rules || "") ||
		allowChatAttachments !== (channelRow.allowChatAttachments ?? true) ||
		avatarFile !== null ||
		!sameSet(selectedGroupIds, originalGroupIds);

	async function handleSave(e) {
		e.preventDefault();
		if (busy || !dirty || name.length === 0) return;
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
		if (busy || confirmText !== channelRow.name) return;
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

	useEffect(() => {
		onBarChange?.({ dirty, busy, formId, canSave: dirty && !busy && name.length > 0, onCancel: onSaved });
	}, [dirty, busy, formId, name.length]);

	return (
		<form id={formId} class="set-form stack" onSubmit={handleSave} style={{ "--gap": "var(--space-l)" }}>
			{error && (
				<p role="alert" style={{ color: "var(--bad)" }}>
					{error}
				</p>
			)}

			<fieldset class="set-group stack" style={{ "--gap": "var(--space-s)" }}>
				<legend>{t("channel.settings.groupAppearance")}</legend>
				<p class="set-group__hint">{t("channel.settings.groupAppearanceHint")}</p>

				<div class="avatar-field bar" style={{ "--gap": "var(--space-s)", "--align": "center" }}>
					{avatarPreviewUrl ? (
						<img src={avatarPreviewUrl} alt="" class="avatar-field__preview rigid" />
					) : (
						<div aria-hidden="true" class="avatar-field__preview avatar-field__preview--empty rigid">
							{(name || "?").trim().charAt(0).toUpperCase()}
						</div>
					)}
					<div class="stack grow" style={{ "--gap": "var(--space-3xs)" }}>
						<div class="row" style={{ "--gap": "var(--space-2xs)" }}>
							<input ref={avatarInputRef} id="edit-channel-avatar" type="file" accept="image/*" style={{ display: "none" }} onChange={handleAvatarSelected} />
							<button type="button" onClick={() => avatarInputRef.current?.click()}>
								{t("channel.settings.chooseAvatarButton")}
							</button>
						</div>
						<small class="field__foot">{avatarError || t("channel.settings.avatarHint")}</small>
					</div>
				</div>

				<div class="field stack" style={{ "--gap": "var(--space-3xs)" }}>
					<label for="edit-channel-name">{t("channels.create.nameLabel")}</label>
					<input id="edit-channel-name" type="text" value={name} maxLength={NAME_MAX_LENGTH} onInput={(e) => setName(e.currentTarget.value)} required />
					<div class="field__foot bar" style={{ "--gap": "var(--space-s)" }}>
						<span class="grow">{t("channel.settings.nameHint")}</span>
						<span class={`field__count${name.length >= NAME_MAX_LENGTH ? " field__count--over" : ""}`}>
							{name.length} / {NAME_MAX_LENGTH}
						</span>
					</div>
				</div>

				<div class="field stack" style={{ "--gap": "var(--space-3xs)" }}>
					<label for="edit-channel-description">{t("channels.create.descriptionLabel")}</label>
					<textarea id="edit-channel-description" value={description} maxLength={DESCRIPTION_MAX_LENGTH} onInput={(e) => setDescription(e.currentTarget.value)} rows={3} />
					<div class="field__foot bar" style={{ "--gap": "var(--space-s)" }}>
						<span class="grow" />
						<span class={`field__count${description.length >= DESCRIPTION_MAX_LENGTH ? " field__count--over" : ""}`}>
							{description.length} / {DESCRIPTION_MAX_LENGTH}
						</span>
					</div>
				</div>

				<div class="field stack" style={{ "--gap": "var(--space-3xs)" }}>
					<label for="edit-channel-rules">{t("channels.create.rulesLabel")}</label>
					<textarea id="edit-channel-rules" value={rules} maxLength={RULES_MAX_LENGTH} onInput={(e) => setRules(e.currentTarget.value)} rows={4} />
					<div class="field__foot bar" style={{ "--gap": "var(--space-s)" }}>
						<span class="grow" />
						<span class={`field__count${rules.length >= RULES_MAX_LENGTH ? " field__count--over" : ""}`}>
							{rules.length} / {RULES_MAX_LENGTH}
						</span>
					</div>
				</div>
			</fieldset>

			<fieldset class="set-group stack" style={{ "--gap": "var(--space-s)" }}>
				<legend>{t("channel.settings.groupRules")}</legend>
				<p class="set-group__hint">{t("channel.settings.groupRulesHint")}</p>
				<label class="opt">
					<input id="edit-channel-allow-chat-attachments" type="checkbox" checked={allowChatAttachments} onChange={(e) => setAllowChatAttachments(e.currentTarget.checked)} />
					<span class="stack" style={{ "--gap": "var(--space-3xs)" }}>
						<span class="opt__t">{t("channels.create.allowChatAttachmentsLabel")}</span>
						<span class="opt__d">{t("channel.settings.allowChatAttachmentsHint")}</span>
					</span>
				</label>
			</fieldset>

			<fieldset class="set-group stack" style={{ "--gap": "var(--space-s)" }}>
				<legend>{t("channel.settings.visibilityLabel")}</legend>
				<p class="set-group__hint">{t("channels.create.visibilityHint")}</p>
				{groups.value.length === 0 ? (
					<p style={{ color: "var(--muted)" }}>{t("channels.create.noGroups")}</p>
				) : (
					<ul role="list" class="group-list">
						{groups.value.map((g) => (
							<li key={g.id}>
								<label class="opt">
									<input
										id={`${instanceId}-group-${g.id}`}
										type="checkbox"
										checked={selectedGroupIds.has(g.id)}
										onChange={() => toggleGroup(g.id)}
									/>
									<span class="opt__t">{t("channels.create.groupWithCount", { name: g.name, count: g.memberPubkeys.length })}</span>
								</label>
							</li>
						))}
					</ul>
				)}
			</fieldset>

			<section class="danger-zone box" style={{ "--pad": "var(--space-s)" }}>
				<div class="stack grow" style={{ "--gap": "var(--space-3xs)" }}>
					<h3>{t("channel.settings.deleteTitle")}</h3>
					<p>{t("channel.settings.deleteExplain")}</p>
				</div>
				{confirming ? (
					<div class="stack" style={{ "--gap": "var(--space-2xs)" }}>
						<label for={`${instanceId}-confirm`}>{t("channel.settings.deleteTypeName", { name: channelRow.name })}</label>
						<input id={`${instanceId}-confirm`} type="text" value={confirmText} onInput={(e) => setConfirmText(e.currentTarget.value)} />
						<div class="row" style={{ "--gap": "var(--space-2xs)" }}>
							<button type="button" class="btn--ghost" onClick={() => setConfirming(false)}>
								{t("common.cancel")}
							</button>
							<button type="button" class="danger-zone__go" disabled={busy || confirmText !== channelRow.name} onClick={handleDelete}>
								<IconTrash /> {t("channel.settings.deleteButton")}
							</button>
						</div>
					</div>
				) : (
					<button type="button" class="danger-zone__go rigid" onClick={() => setConfirming(true)}>
						<IconTrash /> {t("channel.settings.deleteButton")}
					</button>
				)}
			</section>
		</form>
	);
}

export default function ChannelDetail({ ownerPubkey, privKey, dbKey, channelId }) {
	const [channelRow, setChannelRow] = useState(null);
	const [loading, setLoading] = useState(true);
	const [posts, setPosts] = useState([]);
	const [hasMore, setHasMore] = useState(false);
	const [error, setError] = useState("");
	const [commentCounts, setCommentCounts] = useState({});
	const [reactionCountsByPost, setReactionCountsByPost] = useState({});
	const [limiter] = useState(() => createRateLimiter());
	// HEADERS (CONTRACTS.md §HEADERS), этап 1 — срез по типу вложения для
	// вкладки "Посты", "all" по умолчанию сбрасывается при каждом входе.
	// Вкладка "Чат" — своя пара typeFilter/layout ВНУТРИ ChannelChat (её
	// messages туда наружу не поднимаются, поднимать нечего).
	const [typeFilter, setTypeFilter] = useState("all");
	const [attachmentLayout, setAttachmentLayout] = useState("grid");
	// CHANNEL-V2 часть B5 — кнопка «Новая запись» переехала в шапку экрана
	// (Screen's actions), composerOpen поднят сюда из ChannelPostsTab.
	const [composerOpen, setComposerOpen] = useState(false);
	// CHANNEL-V2 часть G4 — save-bar настроек рисуется в footer Screen'а (вне
	// ChannelSettingsForm), dirty/busy/formId сообщаются наверх колбэком
	// (onBarChange), а не пробрасываются пропом вниз.
	const [settingsBar, setSettingsBar] = useState({ dirty: false, busy: false, formId: "", canSave: false, onCancel: () => {} });
	// HEADERS (CONTRACTS.md §HEADERS), этап 3 — бейдж непрочитанного на
	// вкладке "Чат". Заполняется в refresh() ниже, тот же useEffect,
	// который уже перезапускается на messagingActivity.value (тот же
	// сигнал, на который реагируют chat.jsx/channel-chat.jsx при любой
	// read/write активности, включая markChannelAsRead внутри ChannelChat).
	const [chatUnreadCount, setChatUnreadCount] = useState(0);

	const target = place.value;
	const onPostPage = target.kind === "channel" && target.id === channelId && !!target.postId && target.subTab !== "chat";

	// CHANNEL-V2 часть B1 — состояние вкладки: один источник (place.value), не
	// два. Раньше вкладка жила в локальном useState, а place.subTab обновлял её
	// только в обратную сторону (useEffect ниже) — клик по вкладке place не
	// трогал вообще: "назад" после смены вкладки не работало, глубокая ссылка
	// на вкладку не воспроизводилась.
	const onThisChannel = target.kind === "channel" && target.id === channelId;
	const tab = onThisChannel ? (target.subTab ?? "posts") : "posts";

	// Смена вкладки — полная замена места (goTo, не merge): postId/commentId
	// намеренно сбрасываются, иначе уход в «Настройки» и возврат в «Посты»
	// молча выкинул бы на страницу записи, открытой до этого.
	function setTab(next) {
		goTo({ kind: "channel", id: channelId, subTab: next });
	}

	async function refresh() {
		const raw = await db.table("channels").get([ownerPubkey, channelId]);
		const row = raw ? fromEncryptedRow(raw, dbKey) : undefined;
		setChannelRow(row ?? null);
		setLoading(false);
		if (!row) return;
		const { posts: freshPosts, hasMore: more } = await loadPostsWindow(ownerPubkey, dbKey, channelId, { limit: 10 });
		setPosts(freshPosts);
		setHasMore(more);
		if (freshPosts.length > 0) {
			const lastCreatedAt = Math.max(...freshPosts.map((p) => p.createdAt));
			markChannelAsRead(ownerPubkey, privKey, channelId, lastCreatedAt, publish)
				.then(() => refreshUnreadChannelsCount(ownerPubkey, dbKey))
				.catch(() => {});
		}
		const counts = await countCommentsByPost(ownerPubkey, freshPosts.map((p) => p.id));
		setCommentCounts(Object.fromEntries(counts));
		const reactionRows = await listReactionsForTargets(ownerPubkey, dbKey, freshPosts.map((p) => p.id));
		const byPost = {};
		const grouped = new Map();
		for (const r of reactionRows) {
			if (!grouped.has(r.targetId)) grouped.set(r.targetId, []);
			grouped.get(r.targetId).push(r);
		}
		for (const [id, list] of grouped) byPost[id] = aggregateReactions(list, ownerPubkey).counts;
		setReactionCountsByPost(byPost);
	}

	useEffect(() => {
		refresh().catch((e) => setError(errorMessage(e)));
	}, [ownerPubkey, channelId, messagingActivity.value]);

	// HEADERS (CONTRACTS.md §HEADERS), этап 3 — бейдж «Чат» ОТДЕЛЬНЫМ эффектом,
	// не внутри refresh(): markChannelAsRead (вызывается ВНУТРИ ChannelChat при
	// открытии вкладки) — чисто локальное обновление курсора, НЕ бампает
	// messagingActivity (тот сигнализирует о новых сообщениях/синке, не о факте
	// прочтения — найдено живой проверкой, бейдж не пропадал после прочтения).
	// [tab] в зависимостях перечитывает счётчик при КАЖДОМ переключении вкладки
	// — в частности, при уходе С «Чата», когда прочтение уже произошло.
	useEffect(() => {
		if (!channelRow) return;
		getChannelChatUnreadCount(ownerPubkey, channelId)
			.then(setChatUnreadCount)
			.catch(() => {});
	}, [ownerPubkey, channelId, tab, messagingActivity.value, channelRow]);

	async function handleLoadMore() {
		if (posts.length === 0) return;
		const { posts: older, hasMore: more } = await loadPostsWindow(ownerPubkey, dbKey, channelId, { limit: 10, beforeCreatedAt: posts[0].createdAt });
		const combined = [...older, ...posts];
		setPosts(combined);
		setHasMore(more);
		const counts = await countCommentsByPost(ownerPubkey, combined.map((p) => p.id));
		setCommentCounts(Object.fromEntries(counts));
		const reactionRows = await listReactionsForTargets(ownerPubkey, dbKey, combined.map((p) => p.id));
		const byPost = {};
		const grouped = new Map();
		for (const r of reactionRows) {
			if (!grouped.has(r.targetId)) grouped.set(r.targetId, []);
			grouped.get(r.targetId).push(r);
		}
		for (const [id, list] of grouped) byPost[id] = aggregateReactions(list, ownerPubkey).counts;
		setReactionCountsByPost(byPost);
	}

	function collectChannelPostsScope() {
		return posts.flatMap((p) => (p.attachments ?? []).map((a) => refFromAttachment(a, { postId: p.id })));
	}

	// HEADERS (CONTRACTS.md §HEADERS), этап 1 — заменяет postsSlicesCounts +
	// handleOpenPostsSlice: тот же паттерн, что chat.jsx's allAttachmentItems/
	// openFilteredMedia. counts теперь считает сам AttachmentSlices из items.
	function allPostsAttachmentItems() {
		const result = [];
		for (const post of posts) {
			for (const attachment of post.attachments || []) {
				result.push({ post, attachment });
			}
		}
		return result;
	}

	function openFilteredPostsMedia(typeFilter, post, attachment) {
		const refs = collectChannelPostsScope().filter((r) => classOf(r.mime) === typeFilter);
		const target = refFromAttachment(attachment, { postId: post.id });
		const position = findRefPosition(refs, target.digest, target.sourceMeta);
		if (position === -1) return;
		openMedia({ refs, position });
	}

	if (loading) {
		return (
			<Screen breadcrumb={{ label: t("nav.channels"), onBack: () => openChannel(null) }} title={t("channel.defaultTitle")}>
				<p style={{ color: "var(--muted)" }}>{t("common.loading")}</p>
			</Screen>
		);
	}

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

	if (onPostPage) {
		return (
			<ChannelPostPage
				ownerPubkey={ownerPubkey}
				privKey={privKey}
				dbKey={dbKey}
				channelId={channelId}
				channelRow={channelRow}
				postId={target.postId}
				commentId={target.commentId}
				limiter={limiter}
			/>
		);
	}

	// HEADERS (CONTRACTS.md §HEADERS), этап 1 — .ch-bar__slices (MediaButtons
	// Постов/Чата) убран: срезы по типу вложения теперь рендерятся внутри
	// ленты каждой вкладки (AttachmentSlices), не в шапке рядом с табами.
	// Slot Screen's slices несёт ТОЛЬКО навигацию по разделам экрана.
	// HEADERS этап 3 — «Модерация»/«Настройки» ушли из полосы в меню под
	// шестернёй (actions ниже): владельцу/модератору они и так не место в
	// разделе, который открывают ежедневно. Права доступа — тот же isOwner,
	// не изменились. Счётчик непрочитанного — бейджем внутри вкладки «Чат».
	const tabsBar = (
		<nav class="tabs reel" role="tablist" aria-label={t("channel.tabsAriaLabel")}>
			<button type="button" class="tab" role="tab" aria-selected={tab === "posts"} onClick={() => setTab("posts")}>
				{t("channel.tabs.posts")}
			</button>
			<button type="button" class="tab" role="tab" aria-selected={tab === "chat"} onClick={() => setTab("chat")}>
				{t("channel.tabs.chat")}
				{chatUnreadCount > 0 && <span class="tab__badge">{chatUnreadCount}</span>}
			</button>
		</nav>
	);

	return (
		<Screen
			breadcrumb={{ label: t("nav.channels"), onBack: () => openChannel(null) }}
			title={channelRow.name || t("channels.card.untitled")}
			lead={<ChannelLead channelRow={channelRow} />}
			subtitle={<ChannelSubtitle channelRow={channelRow} />}
			headerExtra={<ChannelAbout channelRow={channelRow} />}
			actions={
				<>
					{isOwner && tab === "posts" && (
						<button type="button" class="btn--primary" onClick={() => setComposerOpen(true)}>
							<IconPencil /> {t("channel.writePostButton")}
						</button>
					)}
					{/* CHANNEL-V2 часть B5 — «Скопировать ссылку» пропущен: готового
					    формата внутренней ссылки на канал в проекте нет (ТЗ явно
					    разрешает пропустить пункт в этом случае, не выдумывая формат).
					    Меню остаётся только владельцу.
					    HEADERS этап 3 — «Модерация» переехала сюда из полосы вкладок,
					    тот же порядок слева направо, что был у вкладок (Модерация
					    перед Настройками). */}
					{isOwner && (
						<ActionsMenu label={t("channel.channelActionsAria", { name: channelRow.name })}>
							<button type="button" onClick={() => setTab("moderation")}>
								<IconShield /> {t("channel.tabs.moderation")}
							</button>
							<button type="button" onClick={() => setTab("settings")}>
								<IconGear /> {t("channel.tabs.settings")}
							</button>
						</ActionsMenu>
					)}
				</>
			}
			slices={tabsBar}
			feed={tab === "posts" || tab === "chat"}
			anchored={tab === "chat"}
			footer={
				tab === "chat" ? (
					<ChannelComposer
						ownerPubkey={ownerPubkey}
						privKey={privKey}
						dbKey={dbKey}
						channelId={channelId}
						canWrite={canComment}
						allowAttachments={channelRow.allowChatAttachments}
						limiter={limiter}
					/>
				) : tab === "settings" && isOwner ? (
					<div class="save-bar bar" style={{ "--gap": "var(--space-s)", "--align": "center" }}>
						<span class={`save-bar__state grow${settingsBar.dirty ? " save-bar__state--dirty" : ""}`}>
							{settingsBar.busy ? t("common.saving") : settingsBar.dirty ? t("channel.settings.dirtyNotice") : t("channel.settings.savedNotice")}
						</span>
						<button type="button" class="btn--ghost" onClick={settingsBar.onCancel} disabled={settingsBar.busy}>
							{t("common.cancel")}
						</button>
						<button type="submit" form={settingsBar.formId} class="btn--primary" disabled={!settingsBar.canSave}>
							{settingsBar.busy ? t("common.saving") : t("common.save")}
						</button>
					</div>
				) : undefined
			}
		>
			{error && (
				<p role="alert" style={{ color: "var(--bad)" }}>
					{error}
				</p>
			)}

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
						onBarChange={setSettingsBar}
					/>
				</section>
			)}

			{tab === "posts" && (
				<AttachmentSlices
					items={allPostsAttachmentItems()}
					typeFilter={typeFilter}
					onSelectType={setTypeFilter}
					layout={attachmentLayout}
					onLayoutChange={setAttachmentLayout}
					onOpenItem={(item) => openFilteredPostsMedia(typeFilter, item.post, item.attachment)}
				>
					<ChannelPostsTab
						ownerPubkey={ownerPubkey}
						privKey={privKey}
						dbKey={dbKey}
						channelId={channelId}
						isOwner={isOwner}
						limiter={limiter}
						posts={posts}
						hasMore={hasMore}
						commentCounts={commentCounts}
						reactionCountsByPost={reactionCountsByPost}
						onLoadMore={handleLoadMore}
						onPublished={refresh}
						composerOpen={composerOpen}
						onComposerClose={() => setComposerOpen(false)}
						onOpenComposer={() => setComposerOpen(true)}
					/>
				</AttachmentSlices>
			)}

			{tab === "chat" && (
				<section role="tabpanel">
					<ChannelChat ownerPubkey={ownerPubkey} privKey={privKey} dbKey={dbKey} channelId={channelId} channelOwnerPubkey={channelRow.creatorPubkey} />
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
