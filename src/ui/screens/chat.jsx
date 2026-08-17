import { useState, useEffect, useRef } from "preact/hooks";
import { BUILD_DEFAULT_BLOSSOM_SERVERS } from "../../config.js";
import { shortPubkey } from "../format.js";
import { currentUser, privKeySig, dbKeySig } from "../signals/auth.js";
import {
	ensureConnected,
	publish,
	publishToContact,
	fetchProfiles,
	fetchDeviceKeyPackages,
	refreshGroupMessageSubscription,
	refreshLiveProfileSubscription,
	nextLamportTick,
} from "../signals/transport.js";
import { activeChatPubkey, openChat } from "../signals/chat.js";
import { contacts, profiles, refreshAll, refreshProfiles } from "../signals/contacts.js";
import { placeCall } from "../signals/call.js";
import IconPhoneCall from "../icons/phone-call.jsx";
import IconSend from "../icons/send.jsx";
import IconEraser from "../icons/eraser.jsx";
import IconPaperclip from "../icons/paperclip.jsx";
import IconMicrophone from "../icons/microphone.jsx";
import IconStop from "../icons/stop.jsx";
import IconCross from "../icons/cross.jsx";
import IconFolder from "../icons/folder.jsx";
import IconPencil from "../icons/pencil.jsx";
import IconArrowLeft from "../icons/arrow-left.jsx";
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
import { MAX_ATTACHMENTS_PER_MESSAGE } from "../../domain/files/attachment-validation.js";
import { uploadMessageAttachment } from "../../domain/messaging/attachments.js";
import { createVoiceRecorder, shouldInlineVoice } from "../../domain/messaging/voice.js";
import { getManifest } from "../../domain/files/content.js";
import { getFileKeyFor, projected } from "../signals/files.js";
import MessageBubble from "../components/message-bubble.jsx";
import AttachmentTray from "../components/media/attachment-tray.jsx";
import { useAttachmentTray } from "../hooks/use-attachment-tray.js";
import FilePicker from "../components/file-picker.jsx";
import Screen from "../components/screen.jsx";
import { openMedia } from "../signals/media.js";
import { collectChatScope, findRefPosition } from "../../domain/media/scope.js";
import { buildPlaylist } from "../../domain/media/playlist.js";
import { classOf, refFromAttachment } from "../../domain/media/media-ref.js";
import MediaButtons from "../components/media/media-buttons.jsx";
import { t, errorMessage } from "../signals/i18n.js";
import MarkdownFormatToolbar from "../components/markdown-format-toolbar.jsx";

const MAX_MESSAGE_LENGTH = 10000; // F-MS-08
const BLOSSOM_SERVER_URL = BUILD_DEFAULT_BLOSSOM_SERVERS[0]; // F-AT-09 (список в settings) — этап 32

function base64FromBytes(bytes) {
	return btoa(String.fromCharCode.apply(null, bytes));
}

// contacts.jsx уже вызывает ensureConnected при заходе на вкладку "Контакты" — но
// пользователь может открыть "Сообщения" напрямую, минуя её. ensureConnected идемпотентна
// (singleton-соединение на вкладку), повторный вызов отсюда безопасен.
function ChatList({ ownerPubkey, privKey, dbKey, connectionError, onCompose }) {
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
					// Найденный баг (пользователь, аватар собеседника без контакта не
					// подгружался): fetchProfiles бросает "нет активного соединения", если
					// вызвана раньше ensureConnected. Комментарий над ChatList всегда
					// обещал, что этот вызов идемпотентен и безопасен отсюда — но сам вызов
					// тут отсутствовал, а эффект Chat() (родителя), который реально
					// подключается, коммитится ПОСЛЕ дочернего ChatList (React/Preact
					// гарантируют порядок "снизу вверх" для useEffect на монтировании) —
					// то есть на первом заходе (минуя "Контакты") fetchProfiles ГАРАНТИРОВАННО
					// падал и профиль (в т.ч. аватар) собеседника без контакта, для которого
					// это единственный шанс подгрузиться (нет постоянной live-подписки,
					// см. refreshLiveProfileSubscription — она перечисляет только contacts),
					// не подтягивался вообще, пока не прилетит новое сообщение от него.
					try {
						await ensureConnected(ownerPubkey, privKey, dbKey);
						// Найденный баг (пользователь): ensureProfilesFetched никогда не обновляла
						// уже закэшированное био/имя — refreshProfiles безусловно перезаписывает.
						await refreshProfiles(allPubkeys, fetchProfiles);
					} catch {
						// Офлайн/сеть недоступна — список чатов всё равно показываем по уже
						// загруженным локальным данным, профили подтянутся при следующем
						// срабатывании эффекта (messagingActivity/повторное открытие экрана).
					}
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

	// Пользователь: заголовки-секции "Входящие"/"Чаты" и заглушка "Нет новых
	// запросов..." — лишний визуальный шум с огромными отступами между собой;
	// остаётся только сам список (принять/отклонить для заявок незнакомцев —
	// функционал сохранён, просто без подписи-секции, когда заявок нет —
	// секция схлопывается целиком, а не показывает пустую заглушку).
	const totalUnread = Object.values(unreadByPartner).reduce((sum, n) => sum + n, 0);

	return (
		<Screen
			title={totalUnread > 0 ? `${t("nav.messages")} [${totalUnread}]` : t("nav.messages")}
			actions={
				<button type="button" onClick={onCompose}>
					<IconPencil /> {t("chat.list.composeButton")}
				</button>
			}
			feed
		>
			<div class="stack" style={{ "--gap": "var(--space-l)" }}>
			{/* "Соединение: ..." переехало в постоянную панель под главным меню
			    (app.jsx, ConnectionStatusPanel) — видна на любом экране (пользователь,
			    item 4). */}
			{connectionError && (
				<p role="alert" style={{ color: "var(--bad)" }}>
					{connectionError}
				</p>
			)}
			{listError && (
				<p role="alert" style={{ color: "var(--bad)" }}>
					{listError}
				</p>
			)}

			{inboxList.length > 0 && (
				<section class="stack" aria-label={t("chat.list.inboxHeading", { count: inboxList.length })} style={{ "--gap": "var(--space-s)" }}>
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
									<button type="button" class="btn--ghost btn--good" disabled={busy} onClick={() => handleAccept(req.senderPubkey)}>
										{t("contacts.acceptButton")}
									</button>
									<button type="button" disabled={busy} onClick={() => handleReject(req.senderPubkey)}>
										{t("contacts.rejectButton")}
									</button>
								</div>
							</li>
						))}
					</ul>
				</section>
			)}

			<section class="stack" aria-label={t("chat.list.chatsHeading", { count: chatPartners.length })} style={{ "--gap": "var(--space-s)" }}>
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
									<ContactIdentity pubkey={pubkey} unreadCount={unreadByPartner[pubkey]} />
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
	// Ошибки самой отправки (текст/вложение/голос) — отдельно от error (тот уходит в
	// ленту сообщений через Screen's children и не виден пользователю при длинной
	// истории). Рендерится в footer, рядом с кнопкой "Отправить" — там, где
	// пользователь только что кликнул.
	const [composeError, setComposeError] = useState("");
	const [busy, setBusy] = useState(false);
	const busyRef = useRef(false);
	const draftTimerRef = useRef(null);
	const composerTextareaRef = useRef(null);
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

	// Этап 29 — вложения; этап B4 — лоток мультивыбора (useAttachmentTray, B3).
	// Лоток и recordedVoiceBlob (голосовая запись) ВЗАИМОИСКЛЮЧАЮЩИЕ — сообщение
	// несёт либо вложения, либо голосовое, не оба сразу (тот же принцип, что
	// большинство мессенджеров). fileInputRef — скрытый <input type=file multiple>,
	// кнопка "Прикрепить" триггерит его клик программно.
	const tray = useAttachmentTray({ maxItems: MAX_ATTACHMENTS_PER_MESSAGE });
	const [attachmentPickerOpen, setAttachmentPickerOpen] = useState(false);
	const fileInputRef = useRef(null);

	// recordingState: "idle" | "recording" | "recorded". voiceRecorderRef держит
	// createVoiceRecorder()-экземпляр между start()/stop()/cancel() одного захода записи.
	const [recordingState, setRecordingState] = useState("idle");
	const [recordedVoiceBlob, setRecordedVoiceBlob] = useState(null);
	const voiceRecorderRef = useRef(null);
	const [uploadingAttachment, setUploadingAttachment] = useState(false);

	// Object URL для прослушивания ЗАПИСАННОГО (ещё не отправленного) голоса —
	// создать один раз на смену blob, освободить на очистке/размонтировании,
	// не пересоздавать на каждый рендер (тот же принцип, что objectUrl в
	// components/media/attachment-tray.jsx для превью картинок).
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

	// Markdown-этап D — извлечено из handleTextInput, чтобы панель форматирования
	// (программная вставка, не пользовательский onInput-event) шла тем же путём
	// (черновик обязан сохраняться и после вставки разметки кнопкой).
	function applyTextChange(value) {
		userEditedRef.current = true;
		setText(value);
		if (draftTimerRef.current) clearTimeout(draftTimerRef.current);
		draftTimerRef.current = setTimeout(() => {
			saveChatDraftAction(ownerPubkey, privKey, dbKey, contactPubkey, value, publish).catch(() => {});
		}, 1000);
	}

	function handleTextInput(e) {
		applyTextChange(e.currentTarget.value);
	}

	// Прикрепление/голосовое взаимоисключающие — начало одного сбрасывает другое.
	function handleFilesSelected(e) {
		// FileList из e.currentTarget.files — ЖИВАЯ ссылка на список инпута:
		// обнуление e.currentTarget.value ДО addFiles() опустошило бы её же
		// (тот же объект, не копия) — addFiles() должен уйти первым.
		const files = e.currentTarget.files;
		if (!files || files.length === 0) return;
		setRecordingState("idle");
		setRecordedVoiceBlob(null);
		tray.addFiles(files);
		e.currentTarget.value = ""; // иначе повторный выбор ТЕХ ЖЕ файлов не даёт onChange
	}

	// И7 7.3/7.4 — вложение ИЗ ХРАНИЛИЩА (FilePicker, §5.7 TASK.md). Дедупликация
	// (MATH.md §7: "передают Digest блоба, а не копию байтов") — файл НЕ
	// перезаливается заново под новым ключом, дескриптор вложения ссылается на
	// ТОТ ЖЕ manifestDigest/fileKey узла. Этап B4: расшифровка байтов больше НЕ
	// нужна здесь — AttachmentTray (B3) для storage-item превью показывает
	// только иконку, не картинку, поэтому `getRange` снят (не тянем в память
	// файл целиком ради того, что не рендерится). С момента отправки получатель
	// держит fileKey НАВСЕГДА — отозвать нельзя (решение №9 TASK.md),
	// предупреждение — ДО обращения к хранилищу, простой window.confirm() (тот
	// же приём, что аватар 7.2/необратимые действия files.jsx).
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
			setRecordingState("idle");
			setRecordedVoiceBlob(null);
			tray.addFromStorage([{ manifestDigest: node.blob, fileKey, manifest }]);
		} catch (err) {
			setError(errorMessage(err));
		}
	}

	async function handleStartRecording() {
		setError("");
		tray.reset(); // взаимоисключение — начатая запись отменяет выбранные вложения
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
	// Этап B4 медиа-подсистемы — лоток и голос взаимоисключающие (гарантировано
	// UI: старт записи вызывает tray.reset(), выбор файла сбрасывает запись),
	// поэтому здесь простое ветвление, не слияние.
	async function buildOutgoingAttachments() {
		if (tray.items.length > 0) return tray.uploadAll(privKey);
		if (recordedVoiceBlob) {
			const bytes = new Uint8Array(await recordedVoiceBlob.arrayBuffer());
			if (shouldInlineVoice(bytes.length)) {
				return [{ type: "audio", voice: true, mime: "audio/webm", name: t("chat.voiceMessageName"), size: bytes.length, voiceInline: base64FromBytes(bytes) }];
			}
			const descriptor = await uploadMessageAttachment(BLOSSOM_SERVER_URL, bytes, { mime: "audio/webm", name: t("chat.voiceMessageName") }, privKey);
			descriptor.voice = true;
			return [descriptor];
		}
		return undefined;
	}

	async function handleSend(e) {
		e.preventDefault();
		if (busyRef.current) return;
		if (text.length === 0 && tray.items.length === 0 && !recordedVoiceBlob) return; // нечего отправлять
		if (tray.items.some((item) => item.error)) return; // невалидное вложение — сначала убрать/заменить
		if (text.length > MAX_MESSAGE_LENGTH) {
			setComposeError(t("chat.window.messageTooLong", { max: MAX_MESSAGE_LENGTH }));
			return;
		}
		busyRef.current = true;
		setComposeError("");
		setBusy(true);
		try {
			// Загрузка на Blossom (если есть вложение) — ДО тика Lamport-часов и
			// отправки: сбой загрузки не должен продвигать часы/создавать пустой tick
			// впустую, и вложение/голос ОСТАЮТСЯ в состоянии компоновки для повторной
			// попытки (не теряются на сетевой ошибке).
			setUploadingAttachment(true);
			const attachments = await buildOutgoingAttachments();
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
				fetchDeviceKeyPackages,
				refreshGroupMessageSubscription,
				attachments,
			);
			if (draftTimerRef.current) clearTimeout(draftTimerRef.current);
			setText("");
			tray.reset();
			setRecordedVoiceBlob(null);
			setRecordingState("idle");
			await saveChatDraftAction(ownerPubkey, privKey, dbKey, contactPubkey, "", publish).catch(() => {});
			await reloadWindow();
		} catch (err) {
			setComposeError(errorMessage(err));
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

	// Этап E, E3 (CONTRACTS.md/DESIGN.md "Этап E") — scope на ВЕСЬ загруженный
	// чат (messages уже в состоянии, collectChatScope — Этап A). Ключи/размер
	// уже внутри дескриптора вложения (refFromAttachment) — БЕЗ сети, в
	// отличие от files.jsx's openFolderMediaClass.
	function classesInMessages() {
		const present = { audio: false, video: false, image: false };
		for (const ref of collectChatScope(messages)) {
			const c = classOf(ref.mime);
			if (c in present) present[c] = true;
		}
		return present;
	}

	function openChatMediaClass(cls) {
		const refs = collectChatScope(messages);
		const playlist = buildPlaylist(refs);
		const position = playlist.idx[cls]?.[0];
		if (position === undefined) return;
		openMedia({ refs, position });
	}

	// Этап F, F1/F2 (CONTRACTS.md/DESIGN.md "Этап F") — клик по КОНКРЕТНОМУ
	// вложению в пузыре. sourceMeta {msgId: message.id} — тот же ключ, что уже
	// строит collectChatScope сам (Этап A), иначе findRefPosition не найдёт
	// совпадение (message.id — nostr event.id, НЕ message.msgId, тот другой
	// стабильный идентификатор для edit/delete — Stage A's контракт, не бага).
	function openAttachment(message, attachment) {
		const refs = collectChatScope(messages);
		const target = refFromAttachment(attachment, { msgId: message.id });
		const position = findRefPosition(refs, target.digest, target.sourceMeta);
		if (position === -1) return;
		openMedia({ refs, position });
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
					<button type="button" class="btn--ghost btn--danger" onClick={handleClearHistory}>
						<IconEraser /> {t("chat.window.clearHistoryButton")}
					</button>
				</>
			}
			mediaButtons={<MediaButtons counts={classesInMessages()} onOpen={openChatMediaClass} />}
			feed
			footer={
				<div class="stack" style={{ "--gap": "var(--space-2xs)" }}>
					{composeError && (
						<p role="alert" style={{ color: "var(--bad)" }}>
							{composeError}
						</p>
					)}

					{(tray.items.length > 0 || tray.errors.length > 0) && (
						<AttachmentTray items={tray.items} errors={tray.errors} onRemove={tray.remove} onPositionChange={tray.setPosition} />
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

					<MarkdownFormatToolbar textareaRef={composerTextareaRef} value={text} onChange={applyTextChange} />
					<form class="message-compose row" style={{ "--gap": "var(--space-2xs)", alignItems: "center" }} onSubmit={handleSend}>
						<input ref={fileInputRef} type="file" multiple style={{ display: "none" }} onChange={handleFilesSelected} aria-hidden="true" tabIndex={-1} />
						<button
							type="button"
							class="message-compose-tool-btn row"
							style={{ alignItems: "center", justifyContent: "center" }}
							onClick={() => fileInputRef.current?.click()}
							disabled={recordingState !== "idle"}
							aria-label={t("chat.window.attachFileAria")}
						>
							<IconPaperclip />
						</button>
						<button
							type="button"
							class="message-compose-tool-btn row"
							style={{ alignItems: "center", justifyContent: "center" }}
							onClick={() => setAttachmentPickerOpen(true)}
							disabled={recordingState !== "idle"}
							aria-label={t("chat.window.attachFromStorageAria")}
						>
							<IconFolder />
						</button>
						<button
							type="button"
							class="message-compose-tool-btn row"
							style={{ alignItems: "center", justifyContent: "center" }}
							onClick={handleStartRecording}
							disabled={recordingState !== "idle" || tray.items.length > 0}
							aria-label={t("chat.window.recordVoiceAria")}
						>
							<IconMicrophone />
						</button>
						<label class="visually-hidden" for="chat-message-input">
							{t("chat.window.messageLabel")}
						</label>
						<textarea
							id="chat-message-input"
							ref={composerTextareaRef}
							class="message-compose-field"
							value={text}
							maxLength={MAX_MESSAGE_LENGTH}
							onInput={handleTextInput}
							rows={2}
						/>
						<button
							type="submit"
							class="message-compose-send-btn row"
							style={{ alignItems: "center", justifyContent: "center" }}
							disabled={busy || (text.length === 0 && tray.items.length === 0 && !recordedVoiceBlob) || tray.items.some((item) => item.error)}
							aria-label={t("common.send")}
						>
							<IconSend />
						</button>
					</form>
				</div>
			}
		>
			{error && (
				<p role="alert" style={{ color: "var(--bad)" }}>
					{error}
				</p>
			)}
			{hasMore && (
				<button type="button" onClick={handleLoadMore}>
					{t("chat.window.loadOlderButton")}
				</button>
			)}
			{messages.length === 0 && <p style={{ color: "var(--muted)" }}>{t("chat.window.noMessagesYet")}</p>}
			<div class="message-list stack" style={{ "--gap": "var(--space-2xs)" }}>
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
							onOpenAttachment={openAttachment}
						/>
					);
				})}
				<div ref={bottomRef} />
			</div>
			{attachmentPickerOpen && <FilePicker predicate={() => true} multiple={false} onSelect={handleAttachmentFromStorage} onCancel={() => setAttachmentPickerOpen(false)} />}
		</Screen>
	);
}

// "Написать" (header-actions ChatList) — короткая форма "кому/текст/вложение",
// БЕЗ повторной реализации отправки+вложений: и то, и другое — те же функции,
// что уже использует ChatWindow (sendChatMessageAction/buildOutgoingAttachment
// логика вложения скопирована в укороченном виде — без голосовых/из хранилища,
// пользователь просил именно "выбрать и отправить файлы"). После отправки —
// сразу переход в открывшийся чат (openChat), как и ожидал бы пользователь.
function ComposeMessage({ ownerPubkey, privKey, dbKey, onCancel, onSent }) {
	const [to, setTo] = useState("");
	const [text, setText] = useState("");
	const tray = useAttachmentTray({ maxItems: MAX_ATTACHMENTS_PER_MESSAGE });
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const busyRef = useRef(false);
	const composeTextareaRef = useRef(null);

	useEffect(() => {
		// Тот же приём, что в contacts.jsx: сначала пересчёт из уже загруженной
		// (с прошлого захода) Map, затем — свежие данные после подключения, чтобы
		// datalist "Кому" не оставался пустым, если пользователь попал в
		// "Сообщения" напрямую, минуя "Контакты" в этой сессии.
		refreshAll();
		ensureConnected(ownerPubkey, privKey, dbKey)
			.then(async () => {
				refreshAll();
				await refreshProfiles(contacts.value, fetchProfiles).catch(() => {});
			})
			.catch((e) => setError(errorMessage(e)));
	}, [ownerPubkey]);

	function handleFilesSelected(e) {
		// FileList — живая ссылка на список инпута: addFiles() должен уйти
		// ДО обнуления value (см. тот же комментарий в ChatWindow).
		const files = e.currentTarget.files;
		if (!files || files.length === 0) return;
		tray.addFiles(files);
		e.currentTarget.value = "";
	}

	function resolveRecipient() {
		const trimmed = to.trim();
		return contacts.value.includes(trimmed) ? trimmed : null;
	}

	async function handleSend(e) {
		e.preventDefault();
		if (busyRef.current) return;
		const recipient = resolveRecipient();
		if (!recipient) {
			setError(t("chat.list.composeInvalidRecipient"));
			return;
		}
		if (text.length === 0 && tray.items.length === 0) return;
		if (tray.items.some((item) => item.error)) return;
		if (text.length > MAX_MESSAGE_LENGTH) {
			setError(t("chat.window.messageTooLong", { max: MAX_MESSAGE_LENGTH }));
			return;
		}
		busyRef.current = true;
		setError("");
		setBusy(true);
		try {
			const attachments = tray.items.length > 0 ? await tray.uploadAll(privKey) : undefined;
			await ensureConnected(ownerPubkey, privKey, dbKey);
			const publishToRecipient = (event) => publishToContact(event, recipient);
			const lamportTs = await nextLamportTick(ownerPubkey);
			await sendChatMessageAction(ownerPubkey, privKey, dbKey, recipient, text, lamportTs, publishToRecipient, fetchDeviceKeyPackages, refreshGroupMessageSubscription, attachments);
			onSent(recipient);
		} catch (err) {
			setError(errorMessage(err));
		} finally {
			busyRef.current = false;
			setBusy(false);
		}
	}

	return (
		<Screen
			title={t("chat.list.composeTitle")}
			actions={
				<button type="button" onClick={onCancel}>
					<IconArrowLeft /> {t("chat.list.backToChatsButton")}
				</button>
			}
		>
			{error && (
				<p role="alert" style={{ color: "var(--bad)" }}>
					{error}
				</p>
			)}
			<form class="stack" style={{ "--gap": "var(--space-s)" }} onSubmit={handleSend}>
				<label class="stack" style={{ "--gap": "var(--space-3xs)" }}>
					<span>{t("chat.list.toLabel")}</span>
					<input list="compose-to-contacts" id="contacts" name="contacts-list" value={to} onInput={(e) => setTo(e.currentTarget.value)} autocomplete="off" />
					<datalist id="compose-to-contacts">
						{contacts.value.map((pk) => (
							<option key={pk} value={pk}>
								{profiles.value[pk]?.name || shortPubkey(pk)}
							</option>
						))}
					</datalist>
				</label>
				<label class="stack" style={{ "--gap": "var(--space-3xs)" }}>
					<span>{t("chat.window.messageLabel")}</span>
					<MarkdownFormatToolbar textareaRef={composeTextareaRef} value={text} onChange={setText} />
					<textarea ref={composeTextareaRef} value={text} maxLength={MAX_MESSAGE_LENGTH} onInput={(e) => setText(e.currentTarget.value)} rows={5} />
				</label>
				<label class="stack" style={{ "--gap": "var(--space-3xs)" }}>
					<span>{t("chat.list.attachmentsLabel")}</span>
					<input type="file" multiple onChange={handleFilesSelected} disabled={busy} />
				</label>
				{(tray.items.length > 0 || tray.errors.length > 0) && (
					<AttachmentTray items={tray.items} errors={tray.errors} onRemove={tray.remove} onPositionChange={tray.setPosition} />
				)}
				<button
					type="submit"
					disabled={busy || (text.length === 0 && tray.items.length === 0) || tray.items.some((item) => item.error)}
				>
					<IconSend /> {t("common.send")}
				</button>
			</form>
		</Screen>
	);
}

export default function Chat() {
	const ownerPubkey = currentUser.value.id;
	const privKey = privKeySig.value;
	const dbKey = dbKeySig.value;

	const [connectionError, setConnectionError] = useState("");
	const [composing, setComposing] = useState(false);

	useEffect(() => {
		ensureConnected(ownerPubkey, privKey, dbKey)
			.then(() => refreshLiveProfileSubscription(ownerPubkey))
			.catch((e) => setConnectionError(errorMessage(e)));
	}, [ownerPubkey]);

	if (activeChatPubkey.value) {
		return <ChatWindow ownerPubkey={ownerPubkey} privKey={privKey} dbKey={dbKey} contactPubkey={activeChatPubkey.value} />;
	}

	if (composing) {
		return (
			<ComposeMessage
				ownerPubkey={ownerPubkey}
				privKey={privKey}
				dbKey={dbKey}
				onCancel={() => setComposing(false)}
				onSent={(recipient) => {
					setComposing(false);
					openChat(recipient);
				}}
			/>
		);
	}

	return <ChatList ownerPubkey={ownerPubkey} privKey={privKey} dbKey={dbKey} connectionError={connectionError} onCompose={() => setComposing(true)} />;
}
