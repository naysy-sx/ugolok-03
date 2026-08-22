import { useState, useEffect, useId } from "preact/hooks";
import { currentUser, privKeySig, dbKeySig } from "../signals/auth.js";
import { publish, fetchProfiles } from "../signals/transport.js";
import { messagingActivity } from "../signals/chats.js";
import { profiles, ensureProfilesFetched } from "../signals/contacts.js";
import { openChat, openChannel, goTo } from "../signals/place.js";
import { listConversations } from "../../domain/messaging/chat-activity.js";
import { listOwnedChannels, listSubscribedChannels } from "../../domain/content/channel.js";
import { loadPinned, pinChannel, unpinChannel, pinPerson, unpinPerson } from "../../domain/contacts/pinned.js";
import { useDetailsMenu } from "../hooks/use-details-menu.js";
import { shortPubkey } from "../format.js";
import IconPlus from "../icons/plus.jsx";
import IconMagnifyingGlass from "../icons/magnifying-glass.jsx";
import IconBell from "../icons/bell.jsx";
import { t } from "../signals/i18n.js";

// Редизайн интерфейса, этап 10.2 (CONTRACTS.md) — "Люди" здесь это
// ПЕРЕПИСКИ (listConversations, этап 5), НЕ полный список контактов
// (REDESIGN-SPEC.md явно: "Полный список контактов живёт на экране
// «Люди», не в панели"). Буква "?" в имени/канале — не показана,
// заглушка-круг с первой буквой (тот же приём, что мокап — .ava.ava--sm,
// без реальной загрузки/расшифровки аватара, это лёгкая панель навигации,
// не витрина).
function initial(name) {
	return (name || "?").trim().charAt(0).toUpperCase() || "?";
}

function Avatar({ name }) {
	return (
		<span class="stream-ava row" aria-hidden="true" style={{ alignItems: "center", justifyContent: "center" }}>
			{initial(name)}
		</span>
	);
}

// Пин-тумблер — текстовый глиф (⚑/⚐), тот же приём, что уже есть в проекте
// для лёгких одноразовых индикаторов (discovery-card ✓/○, кнопка "◈ Сегодня") —
// не заводим новый SVG-компонент ради одной иконки.
function PinToggle({ pinned, onToggle, label }) {
	return (
		<button type="button" class="pin-toggle" onClick={onToggle} aria-pressed={pinned} aria-label={label}>
			{pinned ? "⚑" : "⚐"}
		</button>
	);
}

function StreamItem({ name, onOpen, pinned, onTogglePin, pinLabel }) {
	return (
		<li class="stream-row row" style={{ alignItems: "center" }}>
			<button type="button" class="stream row grow" style={{ alignItems: "center" }} onClick={onOpen}>
				<Avatar name={name} />
				<span class="stream__name">{name}</span>
			</button>
			<PinToggle pinned={pinned} onToggle={onTogglePin} label={pinLabel} />
		</li>
	);
}

// "＋" — 2 пункта, оба ведут на экран, где нужная кнопка уже существует
// (chat.jsx's "Написать"/channels.jsx's "Создать канал") — решение Claude:
// не заводить новое кросс-компонентное состояние "открой сразу форму"
// ради экономии одного клика (CONTRACTS.md, этап 10.2).
function AddMenu() {
	const { ref, handleMenuClick } = useDetailsMenu();
	return (
		<details class="menu" ref={ref} onClick={handleMenuClick}>
			<summary class="icon-btn" aria-label={t("shell.addMenuAria")}>
				<IconPlus />
			</summary>
			<div class="menu__pop stack" style={{ "--gap": "2px" }}>
				<button type="button" onClick={() => goTo({ kind: "chat" })}>
					{t("shell.addMenuCompose")}
				</button>
				<button type="button" onClick={() => goTo({ kind: "channels" })}>
					{t("shell.addMenuCreateChannel")}
				</button>
			</div>
		</details>
	);
}

export default function NavGroups({ unreadJournalCount }) {
	const ownerPubkey = currentUser.value.id;
	const privKey = privKeySig.value;
	const dbKey = dbKeySig.value;
	const searchId = useId();

	const [query, setQuery] = useState("");
	const [conversations, setConversations] = useState([]);
	const [owned, setOwned] = useState([]);
	const [subscribed, setSubscribed] = useState([]);
	const [pinned, setPinned] = useState({ channels: [], people: [] });

	async function refresh() {
		const [convs, ownedChannels, subscribedChannels, pinnedData] = await Promise.all([
			listConversations(ownerPubkey, dbKey),
			listOwnedChannels(ownerPubkey, dbKey),
			listSubscribedChannels(ownerPubkey, dbKey),
			loadPinned(ownerPubkey, dbKey),
		]);
		setConversations(convs);
		setOwned([...ownedChannels].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)));
		setSubscribed([...subscribedChannels].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)));
		setPinned(pinnedData);
		ensureProfilesFetched(convs.map((c) => c.chatId), fetchProfiles).catch(() => {});
	}

	useEffect(() => {
		refresh();
	}, [ownerPubkey, messagingActivity.value]);

	async function handleTogglePinChannel(channelId, isPinned) {
		await (isPinned ? unpinChannel : pinChannel)(ownerPubkey, privKey, dbKey, channelId, publish);
		refresh();
	}

	async function handleTogglePinPerson(pubkey, isPinned) {
		await (isPinned ? unpinPerson : pinPerson)(ownerPubkey, privKey, dbKey, pubkey, publish);
		refresh();
	}

	const allChannels = [...owned, ...subscribed];
	const channelName = (id) => allChannels.find((c) => c.id === id)?.name || null;
	const personName = (pubkey) => profiles.value[pubkey]?.name || shortPubkey(pubkey);

	const matches = (name) => !query.trim() || name.toLowerCase().includes(query.trim().toLowerCase());

	const favoriteChannels = pinned.channels.map((id) => ({ id, name: channelName(id) })).filter((c) => c.name && matches(c.name));
	const favoritePeople = pinned.people.filter((pk) => matches(personName(pk)));

	const visibleConversations = conversations.filter((c) => matches(personName(c.chatId)));
	const visibleOwned = owned.filter((c) => matches(c.name || ""));
	const visibleSubscribed = subscribed.filter((c) => matches(c.name || ""));

	return (
		<div class="nav-groups stack" style={{ "--gap": "var(--space-s)" }}>
			<div class="sidebar-row bar grow" style={{ "--gap": "var(--space-2xs)", alignItems: "center" }}>
				<label class="visually-hidden" for={searchId}>
					{t("shell.searchLabel")}
				</label>
				<div class="file-search-field row grow" style={{ "--gap": "var(--space-2xs)", alignItems: "center" }}>
					<IconMagnifyingGlass aria-hidden="true" />
					<input id={searchId} type="search" placeholder={t("shell.searchPlaceholder")} value={query} onInput={(e) => setQuery(e.currentTarget.value)} />
				</div>
				<button type="button" class="icon-btn journal-bell-btn" onClick={() => goTo({ kind: "journal" })} aria-label={t("shell.journalBellAria")}>
					<IconBell />
					{unreadJournalCount > 0 && (
						<span class="nav-badge" aria-label={t("shell.unreadAriaLabel", { count: unreadJournalCount })}>
							{unreadJournalCount}
						</span>
					)}
				</button>
				<AddMenu />
			</div>

			{(favoriteChannels.length > 0 || favoritePeople.length > 0) && (
				<div class="stack" style={{ "--gap": "var(--space-3xs)" }}>
					<p class="eyebrow grouphead-plain">{t("shell.favoritesHeading")}</p>
					<ul class="streams stack" style={{ "--gap": "var(--space-3xs)" }}>
						{favoriteChannels.map((c) => (
							<StreamItem key={`fc-${c.id}`} name={c.name} onOpen={() => openChannel(c.id)} pinned onTogglePin={() => handleTogglePinChannel(c.id, true)} pinLabel={t("shell.unpinAria", { name: c.name })} />
						))}
						{favoritePeople.map((pk) => (
							<StreamItem key={`fp-${pk}`} name={personName(pk)} onOpen={() => openChat(pk)} pinned onTogglePin={() => handleTogglePinPerson(pk, true)} pinLabel={t("shell.unpinAria", { name: personName(pk) })} />
						))}
					</ul>
				</div>
			)}

			<div class="stack" style={{ "--gap": "var(--space-3xs)" }}>
				<button type="button" class="eyebrow grouphead row" style={{ alignItems: "center", justifyContent: "space-between" }} onClick={() => goTo({ kind: "people" })} title={t("shell.peopleGroupTitle")}>
					{t("shell.peopleGroupHeading")}
					<span class="grouphead__all">{t("shell.groupAllLink")}</span>
				</button>
				<ul class="streams stack" style={{ "--gap": "var(--space-3xs)" }}>
					{visibleConversations.map((c) => (
						<StreamItem
							key={c.chatId}
							name={personName(c.chatId)}
							onOpen={() => openChat(c.chatId)}
							pinned={pinned.people.includes(c.chatId)}
							onTogglePin={() => handleTogglePinPerson(c.chatId, pinned.people.includes(c.chatId))}
							pinLabel={t(pinned.people.includes(c.chatId) ? "shell.unpinAria" : "shell.pinAria", { name: personName(c.chatId) })}
						/>
					))}
				</ul>
			</div>

			<div class="stack" style={{ "--gap": "var(--space-3xs)" }}>
				<button type="button" class="eyebrow grouphead row" style={{ alignItems: "center", justifyContent: "space-between" }} onClick={() => goTo({ kind: "channels" })} title={t("shell.myChannelsGroupTitle")}>
					{t("shell.myChannelsGroupHeading")}
					<span class="grouphead__all">{t("shell.groupAllLink")}</span>
				</button>
				<ul class="streams stack" style={{ "--gap": "var(--space-3xs)" }}>
					{visibleOwned.map((c) => (
						<StreamItem
							key={c.id}
							name={c.name || t("channels.card.untitled")}
							onOpen={() => openChannel(c.id)}
							pinned={pinned.channels.includes(c.id)}
							onTogglePin={() => handleTogglePinChannel(c.id, pinned.channels.includes(c.id))}
							pinLabel={t(pinned.channels.includes(c.id) ? "shell.unpinAria" : "shell.pinAria", { name: c.name || t("channels.card.untitled") })}
						/>
					))}
				</ul>
			</div>

			<div class="stack" style={{ "--gap": "var(--space-3xs)" }}>
				<button type="button" class="eyebrow grouphead row" style={{ alignItems: "center", justifyContent: "space-between" }} onClick={() => goTo({ kind: "channels" })} title={t("shell.subscriptionsGroupTitle")}>
					{t("shell.subscriptionsGroupHeading")}
					<span class="grouphead__all">{t("shell.groupAllLink")}</span>
				</button>
				<ul class="streams stack" style={{ "--gap": "var(--space-3xs)" }}>
					{visibleSubscribed.map((c) => (
						<StreamItem
							key={c.id}
							name={c.name || t("channels.card.untitled")}
							onOpen={() => openChannel(c.id)}
							pinned={pinned.channels.includes(c.id)}
							onTogglePin={() => handleTogglePinChannel(c.id, pinned.channels.includes(c.id))}
							pinLabel={t(pinned.channels.includes(c.id) ? "shell.unpinAria" : "shell.pinAria", { name: c.name || t("channels.card.untitled") })}
						/>
					))}
				</ul>
			</div>
		</div>
	);
}
