import { useState, useEffect } from "preact/hooks";
import { NAV_ITEMS, DEFAULT_ACTIVE } from "./ui/nav-items.js";
import Diagnostics from "./ui/screens/diagnostics.jsx";
import Placeholder from "./ui/screens/placeholder.jsx";
import Unlock from "./ui/screens/unlock.jsx";
import Profile from "./ui/screens/profile.jsx";
import Contacts from "./ui/screens/contacts.jsx";
import Chat from "./ui/screens/chat.jsx";
import Channels from "./ui/screens/channels.jsx";
import Discovery from "./ui/screens/discovery.jsx";
import Settings from "./ui/screens/settings.jsx";
import Journal from "./ui/screens/journal.jsx";
import Files from "./ui/screens/files.jsx";
import { currentUser, lock, dbKeySig, privKeySig } from "./ui/signals/auth.js";
import { publish } from "./ui/signals/transport.js";
import { loadUiSettings, saveUiSettings } from "./domain/settings/ui-settings.js";
import { applyAccentColor } from "./ui/theme/accent-palette.js";
import { applyUiScale } from "./ui/theme/ui-scale.js";
import { applyThemeMode, resolveEffectiveTheme, toggleThemeMode } from "./ui/theme/theme-mode.js";
import { activeChatPubkey } from "./ui/signals/chat.js";
import { activeChannelId } from "./ui/signals/channel-nav.js";
import { pendingNavTarget, applyNavTarget } from "./ui/signals/notification-nav.js";
import { messagingActivity } from "./ui/signals/chats.js";
import { refreshContacts } from "./ui/signals/contacts.js";
import { journalEntries, refreshJournal } from "./ui/signals/journal.js";
import { unreadMessagesCount, unreadChannelsCount, refreshUnreadMessagesCount, refreshUnreadChannelsCount } from "./ui/signals/notifications.js";
import { configureDefaultBackend } from "./domain/notifications/notifier.js";
import { pushToast } from "./ui/signals/toasts.js";
import ToastHost from "./ui/components/toast-host.jsx";
import CallOverlay from "./ui/components/call-overlay.jsx";
import { NOTIFICATION_SOUND_DATA_URI } from "./domain/notifications/sound-asset.js";
import SidebarProfileCard from "./ui/components/sidebar-profile-card.jsx";
import ConnectionStatusPanel from "./ui/components/connection-status.jsx";
import IconChatBubble from "./ui/icons/chat-bubble.jsx";
import IconReader from "./ui/icons/reader.jsx";
import IconPeople from "./ui/icons/people.jsx";
import IconGear from "./ui/icons/gear.jsx";
import IconPerson from "./ui/icons/person.jsx";
import IconActivityLog from "./ui/icons/activity-log.jsx";
import IconExit from "./ui/icons/exit.jsx";
import IconGlobe from "./ui/icons/globe.jsx";
import IconBell from "./ui/icons/bell.jsx";
import IconSun from "./ui/icons/sun.jsx";
import IconMoon from "./ui/icons/moon.jsx";
import IconMenu from "./ui/icons/menu.jsx";
import IconFolder from "./ui/icons/folder.jsx";

// nav-items.js — чистые данные (см. комментарий там), маппинг id → иконка
// живёт здесь, во view-слое.
const NAV_ICONS = {
	journal: IconBell,
	messages: IconChatBubble,
	channels: IconReader,
	files: IconFolder,
	contacts: IconPeople,
	discovery: IconGlobe,
	settings: IconGear,
	profile: IconPerson,
	diagnostics: IconActivityLog,
};

function MainShell() {
	const [activeId, setActiveId] = useState(DEFAULT_ACTIVE);
	const [themeMode, setThemeMode] = useState(null); // null="как в системе" — см. theme-mode.js
	const [sidebarOpen, setSidebarOpen] = useState(false);
	const ownerPubkey = currentUser.value.id;
	const privKey = privKeySig.value;
	const dbKey = dbKeySig.value;

	// Найдено пользователем (запрос переключателя тем) — раньше accentColorId/
	// uiScale ТОЖЕ применялись лениво, только при первом визите на "Настройки" в
	// этой сессии (settings.jsx's mount-эффект был единственной точкой). Тема —
	// особенно заметный случай (вспышка чужой темы до первого визита в Настройки),
	// поэтому применяем все три СРАЗУ здесь, как только открылся сам MainShell —
	// не только theme, заодно закрывает тот же пробел для accent/scale.
	useEffect(() => {
		loadUiSettings(ownerPubkey, dbKey).then((loaded) => {
			applyAccentColor(loaded.accentColorId);
			applyUiScale(loaded.uiScale);
			applyThemeMode(loaded.themeMode);
			setThemeMode(loaded.themeMode);
		});
	}, [ownerPubkey]);

	// Простой бинарный тумблер (тот же UX, что демо Opus, VISUAL.md) — переключает
	// от ТЕКУЩЕЙ эффективной темы даже если пользователь ещё ни разу не выбирал
	// явно (themeMode=null). saveUiSettings — best-effort здесь: локальный эффект
	// (applyThemeMode) уже применён синхронно, сбой публикации не должен откатывать
	// визуальный отклик пользователю (тот же принцип, что handleAccentClick).
	function handleToggleTheme() {
		const next = toggleThemeMode(themeMode);
		applyThemeMode(next);
		setThemeMode(next);
		loadUiSettings(ownerPubkey, dbKey).then((current) => {
			saveUiSettings(ownerPubkey, privKey, dbKey, { ...current, themeMode: next }, publish).catch(() => {});
		});
	}

	// Этап 47-довесок — ОДИН раз подключаем свой тост + звуковой ассет к
	// дефолтному backend'у notifier.js (domain-слой не знает о UI/тостах вовсе,
	// см. backend.js). Настраивается здесь, а не в notifier.js, потому что
	// pushToast/аудио — UI-специфичные зависимости.
	useEffect(() => {
		// НАЙДЕНО ЖИВЫМ ИСПОЛЬЗОВАНИЕМ: backend.js вызывает onToast(title, body, onClick)
		// ПОЗИЦИОННО (тот же стиль, что showPopup(title, body, onClick)), а pushToast ждёт
		// ОДИН объект {title, body, onClick} — без адаптера title/body попадали бы
		// неправильно, а onClick вовсе терялся бы: клик по тосту не переходил "к месту
		// события" ни при каких обстоятельствах, хотя backend.js его честно передавал.
		configureDefaultBackend({ onToast: (title, body, onClick) => pushToast({ title, body, onClick }), audioSrc: NOTIFICATION_SOUND_DATA_URI });
	}, []);

	// Клик по контакту (contacts.jsx) устанавливает activeChatPubkey — переключаем
	// вкладку на "Сообщения"; сам экран (chat.jsx, этап 27) реагирует на
	// activeChatPubkey.value самостоятельно (список чатов ↔ открытая переписка).
	useEffect(() => {
		if (activeChatPubkey.value) setActiveId("messages");
	}, [activeChatPubkey.value]);

	// НАЙДЕНО ПОЛЬЗОВАТЕЛЕМ (этап 47-довесок-3) — тот же принцип, что выше для
	// activeChatPubkey, но для каналов ЕГО НЕ БЫЛО ВООБЩЕ: openChannel(id) менял
	// сигнал, но вкладку нава не переключал — работало, только если пользователь
	// УЖЕ был на "Каналах". Без этого клик по уведомлению о канале открывал бы
	// нужный канал "невидимо" за текущей вкладкой.
	useEffect(() => {
		if (activeChannelId.value) setActiveId("channels");
	}, [activeChannelId.value]);

	// Этап 47-довесок-3 — клик по уведомлению (тост/нативное) переходит "к месту
	// события": сначала переключаем вкладку нава, затем форвардим специфику
	// экрана (контакт/канал/пост/комментарий) в уже существующие сигналы.
	useEffect(() => {
		const target = pendingNavTarget.value;
		if (!target) return;
		setActiveId(target.screen);
		applyNavTarget(target);
		pendingNavTarget.value = null;
	}, [pendingNavTarget.value]);

	// Этап 47 — бейджи "[N]" в наве. Тот же триггер (messagingActivity), что уже
	// используют contacts.jsx/channels.jsx для перечитывания своих списков — здесь
	// просто ещё один потребитель того же bump-сигнала. refreshContacts — на случай,
	// если пользователь ни разу не открывал "Контакты" в этой сессии (contacts.value
	// иначе остался бы пустым, unread-сумма всегда 0).
	useEffect(() => {
		refreshContacts(ownerPubkey).then(() => refreshUnreadMessagesCount(ownerPubkey));
		refreshUnreadChannelsCount(ownerPubkey, dbKey);
		// Этап 50 — тот же триггер, для бейджа "Журнал [N]" (непрочитанные записи).
		refreshJournal(ownerPubkey, dbKey);
	}, [ownerPubkey, messagingActivity.value]);

	const unreadJournalCount = journalEntries.value.filter((e) => !e.read).length;

	// Адаптив (< 768px, пользователь) — сайдбар прячется в выезжающую панель
	// поверх контента, открывается бургером в углу. Esc закрывает — тот же
	// приём, что уже есть в ImageModal.
	useEffect(() => {
		if (!sidebarOpen) return;
		function handleKeyDown(e) {
			if (e.key === "Escape") setSidebarOpen(false);
		}
		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [sidebarOpen]);

	function selectNavItem(id) {
		setActiveId(id);
		setSidebarOpen(false);
	}

	return (
		<div class="app-shell">
			<ToastHost />
			{/* Этап 48 — CallOverlay ВНЕ .app-layout: полноэкранные состояния
			    (входящий/исходящий звонок) — намеренно фиксированный modal поверх
			    ВСЕГО, включая сайдбар. Компактная плашка (CONNECTED) — обычный
			    block-элемент в потоке, сжимающий .app-layout по высоте, а не
			    перекрывающий его (иначе плашка накрывала бы верх сайдбара). */}
			<CallOverlay />
			{/* Угол сверху-справа — переключатель темы (пользователь: "переключатель
			    сверху стоит добавить") + бургер адаптива (пользователь: "весь
			    sidebar прятать в бургер-кнопку справа вверху") в одном фиксированном
			    контейнере, чтобы не считать отступы вручную под каждую отдельно. */}
			<div class="top-corner-actions">
				<button
					type="button"
					class="sidebar-toggle-btn"
					onClick={() => setSidebarOpen((v) => !v)}
					aria-expanded={sidebarOpen}
					aria-controls="app-sidebar"
					aria-label={sidebarOpen ? "Закрыть меню" : "Открыть меню"}
				>
					{sidebarOpen ? "✕" : <IconMenu />}
				</button>
				<button
					type="button"
					class="theme-toggle-btn"
					onClick={handleToggleTheme}
					aria-label={resolveEffectiveTheme(themeMode) === "dark" ? "Включить светлую тему" : "Включить тёмную тему"}
				>
					{resolveEffectiveTheme(themeMode) === "dark" ? <IconSun /> : <IconMoon />}
				</button>
			</div>
			<div class="app-layout">
			{sidebarOpen && <div class="sidebar-backdrop" onClick={() => setSidebarOpen(false)} aria-hidden="true" />}
			<aside id="app-sidebar" class={`sidebar${sidebarOpen ? " sidebar-open" : ""}`} aria-label="Профиль и главное меню">
				<SidebarProfileCard onEditProfile={() => selectNavItem("profile")} />
				<nav role="navigation" aria-label="Главное меню" style={{ flex: "1 1 auto" }}>
					<ul role="list">
						{NAV_ITEMS.map(item => {
							const ItemIcon = NAV_ICONS[item.id];
							const badgeCount =
								item.id === "messages"
									? unreadMessagesCount.value
									: item.id === "channels"
										? unreadChannelsCount.value
										: item.id === "journal"
											? unreadJournalCount
											: 0;
							return (
								<li key={item.id}>
									<button
										type="button"
										class={`nav-item-btn${item.id === activeId ? " is-active" : ""}`}
										onClick={() => selectNavItem(item.id)}
										aria-current={item.id === activeId ? "page" : null}
									>
										<ItemIcon />
										{item.label}
										{badgeCount > 0 && (
											<span class="nav-badge" aria-label={`непрочитано: ${badgeCount}`}>
												{badgeCount}
											</span>
										)}
									</button>
								</li>
							);
						})}
					</ul>
					{/* Пользователь (item 4) — статус соединения ПОСТОЯННО виден под
					    главным меню, на любом экране, не только там, где раньше был
					    ad-hoc "Соединение: ..." (contacts.jsx/chat.jsx — убраны). */}
					<ConnectionStatusPanel />
				</nav>
				<button type="button" class="nav-item-btn exit-btn" onClick={lock}>
					<IconExit />
					Выйти
				</button>
			</aside>
			<div class="main-content">
				{activeId === "diagnostics" && <Diagnostics />}
				{activeId === "profile" && <Profile />}
				{activeId === "contacts" && <Contacts />}
				{activeId === "messages" && <Chat />}
				{activeId === "channels" && <Channels />}
				{activeId === "discovery" && <Discovery />}
				{activeId === "settings" && <Settings />}
				{activeId === "journal" && <Journal />}
				{activeId === "files" && <Files />}
				{activeId !== "diagnostics" &&
					activeId !== "profile" &&
					activeId !== "contacts" &&
					activeId !== "messages" &&
					activeId !== "channels" &&
					activeId !== "discovery" &&
					activeId !== "settings" &&
					activeId !== "journal" &&
					activeId !== "files" && <Placeholder title={NAV_ITEMS.find(item => item.id === activeId).label} />}
			</div>
			</div>
		</div>
	);
}

export default function App() {
	const user = currentUser.value;

	if (user) {
		return <MainShell />;
	}

	// Единый стартовый экран (unlock.jsx) — вход, регистрация и "другие способы"
	// живут виджетами одной страницы, отдельный роут /onboarding больше не нужен.
	return <Unlock />;
}
