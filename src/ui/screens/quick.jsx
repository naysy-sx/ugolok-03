import { useState, useEffect, useRef } from "preact/hooks";
import { signal } from "@preact/signals";
import { createRoom, joinRoom, joinRoomByPassword, MAX_VOICE_PARTICIPANTS } from "../../domain/rooms/room-session.js";
import MessageBubble from "../components/message-bubble.jsx";
import RoomAudioVisualizer from "../components/room-audio-visualizer.jsx";
import { relayStatusInfo } from "../components/connection-status.jsx";
import IconQuickRoomPeople from "../icons/quick-room-people.jsx";
import IconUserBadge from "../icons/user-badge.jsx";
import IconVoiceBroadcast from "../icons/voice-broadcast.jsx";
import IconCopy from "../icons/copy.jsx";
import IconLogOut from "../icons/log-out.jsx";
import { t, tPlural } from "../signals/i18n.js";
import { BUILD_DEFAULT_RELAYS, BUILD_DEFAULT_ICE_SERVERS } from "../../config.js";

// ROOMS-SPEC.md §1.4 — отдельная ветка ВНЕ MainShell, переиспользует
// message-bubble.jsx через пропсы (форма сообщения совпадает), НЕ chat.jsx
// (другой жизненный цикл). room-session.js отдаёт сигналы через plain-
// callback onChange (не @preact/signals) — каждое изменение перечитывает
// снимок present()/getMessages()/getRoomState() в локальный state.
const RELAY_URL = BUILD_DEFAULT_RELAYS[0] ?? "ws://127.0.0.1:7777";
// room-session.js сам navigator/config.js не импортирует (граница слоёв, та
// же, что у media-controller.js/call-runtime.js) — конфиг подключается здесь.
const ICE_SERVERS = BUILD_DEFAULT_ICE_SERVERS;

// Редизайн интерфейса, "область контента" — сворачивание в панель сайдбара
// (app.jsx's ActiveRoomSummary), тот же принцип, что mediaSession (media.js):
// лёгкое зеркало самого нужного (название+число участников) в сигнал
// модульного уровня, чтобы читать его СНАРУЖИ Quick без размонтирования
// компонента — размонтирование закрыло бы сессию (см. cleanup-эффект ниже,
// ROOMS-SPEC §0 "закрытие вкладки — конец, без уборки", тот же принцип на
// уровне компонента). НЕ полноценный перенос состояния комнаты в сигналы
// (session/present/messages остаются локальным state, как были) — только
// то, что нужно для сводки снаружи.
export const activeRoomSummary = signal(null); // {name, count} | null, пока сессии нет

// "Инвайт-ссылка" — Этап 3 сознательно НЕ строит настоящий https://-роут
// (нужна была бы интеграция с router.js — отдельная задача); это копируемая
// строка, кодирующая (name, password, suffix) целиком, чтобы войти по ссылке
// не нужно было ничего вводить руками. Реальный URL-формат — будущее
// расширение поверх той же схемы, не блокирует функциональность.
const INVITE_PREFIX = "roomlink:v1:";

// Три режима входа — вкладки-папка (EXAMPLES/quick.jsx): ник общий для всех
// трёх, поэтому живёт в теле папки над разделителем, а не над вкладками.
const ENTRY_TABS = [
	["create", "quick.entry.tabCreate"],
	["join-link", "quick.entry.tabJoinLink"],
	["join-password", "quick.entry.tabJoinPassword"],
];

function encodeInviteLink(name, password, suffix) {
	const payload = JSON.stringify({ name, password, suffix });
	return INVITE_PREFIX + btoa(unescape(encodeURIComponent(payload)));
}

function decodeInviteLink(link) {
	if (!link.startsWith(INVITE_PREFIX)) return null;
	try {
		const payload = decodeURIComponent(escape(atob(link.slice(INVITE_PREFIX.length))));
		const { name, password, suffix } = JSON.parse(payload);
		if (typeof name !== "string" || typeof password !== "string" || typeof suffix !== "string") return null;
		return { name, password, suffix };
	} catch {
		return null;
	}
}

export default function Quick({ onExit }) {
	const [screen, setScreen] = useState("entry"); // "entry" | "in-room"
	const [entryTab, setEntryTab] = useState("create"); // "create" | "join-link" | "join-password"
	const [nick, setNick] = useState("");
	const [roomName, setRoomName] = useState("");
	const [roomPassword, setRoomPassword] = useState("");
	const [openMode, setOpenMode] = useState(false);
	const [inviteInput, setInviteInput] = useState("");
	const [joinPwName, setJoinPwName] = useState("");
	const [joinPwPassword, setJoinPwPassword] = useState("");
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);

	const [session, setSession] = useState(null);
	const [present, setPresent] = useState([]);
	const [messages, setMessages] = useState([]);
	const [raceOutcome, setRaceOutcome] = useState(null);
	const [inviteLink, setInviteLink] = useState("");
	const [chatText, setChatText] = useState("");
	const [voiceActive, setVoiceActive] = useState(false);
	// Этап 6 — ROOMS-SPEC §7 "Релей отвалился": видно в UI, не только в поведении.
	const [connectionState, setConnectionState] = useState("connected");
	const [voiceBusy, setVoiceBusy] = useState(false);
	const [voiceError, setVoiceError] = useState("");
	const [remoteStreams, setRemoteStreams] = useState(new Map());
	// Этап 5 — сырой (не клонированный) собственный поток, нужен
	// room-audio-visualizer.jsx для audio-graph.js (собственный уровень/
	// спектрограмма); mesh-supervisor.js's onLocalStream — единственный источник.
	const [localStream, setLocalStream] = useState(null);
	// Единый источник правды для названия/пароля ТЕКУЩЕЙ комнаты — НЕ производная
	// от roomName/joinPwName через ||-цепочку (найдено живой проверкой: пользователь,
	// сначала создавший комнату, затем в ТОЙ ЖЕ вкладке вошедший в другую комнату
	// по паролю, видел заголовок и reconnect-переподключение старой комнаты —
	// roomName из формы "Создать" не сбрасывался при входе через "По паролю").
	const [activeRoomName, setActiveRoomName] = useState("");
	const [activeRoomPassword, setActiveRoomPassword] = useState("");
	const sessionRef = useRef(null);
	// Автопрокрутка к последнему сообщению (найдено пользователем — без неё
	// список растягивал всю страницу и новые сообщения было не видно без
	// ручной прокрутки). lastMessageIdRef — найдено пользователем живой
	// проверкой: room.tick() (~раз в секунду) даёт getMessages() новую
	// ссылку на массив даже без новых сообщений, а эффект был завязан на
	// саму ссылку — прокрутка дёргалась постоянно, мешая читать историю
	// выше. Теперь скроллим только когда id последнего сообщения реально
	// сменился.
	const messagesScrollRef = useRef(null);
	const lastMessageIdRef = useRef(null);
	// "У низа был" — держим ОТДЕЛЬНО, через scroll-события, а не пересчётом
	// в момент нового сообщения: найдено пользователем живой проверкой —
	// пересчёт ПОСЛЕ того, как бабл уже добавлен в DOM, меряет scrollHeight,
	// УЖЕ выросший на высоту этого бабла, против старого scrollTop — любое
	// сообщение выше ~96px (перенос на несколько строк — обычное дело)
	// ошибочно читалось как "ушёл наверх читать историю", и прокрутка не
	// срабатывала вовсе.
	const wasNearBottomRef = useRef(true);
	// Копирование инвайт-ссылки (тот же приём, что profile.jsx's handleCopyNpub) —
	// статус на 2с, затем гаснет сам.
	const [inviteCopyStatus, setInviteCopyStatus] = useState("");
	const inviteCopyTimerRef = useRef(null);

	// Закрытие вкладки — конец, без уборки (ROOMS-SPEC §0); размонтирование
	// экрана внутри SPA — тот же принцип на уровне компонента.
	useEffect(() => {
		return () => {
			sessionRef.current?.close();
			activeRoomSummary.value = null;
		};
	}, []);

	// Зеркало для сводки снаружи (см. комментарий у activeRoomSummary выше) —
	// без cleanup на каждый ре-run (present меняется часто, при каждом
	// join/leave) — сброс в null только при размонтировании, эффектом выше.
	useEffect(() => {
		activeRoomSummary.value = session ? { name: activeRoomName, count: present.length } : null;
	}, [session, activeRoomName, present]);

	useEffect(() => {
		return () => clearTimeout(inviteCopyTimerRef.current);
	}, []);

	useEffect(() => {
		const el = messagesScrollRef.current;
		if (!el) return;
		function updateWasNearBottom() {
			wasNearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 96;
		}
		el.addEventListener("scroll", updateWasNearBottom, { passive: true });
		return () => el.removeEventListener("scroll", updateWasNearBottom);
		// [screen], не [] — найдено внешним ревью: экран входа и рабочий экран
		// комнаты один и тот же компонент (условный рендер по screen, не
		// перемонтирование), при монтировании .quick-messages ещё нет в DOM
		// (виден экран входа) — с [] слушатель не навешивался НИКОГДА, вход в
		// комнату на это не реагировал.
	}, [screen]);

	useEffect(() => {
		const last = messages[messages.length - 1];
		if (!last || last.id === lastMessageIdRef.current) return;
		const isFirstLoad = lastMessageIdRef.current === null;
		lastMessageIdRef.current = last.id;
		const el = messagesScrollRef.current;
		if (!el) return;
		// .scrollTop контейнера напрямую, а не scrollIntoView — тот, найдено
		// пользователем живой проверкой, попутно чуть прокручивал и саму
		// страницу (пытается довести элемент в видимость во ВСЕХ предках со
		// скроллом, не только в ближайшем). Прокручиваем только если
		// пользователь и так был у низа (или это первая загрузка истории) —
		// иначе не мешаем читать более старые сообщения.
		if (isFirstLoad || wasNearBottomRef.current) {
			el.scrollTop = el.scrollHeight;
			wasNearBottomRef.current = true;
		}
	}, [messages]);

	function attachSession(newSession, invite, name, password) {
		sessionRef.current = newSession;
		setSession(newSession);
		setActiveRoomName(name);
		setActiveRoomPassword(password);
		setInviteLink(invite ?? "");
		setPresent(newSession.getPresent());
		setMessages(newSession.getMessages());
		setRaceOutcome(newSession.getRaceOutcome());
		setConnectionState(newSession.getConnectionState());
		setVoiceActive(false);
		setVoiceError("");
		setRemoteStreams(new Map());
		setLocalStream(null);
		// Сброс автопрокрутки для НОВОЙ комнаты — иначе isFirstLoad (сравнение
		// с lastMessageIdRef) уйдёт в false с самого первого сообщения, а
		// wasNearBottomRef унесёт состояние прежней комнаты (найдено внешним
		// ревью).
		wasNearBottomRef.current = true;
		lastMessageIdRef.current = null;
		setScreen("in-room");
	}

	// stream === null -> ребро закрылось, убрать пира из карты (mesh-supervisor.js
	// шлёт это явно при закрытии — room-audio-visualizer.jsx's диффинг-эффект
	// обязан узнать об уходе, чтобы вызвать audioGraph.removeStream).
	function handleRemoteStream(peer, stream) {
		setRemoteStreams((prev) => {
			const next = new Map(prev);
			if (stream) next.set(peer, stream);
			else next.delete(peer);
			return next;
		});
	}

	function handleLocalStream(stream) {
		setLocalStream(stream);
	}

	function handleSessionChange() {
		const s = sessionRef.current;
		if (!s) return;
		setPresent(s.getPresent());
		setMessages(s.getMessages());
		setRaceOutcome(s.getRaceOutcome());
		// isVoiceActive() читается из самой сессии, не только из ответа joinVoice() —
		// И10 самоэвикция (CONTRACTS.md "Rooms — Этап 4" §3) может выключить голос
		// без явного действия пользователя, onChange — единственный способ узнать об этом.
		setVoiceActive(s.isVoiceActive());
		setConnectionState(s.getConnectionState());
	}

	async function handleCreate(e) {
		e.preventDefault();
		setError("");
		setBusy(true);
		try {
			const newSession = await createRoom({
				name: roomName,
				password: roomPassword,
				nick: nick || t("quick.anonymousNick"),
				relayUrl: RELAY_URL,
				openMode,
				iceServers: ICE_SERVERS,
				onChange: handleSessionChange,
				onRemoteStream: handleRemoteStream,
				onLocalStream: handleLocalStream,
			});
			attachSession(newSession, encodeInviteLink(roomName, roomPassword, newSession.getSuffix()), roomName, roomPassword);
		} catch {
			setError(t("quick.errors.createFailed"));
		} finally {
			setBusy(false);
		}
	}

	async function handleJoinLink(e) {
		e.preventDefault();
		setError("");
		const decoded = decodeInviteLink(inviteInput.trim());
		if (!decoded) {
			setError(t("quick.errors.invalidLink"));
			return;
		}
		setBusy(true);
		try {
			const newSession = await joinRoom({
				name: decoded.name,
				password: decoded.password,
				suffix: decoded.suffix,
				nick: nick || t("quick.anonymousNick"),
				relayUrl: RELAY_URL,
				iceServers: ICE_SERVERS,
				onChange: handleSessionChange,
				onRemoteStream: handleRemoteStream,
				onLocalStream: handleLocalStream,
			});
			attachSession(newSession, inviteInput.trim(), decoded.name, decoded.password);
		} catch {
			setError(t("quick.errors.joinFailed"));
		} finally {
			setBusy(false);
		}
	}

	async function handleJoinPassword(e) {
		e.preventDefault();
		setError("");
		setBusy(true);
		try {
			const newSession = await joinRoomByPassword({
				name: joinPwName,
				password: joinPwPassword,
				nick: nick || t("quick.anonymousNick"),
				relayUrl: RELAY_URL,
				iceServers: ICE_SERVERS,
				onChange: handleSessionChange,
				onRemoteStream: handleRemoteStream,
				onLocalStream: handleLocalStream,
			});
			attachSession(newSession, encodeInviteLink(joinPwName, joinPwPassword, newSession.getSuffix()), joinPwName, joinPwPassword);
		} catch {
			setError(t("quick.errors.notFound"));
		} finally {
			setBusy(false);
		}
	}

	// И9 (ROOMS-MATH §1.4) — сигнал raceOutcome, не автопереподключение
	// (CONTRACTS.md "Rooms — Этап 3": решение "закрыть и переподключиться" —
	// ответственность UI). Только для create({openMode:true}) — activeRoomName/
	// activeRoomPassword гарантированно те самые поля (getRaceOutcome() всегда
	// null для join-путей), а не форма "Создать", которая могла с тех пор
	// измениться пользователем.
	async function handleReconnectToWinner() {
		if (!raceOutcome) return;
		setBusy(true);
		try {
			sessionRef.current?.close();
			const newSession = await joinRoom({
				name: activeRoomName,
				password: activeRoomPassword,
				suffix: raceOutcome.winningSuffix,
				nick: nick || t("quick.anonymousNick"),
				relayUrl: RELAY_URL,
				iceServers: ICE_SERVERS,
				onChange: handleSessionChange,
				onRemoteStream: handleRemoteStream,
				onLocalStream: handleLocalStream,
			});
			attachSession(newSession, encodeInviteLink(activeRoomName, activeRoomPassword, raceOutcome.winningSuffix), activeRoomName, activeRoomPassword);
		} catch {
			setError(t("quick.errors.joinFailed"));
			setScreen("entry");
		} finally {
			setBusy(false);
		}
	}

	function handleLeave() {
		sessionRef.current?.close();
		sessionRef.current = null;
		setSession(null);
		setRaceOutcome(null);
		setActiveRoomName("");
		setActiveRoomPassword("");
		setVoiceActive(false);
		setVoiceError("");
		setRemoteStreams(new Map());
		setLocalStream(null);
		setScreen("entry");
	}

	// Текст не зависит от голоса ни в одном сценарии (ROOMS-SPEC §7) — отказ
	// joinVoice() (микрофон запрещён/голос заполнен/TURN недоступен) оставляет
	// комнату и чат полностью рабочими, только показывает сообщение об ошибке.
	async function handleJoinVoice() {
		if (!sessionRef.current) return;
		setVoiceBusy(true);
		setVoiceError("");
		try {
			await sessionRef.current.joinVoice();
			setVoiceActive(true);
		} catch (err) {
			const message = err?.message || "";
			if (message.includes("заполнена")) {
				setVoiceError(t("quick.room.voiceFullError"));
			} else if (err?.name === "NotAllowedError" || err?.name === "NotFoundError") {
				setVoiceError(t("quick.room.voiceMicDeniedError"));
			} else {
				setVoiceError(t("quick.room.voiceJoinError"));
			}
		} finally {
			setVoiceBusy(false);
		}
	}

	function handleLeaveVoice() {
		sessionRef.current?.leaveVoice();
		setVoiceActive(false);
		setVoiceError("");
		setRemoteStreams(new Map());
		setLocalStream(null);
	}

	function handleSendChat(e) {
		e.preventDefault();
		const text = chatText.trim();
		if (!text || !sessionRef.current) return;
		setChatText("");
		sessionRef.current.sendChat(text).catch(() => {});
	}

	async function handleCopyInvite() {
		try {
			await navigator.clipboard.writeText(inviteLink);
			setInviteCopyStatus(t("quick.room.inviteCopiedStatus"));
		} catch {
			setInviteCopyStatus(t("quick.room.inviteCopyFailedStatus"));
		}
		clearTimeout(inviteCopyTimerRef.current);
		inviteCopyTimerRef.current = setTimeout(() => setInviteCopyStatus(""), 2000);
	}

	if (screen === "in-room" && session) {
		const selfPubkey = session.getPubkeyHex();
		const voiceCount = present.filter((p) => p.inVoice).length;
		// Этап 6 — ROOMS-SPEC §7: комната не завязана на синхронизацию истории
		// (нет её вовсе, §5.4), поэтому isSynced=true всегда — "connected"/
		// "subscribed" всегда читается как "ok", не как "синхронизация".
		const relayInfo = relayStatusInfo(connectionState, true);
		const edgeStates = session.getEdgeStates();
		const voiceFree = MAX_VOICE_PARTICIPANTS - voiceCount;
		// До подключения важно "влезу ли я" (места), после — "сколько нас"
		// (счёт) — два разных вопроса, не одна общая формулировка на оба
		// состояния (решение по итогам разбора с Claude Opus). "Мест" требует
		// склонения (1 место / 2 места / 5 мест) — tPlural, не t().
		const voiceStatusText = voiceActive
			? t("quick.room.voiceConnected", { count: voiceCount, max: MAX_VOICE_PARTICIPANTS })
			: voiceFree <= 0
				? t("quick.room.voiceNoSlots")
				: tPlural("quick.room.voiceFreeSlots", voiceFree, { max: MAX_VOICE_PARTICIPANTS });
		return (
			<div class={voiceActive ? "quick-room stack is-voice-live" : "quick-room stack"} style={{ "--gap": "var(--space-m)" }}>
				<header class="quick-room-header row" style={{ "--gap": "var(--space-s)", alignItems: "center" }}>
					<div class="bar grow" style={{ "--gap": "var(--space-l)", alignItems: "flex-start" }}>
						<IconQuickRoomPeople class="icon quick-room-icon rigid" aria-hidden="true" />
						<div class="stack grow" style={{ "--gap": "var(--space-3xs)" }}>
							<div class="bar" style={{ "--gap": "var(--space-s)", alignItems: "center", justifyContent: "space-between" }}>
								<h2 class="quick-room-title truncate grow">{activeRoomName || t("quick.room.titleFallback")}</h2>
								{/* Уход из комнаты необратим (без ссылки на руках обратно не
								    попасть) — --warn, не нейтральный ghost. */}
								<button type="button" class="quick-room-leave btn--ghost btn--warn bar rigid" style={{ "--gap": "var(--space-3xs)", alignItems: "center" }} onClick={handleLeave}>
									<IconLogOut class="icon rigid" aria-hidden="true" />
									{t("quick.room.leaveButton")}
								</button>
							</div>
							{inviteLink && (
								<div class="quick-invite-inline bar" style={{ "--gap": "var(--space-2xs)", alignItems: "center" }}>
									<code class="quick-invite-code grow truncate">{inviteLink}</code>
									<button type="button" class="icon-btn rigid" onClick={handleCopyInvite} aria-label={t("quick.room.copyInviteAria")}>
										<IconCopy class="icon" aria-hidden="true" />
									</button>
									{inviteCopyStatus && (
										<small role="status" class="quick-invite-status rigid">
											{inviteCopyStatus}
										</small>
									)}
								</div>
							)}
							<p class="quick-room-subtitle">
								{t("quick.room.participantsTitle", { count: present.length })} · {t("quick.room.ephemeralNotice")}
							</p>
						</div>
					</div>
					{typeof onExit === "function" && (
						<div class="row rigid" style={{ "--gap": "var(--space-2xs)", alignItems: "center", marginInlineStart: "auto" }}>
							<button type="button" class="btn--ghost" onClick={onExit}>
								{t("quick.exitButton")}
							</button>
						</div>
					)}
				</header>

				{relayInfo.tone !== "ok" && (
					<p role="status" class={`status-${relayInfo.tone}`}>
						{t(relayInfo.labelKey)}
					</p>
				)}

				{raceOutcome && (
					<div role="alert" class="quick-race-warning stack box" style={{ "--gap": "var(--space-2xs)", "--pad": "var(--space-s)" }}>
						<p>{t("quick.room.raceWarning")}</p>
						<button type="button" class="btn self-start" disabled={busy} onClick={handleReconnectToWinner}>
							{t("quick.room.reconnectButton")}
						</button>
					</div>
				)}

				<section class="quick-stage stack box" style={{ "--gap": "var(--space-s)", "--pad": "var(--space-s)" }} aria-labelledby="quick-stage-title">
					<div class="quick-stage-header bar" style={{ "--gap": "var(--space-s)", alignItems: "center" }}>
						<h3 id="quick-stage-title" class="grow truncate">
							{t("quick.room.voiceSectionTitle")}
						</h3>
						<small class="quick-voice-count rigid">{voiceStatusText}</small>
						{voiceActive ? (
							<button type="button" class="btn--ghost rigid bar" style={{ "--gap": "var(--space-3xs)", alignItems: "center" }} onClick={handleLeaveVoice}>
								<span class="quick-live-dot" aria-hidden="true" />
								{t("quick.room.leaveVoiceButton")}
							</button>
						) : (
							// --good — "приглашающий" цвет для звонка вместо нейтрального --accent.
							<button
								type="button"
								class="btn btn--good rigid bar"
								style={{ "--gap": "var(--space-3xs)", alignItems: "center" }}
								disabled={voiceBusy || voiceFree <= 0}
								onClick={handleJoinVoice}
							>
								<IconVoiceBroadcast class="icon rigid" aria-hidden="true" />
								{voiceFree <= 0 ? t("quick.room.voiceNoSlots") : t("quick.room.joinVoiceButton")}
							</button>
						)}
					</div>

					{voiceError && (
						<p role="alert" class="status-bad">
							{voiceError}
						</p>
					)}

					{voiceActive && (
						<RoomAudioVisualizer
							localStream={localStream}
							remoteStreams={remoteStreams}
							selfPubkey={selfPubkey}
							participantNicks={new Map(present.map((p) => [p.pubkey, p.nick || t("quick.anonymousNick")]))}
						/>
					)}
				</section>

				<div class="quick-room-layout row" style={{ "--gap": "var(--space-m)" }}>
					<aside
						class="quick-participants stack box"
						style={{ "--gap": "var(--space-3xs)", "--pad": "var(--space-s)" }}
						aria-label={t("quick.room.participantsAriaLabel")}
					>
						<h3>{t("quick.room.participantsTitle", { count: present.length })}</h3>
						<ul role="list" class="stack" style={{ "--gap": "var(--space-3xs)" }}>
							{present.map((p) => {
								// Этап 6 — ROOMS-SPEC §7 "у пары взаимная тишина с пометкой": только
								// ЯВНЫЙ отказ ребра (ENDED/RECONNECTING), не переходные состояния
								// установки (OUTGOING_RINGING/INCOMING_RINGING/CONNECTING) — те не
								// диагностика, а нормальные первые секунды процесса (см. CONTRACTS.md).
								const edge = edgeStates.find((e) => e.peer === p.pubkey);
								const edgeSilent = voiceActive && p.inVoice && p.pubkey !== selfPubkey && edge && (edge.state === "ENDED" || edge.state === "RECONNECTING");
								const isSelf = p.pubkey === selfPubkey;
								return (
									<li
										key={p.pubkey}
										class={isSelf ? "quick-participant quick-participant-self row" : "quick-participant row"}
										style={{ "--gap": "var(--space-2xs)", alignItems: "center" }}
									>
										<IconUserBadge class="icon quick-participant-icon" aria-hidden="true" />
										<span class="quick-participant-name grow truncate">
											{p.nick || t("quick.anonymousNick")}
											{isSelf ? ` (${t("quick.room.selfMarker")})` : ""}
										</span>
										{edgeSilent ? (
											<small role="alert" class="quick-edge-silent">
												{t("quick.room.edgeSilentHint")}
											</small>
										) : (
											p.inVoice && <span class="quick-voice-pill">{t("quick.room.inVoiceMarker")}</span>
										)}
									</li>
								);
							})}
						</ul>
					</aside>

					<section class="quick-chat stack grow box" style={{ "--gap": "var(--space-s)" }}>
						<div ref={messagesScrollRef} class="quick-messages stack scroller box" style={{ "--gap": "var(--space-2xs)", "--pad": "var(--space-s)" }}>
							{messages.length === 0 && <p class="quick-empty">{t("quick.room.emptyChat")}</p>}
							{messages.map((m) => (
								<MessageBubble
									key={m.id}
									message={{ msgId: m.id, text: m.text, sentAt: Math.floor(m.createdAt / 1000), deleted: false, edited: false }}
									isOwn={m.pubkey === selfPubkey}
									senderName={m.nick || t("quick.anonymousNick")}
								/>
							))}
						</div>
						<form class="quick-compose bar" style={{ "--gap": "0" }} onSubmit={handleSendChat}>
							<textarea
								class="grow"
								rows={1}
								value={chatText}
								onInput={(e) => setChatText(e.currentTarget.value)}
								onKeyDown={(e) => {
									// Enter отправляет, Shift+Enter — перевод строки. isComposing —
									// защита от IME: во время набора через предиктивный ввод/составные
									// раскладки Enter подтверждает вариант, а не завершает сообщение.
									if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
										e.preventDefault();
										handleSendChat(e);
									}
								}}
								placeholder={t("quick.room.chatPlaceholder")}
								aria-label={t("quick.room.chatPlaceholder")}
							/>
							<button type="submit" class="btn self-end" disabled={chatText.trim().length === 0}>
								{t("quick.room.sendButton")}
							</button>
						</form>
					</section>
				</div>
			</div>
		);
	}

	return (
		<div class="quick-entry stack" style={{ "--gap": "var(--space-m)" }}>
			<span class="quick-lamp" aria-hidden="true" />
			{/* Живой фидбек пользователя — кнопка "Назад" (onExit) здесь была
			    дублем: RoomsOverlay (rooms-overlay.jsx) уже оборачивает ВЕСЬ
			    Quick (и этот экран входа, и комнату) собственной явной кнопкой
			    закрытия (.rooms-overlay-close) — второй выход рядом с
			    заголовком больше не нужен. */}
			<header class="row" style={{ "--gap": "var(--space-s)", alignItems: "center", justifyContent: "center" }}>
				<h2>{t("quick.entry.title")}</h2>
			</header>
			<p class="hero-lead">{t("quick.entry.lead")}</p>

			<div class="folder">
				<div class="folder-tabs bar" role="tablist" aria-label={t("quick.entry.tabsAriaLabel")}>
					{ENTRY_TABS.map(([id, labelKey]) => (
						<button
							key={id}
							type="button"
							role="tab"
							id={`quick-tab-${id}`}
							class="folder-tab"
							aria-selected={entryTab === id}
							aria-controls="quick-tabpanel"
							onClick={() => setEntryTab(id)}
						>
							{t(labelKey)}
						</button>
					))}
				</div>

				<div
					class="folder-body stack box"
					id="quick-tabpanel"
					role="tabpanel"
					aria-labelledby={`quick-tab-${entryTab}`}
					style={{ "--gap": "var(--space-m)", "--pad": "var(--space-l)" }}
				>
					<div class="folder-shared form-group">
						<label for="quick-nick">{t("quick.entry.nickLabel")}</label>
						<input id="quick-nick" type="text" value={nick} onInput={(e) => setNick(e.currentTarget.value)} placeholder={t("quick.anonymousNick")} />
					</div>

					{error && (
						<p role="alert" style={{ color: "var(--bad)" }}>
							{error}
						</p>
					)}

					{entryTab === "create" && (
						<form class="stack" style={{ "--gap": "var(--space-s)" }} onSubmit={handleCreate}>
							<div class="form-group">
								<label for="quick-create-name">{t("quick.entry.nameLabel")}</label>
								<input id="quick-create-name" type="text" required value={roomName} onInput={(e) => setRoomName(e.currentTarget.value)} />
							</div>
							<div class="form-group">
								<label for="quick-create-password">{t("quick.entry.passwordLabel")}</label>
								<input id="quick-create-password" type="text" required value={roomPassword} onInput={(e) => setRoomPassword(e.currentTarget.value)} />
							</div>
							<label class="row" style={{ "--gap": "var(--space-2xs)", alignItems: "center" }}>
								<input type="checkbox" checked={openMode} onChange={(e) => setOpenMode(e.currentTarget.checked)} />
								{t("quick.entry.openModeLabel")}
							</label>
							<p class="auth-widget-subtitle">{openMode ? t("quick.entry.openModeHintOn") : t("quick.entry.openModeHintOff")}</p>
							<button type="submit" class="btn btn-block" disabled={busy}>
								{t("quick.entry.createButton")}
							</button>
						</form>
					)}

					{entryTab === "join-link" && (
						<form class="stack" style={{ "--gap": "var(--space-s)" }} onSubmit={handleJoinLink}>
							<div class="form-group">
								<label for="quick-join-link">{t("quick.entry.linkLabel")}</label>
								<input id="quick-join-link" type="text" required value={inviteInput} onInput={(e) => setInviteInput(e.currentTarget.value)} />
							</div>
							<button type="submit" class="btn btn-block" disabled={busy}>
								{t("quick.entry.joinButton")}
							</button>
						</form>
					)}

					{entryTab === "join-password" && (
						<form class="stack" style={{ "--gap": "var(--space-s)" }} onSubmit={handleJoinPassword}>
							<div class="form-group">
								<label for="quick-joinpw-name">{t("quick.entry.nameLabel")}</label>
								<input id="quick-joinpw-name" type="text" required value={joinPwName} onInput={(e) => setJoinPwName(e.currentTarget.value)} />
							</div>
							<div class="form-group">
								<label for="quick-joinpw-password">{t("quick.entry.passwordLabel")}</label>
								<input id="quick-joinpw-password" type="text" required value={joinPwPassword} onInput={(e) => setJoinPwPassword(e.currentTarget.value)} />
							</div>
							<button type="submit" class="btn btn-block" disabled={busy}>
								{t("quick.entry.joinButton")}
							</button>
						</form>
					)}
				</div>
			</div>

			<p class="auth-widget-subtitle">{t("quick.entry.anonymityNotice")}</p>
		</div>
	);
}
