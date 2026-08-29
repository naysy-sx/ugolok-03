import { useState, useEffect, useRef } from "preact/hooks";
import { loadChannelChatWindow } from "../../core/sync/lazy-channel.js";
import { publish, fetchProfiles, refreshLiveProfileSubscription } from "../signals/transport.js";
import { markChannelAsRead } from "../../domain/content/channel-read-status.js";
import { refreshUnreadChannelsCount } from "../signals/notifications.js";
import { messagingActivity } from "../signals/chats.js";
import { ensureProfilesFresh, watchProfiles } from "../signals/contacts.js";
import { groupByDay } from "../group-by-day.js";
import { openMedia } from "../signals/media.js";
import { collectChatScope, findRefPosition } from "../../domain/media/scope.js";
import { refFromAttachment, classOf } from "../../domain/media/media-ref.js";
import ChannelMessage from "./channel-message.jsx";
import AttachmentSlices from "./media/attachment-slices.jsx";
import { t, errorMessage } from "../signals/i18n.js";

// CHANNEL-V2 часть E2 — подряд идущие сообщения ОДНОГО автора, у которых
// разрыв по createdAt меньше CHAT_GROUP_GAP_SECONDS, схлопываются в одну
// группу (один аватар/имя на группу, не на каждое сообщение).
const CHAT_GROUP_GAP_SECONDS = 300;

function groupMessagesByAuthor(messages) {
	const groups = [];
	let current = null;
	for (const m of messages) {
		if (current && current.authorPubkey === m.authorPubkey && m.createdAt - current.lastCreatedAt < CHAT_GROUP_GAP_SECONDS) {
			current.messages.push(m);
			current.lastCreatedAt = m.createdAt;
		} else {
			current = { id: m.id, authorPubkey: m.authorPubkey, lastCreatedAt: m.createdAt, messages: [m] };
			groups.push(current);
		}
	}
	return groups;
}

// Общий чат канала (этап 32) — плоская лента, свежие внизу (тот же принцип отображения,
// что личные чаты, chat.jsx), не дерево (в отличие от комментариев).
// CHANNEL-V2 часть E1 — композитор (ChatComposer) переехал в отдельный файл
// (channel-composer.jsx), собирается в подвале Screen. Этот компонент —
// только лента: приём/группировка/подгрузка/срезы.
export default function ChannelChat({ ownerPubkey, privKey, dbKey, channelId, channelOwnerPubkey }) {
	const [messages, setMessages] = useState([]);
	const [hasMore, setHasMore] = useState(false);
	const [error, setError] = useState("");
	// HEADERS (CONTRACTS.md §HEADERS), этап 1 — срез по типу вложения, "all"
	// по умолчанию сбрасывается при каждом новом входе (state локален).
	const [typeFilter, setTypeFilter] = useState("all");
	const [attachmentLayout, setAttachmentLayout] = useState("grid");
	const bottomRef = useRef(null);
	const pendingScrollRef = useRef(false);
	// CHANNEL-V2 часть E4.2 — "Показать более ранние" не должен выбрасывать
	// пользователя наверх: перед setMessages запоминаем scrollHeight
	// прокручиваемого предка, после перерисовки возвращаем scrollTop на то
	// же визуальное место (разница высот = высота вставленных сообщений).
	const pendingRestoreRef = useRef(null);
	// CHANNEL-V2 часть A2 — ТЗ просил отдельный useEffect на [ownerPubkey, channelId]
	// с force:true. Буквально это гонка: на смену канала messages ещё держит СТАРОЕ
	// окно (loadChannelChatWindow асинхронна), второй эффект форсировал бы профили
	// не тех авторов. Вместо второго эффекта — флаг: этот useEffect только взводит
	// его при смене канала, refresh() читает и гасит — тот же результат (первый
	// refresh() после открытия канала — force:true, остальные — false), без гонки.
	const forceProfileRefreshRef = useRef(true);

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
		// CHANNEL-V2 часть A2/A3 — ensureProfilesFresh вместо ensureProfilesFetched (null
		// перезапрашивается с остыванием), watchProfiles — авторы канала ловятся живой
		// подпиской (A3), не только явным запросом.
		const authors = [...new Set(fresh.map((m) => m.authorPubkey))];
		const force = forceProfileRefreshRef.current;
		forceProfileRefreshRef.current = false;
		if (watchProfiles(authors)) refreshLiveProfileSubscription(ownerPubkey);
		ensureProfilesFresh(authors, fetchProfiles, { force }).catch(() => {});
	}

	useEffect(() => {
		forceProfileRefreshRef.current = true;
	}, [ownerPubkey, channelId]);

	useEffect(() => {
		refresh().catch((e) => setError(errorMessage(e)));
	}, [ownerPubkey, channelId, messagingActivity.value]);

	useEffect(() => {
		if (pendingRestoreRef.current) {
			const { scroller, oldHeight } = pendingRestoreRef.current;
			pendingRestoreRef.current = null;
			if (scroller) scroller.scrollTop += scroller.scrollHeight - oldHeight;
			return;
		}
		if (pendingScrollRef.current && messages.length > 0) {
			bottomRef.current?.scrollIntoView({ block: "end" });
			pendingScrollRef.current = false;
		}
	}, [messages]);

	async function handleLoadMore() {
		if (messages.length === 0) return;
		const scroller = bottomRef.current?.closest(".content-wrapper") ?? null;
		const oldHeight = scroller?.scrollHeight ?? 0;
		const { messages: older, hasMore: more } = await loadChannelChatWindow(ownerPubkey, dbKey, channelId, { limit: 15, beforeCreatedAt: messages[0].createdAt });
		pendingRestoreRef.current = { scroller, oldHeight };
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

	// HEADERS (CONTRACTS.md §HEADERS), этап 1 — тот же паттерн, что
	// chat.jsx's allAttachmentItems/openFilteredMedia. messages — состояние
	// ЭТОГО компонента; раньше поднималось наружу через onSlicesChange
	// (channel.jsx рендерил кнопки в шапке), теперь браузер вложений
	// рендерится ЗДЕСЬ же, наверх поднимать больше нечего.
	function allAttachmentItems() {
		const result = [];
		for (const message of messages) {
			for (const attachment of message.attachments || []) {
				result.push({ message, attachment });
			}
		}
		return result;
	}

	function openFilteredMedia(typeFilter, message, attachment) {
		const refs = collectChatScope(messages).filter((r) => classOf(r.mime) === typeFilter);
		const target = refFromAttachment(attachment, { msgId: message.id });
		const position = findRefPosition(refs, target.digest, target.sourceMeta);
		if (position === -1) return;
		openMedia({ refs, position });
	}

	const dayGroups = groupByDay(messages);

	return (
		<AttachmentSlices
			items={allAttachmentItems()}
			typeFilter={typeFilter}
			onSelectType={setTypeFilter}
			layout={attachmentLayout}
			onLayoutChange={setAttachmentLayout}
			onOpenItem={(item) => openFilteredMedia(typeFilter, item.message, item.attachment)}
		>
			<div class="stack" style={{ "--gap": "var(--space-s)" }}>
				{error && (
					<p role="alert" style={{ color: "var(--bad)" }}>
						{error}
					</p>
				)}
				{hasMore && (
					<div class="row" style={{ "--align": "center", justifyContent: "center" }}>
						<button type="button" class="btn--ghost" onClick={handleLoadMore}>
							{t("chat.window.loadOlderButton")}
						</button>
					</div>
				)}
				{messages.length === 0 ? (
					<div class="empty stack" style={{ "--gap": "var(--space-2xs)", "--align": "center" }}>
						<h2>{t("channelChat.emptyTitle")}</h2>
						<p>{t("channelChat.emptyHint")}</p>
					</div>
				) : (
					<div class="stack" style={{ "--gap": "var(--space-m)" }}>
						{dayGroups.map(({ key, dayLabel, items }) => (
							<section key={key} class="stack" style={{ "--gap": "var(--space-s)" }}>
								<h2 class="day-sep bar" style={{ "--gap": "var(--space-s)", "--align": "center" }}>
									{dayLabel}
								</h2>
								<ul class="chat-log stack" role="list" style={{ "--gap": "var(--space-s)" }}>
									{groupMessagesByAuthor(items).map((group) => (
										<li key={group.id} class="chat-group stack" style={{ "--gap": "var(--space-3xs)" }}>
											{group.messages.map((m, i) => (
												<ChannelMessage
													key={m.id}
													message={m}
													showAuthor={i === 0}
													isOwn={m.authorPubkey === ownerPubkey}
													isChannelOwner={m.authorPubkey === channelOwnerPubkey}
													ownerPubkey={ownerPubkey}
													privKey={privKey}
													channelOwnerPubkey={channelOwnerPubkey}
													channelId={channelId}
													onOpenAttachment={openAttachment}
												/>
											))}
										</li>
									))}
								</ul>
							</section>
						))}
					</div>
				)}
				<div ref={bottomRef} />
			</div>
		</AttachmentSlices>
	);
}
