import { useState, useEffect } from "preact/hooks";
import { useRoute } from "./ui/router.js";
import { NAV_ITEMS, DEFAULT_ACTIVE } from "./ui/nav-items.js";
import Diagnostics from "./ui/screens/diagnostics.jsx";
import Placeholder from "./ui/screens/placeholder.jsx";
import Onboarding from "./ui/screens/onboarding.jsx";
import Unlock from "./ui/screens/unlock.jsx";
import Profile from "./ui/screens/profile.jsx";
import Contacts from "./ui/screens/contacts.jsx";
import Chat from "./ui/screens/chat.jsx";
import Channels from "./ui/screens/channels.jsx";
import Settings from "./ui/screens/settings.jsx";
import { currentUser } from "./ui/signals/auth.js";
import { activeChatPubkey } from "./ui/signals/chat.js";

function MainShell() {
	const [activeId, setActiveId] = useState(DEFAULT_ACTIVE);

	// Клик по контакту (contacts.jsx) устанавливает activeChatPubkey — переключаем
	// вкладку на "Сообщения"; сам экран (chat.jsx, этап 27) реагирует на
	// activeChatPubkey.value самостоятельно (список чатов ↔ открытая переписка).
	useEffect(() => {
		if (activeChatPubkey.value) setActiveId("messages");
	}, [activeChatPubkey.value]);

	return (
		<div style={{ display: "flex", minHeight: "100dvh" }}>
			<aside
				style={{
					flex: "0 0 auto",
					borderInlineEnd: "var(--border-width) solid var(--border)",
					padding: "var(--space-m)"
				}}
			>
				<nav role="navigation">
					<ul role="list">
						{NAV_ITEMS.map(item => (
							<li key={item.id}>
								<button
									type="button"
									onClick={() => setActiveId(item.id)}
									aria-current={item.id === activeId ? "page" : null}
								>
									{item.label}
								</button>
							</li>
						))}
					</ul>
				</nav>
			</aside>
			<div
				style={{
					flex: "1 1 auto",
					overflow: "auto"
				}}
			>
				{activeId === "diagnostics" && <Diagnostics />}
				{activeId === "profile" && <Profile />}
				{activeId === "contacts" && <Contacts />}
				{activeId === "messages" && <Chat />}
				{activeId === "channels" && <Channels />}
				{activeId === "settings" && <Settings />}
				{activeId !== "diagnostics" &&
					activeId !== "profile" &&
					activeId !== "contacts" &&
					activeId !== "messages" &&
					activeId !== "channels" &&
					activeId !== "settings" && <Placeholder title={NAV_ITEMS.find(item => item.id === activeId).label} />}
			</div>
		</div>
	);
}

export default function App() {
	const route = useRoute();
	const user = currentUser.value;

	if (user) {
		return <MainShell />;
	}

	if (route === "/onboarding") return <Onboarding />;
	return <Unlock />;
}
