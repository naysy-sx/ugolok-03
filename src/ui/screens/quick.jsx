import { useState, useEffect, useRef } from "preact/hooks";
import { createRoom, joinRoom, joinRoomByPassword } from "../../domain/rooms/room-session.js";
import MessageBubble from "../components/message-bubble.jsx";
import { t } from "../signals/i18n.js";
import { BUILD_DEFAULT_RELAYS } from "../../config.js";

// ROOMS-SPEC.md §1.4 — отдельная ветка ВНЕ MainShell, переиспользует
// message-bubble.jsx через пропсы (форма сообщения совпадает), НЕ chat.jsx
// (другой жизненный цикл). room-session.js отдаёт сигналы через plain-
// callback onChange (не @preact/signals) — каждое изменение перечитывает
// снимок present()/getMessages()/getRoomState() в локальный state.
const RELAY_URL = BUILD_DEFAULT_RELAYS[0] ?? "ws://127.0.0.1:7777";

// "Инвайт-ссылка" — Этап 3 сознательно НЕ строит настоящий https://-роут
// (нужна была бы интеграция с router.js — отдельная задача); это копируемая
// строка, кодирующая (name, password, suffix) целиком, чтобы войти по ссылке
// не нужно было ничего вводить руками. Реальный URL-формат — будущее
// расширение поверх той же схемы, не блокирует функциональность.
const INVITE_PREFIX = "roomlink:v1:";

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
	// Единый источник правды для названия/пароля ТЕКУЩЕЙ комнаты — НЕ производная
	// от roomName/joinPwName через ||-цепочку (найдено живой проверкой: пользователь,
	// сначала создавший комнату, затем в ТОЙ ЖЕ вкладке вошедший в другую комнату
	// по паролю, видел заголовок и reconnect-переподключение старой комнаты —
	// roomName из формы "Создать" не сбрасывался при входе через "По паролю").
	const [activeRoomName, setActiveRoomName] = useState("");
	const [activeRoomPassword, setActiveRoomPassword] = useState("");
	const sessionRef = useRef(null);

	// Закрытие вкладки — конец, без уборки (ROOMS-SPEC §0); размонтирование
	// экрана внутри SPA — тот же принцип на уровне компонента.
	useEffect(() => {
		return () => sessionRef.current?.close();
	}, []);

	function attachSession(newSession, invite, name, password) {
		sessionRef.current = newSession;
		setSession(newSession);
		setActiveRoomName(name);
		setActiveRoomPassword(password);
		setInviteLink(invite ?? "");
		setPresent(newSession.getPresent());
		setMessages(newSession.getMessages());
		setRaceOutcome(newSession.getRaceOutcome());
		setScreen("in-room");
	}

	function handleSessionChange() {
		const s = sessionRef.current;
		if (!s) return;
		setPresent(s.getPresent());
		setMessages(s.getMessages());
		setRaceOutcome(s.getRaceOutcome());
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
				onChange: handleSessionChange,
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
				onChange: handleSessionChange,
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
				onChange: handleSessionChange,
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
				onChange: handleSessionChange,
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
		setScreen("entry");
	}

	function handleSendChat(e) {
		e.preventDefault();
		const text = chatText.trim();
		if (!text || !sessionRef.current) return;
		setChatText("");
		sessionRef.current.sendChat(text).catch(() => {});
	}

	if (screen === "in-room" && session) {
		const selfPubkey = session.getPubkeyHex();
		return (
			<div class="quick-room stack" style={{ "--gap": "var(--space-m)" }}>
				<header class="row" style={{ "--gap": "var(--space-s)", alignItems: "center" }}>
					<h2>{activeRoomName || t("quick.room.titleFallback")}</h2>
					<button type="button" class="btn--ghost" onClick={handleLeave}>
						{t("quick.room.leaveButton")}
					</button>
					{typeof onExit === "function" && (
						<button type="button" class="btn--ghost" onClick={onExit}>
							{t("quick.exitButton")}
						</button>
					)}
				</header>

				{raceOutcome && (
					<div role="alert" class="quick-race-warning stack box" style={{ "--gap": "var(--space-2xs)", "--pad": "var(--space-s)" }}>
						<p>{t("quick.room.raceWarning")}</p>
						<button type="button" class="btn" disabled={busy} onClick={handleReconnectToWinner}>
							{t("quick.room.reconnectButton")}
						</button>
					</div>
				)}

				{inviteLink && (
					<div class="quick-invite-box stack box" style={{ "--gap": "var(--space-2xs)", "--pad": "var(--space-s)" }}>
						<label for="quick-invite-link">{t("quick.room.inviteLabel")}</label>
						<input id="quick-invite-link" type="text" readonly value={inviteLink} onFocus={(e) => e.currentTarget.select()} />
					</div>
				)}

				<div class="quick-room-layout row" style={{ "--gap": "var(--space-m)" }}>
					<aside
						class="quick-participants stack box"
						style={{ "--gap": "var(--space-2xs)", "--pad": "var(--space-s)" }}
						aria-label={t("quick.room.participantsAriaLabel")}
					>
						<h3>{t("quick.room.participantsTitle", { count: present.length })}</h3>
						<ul role="list">
							{present.map((p) => (
								<li key={p.pubkey}>
									{p.nick || t("quick.anonymousNick")}
									{p.pubkey === selfPubkey ? ` (${t("quick.room.selfMarker")})` : ""}
								</li>
							))}
						</ul>
					</aside>

					<section class="quick-chat stack grow" style={{ "--gap": "var(--space-s)" }}>
						<div class="quick-messages stack scroller" style={{ "--gap": "var(--space-2xs)" }}>
							{messages.map((m) => (
								<MessageBubble
									key={m.id}
									message={{ msgId: m.id, text: m.text, sentAt: Math.floor(m.createdAt / 1000), deleted: false, edited: false }}
									isOwn={m.pubkey === selfPubkey}
								/>
							))}
						</div>
						<form class="row" style={{ "--gap": "var(--space-2xs)" }} onSubmit={handleSendChat}>
							<input
								type="text"
								class="grow"
								value={chatText}
								onInput={(e) => setChatText(e.currentTarget.value)}
								placeholder={t("quick.room.chatPlaceholder")}
							/>
							<button type="submit" class="btn" disabled={chatText.trim().length === 0}>
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
			<header class="row" style={{ "--gap": "var(--space-s)", alignItems: "center" }}>
				<h2>{t("quick.entry.title")}</h2>
				{typeof onExit === "function" && (
					<button type="button" class="btn--ghost" onClick={onExit}>
						{t("quick.exitButton")}
					</button>
				)}
			</header>
			<p class="hero-lead">{t("quick.entry.lead")}</p>

			<nav class="row" style={{ "--gap": "var(--space-2xs)" }} aria-label={t("quick.entry.tabsAriaLabel")}>
				<button type="button" class={entryTab === "create" ? "nav-link-btn nav-link-btn--active" : "nav-link-btn"} onClick={() => setEntryTab("create")}>
					{t("quick.entry.tabCreate")}
				</button>
				<button
					type="button"
					class={entryTab === "join-link" ? "nav-link-btn nav-link-btn--active" : "nav-link-btn"}
					onClick={() => setEntryTab("join-link")}
				>
					{t("quick.entry.tabJoinLink")}
				</button>
				<button
					type="button"
					class={entryTab === "join-password" ? "nav-link-btn nav-link-btn--active" : "nav-link-btn"}
					onClick={() => setEntryTab("join-password")}
				>
					{t("quick.entry.tabJoinPassword")}
				</button>
			</nav>

			<div class="form-group">
				<label for="quick-nick">{t("quick.entry.nickLabel")}</label>
				<input id="quick-nick" type="text" value={nick} onInput={(e) => setNick(e.currentTarget.value)} placeholder={t("quick.anonymousNick")} />
			</div>

			{error && (
				<p role="alert" style={{ color: "var(--bad)" }}>
					{error}
				</p>
			)}

			{entryTab === "create" && (
				<form class="auth-form stack" style={{ "--gap": "var(--space-s)" }} onSubmit={handleCreate}>
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
				<form class="auth-form stack" style={{ "--gap": "var(--space-s)" }} onSubmit={handleJoinLink}>
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
				<form class="auth-form stack" style={{ "--gap": "var(--space-s)" }} onSubmit={handleJoinPassword}>
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

			<p class="auth-widget-subtitle">{t("quick.entry.anonymityNotice")}</p>
		</div>
	);
}
