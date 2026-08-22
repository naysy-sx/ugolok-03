import { useState, useEffect, useId } from "preact/hooks";
import { currentUser, privKeySig, dbKeySig } from "../signals/auth.js";
import { publish, fetchProfiles } from "../signals/transport.js";
import { messagingActivity } from "../signals/chats.js";
import { contacts, profiles, ensureProfilesFetched } from "../signals/contacts.js";
import { openChat, openChannel, goTo } from "../signals/place.js";
import { listConversations } from "../../domain/messaging/chat-activity.js";
import { listOwnedChannels, listSubscribedChannels } from "../../domain/content/channel.js";
import { loadPinned, pinChannel, unpinChannel, pinPerson, unpinPerson } from "../../domain/contacts/pinned.js";
import { useDetailsMenu } from "../hooks/use-details-menu.js";
import { shortPubkey } from "../format.js";
import ChannelAvatarThumb from "./channel-avatar-thumb.jsx";
import IconPlus from "../icons/plus.jsx";
import IconMagnifyingGlass from "../icons/magnifying-glass.jsx";
import IconBell from "../icons/bell.jsx";
import { t } from "../signals/i18n.js";

// Редизайн интерфейса, этап 10.2 (CONTRACTS.md) — "Люди" здесь это
// ПЕРЕПИСКИ (listConversations, этап 5) ДОПОЛНЕННЫЕ остальными контактами
// без переписки (этап "область контента" — пользователь: "люди вообще не
// отображаются, а должно отображаться хотя бы несколько контактов"; пустой
// список конверсий на свежем аккаунте не должен означать пустую группу),
// НЕ полный экран управления контактами (группы/заявки — по-прежнему
// только на "Люди", REDESIGN-SPEC.md). Буква — фолбэк, когда реальной
// картинки нет (профиля не расшифровать/канал без аватара).
function initial(name) {
	return (name || "?").trim().charAt(0).toUpperCase() || "?";
}

// profile.picture — уже готовый URL из kind:0 (публичные метаданные, не
// зашифрованное вложение канала) — тот же приём, что ContactIdentity
// (contacts.jsx). Каналы — отдельный ChannelAvatarThumb (зашифрованный
// дескриптор, нужны расшифровка+скачивание, см. этот компонент).
function PersonAvatar({ pubkey, name }) {
	const picture = profiles.value[pubkey]?.picture;
	if (picture) {
		return <img src={picture} alt="" class="stream-ava" />;
	}
	return (
		<span class="stream-ava bar" aria-hidden="true" style={{ alignItems: "center", justifyContent: "center" }}>
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

function StreamItem({ avatar, name, onOpen, pinned, onTogglePin, pinLabel }) {
	return (
		<li class="stream-row row" style={{ alignItems: "center" }}>
			<button type="button" class="stream row grow" style={{ alignItems: "center" }} onClick={onOpen}>
				{avatar}
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
			<div class="menu-pop stack" style={{ "--gap": "2px" }}>
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
		// Профили нужны и для конверсий, и для контактов без переписки
		// (объединены ниже в people) — иначе имя/аватар "довешенных" контактов
		// никогда бы не подтянулись.
		ensureProfilesFetched([...new Set([...convs.map((c) => c.chatId), ...contacts.value])], fetchProfiles).catch(() => {});
	}

	useEffect(() => {
		refresh();
	}, [ownerPubkey, messagingActivity.value, contacts.value]);

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
	const channelByIdMap = new Map(allChannels.map((c) => [c.id, c]));
	const personName = (pubkey) => profiles.value[pubkey]?.name || shortPubkey(pubkey);

	const matches = (name) => !query.trim() || name.toLowerCase().includes(query.trim().toLowerCase());

	const favoriteChannels = pinned.channels.map((id) => ({ id, name: channelName(id) })).filter((c) => c.name && matches(c.name));
	const favoritePeople = pinned.people.filter((pk) => matches(personName(pk)));

	// "Люди" — переписки (свежие первыми, этап 5), ДОПОЛНЕННЫЕ остальными
	// контактами без переписки (иначе свежий аккаунт с контактами, но без
	// открытых чатов, видел бы пустую группу — найдено пользователем).
	// Контакты — НЕ полный экран управления (группы/заявки остаются только
	// на "Люди"), просто ещё несколько строк в том же списке.
	const conversationPubkeys = new Set(conversations.map((c) => c.chatId));
	const contactsWithoutConversation = contacts.value.filter((pk) => !conversationPubkeys.has(pk));
	const visiblePeople = [...conversations.map((c) => c.chatId), ...contactsWithoutConversation].filter((pk) => matches(personName(pk)));
	const visibleOwned = owned.filter((c) => matches(c.name || ""));
	const visibleSubscribed = subscribed.filter((c) => matches(c.name || ""));

	return (
		<>
			{/* Разметка по макету — .pane__top заканчивается строкой поиска
			    (карточка идентити выше — отдельный компонент, тот же фикс-блок
			    визуально благодаря общему padding-inline). НЕ scroller — эта
			    строка остаётся на месте, скроллится только .pane__body ниже. */}
			<div class="sidebar-row bar" style={{ "--gap": "var(--space-2xs)", alignItems: "center" }}>
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

			{/* .pane__body — единственный .scroller сайдбара (REGLAMENT.md §1 —
			    "ровно один .scroller на каждом пути от .shell до листа"; путь
			    через .sidebar теперь заходит СЮДА, не в сам <aside>, см. app.jsx). */}
			<div class="pane__body stack scroller grow" style={{ "--gap": "var(--space-s)" }}>
				{(favoriteChannels.length > 0 || favoritePeople.length > 0) && (
					<div class="stack" style={{ "--gap": "1px" }}>
						<p class="eyebrow grouphead-plain">{t("shell.favoritesHeading")}</p>
						<ul class="streams stack" style={{ "--gap": "1px" }}>
							{favoriteChannels.map((c) => (
								<StreamItem
									key={`fc-${c.id}`}
									avatar={<ChannelAvatarThumb channel={channelByIdMap.get(c.id) ?? c} small />}
									name={c.name}
									onOpen={() => openChannel(c.id)}
									pinned
									onTogglePin={() => handleTogglePinChannel(c.id, true)}
									pinLabel={t("shell.unpinAria", { name: c.name })}
								/>
							))}
							{favoritePeople.map((pk) => (
								<StreamItem
									key={`fp-${pk}`}
									avatar={<PersonAvatar pubkey={pk} name={personName(pk)} />}
									name={personName(pk)}
									onOpen={() => openChat(pk)}
									pinned
									onTogglePin={() => handleTogglePinPerson(pk, true)}
									pinLabel={t("shell.unpinAria", { name: personName(pk) })}
								/>
							))}
						</ul>
					</div>
				)}

				<div class="stack" style={{ "--gap": "1px" }}>
					<button type="button" class="eyebrow grouphead bar" style={{ alignItems: "center" }} onClick={() => goTo({ kind: "people" })} title={t("shell.peopleGroupTitle")}>
						{t("shell.peopleGroupHeading")}
						<span class="grouphead__all">{t("shell.groupAllLink")}</span>
					</button>
					<ul class="streams stack" style={{ "--gap": "1px" }}>
						{visiblePeople.map((pk) => (
							<StreamItem
								key={pk}
								avatar={<PersonAvatar pubkey={pk} name={personName(pk)} />}
								name={personName(pk)}
								onOpen={() => openChat(pk)}
								pinned={pinned.people.includes(pk)}
								onTogglePin={() => handleTogglePinPerson(pk, pinned.people.includes(pk))}
								pinLabel={t(pinned.people.includes(pk) ? "shell.unpinAria" : "shell.pinAria", { name: personName(pk) })}
							/>
						))}
					</ul>
				</div>

				<div class="stack" style={{ "--gap": "1px" }}>
					<button type="button" class="eyebrow grouphead bar" style={{ alignItems: "center" }} onClick={() => goTo({ kind: "channels" })} title={t("shell.myChannelsGroupTitle")}>
						{t("shell.myChannelsGroupHeading")}
						<span class="grouphead__all">{t("shell.groupAllLink")}</span>
					</button>
					<ul class="streams stack" style={{ "--gap": "1px" }}>
						{visibleOwned.map((c) => (
							<StreamItem
								key={c.id}
								avatar={<ChannelAvatarThumb channel={c} small />}
								name={c.name || t("channels.card.untitled")}
								onOpen={() => openChannel(c.id)}
								pinned={pinned.channels.includes(c.id)}
								onTogglePin={() => handleTogglePinChannel(c.id, pinned.channels.includes(c.id))}
								pinLabel={t(pinned.channels.includes(c.id) ? "shell.unpinAria" : "shell.pinAria", { name: c.name || t("channels.card.untitled") })}
							/>
						))}
					</ul>
				</div>

				<div class="stack" style={{ "--gap": "1px" }}>
					<button type="button" class="eyebrow grouphead bar" style={{ alignItems: "center" }} onClick={() => goTo({ kind: "channels" })} title={t("shell.subscriptionsGroupTitle")}>
						{t("shell.subscriptionsGroupHeading")}
						<span class="grouphead__all">{t("shell.groupAllLink")}</span>
					</button>
					<ul class="streams stack" style={{ "--gap": "1px" }}>
						{visibleSubscribed.map((c) => (
							<StreamItem
								key={c.id}
								avatar={<ChannelAvatarThumb channel={c} small />}
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
		</>
	);
}
