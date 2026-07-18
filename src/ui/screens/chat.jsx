import { useState, useEffect, useRef } from "preact/hooks";
import { BUILD_DEFAULT_RELAYS as DEFAULT_RELAYS } from "../../config.js";
import { shortPubkey } from "../format.js";
import { currentUser, privKeySig } from "../signals/auth.js";
import {
	ensureConnected,
	publish,
	fetchProfiles,
	fetchKeyPackage,
	refreshGroupMessageSubscription,
	nextLamportTick,
	connState,
	synced,
} from "../signals/transport.js";
import { activeChatPubkey, openChat } from "../signals/chat.js";
import { profiles, refreshProfiles } from "../signals/contacts.js";
import { ContactIdentity } from "./contacts.jsx";
import {
	messagingActivity,
	listChatPartners,
	sendChatMessageAction,
	deleteChatMessageAction,
	markChatReadAction,
	saveChatDraftAction,
} from "../signals/chats.js";
import { refreshInboxRequests, acceptInboxRequestAction, rejectInboxRequestAction } from "../signals/inbox.js";
import { loadChatWindow, markWindowLoaded } from "../../core/sync/lazy-chat.js";
import { getDraft } from "../../domain/messaging/drafts.js";
import { getUnreadCount } from "../../domain/messaging/read-status.js";
import SyncIndicator from "../components/sync-indicator.jsx";
import MessageBubble from "../components/message-bubble.jsx";

const MAX_MESSAGE_LENGTH = 10000; // F-MS-08

// contacts.jsx уже вызывает ensureConnected при заходе на вкладку "Контакты" — но
// пользователь может открыть "Сообщения" напрямую, минуя её. ensureConnected идемпотентна
// (singleton-соединение на вкладку), повторный вызов отсюда безопасен.
function ChatList({ ownerPubkey, privKey, connectionError }) {
	const [chatPartners, setChatPartners] = useState([]);
	const [inboxList, setInboxList] = useState([]);
	const [unreadByPartner, setUnreadByPartner] = useState({});
	const [listError, setListError] = useState("");
	const [busy, setBusy] = useState(false);
	const busyRef = useRef(false);

	// Находка 2 (CONTRACTS.md, этап 27): messagingActivity — диспетчер transport.js
	// работает вне React re-render, этот сигнал сообщает "что-то изменилось".
	useEffect(() => {
		let cancelled = false;
		async function refresh() {
			try {
				const partners = await listChatPartners(ownerPubkey);
				const inbox = await refreshInboxRequests(ownerPubkey);
				const unread = {};
				for (const partnerPubkey of partners) {
					unread[partnerPubkey] = await getUnreadCount(ownerPubkey, partnerPubkey);
				}
				if (cancelled) return;
				setChatPartners(partners);
				setInboxList(inbox);
				setUnreadByPartner(unread);
				const allPubkeys = [...partners, ...inbox.map((r) => r.senderPubkey)];
				if (allPubkeys.length > 0) {
					// Найденный баг (пользователь): ensureProfilesFetched никогда не обновляла
					// уже закэшированное био/имя — refreshProfiles безусловно перезаписывает.
					await refreshProfiles(allPubkeys, fetchProfiles).catch(() => {});
				}
			} catch (err) {
				if (!cancelled) setListError(err?.message || String(err));
			}
		}
		refresh();
		return () => {
			cancelled = true;
		};
	}, [ownerPubkey, messagingActivity.value]);

	async function runAction(fn) {
		if (busyRef.current) return;
		busyRef.current = true;
		setListError("");
		setBusy(true);
		try {
			await fn();
		} catch (err) {
			setListError(err?.message || String(err));
		} finally {
			busyRef.current = false;
			setBusy(false);
		}
	}

	function handleAccept(senderPubkey) {
		return runAction(async () => {
			await acceptInboxRequestAction(ownerPubkey, privKey, senderPubkey, refreshGroupMessageSubscription, publish);
		});
	}

	function handleReject(senderPubkey) {
		return runAction(async () => {
			await rejectInboxRequestAction(ownerPubkey, senderPubkey);
			setInboxList((prev) => prev.filter((r) => r.senderPubkey !== senderPubkey));
		});
	}

	return (
		<main class="flow" style={{ padding: "var(--space-m)", "--container": "56rem" }}>
			<header class="flow" style={{ "--flow-space": "var(--space-2xs)" }}>
				<p class="eyebrow">Уголок</p>
				<h1>Сообщения</h1>
				<p class="cluster" style={{ alignItems: "center", color: "var(--muted)" }}>
					Соединение: <SyncIndicator state={connState.value} synced={synced.value} url={DEFAULT_RELAYS[0]} />
				</p>
				{connectionError && (
					<p role="alert" style={{ color: "var(--bad, oklch(0.58 0.21 25))" }}>
						{connectionError}
					</p>
				)}
				{listError && (
					<p role="alert" style={{ color: "var(--bad, oklch(0.58 0.21 25))" }}>
						{listError}
					</p>
				)}
			</header>

			<section class="flow" aria-labelledby="inbox-heading" style={{ "--flow-space": "var(--space-s)" }}>
				<h2 id="inbox-heading">Входящие ({inboxList.length})</h2>
				{inboxList.length === 0 ? (
					<p style={{ color: "var(--muted)" }}>Нет новых запросов на переписку от незнакомцев.</p>
				) : (
					<ul role="list" style={{ listStyle: "none", paddingInlineStart: 0 }}>
						{inboxList.map((req) => (
							<li
								key={req.senderPubkey}
								class="cluster"
								style={{
									alignItems: "center",
									justifyContent: "space-between",
									paddingBlock: "var(--space-s)",
									borderBlockEnd: "var(--border-width) solid var(--border)",
								}}
							>
								<ContactIdentity pubkey={req.senderPubkey} />
								<div class="cluster">
									<button type="button" disabled={busy} onClick={() => handleAccept(req.senderPubkey)}>
										Принять
									</button>
									<button type="button" disabled={busy} onClick={() => handleReject(req.senderPubkey)}>
										Отклонить
									</button>
								</div>
							</li>
						))}
					</ul>
				)}
			</section>

			<section class="flow" aria-labelledby="chats-heading" style={{ "--flow-space": "var(--space-s)" }}>
				<h2 id="chats-heading">Чаты ({chatPartners.length})</h2>
				{chatPartners.length === 0 ? (
					<p style={{ color: "var(--muted)" }}>
						Пока нет ни одного чата — откройте переписку по никнейму контакта в разделе "Контакты".
					</p>
				) : (
					<ul role="list" style={{ listStyle: "none", paddingInlineStart: 0 }}>
						{chatPartners.map((pubkey) => (
							<li
								key={pubkey}
								style={{ paddingBlock: "var(--space-s)", borderBlockEnd: "var(--border-width) solid var(--border)" }}
							>
								<button
									type="button"
									onClick={() => openChat(pubkey)}
									aria-label={`Открыть чат с ${profiles.value[pubkey]?.name || shortPubkey(pubkey)}`}
									class="cluster"
									style={{
										alignItems: "center",
										justifyContent: "space-between",
										width: "100%",
										background: "none",
										border: "none",
										padding: 0,
										cursor: "pointer",
										font: "inherit",
										color: "inherit",
									}}
								>
									<ContactIdentity pubkey={pubkey} />
									{unreadByPartner[pubkey] > 0 && (
										<span
											aria-label={`Непрочитанных: ${unreadByPartner[pubkey]}`}
											style={{
												background: "var(--bad, oklch(0.58 0.21 25))",
												color: "white",
												borderRadius: "999px",
												padding: "0 var(--space-3xs)",
												fontSize: "0.85em",
											}}
										>
											{unreadByPartner[pubkey]}
										</span>
									)}
								</button>
							</li>
						))}
					</ul>
				)}
			</section>
		</main>
	);
}

function ChatWindow({ ownerPubkey, privKey, contactPubkey }) {
	const [messages, setMessages] = useState([]);
	const [hasMore, setHasMore] = useState(false);
	const [text, setText] = useState("");
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const busyRef = useRef(false);
	const draftTimerRef = useRef(null);
	// Найдено живым E2E-прогоном (мультиаккаунт, не гипотеза): асинхронная загрузка
	// черновика при монтировании МОЖЕТ резолвиться ПОСЛЕ того, как пользователь уже начал
	// печатать — тогда setText(draft) стирает уже введённый текст. В обычном человеческом
	// использовании это маловероятно (БД быстрее печати), но не гарантировано. Как только
	// пользователь хоть раз редактировал текст — асинхронная загрузка черновика больше не
	// имеет права его перезаписывать. Сбрасывается при смене contactPubkey (новый чат).
	const userEditedRef = useRef(false);

	useEffect(() => {
		// Найденный баг (пользователь): при входе в чат подтягиваем СВЕЖИЙ профиль
		// собеседника (refreshProfiles), а не только "если ещё не кэширован".
		refreshProfiles([contactPubkey], fetchProfiles).catch(() => {});
	}, [contactPubkey]);

	useEffect(() => {
		let cancelled = false;
		async function load() {
			const { messages: freshWindow, hasMore: more } = await loadChatWindow(ownerPubkey, contactPubkey, { limit: 100 });
			if (cancelled) return;
			setMessages(freshWindow);
			setHasMore(more);
			if (freshWindow.length > 0) {
				const lastLamportTs = freshWindow[freshWindow.length - 1].lamportTs;
				await markChatReadAction(ownerPubkey, privKey, contactPubkey, lastLamportTs, publish).catch(() => {});
			}
		}
		load();
		return () => {
			cancelled = true;
		};
		// messagingActivity.value — находка 2: новое входящее сообщение перезагружает окно
	}, [ownerPubkey, privKey, contactPubkey, messagingActivity.value]);

	// ОТДЕЛЬНО от загрузки окна сообщений (найдено живым тестированием, не домысел):
	// черновик подтягивается ТОЛЬКО при смене контакта, не на каждый messagingActivity —
	// иначе входящее сообщение фоном стирало бы уже вводимый (ещё не сохранённый) текст
	// пользователя, перезаписывая его последним ЗАСОХРАНЁННЫМ черновиком.
	useEffect(() => {
		userEditedRef.current = false;
		let cancelled = false;
		getDraft(ownerPubkey, contactPubkey).then((draft) => {
			if (!cancelled && !userEditedRef.current) setText(draft);
		});
		return () => {
			cancelled = true;
		};
	}, [ownerPubkey, contactPubkey]);

	// Черновик не сохраняется на КАЖДОЕ нажатие клавиши (лишняя публикация kind 30071) —
	// debounce 1с; таймер отменяется при размонтировании/смене чата, чтобы не сохранить
	// черновик УЖЕ другого contactPubkey из устаревшего замыкания.
	useEffect(() => {
		return () => {
			if (draftTimerRef.current) clearTimeout(draftTimerRef.current);
		};
	}, [contactPubkey]);

	function handleTextInput(e) {
		userEditedRef.current = true;
		const value = e.currentTarget.value;
		setText(value);
		if (draftTimerRef.current) clearTimeout(draftTimerRef.current);
		draftTimerRef.current = setTimeout(() => {
			saveChatDraftAction(ownerPubkey, privKey, contactPubkey, value, publish).catch(() => {});
		}, 1000);
	}

	// Известное упрощение MVP: перезагружает ПОСЛЕДНИЕ 100, не сохраняя ранее
	// подгруженную (через "Загрузить более старые") историю выше — если пользователь
	// проскроллил вверх, отправка/удаление сообщения молча возвращает его к низу.
	// Не теряет данные (просто нужно заново нажать "Загрузить более старые" при
	// следующем скролле) — полировка отложена (backlog, этап 32).
	async function reloadWindow() {
		const { messages: freshWindow, hasMore: more } = await loadChatWindow(ownerPubkey, contactPubkey, { limit: 100 });
		setMessages(freshWindow);
		setHasMore(more);
	}

	async function handleLoadMore() {
		if (messages.length === 0) return;
		const oldestSeq = messages[0].seq;
		const { messages: older, hasMore: more } = await loadChatWindow(ownerPubkey, contactPubkey, { limit: 100, beforeSeq: oldestSeq });
		setMessages((prev) => [...older, ...prev]);
		setHasMore(more);
		if (older.length > 0) await markWindowLoaded(ownerPubkey, contactPubkey, older[0].seq);
	}

	async function handleSend(e) {
		e.preventDefault();
		if (busyRef.current || text.length === 0) return;
		if (text.length > MAX_MESSAGE_LENGTH) {
			setError(`Сообщение слишком длинное (максимум ${MAX_MESSAGE_LENGTH} символов)`);
			return;
		}
		busyRef.current = true;
		setError("");
		setBusy(true);
		try {
			const lamportTs = await nextLamportTick();
			await sendChatMessageAction(
				ownerPubkey,
				privKey,
				contactPubkey,
				text,
				lamportTs,
				publish,
				fetchKeyPackage,
				refreshGroupMessageSubscription,
			);
			if (draftTimerRef.current) clearTimeout(draftTimerRef.current);
			setText("");
			await saveChatDraftAction(ownerPubkey, privKey, contactPubkey, "", publish).catch(() => {});
			await reloadWindow();
		} catch (err) {
			setError(err?.message || String(err));
		} finally {
			busyRef.current = false;
			setBusy(false);
		}
	}

	async function handleDelete(msgId) {
		if (busyRef.current) return;
		busyRef.current = true;
		setBusy(true);
		try {
			const lamportTs = await nextLamportTick();
			await deleteChatMessageAction(ownerPubkey, privKey, contactPubkey, msgId, lamportTs, publish);
			await reloadWindow();
		} catch (err) {
			setError(err?.message || String(err));
		} finally {
			busyRef.current = false;
			setBusy(false);
		}
	}

	const profile = profiles.value[contactPubkey];
	const displayName = profile?.name || shortPubkey(contactPubkey);

	return (
		<main class="flow" style={{ padding: "var(--space-m)", "--container": "56rem", height: "100%", display: "flex", flexDirection: "column" }}>
			<header class="cluster" style={{ alignItems: "center" }}>
				<button type="button" onClick={() => openChat(null)}>
					← Назад
				</button>
				<h1>{displayName}</h1>
			</header>
			{error && (
				<p role="alert" style={{ color: "var(--bad, oklch(0.58 0.21 25))" }}>
					{error}
				</p>
			)}

			<div class="flow" style={{ flex: "1 1 auto", overflowY: "auto", "--flow-space": "var(--space-2xs)" }}>
				{hasMore && (
					<button type="button" onClick={handleLoadMore}>
						Загрузить более старые сообщения
					</button>
				)}
				{messages.length === 0 && <p style={{ color: "var(--muted)" }}>Сообщений пока нет — напишите первое!</p>}
				<div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2xs)" }}>
					{messages.map((message) => {
						const isOwn = message.senderPubkey === ownerPubkey;
						return (
							<MessageBubble
								key={message.msgId}
								message={message}
								isOwn={isOwn}
								onDelete={isOwn ? handleDelete : undefined}
							/>
						);
					})}
				</div>
			</div>

			<form class="cluster" onSubmit={handleSend} style={{ alignItems: "flex-end" }}>
				<div class="flow" style={{ "--flow-space": "var(--space-3xs)", flex: 1 }}>
					<label class="visually-hidden" for="chat-message-input">
						Сообщение
					</label>
					<textarea
						id="chat-message-input"
						value={text}
						maxLength={MAX_MESSAGE_LENGTH}
						onInput={handleTextInput}
						rows={2}
					/>
				</div>
				<button type="submit" disabled={busy || text.length === 0}>
					Отправить
				</button>
			</form>
		</main>
	);
}

export default function Chat() {
	const ownerPubkey = currentUser.value.id;
	const privKey = privKeySig.value;

	const [connectionError, setConnectionError] = useState("");

	useEffect(() => {
		ensureConnected(ownerPubkey, privKey).catch((e) => setConnectionError(e?.message || String(e)));
	}, [ownerPubkey]);

	if (activeChatPubkey.value) {
		return <ChatWindow ownerPubkey={ownerPubkey} privKey={privKey} contactPubkey={activeChatPubkey.value} />;
	}

	return <ChatList ownerPubkey={ownerPubkey} privKey={privKey} connectionError={connectionError} />;
}
