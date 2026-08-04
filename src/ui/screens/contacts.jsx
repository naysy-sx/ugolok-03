import { useState, useEffect, useRef } from "preact/hooks";
import { shortPubkey } from "../format.js";
import { currentUser, privKeySig, dbKeySig } from "../signals/auth.js";
import { ensureConnected, publish, fetchProfiles, refreshLiveProfileSubscription } from "../signals/transport.js";
import { openChat } from "../signals/chat.js";
import { placeCall } from "../signals/call.js";
import IconPhoneCall from "../icons/phone-call.jsx";
import IconPencil from "../icons/pencil.jsx";
import IconTrash from "../icons/trash.jsx";
import IconGear from "../icons/gear.jsx";
import IconLockClosed from "../icons/lock-closed.jsx";
import IconChevronRight from "../icons/chevron-right.jsx";
import IconPlus from "../icons/plus.jsx";
import IconPersonAdd from "../icons/person-add.jsx";
import ActionsMenu from "../components/actions-menu.jsx";
import { useDetailsMenu } from "../hooks/use-details-menu.js";
import {
	contacts,
	blockedContacts,
	outgoingRequests,
	incomingRequests,
	rejectedByMe,
	groups,
	profiles,
	refreshAll,
	refreshGroups,
	ensureProfilesFetched,
	refreshProfiles,
	removeContactAction,
	blockContactAction,
	unblockContactAction,
	createGroupAction,
	renameGroupAction,
	addGroupMemberAction,
	removeGroupMemberAction,
	deleteGroupAction,
	sendContactRequestAction,
	acceptContactRequestAction,
	rejectContactRequestAction,
	cancelContactRequestAction,
} from "../signals/contacts.js";
import PermissionEditor from "../components/permission-editor.jsx";
import Screen from "../components/screen.jsx";
import { t, errorMessage } from "../signals/i18n.js";

// F-CT-04: показывает никнейм/аватар/био контакта, если профиль уже подтянут
// (см. ensureProfilesFetched), иначе — усечённый npub как раньше. onClick, если
// передан, делает аватар+имя ссылкой на чат (contacts.jsx, реальные контакты);
// в списке заблокированных onClick не передаётся — просто отображение.
export function ContactIdentity({ pubkey, onClick }) {
	const profile = profiles.value[pubkey];
	const displayName = profile?.name || shortPubkey(pubkey);

	const avatar = profile?.picture ? (
		<img src={profile.picture} alt="" width="40" height="40" class="contact-avatar" />
	) : (
		<div aria-hidden="true" class="contact-avatar contact-avatar-fallback row" style={{ alignItems: "center", justifyContent: "center" }}>
			{(displayName || "?").trim().charAt(0).toUpperCase()}
		</div>
	);

	const text = (
		<span class="stack" style={{ "--gap": "var(--space-3xs)" }}>
			<span class={profile?.name ? undefined : "contact-identity-npub"}>{displayName}</span>
			{profile?.about && <small>{profile.about}</small>}
		</span>
	);

	if (!onClick) {
		return (
			<div class="contact-identity row" style={{ "--gap": "var(--space-s)", alignItems: "center" }}>
				{avatar}
				{text}
			</div>
		);
	}

	return (
		<button
			type="button"
			onClick={onClick}
			aria-label={t("contacts.openChatAria", { name: displayName })}
			class="contact-identity contact-identity-btn row"
			style={{ "--gap": "var(--space-s)", alignItems: "center" }}
		>
			{avatar}
			{text}
		</button>
	);
}

export default function Contacts() {
	const ownerPubkey = currentUser.value.id;
	const privKey = privKeySig.value;
	const dbKey = dbKeySig.value;

	const [connectionError, setConnectionError] = useState("");
	const [npubInput, setNpubInput] = useState("");
	const [addError, setAddError] = useState("");
	const [newGroupName, setNewGroupName] = useState("");
	const [groupError, setGroupError] = useState("");
	const [selectedGroupIds, setSelectedGroupIds] = useState(() => new Set());
	const [expandedPubkey, setExpandedPubkey] = useState(null);
	const [renamingGroupId, setRenamingGroupId] = useState(null);
	const [renameValue, setRenameValue] = useState("");
	const [rowError, setRowError] = useState("");
	const [busy, setBusy] = useState(false);
	// busyRef — синхронная защита от повторного входа. busy (state) обновляется через
	// setBusy и коммитится АСИНХРОННО (рендер-цикл) — обработчик второго клика,
	// вызванный до коммита, читает СТАРОЕ значение busy из замыкания того же рендера
	// и гонку не ловит. Ref читается/пишется немедленно, синхронно с самим кликом.
	const busyRef = useRef(false);

	useEffect(() => {
		refreshAll();
		ensureConnected(ownerPubkey, privKey, dbKey)
			.then(async () => {
				refreshAll();
				await refreshGroups(ownerPubkey, dbKey);
				// именно здесь, не раньше: до этой точки fetchProfiles бросил бы
				// (нет соединения). Экран открыт заново — refreshProfiles подтягивает
				// СВЕЖИЕ данные (найденный баг: старое био/имя не обновлялись годами).
				await refreshProfiles(contacts.value, fetchProfiles).catch(() => {});
				// Найденный баг (пользователь, этап 27-довесок-7): без ЖИВОЙ подписки
				// изменение профиля контакта не появлялось на уже открытом экране — нужно
				// было уйти и вернуться (только тогда refreshProfiles вызывался заново).
				await refreshLiveProfileSubscription(ownerPubkey).catch(() => {});
			})
			.catch((e) => setConnectionError(errorMessage(e)));
	}, [ownerPubkey]);

	// F-CT-04, этап 49 — сигналы (contacts/incomingRequests/outgoingRequests/
	// rejectedByMe) теперь реактивны САМИ ПО СЕБЕ (EMIT из contact-runtime.js на
	// каждый переход состояния peer'а) — отдельный "messagingActivity"-триггер
	// (было раньше, ручной перечитыватель Dexie-таблиц) больше не нужен, этот эффект
	// просто подтягивает профили для любых новых pubkey, появившихся в любом разделе.
	useEffect(() => {
		const pubkeys = [
			...contacts.value,
			...incomingRequests.value.map((r) => r.peerPubkey),
			...outgoingRequests.value.map((r) => r.peerPubkey),
			...rejectedByMe.value.map((r) => r.peerPubkey),
		];
		if (pubkeys.length > 0) {
			ensureProfilesFetched(pubkeys, fetchProfiles).catch(() => {});
			// Новый контакт — переподписка (идемпотентно, тот же приём, что
			// refreshGroupMessageSubscription на каждую отправку) подхватывает его в live-набор.
			refreshLiveProfileSubscription(ownerPubkey).catch(() => {});
		}
	}, [contacts.value, incomingRequests.value, outgoingRequests.value, rejectedByMe.value]);

	// busy сериализует действия этого экрана намеренно — найдено адверсарной фазой:
	// два быстрых клика подряд (напр. "Добавить" дважды с разными контактами) читают
	// contacts.value ДО того, как первое действие успевает его обновить — второе
	// добавление тихо теряется (lost update). Простое отключение кнопок на время
	// одного in-flight действия полностью устраняет гонку для UI, управляемого кликом.
	async function handleAddContact(e) {
		e.preventDefault();
		if (busyRef.current) return;
		busyRef.current = true;
		setAddError("");
		setBusy(true);
		try {
			// Находка 1 (CONTRACTS.md, этап 27) — теперь единая точка для ОБОИХ путей
			// отправки заявки ("Добавить контакт" здесь И "Обзор", discovery.jsx, этап 49):
			// адресат больше НЕ добавляется оптимистично — увидит заявку во "Входящих"
			// и решит сам (это и убрало найденную дублирующуюся запись бага).
			await sendContactRequestAction(npubInput, "");
			setNpubInput("");
		} catch (err) {
			setAddError(errorMessage(err));
		} finally {
			busyRef.current = false;
			setBusy(false);
		}
	}

	async function handleAcceptContactRequest(peerPubkey) {
		if (busyRef.current) return;
		busyRef.current = true;
		setRowError("");
		setBusy(true);
		try {
			await acceptContactRequestAction(peerPubkey);
		} catch (err) {
			setRowError(errorMessage(err));
		} finally {
			busyRef.current = false;
			setBusy(false);
		}
	}

	async function handleRejectContactRequest(peerPubkey) {
		if (busyRef.current) return;
		busyRef.current = true;
		setRowError("");
		setBusy(true);
		try {
			await rejectContactRequestAction(peerPubkey);
		} catch (err) {
			setRowError(errorMessage(err));
		} finally {
			busyRef.current = false;
			setBusy(false);
		}
	}

	async function handleCreateGroup(e) {
		e.preventDefault();
		if (busyRef.current) return;
		busyRef.current = true;
		setGroupError("");
		setBusy(true);
		try {
			await createGroupAction(ownerPubkey, privKey, dbKey, newGroupName, publish);
			setNewGroupName("");
		} catch (err) {
			setGroupError(errorMessage(err));
		} finally {
			busyRef.current = false;
			setBusy(false);
		}
	}

	function groupsForContact(pubkey) {
		return groups.value.filter((g) => g.memberPubkeys.includes(pubkey));
	}

	function toggleGroupFilter(groupId) {
		setSelectedGroupIds((prev) => {
			const next = new Set(prev);
			if (next.has(groupId)) next.delete(groupId);
			else next.add(groupId);
			return next;
		});
	}

	async function runRowAction(fn) {
		if (busyRef.current) return;
		busyRef.current = true;
		setRowError("");
		setBusy(true);
		try {
			await fn();
		} catch (err) {
			setRowError(errorMessage(err));
		} finally {
			busyRef.current = false;
			setBusy(false);
		}
	}

	// Контакты и заблокированные теперь СТРУКТУРНО взаимоисключающие (единая
	// contactRelationships, один state на peer — этап 49, CONTACTS-FSM.md) —
	// отдельный фильтр здесь больше не нужен.
	const visibleContacts =
		selectedGroupIds.size === 0
			? contacts.value
			: contacts.value.filter((pk) => groupsForContact(pk).some((g) => selectedGroupIds.has(g.id)));

	return (
		<Screen title={t("nav.contacts")}>
			<div class="contacts-toolbar stack" style={{ "--gap": "var(--space-s)" }}>
				{/* "Соединение: ..." переехало в постоянную панель под главным
				    меню (app.jsx, ConnectionStatusPanel) — видна на любом экране,
				    здесь дублировать незачем (пользователь, item 4). */}
				{connectionError && (
					<p role="alert" style={{ color: "var(--bad, oklch(0.58 0.21 25))" }}>
						{connectionError}
					</p>
				)}

				<form class="row contacts-add-form" style={{ "--gap": "0", alignItems: "stretch" }} onSubmit={handleAddContact}>
					<div class="row grow contact-add-field" style={{ "--gap": "var(--space-2xs)", alignItems: "center" }}>
						<IconPersonAdd aria-hidden="true" />
						<label class="visually-hidden" for="add-contact-input">
							{t("contacts.addContactLabel")}
						</label>
						<input
							id="add-contact-input"
							type="text"
							placeholder={t("contacts.addContactLabel")}
							value={npubInput}
							onInput={(e) => setNpubInput(e.currentTarget.value)}
						/>
					</div>
					<button type="submit" disabled={busy}>
						{t("common.add")}
					</button>
				</form>
				{addError && (
					<p role="alert" style={{ color: "var(--bad, oklch(0.58 0.21 25))" }}>
						{addError}
					</p>
				)}
			</div>

			<div class="contacts-layout">
				<aside class="card contacts-groups-aside" aria-labelledby="groups-heading">
					<h2 id="groups-heading">{t("contacts.groupsHeading")}</h2>
					<ul role="list" class="group-filter-list stack">
						<li>
							<span class="group-filter-chip row" style={{ "--gap": "var(--space-3xs)", alignItems: "center" }}>
								<input
									id="group-filter-all"
									type="checkbox"
									checked={selectedGroupIds.size === 0}
									onChange={() => setSelectedGroupIds(new Set())}
								/>
								<label for="group-filter-all">{t("contacts.allGroupsLabel")}</label>
							</span>
						</li>
						{groups.value.map((g) => (
							<li key={g.id}>
								<div class="group-filter-chip row" style={{ "--gap": "var(--space-3xs)", alignItems: "center" }}>
									<input
										id={`group-filter-${g.id}`}
										type="checkbox"
										checked={selectedGroupIds.has(g.id)}
										onChange={() => toggleGroupFilter(g.id)}
									/>
									{renamingGroupId === g.id ? (
										<form
											class="row"
											style={{ "--gap": "var(--space-s)", alignItems: "center" }}
											onSubmit={(e) => {
												e.preventDefault();
												runRowAction(async () => {
													await renameGroupAction(ownerPubkey, privKey, dbKey, g.id, renameValue, publish);
													setRenamingGroupId(null);
												});
											}}
										>
											<label class="visually-hidden" for={`rename-group-${g.id}`}>
												{t("contacts.renameGroupLabel")}
											</label>
											<input
												id={`rename-group-${g.id}`}
												type="text"
												value={renameValue}
												onInput={(e) => setRenameValue(e.currentTarget.value)}
											/>
											<button type="submit" disabled={busy}>
												{t("common.save")}
											</button>
											<button type="button" onClick={() => setRenamingGroupId(null)}>
												{t("common.cancel")}
											</button>
										</form>
									) : (
										<>
											<label for={`group-filter-${g.id}`}>
												{t("channels.create.groupWithCount", { name: g.name, count: g.memberPubkeys.length })}
											</label>
											<ActionsMenu label={t("contacts.groupActionsAria", { name: g.name })}>
												<button
													type="button"
													onClick={() => {
														setRenamingGroupId(g.id);
														setRenameValue(g.name);
													}}
												>
													<IconPencil /> {t("contacts.renameAction")}
												</button>
												<button
													type="button"
													class="danger"
													disabled={busy}
													onClick={() =>
														runRowAction(() => deleteGroupAction(ownerPubkey, privKey, dbKey, g.id, publish))
													}
												>
													<IconTrash /> {t("common.delete")}
												</button>
											</ActionsMenu>
										</>
									)}
								</div>
							</li>
						))}
					</ul>

					<form class="row" style={{ "--gap": "var(--space-s)", alignItems: "center" }} onSubmit={handleCreateGroup}>
						<label class="visually-hidden" for="new-group-name">
							{t("contacts.newGroupNameLabel")}
						</label>
						<input
							id="new-group-name"
							type="text"
							placeholder={t("contacts.newGroupPlaceholder")}
							value={newGroupName}
							onInput={(e) => setNewGroupName(e.currentTarget.value)}
						/>
						<button type="submit" disabled={busy}>
							{t("common.add")}
						</button>
					</form>
					{groupError && (
						<p role="alert" style={{ color: "var(--bad, oklch(0.58 0.21 25))" }}>
							{groupError}
						</p>
					)}
				</aside>

				<div class="contacts-main stack" style={{ "--gap": "var(--space-l)" }}>
					{/* Пользователь: "существующие контакты — главный рабочий блок,
					    надо поднять вверх и выделить" — был зажат между "Отклонённые"
					    и "Заблокированные" внизу страницы. Теперь первым, в своей
					    рамке (contacts-primary-section). */}
					<section class="stack card contacts-primary-section" aria-labelledby="contacts-heading" style={{ "--gap": "var(--space-s)" }}>
						<h2 id="contacts-heading">{t("contacts.heading", { count: visibleContacts.length })}</h2>
						{rowError && (
							<p role="alert" style={{ color: "var(--bad, oklch(0.58 0.21 25))" }}>
								{rowError}
							</p>
						)}
						<ul role="list" class="contact-row-list stack" style={{ "--gap": "var(--space-2xs)" }}>
							{visibleContacts.map((pubkey) => {
								const memberOfGroups = groupsForContact(pubkey);
								const isExpanded = expandedPubkey === pubkey;
								return (
									<li
										key={pubkey}
										class="contact-row contact-row-expandable row"
										style={{ "--gap": "var(--space-s)", alignItems: "center", justifyContent: "space-between" }}
									>
										<div class="contact-row-main row" style={{ "--gap": "var(--space-s)", alignItems: "center", justifyContent: "space-between" }}>
											<ContactIdentity pubkey={pubkey} onClick={() => openChat(pubkey)} />
											<div class="contact-row-actions row" style={{ "--gap": "var(--space-2xs)", alignItems: "center" }}>
												<button type="button" onClick={() => placeCall(pubkey)} aria-label={t("contacts.callAria", { name: profiles.value[pubkey]?.name || shortPubkey(pubkey) })}>
													<IconPhoneCall /> <span class="call-txt">{t("common.call")}</span>
												</button>
												<ActionsMenu label={t("channel.comment.moreActionsAria", { name: profiles.value[pubkey]?.name || shortPubkey(pubkey) })}>
													<button type="button" onClick={() => setExpandedPubkey(isExpanded ? null : pubkey)}>
														<IconGear /> {isExpanded ? t("contacts.hidePermissions") : t("contacts.showPermissions")}
													</button>
													<button
														type="button"
														disabled={busy}
														onClick={() => runRowAction(() => blockContactAction(pubkey))}
													>
														<IconLockClosed /> {t("contacts.blockAction")}
													</button>
													<button
														type="button"
														class="danger"
														disabled={busy}
														onClick={() => runRowAction(() => removeContactAction(pubkey))}
													>
														<IconTrash /> {t("common.delete")}
													</button>
												</ActionsMenu>
											</div>
										</div>

										<div class="contact-row-groups row" style={{ "--gap": "var(--space-2xs)", alignItems: "center" }}>
											{memberOfGroups.map((g) => (
												<span key={g.id} class="group-chip row" style={{ "--gap": "var(--space-3xs)", alignItems: "center" }}>
													{g.name}
													<button
														type="button"
														disabled={busy}
														aria-label={t("contacts.removeFromGroupAria", { name: g.name })}
														onClick={() =>
															runRowAction(() =>
																removeGroupMemberAction(ownerPubkey, privKey, dbKey, g.id, pubkey, publish),
															)
														}
													>
														×
													</button>
												</span>
											))}
											{groups.value.length > 0 && (
												<AddToGroupControl
													groups={groups.value}
													excludeGroupIds={memberOfGroups.map((g) => g.id)}
													disabled={busy}
													onAdd={(groupId) =>
														runRowAction(() =>
															addGroupMemberAction(ownerPubkey, privKey, dbKey, groupId, pubkey, publish),
														)
													}
												/>
											)}
										</div>

										{isExpanded && (
											<PermissionEditor ownerPubkey={ownerPubkey} privKey={privKey} subject={pubkey} />
										)}
									</li>
								);
							})}
						</ul>
						{visibleContacts.length === 0 && (
							<p style={{ color: "var(--muted)" }}>
								{contacts.value.length === 0 ? t("contacts.noContactsAtAll") : t("contacts.noContactsInGroups")}
							</p>
						)}
					</section>

					<section class="stack" aria-labelledby="requests-heading" style={{ "--gap": "var(--space-s)" }}>
						<h2 id="requests-heading">{t("contacts.incomingHeading", { count: incomingRequests.value.length })}</h2>
						{incomingRequests.value.length === 0 ? (
							<p style={{ color: "var(--muted)" }}>{t("contacts.noIncoming")}</p>
						) : (
							<ul role="list" class="contact-row-list stack" style={{ "--gap": "var(--space-2xs)" }}>
								{incomingRequests.value.map((req) => (
									<li key={req.peerPubkey} class="contact-row row" style={{ "--gap": "var(--space-s)", alignItems: "center", justifyContent: "space-between" }}>
										<ContactIdentity pubkey={req.peerPubkey} />
										<div class="contact-row-actions row" style={{ "--gap": "var(--space-2xs)", alignItems: "center" }}>
											<button type="button" disabled={busy} onClick={() => handleAcceptContactRequest(req.peerPubkey)}>
												{t("contacts.acceptButton")}
											</button>
											<button type="button" disabled={busy} onClick={() => handleRejectContactRequest(req.peerPubkey)}>
												{t("contacts.rejectButton")}
											</button>
										</div>
									</li>
								))}
							</ul>
						)}
					</section>

					{/* Пользователь: не диктовал явно, но "Входящие" остаётся всегда
					    развёрнутым (требует решения) — эти два списка вторичны
					    (редко нужны, обычно пусты), сворачиваем в <details>
					    (VISUAL.md v2 .req), чтобы не отвлекали от главного. */}
					<div class="requests stack" style={{ "--gap": "var(--space-2xs)" }}>
						<details class="req">
							<summary class="row" style={{ "--gap": "var(--space-2xs)", alignItems: "center" }}>
								{t("contacts.outgoingSummary")} <span class="req__count">{outgoingRequests.value.length}</span>
								<IconChevronRight class="icon req__chev" aria-hidden="true" />
							</summary>
							<div class="req__body">
								{outgoingRequests.value.length === 0 ? (
									<p style={{ color: "var(--muted)" }}>{t("contacts.noOutgoing")}</p>
								) : (
									<ul role="list" class="contact-row-list stack" style={{ "--gap": "var(--space-2xs)" }}>
										{outgoingRequests.value.map((req) => (
											<li key={req.peerPubkey} class="contact-row row" style={{ "--gap": "var(--space-s)", alignItems: "center", justifyContent: "space-between" }}>
												<ContactIdentity pubkey={req.peerPubkey} />
												<div class="contact-row-actions row" style={{ "--gap": "var(--space-2xs)", alignItems: "center" }}>
													<button type="button" disabled={busy} onClick={() => runRowAction(() => cancelContactRequestAction(req.peerPubkey))}>
														{t("contacts.cancelRequestButton")}
													</button>
												</div>
											</li>
										))}
									</ul>
								)}
							</div>
						</details>

						<details class="req">
							<summary class="row" style={{ "--gap": "var(--space-2xs)", alignItems: "center" }}>
								{t("contacts.rejectedSummary")} <span class="req__count">{rejectedByMe.value.length}</span>
								<IconChevronRight class="icon req__chev" aria-hidden="true" />
							</summary>
							<div class="req__body">
								{rejectedByMe.value.length === 0 ? (
									<p style={{ color: "var(--muted)" }}>{t("contacts.noRejected")}</p>
								) : (
									<ul role="list" class="contact-row-list stack" style={{ "--gap": "var(--space-2xs)" }}>
										{rejectedByMe.value.map((req) => (
											<li key={req.peerPubkey} class="contact-row row" style={{ "--gap": "var(--space-s)", alignItems: "center", justifyContent: "space-between" }}>
												<ContactIdentity pubkey={req.peerPubkey} />
												{/* Отказ — не блокировка (CONTACTS-FSM.md, I6): можно передумать и
												написать самому тому, чью заявку отклонил(а) раньше. */}
												<div class="contact-row-actions row" style={{ "--gap": "var(--space-2xs)", alignItems: "center" }}>
													<button
														type="button"
														disabled={busy}
														onClick={() => runRowAction(() => sendContactRequestAction(req.peerPubkey, ""))}
													>
														{t("contacts.addAnywayButton")}
													</button>
												</div>
											</li>
										))}
									</ul>
								)}
							</div>
						</details>
					</div>

					<div class="requests stack" style={{ "--gap": "var(--space-2xs)" }}>
						<details class="req">
							<summary class="row" style={{ "--gap": "var(--space-2xs)", alignItems: "center" }}>
								{t("contacts.blockedSummary")} <span class="req__count">{blockedContacts.value.length}</span>
								<IconChevronRight class="icon req__chev" aria-hidden="true" />
							</summary>
							<div class="req__body">
								<ul role="list" class="contact-row-list stack" style={{ "--gap": "var(--space-2xs)" }}>
									{blockedContacts.value.map((pubkey) => (
										<li key={pubkey} class="contact-row row" style={{ "--gap": "var(--space-s)", alignItems: "center", justifyContent: "space-between" }}>
											<ContactIdentity pubkey={pubkey} />
											<div class="contact-row-actions row" style={{ "--gap": "var(--space-2xs)", alignItems: "center" }}>
												<button type="button" disabled={busy} onClick={() => runRowAction(() => unblockContactAction(pubkey))}>
													{t("contacts.unblockButton")}
												</button>
											</div>
										</li>
									))}
								</ul>
								{blockedContacts.value.length === 0 && (
									<p style={{ color: "var(--muted)" }}>{t("contacts.noBlocked")}</p>
								)}
							</div>
						</details>
					</div>
				</div>
			</div>
		</Screen>
	);
}

// VISUAL.md v2 — чип-триггер с чекбоксами вместо select+submit: можно
// отметить сразу несколько групп без переоткрытия (useDetailsMenu не
// закрывает меню по клику на чекбокс, только на кнопку/ссылку).
function AddToGroupControl({ groups, excludeGroupIds, onAdd, disabled }) {
	const { ref, handleMenuClick } = useDetailsMenu();
	const available = groups.filter((g) => !excludeGroupIds.includes(g.id));
	if (available.length === 0) return null;

	return (
		<details class="menu" ref={ref} onClick={handleMenuClick}>
			<summary class="chip row" style={{ "--gap": "var(--space-3xs)", alignItems: "center", cursor: "pointer" }}>
				<IconPlus /> {t("contacts.addToGroupLabel")}
			</summary>
			<div class="menu__pop stack" style={{ "--gap": "2px" }}>
				{available.map((g) => (
					<label key={g.id} class="menu-check">
						<input type="checkbox" disabled={disabled} onChange={() => onAdd(g.id)} />
						{g.name}
					</label>
				))}
			</div>
		</details>
	);
}
