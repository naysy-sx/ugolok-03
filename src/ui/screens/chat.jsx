import { useState, useEffect, useRef } from "preact/hooks";
import { BUILD_DEFAULT_BLOSSOM_SERVERS } from "../../config.js";
import { shortPubkey } from "../format.js";
import { currentUser, privKeySig, dbKeySig } from "../signals/auth.js";
import {
	ensureConnected,
	publish,
	publishToContact,
	fetchProfiles,
	fetchKeyPackage,
	refreshGroupMessageSubscription,
	refreshLiveProfileSubscription,
	nextLamportTick,
} from "../signals/transport.js";
import { activeChatPubkey, openChat } from "../signals/chat.js";
import { profiles, refreshProfiles } from "../signals/contacts.js";
import { placeCall } from "../signals/call.js";
import IconPhoneCall from "../icons/phone-call.jsx";
import IconSend from "../icons/send.jsx";
import IconEraser from "../icons/eraser.jsx";
import IconPaperclip from "../icons/paperclip.jsx";
import IconMicrophone from "../icons/microphone.jsx";
import IconStop from "../icons/stop.jsx";
import IconCross from "../icons/cross.jsx";
import IconFolder from "../icons/folder.jsx";
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
import { validateAttachment } from "../../domain/files/attachment-validation.js";
import { uploadMessageAttachment, referenceStoredFile } from "../../domain/messaging/attachments.js";
import { createVoiceRecorder, shouldInlineVoice } from "../../domain/messaging/voice.js";
import { getManifest, getRange } from "../../domain/files/content.js";
import { getFileKeyFor, projected } from "../signals/files.js";
import MessageBubble from "../components/message-bubble.jsx";
import AttachmentPreview from "../components/attachment-preview.jsx";
import FilePicker from "../components/file-picker.jsx";
import Screen from "../components/screen.jsx";
import { t, errorMessage } from "../signals/i18n.js";

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
				if (!cancelled) setListError(errorMessage(err));
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
			setListError(errorMessage(err));
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
		<Screen title={t("nav.messages")} feed>
			<div class="stack" style={{ "--gap": "var(--space-l)" }}>
			{/* "Соединение: ..." переехало в постоянную панель под главным меню
			    (app.jsx, ConnectionStatusPanel) — видна на любом экране (пользователь,
			    item 4). */}
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

			<section class="stack" aria-labelledby="inbox-heading" style={{ "--gap": "var(--space-s)" }}>
				<h2 id="inbox-heading">{t("chat.list.inboxHeading", { count: inboxList.length })}</h2>
				{inboxList.length === 0 ? (
					<p style={{ color: "var(--muted)" }}>{t("chat.list.noInboxRequests")}</p>
				) : (
					<ul role="list" style={{ listStyle: "none", paddingInlineStart: 0 }}>
						{inboxList.map((req) => (
							<li
								key={req.senderPubkey}
								class="row"
								style={{
									"--gap": "var(--space-s)",
									alignItems: "center",
									justifyContent: "space-between",
									paddingBlock: "var(--space-s)",
									borderBlockEnd: "var(--border-width) solid var(--border)",
								}}
							>
								<ContactIdentity pubkey={req.senderPubkey} />
								<div class="row" style={{ "--gap": "var(--space-s)", alignItems: "center" }}>
									<button type="button" disabled={busy} onClick={() => handleAccept(req.senderPubkey)}>
										{t("contacts.acceptButton")}
									</button>
									<button type="button" disabled={busy} onClick={() => handleReject(req.senderPubkey)}>
										{t("contacts.rejectButton")}
									</button>
								</div>
							</li>
						))}
					</ul>
				)}
			</section>

			<section class="stack" aria-labelledby="chats-heading" style={{ "--gap": "var(--space-s)" }}>
				<h2 id="chats-heading">{t("chat.list.chatsHeading", { count: chatPartners.length })}</h2>
				{chatPartners.length === 0 ? (
					<p style={{ color: "var(--muted)" }}>
						{t("chat.list.noChatsYet", { contactsLabel: t("nav.contacts") })}
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
									aria-label={t("contacts.openChatAria", { name: profiles.value[pubkey]?.name || shortPubkey(pubkey) })}
									class="row"
									style={{
										"--gap": "var(--space-s)",
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
											aria-label={t("chat.list.unreadAria", { count: unreadByPartner[pubkey] })}
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
			</div>
		</Screen>
	);
}

function ChatWindow({ ownerPubkey, privKey, dbKey, contactPubkey }) {
	// Этап 60 — kind:445 (MLS group message, отправка/удаление/правка — все три
	// используют chat.js's sendMessage под капотом, см. deletions.js/edits.js)
	// не несёт тега #p (адресация по #h группы, эфемерный отправитель), поэтому
	// generic publish()'s auto-детект получателя тут не сработает — получатель
	// передаётся явно.
	const publishToChatPartner = (event) => publishToContact(event, contactPubkey);
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
	const [attachmentPickerOpen, setAttachmentPickerOpen] = useState(false);
	// Заполнено ТОЛЬКО когда attachmentFile пришёл из "Файлы" (не с диска/не
	// запись) — {manifestDigest, fileKey, manifest}, уже известные узлу.
	// Наличие этой ссылки означает: buildOutgoingAttachment ОБЯЗАН собрать
	// дескриптор через referenceStoredFile (без сети, без повторной заливки —
	// MATH.md §7 "передают Digest блоба, а не копию байтов"), а НЕ через
	// uploadMessageAttachment. attachmentFile сам по себе (File, декодированный
	// ЛОКАЛЬНО из этих же bytes) остаётся нужен ТОЛЬКО для превью
	// (AttachmentPreview требует File-подобный объект с URL.createObjectURL).
	const [attachmentSourceRef, setAttachmentSourceRef] = useState(null);
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
	// Общий хвост обоих источников (с диска/из хранилища, И7 7.3) — file уже
	// готовый File/Blob-подобный объект (name/type/size/arrayBuffer()), откуда он
	// взят — не важно ниже по стеку для ПРЕВЬЮ (validateAttachment/AttachmentPreview
	// агностичны к происхождению). sourceRef (не null, только из хранилища) —
	// см. buildOutgoingAttachment: решает, заливать ли файл заново или сослаться
	// на уже существующий digest (MATH.md §7 — дедупликация).
	function applySelectedFile(file, sourceRef = null) {
		setRecordingState("idle");
		setRecordedVoiceBlob(null);
		setAttachmentFile(file);
		setAttachmentSourceRef(sourceRef);
		setAttachmentPosition("below");
		try {
			validateAttachment({ mime: file.type, size: file.size });
			setAttachmentError("");
		} catch (err) {
			// Файл ВСЁ РАВНО показывается (AttachmentPreview покажет причину отказа) —
			// пользователь должен понимать, ЧТО он выбрал и почему это не пройдёт, а не
			// молча ничего не происходит.
			setAttachmentError(errorMessage(err));
		}
	}

	function handleFileSelected(e) {
		const file = e.currentTarget.files?.[0];
		e.currentTarget.value = ""; // иначе повторный выбор ТОГО ЖЕ файла не даёт onChange
		if (!file) return;
		applySelectedFile(file);
	}

	// И7 7.3/7.4 — вложение ИЗ ХРАНИЛИЩА (FilePicker, §5.7 TASK.md). Дедупликация
	// (MATH.md §7: "передают Digest блоба, а не копию байтов") — файл НЕ
	// перезаливается заново под новым ключом (это создавало бы дубликат блоба,
	// первая версия 7.3 так и делала — исправлено этим проходом), дескриптор
	// вложения ссылается на ТОТ ЖЕ manifestDigest/fileKey узла. Расшифровка
	// (getRange) здесь — ТОЛЬКО ради локального превью (AttachmentPreview),
	// сети/повторной заливки не требует. С момента отправки получатель держит
	// fileKey НАВСЕГДА — отозвать нельзя (решение №9 TASK.md), предупреждение —
	// ДО расшифровки, простой window.confirm() (тот же приём, что аватар 7.2/
	// необратимые действия files.jsx).
	async function handleAttachmentFromStorage([nodeId]) {
		setAttachmentPickerOpen(false);
		const node = projected.value.nodes.get(nodeId);
		if (!node || node.kind !== "file") return;
		if (!window.confirm(t("chat.window.sendAttachmentConfirm"))) return;
		try {
			const manifest = await getManifest(node.blob, { serverUrl: BLOSSOM_SERVER_URL });
			const fileKey = await getFileKeyFor(node.blob);
			if (!fileKey) {
				setError(t("chat.window.fileKeyNotFoundError"));
				return;
			}
			const bytes = await getRange(manifest, fileKey, 0, manifest.size, { serverUrl: BLOSSOM_SERVER_URL });
			applySelectedFile(new File([bytes], node.displayName, { type: manifest.mime }), { manifestDigest: node.blob, fileKey, manifest });
		} catch (err) {
			setError(errorMessage(err));
		}
	}

	function handleRemoveAttachment() {
		setAttachmentFile(null);
		setAttachmentSourceRef(null);
		setAttachmentError("");
	}

	async function handleStartRecording() {
		setError("");
		setAttachmentFile(null); // взаимоисключение — начатая запись отменяет выбранный файл
		setAttachmentSourceRef(null);
		const recorder = createVoiceRecorder();
		try {
			await recorder.start();
			voiceRecorderRef.current = recorder;
			setRecordingState("recording");
		} catch (err) {
			setError(errorMessage(err));
		}
	}

	async function handleStopRecording() {
		if (!voiceRecorderRef.current) return;
		try {
			const blob = await voiceRecorderRef.current.stop();
			setRecordedVoiceBlob(blob);
			setRecordingState("recorded");
		} catch (err) {
			setError(errorMessage(err));
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
			// attachmentSourceRef — файл пришёл из "Файлы" (handleAttachmentFromStorage):
			// БЕЗ сети, ссылка на уже существующий блоб (MATH.md §7 — дедупликация,
			// не повторная заливка под новым ключом).
			if (attachmentSourceRef) {
				const descriptor = referenceStoredFile(attachmentSourceRef.manifestDigest, attachmentSourceRef.fileKey, attachmentSourceRef.manifest);
				if (descriptor.type === "image") descriptor.position = attachmentPosition;
				return descriptor;
			}
			validateAttachment({ mime: attachmentFile.type, size: attachmentFile.size }); // повторно, defense-in-depth
			const bytes = new Uint8Array(await attachmentFile.arrayBuffer());
			const descriptor = await uploadMessageAttachment(BLOSSOM_SERVER_URL, bytes, { mime: attachmentFile.type, name: attachmentFile.name }, privKey);
			if (descriptor.type === "image") descriptor.position = attachmentPosition;
			return descriptor;
		}
		if (recordedVoiceBlob) {
			const bytes = new Uint8Array(await recordedVoiceBlob.arrayBuffer());
			if (shouldInlineVoice(bytes.length)) {
				return { type: "audio", voice: true, mime: "audio/webm", name: t("chat.voiceMessageName"), size: bytes.length, voiceInline: base64FromBytes(bytes) };
			}
			const descriptor = await uploadMessageAttachment(BLOSSOM_SERVER_URL, bytes, { mime: "audio/webm", name: t("chat.voiceMessageName") }, privKey);
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
			setError(t("chat.window.messageTooLong", { max: MAX_MESSAGE_LENGTH }));
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
				publishToChatPartner,
				fetchKeyPackage,
				refreshGroupMessageSubscription,
				attachment,
			);
			if (draftTimerRef.current) clearTimeout(draftTimerRef.current);
			setText("");
			setAttachmentFile(null);
			setAttachmentSourceRef(null);
			setAttachmentError("");
			setRecordedVoiceBlob(null);
			setRecordingState("idle");
			await saveChatDraftAction(ownerPubkey, privKey, dbKey, contactPubkey, "", publish).catch(() => {});
			await reloadWindow();
		} catch (err) {
			setError(errorMessage(err));
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
			await deleteChatMessageAction(ownerPubkey, privKey, dbKey, contactPubkey, msgId, lamportTs, publishToChatPartner);
			await reloadWindow();
		} catch (err) {
			setError(errorMessage(err));
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
			setError(errorMessage(err));
		}
	}

	async function handleClearHistory() {
		if (!window.confirm(t("chat.window.clearHistoryConfirm"))) return;
		try {
			await clearChatHistoryAction(ownerPubkey, contactPubkey);
			await reloadWindow();
		} catch (err) {
			setError(errorMessage(err));
		}
	}

	async function handleEdit(msgId, newText) {
		if (busyRef.current) return;
		if (newText.length > MAX_MESSAGE_LENGTH) {
			setError(t("chat.window.messageTooLong", { max: MAX_MESSAGE_LENGTH }));
			return;
		}
		busyRef.current = true;
		setBusy(true);
		try {
			const lamportTs = await nextLamportTick(ownerPubkey);
			await editChatMessageAction(ownerPubkey, privKey, dbKey, contactPubkey, msgId, newText, lamportTs, publishToChatPartner);
			await reloadWindow();
		} catch (err) {
			setError(errorMessage(err));
		} finally {
			busyRef.current = false;
			setBusy(false);
		}
	}

	const profile = profiles.value[contactPubkey];
	const displayName = profile?.name || shortPubkey(contactPubkey);

	return (
		<Screen
			breadcrumb={{ label: t("nav.messages"), onBack: () => openChat(null) }}
			title={displayName}
			actions={
				<>
					<button type="button" onClick={() => placeCall(contactPubkey)} aria-label={t("contacts.callAria", { name: displayName })}>
						<IconPhoneCall /> {t("common.call")}
					</button>
					<button type="button" onClick={handleClearHistory}>
						<IconEraser /> {t("chat.window.clearHistoryButton")}
					</button>
				</>
			}
			feed
			footer={
				<div class="stack" style={{ "--gap": "var(--space-2xs)" }}>
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
						<p class="row recording-status" style={{ "--gap": "var(--space-s)", alignItems: "center" }} role="status">
							<span class="recording-dot" aria-hidden="true" /> {t("chat.window.recordingStatus")}
							<button type="button" onClick={handleStopRecording}>
								<IconStop /> {t("common.stop")}
							</button>
							<button type="button" onClick={handleCancelRecording}>
								<IconCross /> {t("contacts.cancelRequestButton")}
							</button>
						</p>
					)}

					{recordingState === "recorded" && recordedVoiceUrl && (
						<p class="row recording-status" style={{ "--gap": "var(--space-s)", alignItems: "center" }}>
							<audio controls src={recordedVoiceUrl} />
							<button type="button" onClick={handleDiscardRecordedVoice}>
								<IconCross /> {t("chat.window.deleteRecordingButton")}
							</button>
						</p>
					)}

					{uploadingAttachment && (
						<p class="row recording-status" style={{ "--gap": "var(--space-s)", alignItems: "center" }} role="status">
							<span class="spinner" aria-hidden="true" /> {t("chat.window.uploadingAttachment")}
						</p>
					)}

					<form class="message-compose" onSubmit={handleSend}>
						<input ref={fileInputRef} type="file" style={{ display: "none" }} onChange={handleFileSelected} aria-hidden="true" tabIndex={-1} />
						<button
							type="button"
							class="message-compose-tool-btn"
							onClick={() => fileInputRef.current?.click()}
							disabled={recordingState !== "idle"}
							aria-label={t("chat.window.attachFileAria")}
						>
							<IconPaperclip />
						</button>
						<button
							type="button"
							class="message-compose-tool-btn"
							onClick={() => setAttachmentPickerOpen(true)}
							disabled={recordingState !== "idle"}
							aria-label={t("chat.window.attachFromStorageAria")}
						>
							<IconFolder />
						</button>
						<button
							type="button"
							class="message-compose-tool-btn"
							onClick={handleStartRecording}
							disabled={recordingState !== "idle" || !!attachmentFile}
							aria-label={t("chat.window.recordVoiceAria")}
						>
							<IconMicrophone />
						</button>
						<label class="visually-hidden" for="chat-message-input">
							{t("chat.window.messageLabel")}
						</label>
						<textarea
							id="chat-message-input"
							class="message-compose-field"
							value={text}
							maxLength={MAX_MESSAGE_LENGTH}
							onInput={handleTextInput}
							rows={2}
						/>
						<button
							type="submit"
							class="message-compose-send-btn"
							disabled={busy || (text.length === 0 && !attachmentFile && !recordedVoiceBlob) || (!!attachmentFile && !!attachmentError)}
							aria-label={t("common.send")}
						>
							<IconSend />
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
					{t("chat.window.loadOlderButton")}
				</button>
			)}
			{messages.length === 0 && <p style={{ color: "var(--muted)" }}>{t("chat.window.noMessagesYet")}</p>}
			<div class="message-list">
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
			{attachmentPickerOpen && <FilePicker predicate={() => true} multiple={false} onSelect={handleAttachmentFromStorage} onCancel={() => setAttachmentPickerOpen(false)} />}
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
			.catch((e) => setConnectionError(errorMessage(e)));
	}, [ownerPubkey]);

	if (activeChatPubkey.value) {
		return <ChatWindow ownerPubkey={ownerPubkey} privKey={privKey} dbKey={dbKey} contactPubkey={activeChatPubkey.value} />;
	}

	return <ChatList ownerPubkey={ownerPubkey} privKey={privKey} dbKey={dbKey} connectionError={connectionError} />;
}
