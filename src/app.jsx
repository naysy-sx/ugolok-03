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
import { currentUser, lock, dbKeySig } from "./ui/signals/auth.js";
import { activeChatPubkey } from "./ui/signals/chat.js";
import { messagingActivity } from "./ui/signals/chats.js";
import { refreshContacts } from "./ui/signals/contacts.js";
import { unreadMessagesCount, unreadChannelsCount, refreshUnreadMessagesCount, refreshUnreadChannelsCount } from "./ui/signals/notifications.js";
import SidebarProfileCard from "./ui/components/sidebar-profile-card.jsx";
import IconChatBubble from "./ui/icons/chat-bubble.jsx";
import IconReader from "./ui/icons/reader.jsx";
import IconPeople from "./ui/icons/people.jsx";
import IconGear from "./ui/icons/gear.jsx";
import IconPerson from "./ui/icons/person.jsx";
import IconActivityLog from "./ui/icons/activity-log.jsx";
import IconExit from "./ui/icons/exit.jsx";
import IconGlobe from "./ui/icons/globe.jsx";

// nav-items.js — чистые данные (см. комментарий там), маппинг id → иконка
// живёт здесь, во view-слое.
const NAV_ICONS = {
	messages: IconChatBubble,
	channels: IconReader,
	contacts: IconPeople,
	discovery: IconGlobe,
	settings: IconGear,
	profile: IconPerson,
	diagnostics: IconActivityLog,
};

function MainShell() {
	const [activeId, setActiveId] = useState(DEFAULT_ACTIVE);
	const ownerPubkey = currentUser.value.id;
	const dbKey = dbKeySig.value;

	// Клик по контакту (contacts.jsx) устанавливает activeChatPubkey — переключаем
	// вкладку на "Сообщения"; сам экран (chat.jsx, этап 27) реагирует на
	// activeChatPubkey.value самостоятельно (список чатов ↔ открытая переписка).
	useEffect(() => {
		if (activeChatPubkey.value) setActiveId("messages");
	}, [activeChatPubkey.value]);

	// Этап 47 — бейджи "[N]" в наве. Тот же триггер (messagingActivity), что уже
	// используют contacts.jsx/channels.jsx для перечитывания своих списков — здесь
	// просто ещё один потребитель того же bump-сигнала. refreshContacts — на случай,
	// если пользователь ни разу не открывал "Контакты" в этой сессии (contacts.value
	// иначе остался бы пустым, unread-сумма всегда 0).
	useEffect(() => {
		refreshContacts(ownerPubkey).then(() => refreshUnreadMessagesCount(ownerPubkey));
		refreshUnreadChannelsCount(ownerPubkey, dbKey);
	}, [ownerPubkey, messagingActivity.value]);

	return (
		<div class="app-layout">
			<aside class="sidebar" aria-label="Профиль и главное меню">
				<SidebarProfileCard onEditProfile={() => setActiveId("profile")} />
				<nav role="navigation" aria-label="Главное меню" style={{ flex: "1 1 auto" }}>
					<ul role="list">
						{NAV_ITEMS.map(item => {
							const ItemIcon = NAV_ICONS[item.id];
							const badgeCount = item.id === "messages" ? unreadMessagesCount.value : item.id === "channels" ? unreadChannelsCount.value : 0;
							return (
								<li key={item.id}>
									<button
										type="button"
										class={`nav-item-btn${item.id === activeId ? " is-active" : ""}`}
										onClick={() => setActiveId(item.id)}
										aria-current={item.id === activeId ? "page" : null}
									>
										<ItemIcon />
										{item.label}
										{badgeCount > 0 && <span aria-label={`непрочитано: ${badgeCount}`}> [{badgeCount}]</span>}
									</button>
								</li>
							);
						})}
					</ul>
				</nav>
				<button type="button" class="nav-item-btn" onClick={lock}>
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
				{activeId !== "diagnostics" &&
					activeId !== "profile" &&
					activeId !== "contacts" &&
					activeId !== "messages" &&
					activeId !== "channels" &&
					activeId !== "discovery" &&
					activeId !== "settings" && <Placeholder title={NAV_ITEMS.find(item => item.id === activeId).label} />}
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
