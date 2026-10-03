import { useState, useEffect, useId } from "preact/hooks";
import { currentUser, privKeySig, dbKeySig } from "../signals/auth.js";
import { publish, fetchProfiles } from "../signals/transport.js";
import { messagingActivity } from "../signals/chats.js";
import { contacts, profiles, ensureProfilesFetched, ownDiscoveryVisible, discoveryProfiles, incomingRequests } from "../signals/contacts.js";
import { place, openChat, openChannel, openSearch, closeSearch, goTo } from "../signals/place.js";
import { roomsScreenActive, roomsMinimized } from "../signals/rooms.js";
import { activeRoomSummary } from "../screens/quick.jsx";
import { listConversations } from "../../domain/messaging/chat-activity.js";
import { listOwnedChannels, listSubscribedChannels } from "../../domain/content/channel.js";
import { loadPinned, pinChannel, unpinChannel, pinPerson, unpinPerson } from "../../domain/contacts/pinned.js";
import {
	unreadMessagesCount,
	unreadByContact,
	unreadByChannel,
	refreshUnreadMessagesCount,
	refreshUnreadChannelsCount,
} from "../signals/notifications.js";
import { useDetailsMenu } from "../hooks/use-details-menu.js";
import { shortPubkey } from "../format.js";
import ChannelAvatarThumb from "./channel-avatar-thumb.jsx";
import BracketCount from "./bracket-count.jsx";
import AddContactModal from "./add-contact-modal.jsx";
import IconMagnifyingGlass from "../icons/magnifying-glass.jsx";
import IconCross from "../icons/cross.jsx";
import IconStar from "../icons/star.jsx";
import IconStarFill from "../icons/star-fill.jsx";
import IconPersonAdd from "../icons/person-add.jsx";
import IconPerson from "../icons/person.jsx";
import IconChatBubble from "../icons/chat-bubble.jsx";
import IconActivityLog from "../icons/activity-log.jsx";
import IconLightning from "../icons/lightning.jsx";
import IconWave from "../icons/wave.jsx";
import IconHash from "../icons/hash.jsx";
import IconFolder from "../icons/folder.jsx";
import { loadDiscoverySettings } from "../../domain/discovery/discovery.js";
import { t, currentLocale } from "../signals/i18n.js";

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
		<span class="stream-ava bar" aria-hidden="true" style={{ "--align": "center", justifyContent: "center" }}>
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
	// Раньше один файл star.jsx сам переключал fill по пропу — генератор
	// Phosphor (ICONS-PHOSPHOR.md §3) даёт для "включено" отдельный файл
	// -fill, а не проп, поэтому переключение теперь на уровне компонента.
	const Star = pinned ? IconStarFill : IconStar;
	return (
		<button type="button" class="fav-toggle" onClick={onToggle} aria-pressed={pinned} aria-label={label}>
			<Star />
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
		<li class={`stream-row bar${active ? " is-active" : ""}${unread > 0 ? " has-unread" : ""}`} style={{ "--gap": "0", "--align": "center" }}>
			<button type="button" class="stream bar grow" style={{ "--gap": "var(--space-2xs)", "--align": "center" }} onClick={onOpen}>
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

// Пункт главного меню (макет ggQHr.jpg): иконка, подпись, необязательная
// вторая строка-пояснение, бейдж-счётчик и метка «живого» состояния (открытая
// комната / включённая видимость в «Знакомствах»). Пустой/нулевой badge не рисуется.
function DrawerLink({ icon: Icon, label, hint, active, badge = 0, count = null, live = false, onClick }) {
	return (
		<button type="button" class={"drawer-link" + (active ? " is-active" : "") + (live ? " is-live" : "")} aria-current={active ? "page" : undefined} onClick={onClick}>
			<Icon class="icon drawer-link__icon" aria-hidden="true" />
			<span class="drawer-link__text">
				<span class="drawer-link__label">
					{label}
					{count != null && <BracketCount class="drawer-link__count" value={count} />}
				</span>
				{hint && <small class="drawer-link__hint">{hint}</small>}
			</span>
			{live && <span class="drawer-link__live" aria-hidden="true" />}
			{badge > 0 && <span class="chat-row__badge">{badge}</span>}
		</button>
	);
}

export default function NavGroups({ unreadJournalCount }) {
	const ownerPubkey = currentUser.value.id;
	const privKey = privKeySig.value;
	const dbKey = dbKeySig.value;
	const searchId = useId();

	const [query, setQuery] = useState("");
	// Пользователь (item 2) — "Добавить контакт" открывает модальное окно с
	// формой заявки, а не отдельный экран (см. AddContactModal).
	const [showAddContact, setShowAddContact] = useState(false);

	// Вход на экран поиска — поле показывает зафиксированный запрос
	// (SEARCH-SPEC.md §3.7). Дальше это снова обычное локальное поле:
	// правка на экране результатов НЕ трогает выдачу до следующего Enter —
	// эффект синхронизирует состояние ТОЛЬКО в момент фиксации нового
	// запроса (смена place.query на экране поиска), не постоянно.
	useEffect(() => {
		if (place.value.kind === "search") setQuery(place.value.query);
	}, [place.value.kind, place.value.kind === "search" ? place.value.query : null]);

	function handleSearchKeyDown(e) {
		if (e.key !== "Enter") return;
		const trimmed = query.trim();
		if (trimmed) openSearch(trimmed); // I-EMPTY-NOOP: пустой запрос — не сюда вовсе
	}

	// До какого часа видна моя карточка в «Кто здесь» — для подписи пункта меню.
	const [ownVisibleUntil, setOwnVisibleUntil] = useState(0);
	useEffect(() => {
		if (!ownDiscoveryVisible.value) {
			setOwnVisibleUntil(0);
			return;
		}
		loadDiscoverySettings(ownerPubkey)
			.then((s) => setOwnVisibleUntil(s.visible ? s.visibleUntil : 0))
			.catch(() => {});
	}, [ownDiscoveryVisible.value, ownerPubkey]);

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
				<div class="file-search-field row" style={{ "--gap": "var(--space-2xs)", "--align": "center" }}>
					<IconMagnifyingGlass aria-hidden="true" />
					<input id={searchId} type="search" placeholder={t("shell.searchPlaceholder")} value={query} onInput={(e) => setQuery(e.currentTarget.value)} onKeyDown={handleSearchKeyDown} />
					{/* Живой фидбек: после запуска поиска это поле молча "висит" с
					    зафиксированным запросом, и не каждый догадается про Escape
					    или кнопку "Назад" на самом экране результатов. Явная кнопка
					    отмены прямо в поле — там, где человек только что нажал Enter,
					    самое заметное место. Возвращает на экран, с которого искали
					    (closeSearch, place.js), не жёстко в Журнал. */}
					{place.value.kind === "search" && (
						<button type="button" class="icon-btn" aria-label={t("search.closeAria")} onClick={closeSearch}>
							<IconCross aria-hidden="true" />
						</button>
					)}
				</div>
				{/* Второй, видимый путь к Enter (SEARCH-SPEC.md §3.7) — контрол
				    выглядит как обычный фильтр, без этой строки никто не
				    догадался бы, что здесь есть полноценный поиск по содержимому.
				    Без своей лупы — она уже есть в поле выше, дублировать не нужно
				    (живой фидбек). */}
				{query.trim() && (
					<button type="button" class="sr-cue" onClick={() => openSearch(query.trim())}>
						<span class="grow">{t("search.cue", { query: query.trim() })}</span>
						{/* "Enter" — имя клавиши, не переводится ни в одной локали (тот же
						    приём, что "Enter"/"Esc" literal в самом мокапе). */}
						<span class="sr-kbd" aria-hidden="true">Enter</span>
					</button>
				)}
			</div>

			{/* .pane__body — единственный .scroller сайдбара (REGLAMENT.md §1 —
			    "ровно один .scroller на каждом пути от .shell до листа"; путь
			    через .sidebar теперь заходит СЮДА, не в сам <aside>, см. app.jsx). */}
			<div class="pane__body stack scroller grow" style={{ "--gap": "var(--space-s)" }}>
				<nav class="drawer-nav stack" aria-label={t("shell.navAriaLabel")}>
					<p class="drawer-section">{t("shell.sectionTalk")}</p>
					<DrawerLink icon={IconChatBubble} label={t("shell.navChats")} active={place.value.kind === "chat"} badge={unreadMessagesCount.value} onClick={() => openChat(null)} />
					<DrawerLink icon={IconActivityLog} label={t("nav.journal")} active={place.value.kind === "journal"} badge={unreadJournalCount} onClick={() => goTo({ kind: "journal" })} />
					<DrawerLink icon={IconPerson} label={t("nav.contacts")} active={place.value.kind === "people" && place.value.section !== "requests"} onClick={() => goTo({ kind: "people" })} />
					<DrawerLink icon={IconPersonAdd} label={t("shell.addContact")} onClick={() => setShowAddContact(true)} />
					<DrawerLink
						icon={IconPersonAdd}
						label={t("shell.navRequests")}
						active={place.value.kind === "people" && place.value.section === "requests"}
						badge={incomingRequests.value.length}
						onClick={() => goTo({ kind: "people", section: "requests" })}
					/>

					<p class="drawer-section">{t("shell.sectionServices")}</p>
					<QuickConnectRow />
					<DrawerLink
						icon={IconWave}
						label={t("shell.discoverHeading")}
						count={discoveryProfiles.value.length}
						hint={
							ownDiscoveryVisible.value && ownVisibleUntil > 0
								? t("shell.discoverHintVisible", { time: new Date(ownVisibleUntil * 1000).toLocaleTimeString(currentLocale.value, { hour: "2-digit", minute: "2-digit" }) })
								: t("shell.discoverHintHidden")
						}
						active={place.value.kind === "discovery"}
						live={ownDiscoveryVisible.value}
						onClick={() => goTo({ kind: "discovery" })}
					/>

					<p class="drawer-section">{t("shell.sectionMore")}</p>
					<DrawerLink icon={IconHash} label={t("nav.channels")} active={place.value.kind === "channels" || place.value.kind === "channel"} onClick={() => goTo({ kind: "channels" })} />
					<DrawerLink icon={IconFolder} label={t("nav.files")} active={place.value.kind === "storage"} onClick={() => goTo({ kind: "storage" })} />
				</nav>

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

			</div>
			{showAddContact && <AddContactModal onClose={() => setShowAddContact(false)} />}
		</>
	);
}

// Пользователь (item 7) — тот же визуальный язык, что "Знакомства" (.discover-row/
// .discover/.discover-mark), но собственное состояние: не активна (обычный вход,
// как и раньше — "разговор без учётной записи") ИЛИ активна (комната открыта, окно
// развёрнуто ИЛИ свёрнуто — свёрнутое состояние должно оставаться ЗАМЕТНО отличным
// от простоя, иначе пользователь забывает, что где-то идёт разговор, см. .quick-live-dot,
// уже использованный тем же языком внутри самой Quick). roomsScreenActive/roomsMinimized —
// rooms.js, не app.jsx (циклический импорт), activeRoomSummary — quick.jsx (имя
// комнаты/число участников, если сессия уже идёт).
function QuickConnectRow() {
	const active = roomsScreenActive.value;
	const minimized = roomsMinimized.value;
	const summary = activeRoomSummary.value;

	function handleClick() {
		if (active) {
			roomsMinimized.value = false;
		} else {
			roomsScreenActive.value = true;
			roomsMinimized.value = false;
		}
	}

	// Подпись — "свёрнуто, нажмите чтобы вернуться" ТОЛЬКО пока модалка правда
	// свёрнута (minimized): активна-но-развёрнута (пользователь только что
	// открыл, комнату ещё не создал/не вошёл) — тот же текст был бы неверен,
	// самой модалки и так видно на экране. Число участников (summary) —
	// приоритетнее в обоих случаях, если сессия уже идёт.
	let hint;
	if (summary) hint = t("quick.room.participantsTitle", { count: summary.count });
	else if (active && minimized) hint = t("shell.quickConnectActiveHint");
	else hint = t("shell.quickConnectHint");

	return (
		<DrawerLink
			icon={IconLightning}
			label={summary?.name || t("shell.quickConnect")}
			hint={hint}
			active={active}
			live={active}
			onClick={handleClick}
		/>
	);
}
