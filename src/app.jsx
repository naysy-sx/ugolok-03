import { useState, useEffect } from "preact/hooks";
import { signal } from "@preact/signals";
import { NAV_ITEMS } from "./ui/nav-items.js";
import Quick from "./ui/screens/quick.jsx";
import Diagnostics from "./ui/screens/diagnostics.jsx";
import Placeholder from "./ui/screens/placeholder.jsx";
import Unlock from "./ui/screens/unlock.jsx";
import Profile from "./ui/screens/profile.jsx";
import Contacts from "./ui/screens/contacts.jsx";
import Chat from "./ui/screens/chat.jsx";
import Channels from "./ui/screens/channels.jsx";
import Settings from "./ui/screens/settings.jsx";
import Journal from "./ui/screens/journal.jsx";
import Today from "./ui/screens/today.jsx";
import Files from "./ui/screens/files.jsx";
import Help from "./ui/screens/help.jsx";
import { currentUser, lock, dbKeySig, privKeySig } from "./ui/signals/auth.js";
import { publish, ensureConnected } from "./ui/signals/transport.js";
import { startPlayerBridge } from "./domain/files/player-bridge.js";
import { loadUiSettings, saveUiSettings } from "./domain/settings/ui-settings.js";
import { applyCustomPalette } from "./ui/theme/palette-apply.js";
import { applyUiScale } from "./ui/theme/ui-scale.js";
import { applyThemeMode, toggleThemeMode } from "./ui/theme/theme-mode.js";
import { setLocale, t } from "./ui/signals/i18n.js";
import { place, goTo } from "./ui/signals/place.js";
import { pendingNavTarget, applyNavTarget } from "./ui/signals/notification-nav.js";
import { messagingActivity } from "./ui/signals/chats.js";
import { refreshContacts } from "./ui/signals/contacts.js";
import { journalEntries, refreshJournal } from "./ui/signals/journal.js";
import { unreadMessagesCount, unreadChannelsCount, refreshUnreadMessagesCount, refreshUnreadChannelsCount } from "./ui/signals/notifications.js";
import { configureDefaultBackend } from "./domain/notifications/notifier.js";
import { pushToast } from "./ui/signals/toasts.js";
import ToastHost from "./ui/components/toast-host.jsx";
import CallOverlay from "./ui/components/call-overlay.jsx";
import MediaOverlay from "./ui/components/media/media-overlay.jsx";
import SyncProgressBar from "./ui/components/sync-progress-bar.jsx";
import { NOTIFICATION_SOUND_DATA_URI } from "./domain/notifications/sound-asset.js";
import SidebarProfileCard from "./ui/components/sidebar-profile-card.jsx";
import ThemeStatusPanel from "./ui/components/theme-status.jsx";
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
import IconHelpCircle from "./ui/icons/help-circle.jsx";

// ROOMS-SPEC.md §1.4 — "Быстрая связь" (Rooms) — отдельная ветка ВЕРХНЕГО
// уровня, НЕ внутри MainShell (иначе гостевые if внутри общей оболочки дают
// тот же класс расползающихся правок, что owner-scoping доставался четырьмя
// заходами, см. ROOMS-SPEC). Сигнал модульного уровня, не useState внутри
// MainShell — доступен App() снаружи MainShell для переключения ветки.
export const roomsScreenActive = signal(false);

// nav-items.js — чистые данные (см. комментарий там), маппинг id → иконка
// живёт здесь, во view-слое.
const NAV_ICONS = {
	journal: IconBell,
	chat: IconChatBubble,
	channels: IconReader,
	people: IconPeople,
	settings: IconGear,
	profile: IconPerson,
	help: IconHelpCircle,
	diagnostics: IconActivityLog,
};

function MainShell() {
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
			applyCustomPalette(loaded.customPalette);
			applyUiScale(loaded.uiScale);
			applyThemeMode(loaded.themeMode);
			setThemeMode(loaded.themeMode);
			// Этап 64 — тот же принцип, что accent/scale/theme выше: применить СРАЗУ
			// при заходе в MainShell, не ждать, пока пользователь откроет Настройки
			// (иначе после логина интерфейс на секунду показывает язык, определённый
			// currentLocale's дефолтом при загрузке модуля, вместо явного выбора
			// пользователя, сохранённого для ЭТОГО аккаунта).
			setLocale(loaded.language);
		});
	}, [ownerPubkey]);

	// Найдено живой проверкой (этап 53-довесок): ensureConnected() вызывался
	// только точечно изнутри отдельных экранов (Обзор/Контакты/Каналы/Чат/
	// Профиль) — "Журнал"/"Файлы"/сам сайдбар соединение не инициировали
	// вовсе. Пользователь, чей первый взгляд после логина/разблокировки
	// приходится на один из этих экранов, видел "офлайн" и пустой
	// профиль/список чатов, пока не переходил на "подключающий" экран —
	// bootstrap (включая hydrateOwnProfile, kind 0/3/30050/…) не запускался.
	// ensureConnected идемпотентен (см. transport.js — де-дуп по
	// connectedForPubkey/connectPromise), поэтому безопасно вызвать его ещё
	// раз здесь и ещё раз с каждого экрана ниже — повторные вызовы не
	// пересоздают соединение. Ошибка — best-effort: ConnectionStatusPanel
	// уже отражает connState реактивно, отдельный экран покажет её сам,
	// если попытается что-то запросить без соединения.
	useEffect(() => {
		ensureConnected(ownerPubkey, privKey, dbKey).catch(() => {});
	}, [ownerPubkey]);

	// Этап 53 И4 (задача 4.1) — обработчик сообщений SW->страница для
	// перехвата Range (CONTRACTS.md/DESIGN.md). Один раз на приложение,
	// не завязан на ownerPubkey (реестр открытых файлов — player-bridge.js).
	useEffect(() => startPlayerBridge(), []);

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

	// Редизайн интерфейса, этап 10.1 (CONTRACTS.md/DESIGN.md) — клик по
	// уведомлению (тост/нативное) переходит "к месту события": applyNavTarget
	// пишет ПРЯМО в place (единое состояние места) — отдельного переключения
	// вкладки нава не нужно, рендер уже читает place.value.kind напрямую.
	// Раньше здесь было ТРИ отдельных useEffect-синхронизатора (activeId ⇐
	// activeChatPubkey/activeChannelId/pendingNavTarget, отчёт A1/A3) — вся
	// причина их существования (три независимых сигнала могли разойтись)
	// устранена самим единым place, синхронизировать больше нечего.
	useEffect(() => {
		const target = pendingNavTarget.value;
		if (!target) return;
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

	// Редизайн интерфейса, этап 10.1 — раньше здесь был ручной сброс ЧУЖИХ
	// сигналов (activeChatPubkey/activeChannelId), нужный из-за найденного
	// пользователем бага (повторный клик по тому же контакту после ухода на
	// другую вкладку не переключал её — activeChatPubkey не МЕНЯЛ значение,
	// эффект на него не срабатывал повторно). place — ПОЛНАЯ замена объекта
	// (goTo/place.js), кросс-сигнальной рассинхронизации структурно не
	// бывает: id всегда однозначно относится к ТЕКУЩЕМУ kind, отдельно
	// сбрасывать нечего.
	function selectNavItem(id) {
		goTo({ kind: id });
		setSidebarOpen(false);
	}

	return (
		<div class="shell stack">
			<ToastHost />
			<SyncProgressBar />
			{/* Этап 48 — CallOverlay ВНЕ .app-layout: полноэкранные состояния
			    (входящий/исходящий звонок) — намеренно фиксированный modal поверх
			    ВСЕГО, включая сайдбар. Компактная плашка (CONNECTED) — обычный
			    block-элемент в потоке, сжимающий .app-layout по высоте, а не
			    перекрывающий его (иначе плашка накрывала бы верх сайдбара). */}
			<CallOverlay />
			{/* Этап D медиа-подсистемы — MediaOverlay ВНЕ .app-layout по тому же
			    принципу, что CallOverlay: полноэкранный просмотр/свёрнутая плашка
			    должны пережить переход между разделами (MEDIA-SPEC.md §7.5), не
			    размонтируясь вместе с текущим экраном. z-index ниже CallOverlay
			    (custom.css: .media-overlay 190 < .call-overlay 200 < .top-corner-actions
			    300) — звонок приоритетнее (И2 и так приостанавливает воспроизведение,
			    но чтобы вплывающий чат-звонок не оказался ПОД просмотрщиком). */}
			<MediaOverlay />
			{/* Ограничение ширины на широких мониторах (пользователь: 3440px —
			    приложение расползалось на всю ширину) + якорь позиционирования
			    для .top-corner-actions ниже — раскладка/размер в custom.css
			    (.app-shell-inner: не подошёл готовый composition-класс .center,
			    там общий на проект --measure протёк бы в каждый <p> внутри). */}
			<div class="app-shell-inner stack grow">
			{/* Угол сверху-справа — бургер адаптива (пользователь: "весь sidebar
			    прятать в бургер-кнопку справа вверху"). Переключатель темы отсюда
			    убран (пользователь) — переехал в сайдбар отдельной панелью
			    (ThemeStatusPanel), над ConnectionStatusPanel, тот же визуальный
			    язык. */}
			<div class="top-corner-actions row" style={{ "--gap": "var(--space-2xs)" }}>
				<button
					type="button"
					class={`sidebar-toggle-btn${sidebarOpen ? " is-open" : ""}`}
					onClick={() => setSidebarOpen((v) => !v)}
					aria-expanded={sidebarOpen}
					aria-controls="app-sidebar"
					aria-label={sidebarOpen ? t("shell.closeMenu") : t("shell.openMenu")}
				>
					<span class="hamburger-bar" aria-hidden="true" />
					<span class="hamburger-bar" aria-hidden="true" />
					<span class="hamburger-bar" aria-hidden="true" />
				</button>
			</div>
			<div class="app-layout grow">
			{sidebarOpen && <div class="sidebar-backdrop" onClick={() => setSidebarOpen(false)} aria-hidden="true" />}
			<aside
				id="app-sidebar"
				class={`sidebar rigid stack scroller box${sidebarOpen ? " sidebar-open" : ""}`}
				style={{ "--gap": "var(--space-m)", "--pad": "var(--space-m)" }}
				aria-label={t("shell.sidebarAriaLabel")}
			>
				<SidebarProfileCard onEditProfile={() => selectNavItem("profile")} onOpenStorage={() => selectNavItem("files")} />
				<nav role="navigation" class="grow" aria-label={t("shell.navAriaLabel")}>
					<ul role="list">
						{NAV_ITEMS.map(item => {
							const ItemIcon = NAV_ICONS[item.id];
							const badgeCount =
								item.id === "chat"
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
										class={`nav-item-btn row${item.id === place.value.kind ? " is-active" : ""}`}
										style={{ "--gap": "var(--space-2xs)", alignItems: "center" }}
										onClick={() => selectNavItem(item.id)}
										aria-current={item.id === place.value.kind ? "page" : null}
									>
										<ItemIcon />
										{t(item.labelKey)}
										{badgeCount > 0 && (
											<span class="nav-badge" aria-label={t("shell.unreadAriaLabel", { count: badgeCount })}>
												{badgeCount}
											</span>
										)}
									</button>
								</li>
							);
						})}
					</ul>
					{/* Переключатель темы (пользователь) — был плавающей кнопкой в углу
					    экрана, теперь панель здесь, тот же визуальный язык, что
					    ConnectionStatusPanel сразу под ней. */}
					<ThemeStatusPanel themeMode={themeMode} onToggle={handleToggleTheme} />
					{/* Пользователь (item 4) — статус соединения ПОСТОЯННО виден под
					    главным меню, на любом экране, не только там, где раньше был
					    ad-hoc "Соединение: ..." (contacts.jsx/chat.jsx — убраны). */}
					<ConnectionStatusPanel />
				</nav>
				{/* ROOMS-SPEC.md §1.4 — вход в отдельную верхнеуровневую ветку (см.
				    App() ниже), не переключение activeId: "Быстрая связь" не является
				    вкладкой MainShell, у неё своя, независимая от аккаунта, identity. */}
				<button
					type="button"
					class="nav-item-btn row"
					style={{ "--gap": "var(--space-2xs)", alignItems: "center" }}
					onClick={() => (roomsScreenActive.value = true)}
				>
					<IconGlobe />
					{t("shell.quickConnect")}
				</button>
				<button type="button" class="nav-item-btn exit-btn row" style={{ "--gap": "var(--space-2xs)", alignItems: "center" }} onClick={lock}>
					<IconExit />
					{t("shell.logout")}
				</button>
			</aside>
			<div class="main-content grow">
				{place.value.kind === "diagnostics" && <Diagnostics />}
				{place.value.kind === "profile" && <Profile />}
				{place.value.kind === "help" && <Help />}
				{place.value.kind === "people" && <Contacts />}
				{place.value.kind === "chat" && <Chat />}
				{(place.value.kind === "channels" || place.value.kind === "channel") && <Channels />}
				{place.value.kind === "settings" && <Settings />}
				{place.value.kind === "journal" && <Journal />}
				{place.value.kind === "today" && <Today onBack={() => goTo({ kind: "journal" })} />}
				{place.value.kind === "storage" && <Files />}
				{(() => {
					const KNOWN_KINDS = ["diagnostics", "profile", "help", "people", "chat", "channels", "channel", "settings", "journal", "today", "storage"];
					if (KNOWN_KINDS.includes(place.value.kind)) return null;
					const item = NAV_ITEMS.find((i) => i.id === place.value.kind);
					return <Placeholder title={item ? t(item.labelKey) : place.value.kind} />;
				})()}
			</div>
			</div>
			</div>
		</div>
	);
}

export default function App() {
	// ROOMS-SPEC.md §1.4 — проверяется ПЕРВЫМ, до currentUser: "Быстрая связь"
	// стоит НАД веткой вход/MainShell, не внутри неё. Гостевой доступ (не
	// залогинен) — через собственную вкладку unlock.jsx (см. "temp-chat" там),
	// этот сигнал включается только из MainShell (кнопка в сайдбаре).
	if (roomsScreenActive.value) {
		return <Quick onExit={() => (roomsScreenActive.value = false)} />;
	}

	const user = currentUser.value;

	if (user) {
		return <MainShell />;
	}

	// Единый стартовый экран (unlock.jsx) — вход, регистрация и "другие способы"
	// живут виджетами одной страницы, отдельный роут /onboarding больше не нужен.
	return <Unlock />;
}
