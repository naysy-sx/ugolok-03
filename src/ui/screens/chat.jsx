import { useState, useEffect, useRef } from "preact/hooks";
import { BUILD_DEFAULT_RELAYS as DEFAULT_RELAYS, BUILD_DEFAULT_BLOSSOM_SERVERS } from "../../config.js";
import { shortPubkey } from "../format.js";
import { currentUser, privKeySig, dbKeySig } from "../signals/auth.js";
import {
	ensureConnected,
	publish,
	fetchProfiles,
	fetchKeyPackage,
	refreshGroupMessageSubscription,
	refreshLiveProfileSubscription,
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
	deleteMessageForMeAction,
	clearChatHistoryAction,
	editChatMessageAction,
	markChatReadAction,
	saveChatDraftAction,
} from "../signals/chats.js";
import { refreshInboxRequests, acceptInboxRequestAction, rejectInboxRequestAction } from "../signals/inbox.js";
import { loadChatWindow, markWindowLoaded } from "../../core/sync/lazy-chat.js";
import { getDraft } from "../../domain/messaging/drafts.js";
import { getUnreadCount } from "../../domain/messaging/read-status.js";
import { refreshUnreadMessagesCount } from "../signals/notifications.js";
import { validateAttachment } from "../../domain/attachments/validation.js";
import { uploadAttachment } from "../../domain/attachments/upload.js";
import { createVoiceRecorder, shouldInlineVoice } from "../../domain/attachments/voice.js";
import SyncIndicator from "../components/sync-indicator.jsx";
import MessageBubble from "../components/message-bubble.jsx";
import AttachmentPreview from "../components/attachment-preview.jsx";
import Screen from "../components/screen.jsx";

const MAX_MESSAGE_LENGTH = 10000; // F-MS-08
const BLOSSOM_SERVER_URL = BUILD_DEFAULT_BLOSSOM_SERVERS[0]; // F-AT-09 (список в settings) — этап 32

function base64FromBytes(bytes) {
	return btoa(String.fromCharCode.apply(null, bytes));
}

// contacts.jsx уже вызывает ensureConnected при заходе на вкладку "Контакты" — но
// пользователь может открыть "Сообщения" напрямую, минуя её. ensureConnected идемпотентна
// (singleton-соединение на вкладку), повторный вызов отсюда безопасен.
function ChatList({ ownerPubkey, privKey, dbKey, connectionError }) {
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
				const partners = await listChatPartners(ownerPubkey, dbKey);
				const inbox = await refreshInboxRequests(ownerPubkey, dbKey);
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
			await acceptInboxRequestAction(ownerPubkey, privKey, dbKey, senderPubkey, refreshGroupMessageSubscription, publish);
		});
	}

	function handleReject(senderPubkey) {
		return runAction(async () => {
			await rejectInboxRequestAction(ownerPubkey, senderPubkey);
			setInboxList((prev) => prev.filter((r) => r.senderPubkey !== senderPubkey));
		});
	}

	return (
		<Screen title="Сообщения" feed>
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
		</Screen>
	);
}

function ChatWindow({ ownerPubkey, privKey, dbKey, contactPubkey }) {
	const [messages, setMessages] = useState([]);
	const [hasMore, setHasMore] = useState(false);
	const [text, setText] = useState("");
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const busyRef = useRef(false);
	const draftTimerRef = useRef(null);
	// Упущение пользователя (не баг): при входе в чат нужна автопрокрутка к последнему
	// сообщению. bottomRef — сентинел ПОСЛЕ последнего сообщения; scrollIntoView() сам
	// находит реально скроллящегося предка — после переезда на общий каркас (screen.jsx)
	// это .content-wrapper (position:absolute;inset:0;overflow-y:auto), не document.
	// pendingScrollRef взводится при смене contactPubkey (список messages грузится
	// АСИНХРОННО отдельным эффектом ниже) — прокрутка срабатывает один раз, когда messages
	// реально обновится, а не на каждое последующее фоновое сообщение (иначе выдёргивала
	// бы пользователя, читающего историю выше).
	const bottomRef = useRef(null);
	const pendingScrollRef = useRef(false);
	// Найдено живым E2E-прогоном (мультиаккаунт, не гипотеза): асинхронная загрузка
	// черновика при монтировании МОЖЕТ резолвиться ПОСЛЕ того, как пользователь уже начал
	// печатать — тогда setText(draft) стирает уже введённый текст. В обычном человеческом
	// использовании это маловероятно (БД быстрее печати), но не гарантировано. Как только
	// пользователь хоть раз редактировал текст — асинхронная загрузка черновика больше не
	// имеет права его перезаписывать. Сбрасывается при смене contactPubkey (новый чат).
	const userEditedRef = useRef(false);

	// Этап 29 — вложения. attachmentFile (выбранный файл) и recordedVoiceBlob (голосовая
	// запись) ВЗАИМОИСКЛЮЧАЮЩИЕ — сообщение несёт максимум одно вложение за раз
	// (тот же принцип, что большинство мессенджеров: либо файл, либо голосовое, не оба
	// сразу в одном сообщении). fileInputRef — скрытый <input type=file>, кнопка
	// "Прикрепить" триггерит его клик программно.
	const [attachmentFile, setAttachmentFile] = useState(null);
	const [attachmentPosition, setAttachmentPosition] = useState("below");
	const [attachmentError, setAttachmentError] = useState("");
	const fileInputRef = useRef(null);

	// recordingState: "idle" | "recording" | "recorded". voiceRecorderRef держит
	// createVoiceRecorder()-экземпляр между start()/stop()/cancel() одного захода записи.
	const [recordingState, setRecordingState] = useState("idle");
	const [recordedVoiceBlob, setRecordedVoiceBlob] = useState(null);
	const voiceRecorderRef = useRef(null);
	const [uploadingAttachment, setUploadingAttachment] = useState(false);

	// Object URL для прослушивания ЗАПИСАННОГО (ещё не отправленного) голоса — тот же
	// принцип, что attachment-preview.jsx: создать один раз на смену blob, освободить
	// на очистке/размонтировании, не пересоздавать на каждый рендер.
	const [recordedVoiceUrl, setRecordedVoiceUrl] = useState(null);
	useEffect(() => {
		if (!recordedVoiceBlob) {
			setRecordedVoiceUrl(null);
			return;
		}
		const url = URL.createObjectURL(recordedVoiceBlob);
		setRecordedVoiceUrl(url);
		return () => URL.revokeObjectURL(url);
	}, [recordedVoiceBlob]);

	useEffect(() => {
		// Найденный баг (пользователь): при входе в чат подтягиваем СВЕЖИЙ профиль
		// собеседника (refreshProfiles), а не только "если ещё не кэширован".
		refreshProfiles([contactPubkey], fetchProfiles).catch(() => {});
	}, [contactPubkey]);

	useEffect(() => {
		pendingScrollRef.current = true;
	}, [contactPubkey]);

	useEffect(() => {
		// messages стартует с [] и этот эффект тоже срабатывает на самом первом рендере —
		// длину проверяем, чтобы не погасить pendingScrollRef на пустом начальном значении
		// ДО того, как асинхронный loadChatWindow реально подгрузит историю.
		if (pendingScrollRef.current && messages.length > 0 && bottomRef.current) {
			bottomRef.current.scrollIntoView({ block: "end" });
			pendingScrollRef.current = false;
		}
	}, [messages]);

	useEffect(() => {
		let cancelled = false;
		async function load() {
			const { messages: freshWindow, hasMore: more } = await loadChatWindow(ownerPubkey, contactPubkey, dbKey, { limit: 100 });
			if (cancelled) return;
			setMessages(freshWindow);
			setHasMore(more);
			if (freshWindow.length > 0) {
				const lastLamportTs = freshWindow[freshWindow.length - 1].lamportTs;
				// НАЙДЕНО ПОЛЬЗОВАТЕЛЕМ (этап 47-довесок): прочтение — ЛОКАЛЬНОЕ действие,
				// не бампает messagingActivity (тот бампается только входящими событиями из
				// transport.js) — без явного пересчёта здесь бейдж "Сообщения [N]" в нave
				// оставался бы прежним навсегда после открытия чата.
				await markChatReadAction(ownerPubkey, privKey, dbKey, contactPubkey, lastLamportTs, publish).catch(() => {});
				refreshUnreadMessagesCount(ownerPubkey).catch(() => {});
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
		getDraft(ownerPubkey, dbKey, contactPubkey).then((draft) => {
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
			saveChatDraftAction(ownerPubkey, privKey, dbKey, contactPubkey, value, publish).catch(() => {});
		}, 1000);
	}

	// Прикрепление/голосовое взаимоисключающие — выбор одного сбрасывает другое.
	function handleFileSelected(e) {
		const file = e.currentTarget.files?.[0];
		e.currentTarget.value = ""; // иначе повторный выбор ТОГО ЖЕ файла не даёт onChange
		if (!file) return;
		setRecordingState("idle");
		setRecordedVoiceBlob(null);
		setAttachmentFile(file);
		setAttachmentPosition("below");
		try {
			validateAttachment({ mime: file.type, size: file.size });
			setAttachmentError("");
		} catch (err) {
			// Файл ВСЁ РАВНО показывается (AttachmentPreview покажет причину отказа) —
			// пользователь должен понимать, ЧТО он выбрал и почему это не пройдёт, а не
			// молча ничего не происходит.
			setAttachmentError(err?.message || String(err));
		}
	}

	function handleRemoveAttachment() {
		setAttachmentFile(null);
		setAttachmentError("");
	}

	async function handleStartRecording() {
		setError("");
		setAttachmentFile(null); // взаимоисключение — начатая запись отменяет выбранный файл
		const recorder = createVoiceRecorder();
		try {
			await recorder.start();
			voiceRecorderRef.current = recorder;
			setRecordingState("recording");
		} catch (err) {
			setError(err?.message || String(err));
		}
	}

	async function handleStopRecording() {
		if (!voiceRecorderRef.current) return;
		try {
			const blob = await voiceRecorderRef.current.stop();
			setRecordedVoiceBlob(blob);
			setRecordingState("recorded");
		} catch (err) {
			setError(err?.message || String(err));
			setRecordingState("idle");
		} finally {
			voiceRecorderRef.current = null;
		}
	}

	function handleCancelRecording() {
		voiceRecorderRef.current?.cancel();
		voiceRecorderRef.current = null;
		setRecordingState("idle");
		setRecordedVoiceBlob(null);
	}

	function handleDiscardRecordedVoice() {
		setRecordedVoiceBlob(null);
		setRecordingState("idle");
	}

	// Известное упрощение MVP: перезагружает ПОСЛЕДНИЕ 100, не сохраняя ранее
	// подгруженную (через "Загрузить более старые") историю выше — если пользователь
	// проскроллил вверх, отправка/удаление сообщения молча возвращает его к низу.
	// Не теряет данные (просто нужно заново нажать "Загрузить более старые" при
	// следующем скролле) — полировка отложена (backlog, этап 32).
	async function reloadWindow() {
		const { messages: freshWindow, hasMore: more } = await loadChatWindow(ownerPubkey, contactPubkey, dbKey, { limit: 100 });
		setMessages(freshWindow);
		setHasMore(more);
	}

	async function handleLoadMore() {
		if (messages.length === 0) return;
		const oldestSeq = messages[0].seq;
		const { messages: older, hasMore: more } = await loadChatWindow(ownerPubkey, contactPubkey, dbKey, { limit: 100, beforeSeq: oldestSeq });
		setMessages((prev) => [...older, ...prev]);
		setHasMore(more);
		if (older.length > 0) await markWindowLoaded(ownerPubkey, dbKey, contactPubkey, older[0].seq);
	}

	// Строит дескриптор вложения (F-AT-02) из выбранного файла или записанного голоса.
	// Возвращает undefined, если нечего прикреплять (обычное текстовое сообщение).
	// Голосовое ≤32КБ (F-AT-08/AC-AT-03b) НИКОГДА не грузится на Blossom — inline
	// base64 прямо в сообщении; иначе — тот же uploadAttachment, что обычный файл.
	async function buildOutgoingAttachment() {
		if (attachmentFile) {
			validateAttachment({ mime: attachmentFile.type, size: attachmentFile.size }); // повторно, defense-in-depth
			const bytes = new Uint8Array(await attachmentFile.arrayBuffer());
			const descriptor = await uploadAttachment(BLOSSOM_SERVER_URL, bytes, { mime: attachmentFile.type, name: attachmentFile.name }, privKey);
			if (descriptor.type === "image") descriptor.position = attachmentPosition;
			return descriptor;
		}
		if (recordedVoiceBlob) {
			const bytes = new Uint8Array(await recordedVoiceBlob.arrayBuffer());
			if (shouldInlineVoice(bytes.length)) {
				return { type: "audio", voice: true, mime: "audio/webm", name: "Голосовое сообщение", size: bytes.length, voiceInline: base64FromBytes(bytes) };
			}
			const descriptor = await uploadAttachment(BLOSSOM_SERVER_URL, bytes, { mime: "audio/webm", name: "Голосовое сообщение" }, privKey);
			descriptor.voice = true;
			return descriptor;
		}
		return undefined;
	}

	async function handleSend(e) {
		e.preventDefault();
		if (busyRef.current) return;
		if (text.length === 0 && !attachmentFile && !recordedVoiceBlob) return; // нечего отправлять
		if (attachmentFile && attachmentError) return; // невалидное вложение — сначала убрать/заменить
		if (text.length > MAX_MESSAGE_LENGTH) {
			setError(`Сообщение слишком длинное (максимум ${MAX_MESSAGE_LENGTH} символов)`);
			return;
		}
		busyRef.current = true;
		setError("");
		setBusy(true);
		try {
			// Загрузка на Blossom (если есть вложение) — ДО тика Lamport-часов и
			// отправки: сбой загрузки не должен продвигать часы/создавать пустой tick
			// впустую, и вложение/голос ОСТАЮТСЯ в состоянии компоновки для повторной
			// попытки (не теряются на сетевой ошибке).
			setUploadingAttachment(true);
			const attachment = await buildOutgoingAttachment();
			setUploadingAttachment(false);

			const lamportTs = await nextLamportTick(ownerPubkey);
			await sendChatMessageAction(
				ownerPubkey,
				privKey,
				dbKey,
				contactPubkey,
				text,
				lamportTs,
				publish,
				fetchKeyPackage,
				refreshGroupMessageSubscription,
				attachment,
			);
			if (draftTimerRef.current) clearTimeout(draftTimerRef.current);
			setText("");
			setAttachmentFile(null);
			setAttachmentError("");
			setRecordedVoiceBlob(null);
			setRecordingState("idle");
			await saveChatDraftAction(ownerPubkey, privKey, dbKey, contactPubkey, "", publish).catch(() => {});
			await reloadWindow();
		} catch (err) {
			setError(err?.message || String(err));
		} finally {
			setUploadingAttachment(false);
			busyRef.current = false;
			setBusy(false);
		}
	}

	async function handleDeleteForBoth(msgId) {
		if (busyRef.current) return;
		busyRef.current = true;
		setBusy(true);
		try {
			const lamportTs = await nextLamportTick(ownerPubkey);
			await deleteChatMessageAction(ownerPubkey, privKey, dbKey, contactPubkey, msgId, lamportTs, publish);
			await reloadWindow();
		} catch (err) {
			setError(err?.message || String(err));
		} finally {
			busyRef.current = false;
			setBusy(false);
		}
	}

	// "Удалить у себя" — чисто локально (нет сети, нет ожидания relay) — busy-блокировка
	// не нужна, но reloadWindow всё равно async.
	async function handleDeleteForMe(msgId) {
		try {
			await deleteMessageForMeAction(ownerPubkey, contactPubkey, msgId);
			await reloadWindow();
		} catch (err) {
			setError(err?.message || String(err));
		}
	}

	async function handleClearHistory() {
		if (!window.confirm("Очистить переписку? Сообщения удалятся только у вас, у собеседника всё останется.")) return;
		try {
			await clearChatHistoryAction(ownerPubkey, contactPubkey);
			await reloadWindow();
		} catch (err) {
			setError(err?.message || String(err));
		}
	}

	async function handleEdit(msgId, newText) {
		if (busyRef.current) return;
		if (newText.length > MAX_MESSAGE_LENGTH) {
			setError(`Сообщение слишком длинное (максимум ${MAX_MESSAGE_LENGTH} символов)`);
			return;
		}
		busyRef.current = true;
		setBusy(true);
		try {
			const lamportTs = await nextLamportTick(ownerPubkey);
			await editChatMessageAction(ownerPubkey, privKey, dbKey, contactPubkey, msgId, newText, lamportTs, publish);
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
		<Screen
			breadcrumb={{ label: "Сообщения", onBack: () => openChat(null) }}
			title={displayName}
			actions={
				<button type="button" onClick={handleClearHistory}>
					Очистить переписку
				</button>
			}
			feed
			footer={
				<div class="flow" style={{ "--flow-space": "var(--space-2xs)" }}>
					{attachmentFile && (
						<AttachmentPreview
							file={attachmentFile}
							position={attachmentPosition}
							onPositionChange={setAttachmentPosition}
							onRemove={handleRemoveAttachment}
							error={attachmentError}
						/>
					)}

					{recordingState === "recording" && (
						<p class="cluster" role="status" style={{ alignItems: "center" }}>
							<span aria-hidden="true">🔴</span> Идёт запись голосового…
							<button type="button" onClick={handleStopRecording}>
								Остановить
							</button>
							<button type="button" onClick={handleCancelRecording}>
								Отменить
							</button>
						</p>
					)}

					{recordingState === "recorded" && recordedVoiceUrl && (
						<p class="cluster" style={{ alignItems: "center" }}>
							<audio controls src={recordedVoiceUrl} />
							<button type="button" onClick={handleDiscardRecordedVoice}>
								Удалить запись
							</button>
						</p>
					)}

					{uploadingAttachment && (
						<p class="cluster" role="status" style={{ alignItems: "center" }}>
							<span class="spinner" aria-hidden="true" /> Загрузка вложения…
						</p>
					)}

					<form class="cluster" onSubmit={handleSend} style={{ alignItems: "flex-end" }}>
						<input ref={fileInputRef} type="file" style={{ display: "none" }} onChange={handleFileSelected} aria-hidden="true" tabIndex={-1} />
						<button
							type="button"
							onClick={() => fileInputRef.current?.click()}
							disabled={recordingState !== "idle"}
							aria-label="Прикрепить файл"
						>
							📎
						</button>
						<button
							type="button"
							onClick={handleStartRecording}
							disabled={recordingState !== "idle" || !!attachmentFile}
							aria-label="Записать голосовое сообщение"
						>
							🎤
						</button>
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
						<button
							type="submit"
							disabled={busy || (text.length === 0 && !attachmentFile && !recordedVoiceBlob) || (!!attachmentFile && !!attachmentError)}
						>
							Отправить
						</button>
					</form>
				</div>
			}
		>
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
			{messages.length === 0 && <p style={{ color: "var(--muted)" }}>Сообщений пока нет — напишите первое!</p>}
			<div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2xs)" }}>
				{messages.map((message) => {
					const isOwn = message.senderPubkey === ownerPubkey;
					return (
						<MessageBubble
							key={message.msgId}
							message={message}
							isOwn={isOwn}
							onDeleteForMe={handleDeleteForMe}
							onDeleteForBoth={isOwn ? handleDeleteForBoth : undefined}
							onEdit={isOwn ? handleEdit : undefined}
							maxLength={MAX_MESSAGE_LENGTH}
						/>
					);
				})}
				<div ref={bottomRef} />
			</div>
		</Screen>
	);
}

export default function Chat() {
	const ownerPubkey = currentUser.value.id;
	const privKey = privKeySig.value;
	const dbKey = dbKeySig.value;

	const [connectionError, setConnectionError] = useState("");

	useEffect(() => {
		ensureConnected(ownerPubkey, privKey, dbKey)
			.then(() => refreshLiveProfileSubscription(ownerPubkey))
			.catch((e) => setConnectionError(e?.message || String(e)));
	}, [ownerPubkey]);

	if (activeChatPubkey.value) {
		return <ChatWindow ownerPubkey={ownerPubkey} privKey={privKey} dbKey={dbKey} contactPubkey={activeChatPubkey.value} />;
	}

	return <ChatList ownerPubkey={ownerPubkey} privKey={privKey} dbKey={dbKey} connectionError={connectionError} />;
}
