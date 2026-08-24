import { useState, useEffect, useId } from "preact/hooks";
import { currentUser, privKeySig, dbKeySig } from "../signals/auth.js";
import { publish, fetchProfiles } from "../signals/transport.js";
import { messagingActivity } from "../signals/chats.js";
import { contacts, profiles, ensureProfilesFetched } from "../signals/contacts.js";
import { place, openChat, openChannel, goTo } from "../signals/place.js";
import { listConversations } from "../../domain/messaging/chat-activity.js";
import { listOwnedChannels, listSubscribedChannels } from "../../domain/content/channel.js";
import { loadPinned, pinChannel, unpinChannel, pinPerson, unpinPerson } from "../../domain/contacts/pinned.js";
import {
	unreadMessagesCount,
	unreadOwnedChannelsCount,
	unreadSubscribedChannelsCount,
	unreadByContact,
	unreadByChannel,
	refreshUnreadMessagesCount,
	refreshUnreadChannelsCount,
} from "../signals/notifications.js";
import { useDetailsMenu } from "../hooks/use-details-menu.js";
import { shortPubkey } from "../format.js";
import ChannelAvatarThumb from "./channel-avatar-thumb.jsx";
import IconMagnifyingGlass from "../icons/magnifying-glass.jsx";
import IconStar from "../icons/star.jsx";
import IconCompass from "../icons/compass.jsx";
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

// Избранное (ASIDE-REDESIGN/SIDEBAR-SPEC-2.md, этап 3) — было текстовым
// глифом-флажком (⚑/⚐); звезда честнее сообщает "избранное" (флажок читался
// как "пометить"/"пожаловаться" — жест из почты и модерации). Домен
// (pinChannel/unpinChannel, kind 30066) не менялся — это переименование
// только UI-слоя, group.value/группа "Избранное" уже существовали.
function FavToggle({ pinned, onToggle, label }) {
	return (
		<button type="button" class="fav-toggle" onClick={onToggle} aria-pressed={pinned} aria-label={label}>
			<IconStar filled={pinned} />
		</button>
	);
}

// active (ASIDE-REDESIGN/SIDEBAR-SPEC.md, этап 4) — строка текущего места
// (place.value, сравнение в NavGroups): без неё в списке из тридцати
// переписок/каналов не видно, где находишься. .bar, не .row — строка
// никогда не переносится (длинное имя обрезается .stream__name).
//
// unread (этап 3) — точка на аватаре, число НЕ показываем (пользователь:
// счётчик в строке отнимает у имени четверть ширины панели). .stream-ava
// иногда рендерится как <img> (PersonAvatar с реальным фото) — у img не
// бывает дочерних узлов, поэтому .ava-dot кладём не ВНУТРЬ аватара
// (ТЗ-2 §5.2 предполагало именно так), а в тонкую позиционирующую обёртку
// вокруг него — тот же визуальный результат (точка в углу), без невалидного
// DOM.
function StreamItem({ avatar, name, onOpen, active, pinned, onTogglePin, pinLabel, unread = 0 }) {
	return (
		<li class={`stream-row bar${active ? " is-active" : ""}${unread > 0 ? " has-unread" : ""}`} style={{ "--gap": "0", alignItems: "center" }}>
			<button type="button" class="stream bar grow" style={{ "--gap": "var(--space-2xs)", alignItems: "center" }} onClick={onOpen}>
				<span style={{ position: "relative", display: "inline-flex", flex: "none" }}>
					{avatar}
					{unread > 0 && <span class="ava-dot" aria-hidden="true" />}
				</span>
				<span class="stream__name">{name}</span>
			</button>
			<FavToggle pinned={pinned} onToggle={onTogglePin} label={pinLabel} />
		</li>
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
			refreshUnreadMessagesCount(ownerPubkey),
			refreshUnreadChannelsCount(ownerPubkey, dbKey),
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
	// Избранные исключены отсюда (найдено пользователем — раньше пункт
	// дублировался и в "Избранном", и в своей обычной группе): у каждого
	// контакта/канала/подписки теперь ровно одна строка в списке.
	const conversationPubkeys = new Set(conversations.map((c) => c.chatId));
	const contactsWithoutConversation = contacts.value.filter((pk) => !conversationPubkeys.has(pk));
	const visiblePeople = [...conversations.map((c) => c.chatId), ...contactsWithoutConversation]
		.filter((pk) => matches(personName(pk)))
		.filter((pk) => !pinned.people.includes(pk));
	const visibleOwned = owned.filter((c) => matches(c.name || "")).filter((c) => !pinned.channels.includes(c.id));
	const visibleSubscribed = subscribed.filter((c) => matches(c.name || "")).filter((c) => !pinned.channels.includes(c.id));

	// ASIDE-REDESIGN/SIDEBAR-SPEC-2.md, этап 5 — пустое состояние: ПОЛНЫЕ
	// списки (до search-фильтра), не visiblePeople/visibleOwned/
	// visibleSubscribed — иначе пустой поисковый запрос без совпадений
	// показывал бы приглашение "начни знакомиться" вместо честного "ничего
	// не найдено" (тот список НЕ пуст, просто фильтр ничего не оставил).
	const isEmpty = conversations.length + contactsWithoutConversation.length === 0 && owned.length === 0 && subscribed.length === 0;

	// Активная строка (этап 4) — сравнение с ЕДИНЫМ источником "где я
	// нахожусь" (place.js), не отдельным локальным состоянием: то же
	// значение уже двигает саму навигацию (openChat/openChannel).
	const isChannelActive = (id) => place.value.kind === "channel" && place.value.id === id;
	const isPersonActive = (pk) => place.value.kind === "chat" && place.value.id === pk;

	return (
		<>
			{/* Разметка по макету — .pane__top заканчивается строкой поиска
			    (карточка идентити выше — отдельный компонент, тот же фикс-блок
			    визуально благодаря общему padding-inline). НЕ scroller — эта
			    строка остаётся на месте, скроллится только .pane__body ниже. */}
			<div class="sidebar-row">
				<label class="visually-hidden" for={searchId}>
					{t("shell.searchLabel")}
				</label>
				<div class="file-search-field row" style={{ "--gap": "var(--space-2xs)", alignItems: "center" }}>
					<IconMagnifyingGlass aria-hidden="true" />
					<input id={searchId} type="search" placeholder={t("shell.searchPlaceholder")} value={query} onInput={(e) => setQuery(e.currentTarget.value)} />
				</div>
			</div>

			{/* .pane__body — единственный .scroller сайдбара (REGLAMENT.md §1 —
			    "ровно один .scroller на каждом пути от .shell до листа"; путь
			    через .sidebar теперь заходит СЮДА, не в сам <aside>, см. app.jsx). */}
			<div class="pane__body stack scroller grow" style={{ "--gap": "var(--space-s)" }}>
				{/* ASIDE-REDESIGN/SIDEBAR-SPEC-2.md, этап 4 — "Знакомства" постоянной
				    первой строкой, до всех групп (включая "Избранное"): раздел живёт
				    отдельным экраном (discovery.jsx), не внутри "Контактов". Иконка —
				    компас, не лупа (та уже занята полем поиска строкой выше). */}
				<ul class="streams stack" style={{ "--gap": "1px" }}>
					<li class={`discover-row${place.value.kind === "discovery" ? " is-active" : ""}`}>
						<button type="button" class="discover" onClick={() => goTo({ kind: "discovery" })}>
							<span class="discover-mark">
								<IconCompass />
							</span>
							<span class="stream__name">{t("shell.discoverHeading")}</span>
						</button>
					</li>
				</ul>

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
									active={isChannelActive(c.id)}
									unread={unreadByChannel.value[c.id] ?? 0}
									pinned
									onTogglePin={() => handleTogglePinChannel(c.id, true)}
									pinLabel={t("account.favRemove", { name: c.name })}
								/>
							))}
							{favoritePeople.map((pk) => (
								<StreamItem
									key={`fp-${pk}`}
									avatar={<PersonAvatar pubkey={pk} name={personName(pk)} />}
									name={personName(pk)}
									onOpen={() => openChat(pk)}
									active={isPersonActive(pk)}
									unread={unreadByContact.value[pk] ?? 0}
									pinned
									onTogglePin={() => handleTogglePinPerson(pk, true)}
									pinLabel={t("account.favRemove", { name: personName(pk) })}
								/>
							))}
						</ul>
					</div>
				)}

				{isEmpty ? (
					<div class="empty">
						<h3>{t("shell.emptyTitle")}</h3>
						<p>{t("shell.emptyBody")}</p>
						<button type="button" class="act act--primary" onClick={() => goTo({ kind: "discovery" })}>
							<IconCompass /> {t("shell.emptyAction")}
						</button>
					</div>
				) : (
				<>
				<div class="stack" style={{ "--gap": "1px" }}>
					<button type="button" class="eyebrow grouphead bar" style={{ alignItems: "center" }} onClick={() => goTo({ kind: "people" })} title={t("shell.peopleGroupTitle")}>
						{t("shell.peopleGroupHeading")}
						{unreadMessagesCount.value > 0 && <span class="group-count">{unreadMessagesCount.value}</span>}
						<span class="grouphead__all">{t("shell.groupAllLink")}</span>
					</button>
					<ul class="streams stack" style={{ "--gap": "1px" }}>
						{visiblePeople.map((pk) => (
							<StreamItem
								key={pk}
								avatar={<PersonAvatar pubkey={pk} name={personName(pk)} />}
								name={personName(pk)}
								onOpen={() => openChat(pk)}
								active={isPersonActive(pk)}
								unread={unreadByContact.value[pk] ?? 0}
								pinned={pinned.people.includes(pk)}
								onTogglePin={() => handleTogglePinPerson(pk, pinned.people.includes(pk))}
								pinLabel={t(pinned.people.includes(pk) ? "account.favRemove" : "account.favAdd", { name: personName(pk) })}
							/>
						))}
					</ul>
				</div>

				<div class="stack" style={{ "--gap": "1px" }}>
					<button type="button" class="eyebrow grouphead bar" style={{ alignItems: "center" }} onClick={() => goTo({ kind: "channels" })} title={t("shell.myChannelsGroupTitle")}>
						{t("shell.myChannelsGroupHeading")}
						{unreadOwnedChannelsCount.value > 0 && <span class="group-count">{unreadOwnedChannelsCount.value}</span>}
						<span class="grouphead__all">{t("shell.groupAllLink")}</span>
					</button>
					<ul class="streams stack" style={{ "--gap": "1px" }}>
						{visibleOwned.map((c) => (
							<StreamItem
								key={c.id}
								avatar={<ChannelAvatarThumb channel={c} small />}
								name={c.name || t("channels.card.untitled")}
								onOpen={() => openChannel(c.id)}
								active={isChannelActive(c.id)}
								unread={unreadByChannel.value[c.id] ?? 0}
								pinned={pinned.channels.includes(c.id)}
								onTogglePin={() => handleTogglePinChannel(c.id, pinned.channels.includes(c.id))}
								pinLabel={t(pinned.channels.includes(c.id) ? "account.favRemove" : "account.favAdd", { name: c.name || t("channels.card.untitled") })}
							/>
						))}
					</ul>
				</div>

				<div class="stack" style={{ "--gap": "1px" }}>
					<button type="button" class="eyebrow grouphead bar" style={{ alignItems: "center" }} onClick={() => goTo({ kind: "channels" })} title={t("shell.subscriptionsGroupTitle")}>
						{t("shell.subscriptionsGroupHeading")}
						{unreadSubscribedChannelsCount.value > 0 && <span class="group-count">{unreadSubscribedChannelsCount.value}</span>}
						<span class="grouphead__all">{t("shell.groupAllLink")}</span>
					</button>
					<ul class="streams stack" style={{ "--gap": "1px" }}>
						{visibleSubscribed.map((c) => (
							<StreamItem
								key={c.id}
								avatar={<ChannelAvatarThumb channel={c} small />}
								name={c.name || t("channels.card.untitled")}
								onOpen={() => openChannel(c.id)}
								active={isChannelActive(c.id)}
								unread={unreadByChannel.value[c.id] ?? 0}
								pinned={pinned.channels.includes(c.id)}
								onTogglePin={() => handleTogglePinChannel(c.id, pinned.channels.includes(c.id))}
								pinLabel={t(pinned.channels.includes(c.id) ? "account.favRemove" : "account.favAdd", { name: c.name || t("channels.card.untitled") })}
							/>
						))}
					</ul>
				</div>
				</>
				)}
			</div>
		</>
	);
}
