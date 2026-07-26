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
		<div aria-hidden="true" class="contact-avatar contact-avatar-fallback">
			{(displayName || "?").trim().charAt(0).toUpperCase()}
		</div>
	);

	const text = (
		<span class="flow" style={{ "--flow-space": "var(--space-3xs)" }}>
			<span class={profile?.name ? undefined : "contact-identity-npub"}>{displayName}</span>
			{profile?.about && <small>{profile.about}</small>}
		</span>
	);

	if (!onClick) {
		return (
			<div class="contact-identity">
				{avatar}
				{text}
			</div>
		);
	}

	return (
		<button type="button" onClick={onClick} aria-label={`Открыть чат с ${displayName}`} class="contact-identity contact-identity-btn">
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
			.catch((e) => setConnectionError(e?.message || String(e)));
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
			setAddError(err?.message || String(err));
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
			setRowError(err?.message || String(err));
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
			setRowError(err?.message || String(err));
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
			setGroupError(err?.message || String(err));
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
			setRowError(err?.message || String(err));
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
		<Screen title="Контакты">
			<div class="card contacts-toolbar">
				{/* "Соединение: ..." переехало в постоянную панель под главным
				    меню (app.jsx, ConnectionStatusPanel) — видна на любом экране,
				    здесь дублировать незачем (пользователь, item 4). */}
				{connectionError && (
					<p role="alert" style={{ color: "var(--bad, oklch(0.58 0.21 25))" }}>
						{connectionError}
					</p>
				)}

				<form class="cluster contacts-add-form" onSubmit={handleAddContact} style={{ alignItems: "flex-end" }}>
					<div class="flow" style={{ "--flow-space": "var(--space-3xs)", flex: 1 }}>
						<label for="add-contact-input">Добавить контакт (npub или hex-ключ)</label>
						<input
							id="add-contact-input"
							type="text"
							value={npubInput}
							onInput={(e) => setNpubInput(e.currentTarget.value)}
						/>
					</div>
					<button type="submit" disabled={busy}>
						Добавить
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
					<h2 id="groups-heading">Группы</h2>
					<ul role="list" class="group-filter-list">
						<li>
							<span class="group-filter-chip">
								<input
									id="group-filter-all"
									type="checkbox"
									checked={selectedGroupIds.size === 0}
									onChange={() => setSelectedGroupIds(new Set())}
								/>
								<label for="group-filter-all">Все группы</label>
							</span>
						</li>
						{groups.value.map((g) => (
							<li key={g.id}>
								<div class="group-filter-chip">
									<input
										id={`group-filter-${g.id}`}
										type="checkbox"
										checked={selectedGroupIds.has(g.id)}
										onChange={() => toggleGroupFilter(g.id)}
									/>
									{renamingGroupId === g.id ? (
										<form
											class="cluster"
											onSubmit={(e) => {
												e.preventDefault();
												runRowAction(async () => {
													await renameGroupAction(ownerPubkey, privKey, dbKey, g.id, renameValue, publish);
													setRenamingGroupId(null);
												});
											}}
										>
											<label class="visually-hidden" for={`rename-group-${g.id}`}>
												Новое имя группы
											</label>
											<input
												id={`rename-group-${g.id}`}
												type="text"
												value={renameValue}
												onInput={(e) => setRenameValue(e.currentTarget.value)}
											/>
											<button type="submit" disabled={busy}>
												Сохранить
											</button>
											<button type="button" onClick={() => setRenamingGroupId(null)}>
												Отмена
											</button>
										</form>
									) : (
										<>
											<label for={`group-filter-${g.id}`}>
												{g.name} ({g.memberPubkeys.length})
											</label>
											<ActionsMenu label={`Действия с группой «${g.name}»`}>
												<button
													type="button"
													onClick={() => {
														setRenamingGroupId(g.id);
														setRenameValue(g.name);
													}}
												>
													<IconPencil /> Переименовать
												</button>
												<button
													type="button"
													class="danger"
													disabled={busy}
													onClick={() =>
														runRowAction(() => deleteGroupAction(ownerPubkey, privKey, dbKey, g.id, publish))
													}
												>
													<IconTrash /> Удалить
												</button>
											</ActionsMenu>
										</>
									)}
								</div>
							</li>
						))}
					</ul>

					<form class="cluster" onSubmit={handleCreateGroup}>
						<label class="visually-hidden" for="new-group-name">
							Название новой группы
						</label>
						<input
							id="new-group-name"
							type="text"
							placeholder="Новая группа…"
							value={newGroupName}
							onInput={(e) => setNewGroupName(e.currentTarget.value)}
						/>
						<button type="submit" disabled={busy}>
							Добавить
						</button>
					</form>
					{groupError && (
						<p role="alert" style={{ color: "var(--bad, oklch(0.58 0.21 25))" }}>
							{groupError}
						</p>
					)}
				</aside>

				<div class="contacts-main">
					{/* Пользователь: "существующие контакты — главный рабочий блок,
					    надо поднять вверх и выделить" — был зажат между "Отклонённые"
					    и "Заблокированные" внизу страницы. Теперь первым, в своей
					    рамке (contacts-primary-section). */}
					<section class="flow card contacts-primary-section" aria-labelledby="contacts-heading" style={{ "--flow-space": "var(--space-s)" }}>
						<h2 id="contacts-heading">Контакты ({visibleContacts.length})</h2>
						{rowError && (
							<p role="alert" style={{ color: "var(--bad, oklch(0.58 0.21 25))" }}>
								{rowError}
							</p>
						)}
						<ul role="list" class="contact-row-list">
							{visibleContacts.map((pubkey) => {
								const memberOfGroups = groupsForContact(pubkey);
								const isExpanded = expandedPubkey === pubkey;
								return (
									<li key={pubkey} class="contact-row contact-row-expandable">
										<div class="contact-row-main">
											<ContactIdentity pubkey={pubkey} onClick={() => openChat(pubkey)} />
											<div class="contact-row-actions">
												<button type="button" onClick={() => placeCall(pubkey)} aria-label={`Позвонить ${profiles.value[pubkey]?.name || shortPubkey(pubkey)}`}>
													<IconPhoneCall /> <span class="call-txt">Позвонить</span>
												</button>
												<ActionsMenu label={`Ещё действия для ${profiles.value[pubkey]?.name || shortPubkey(pubkey)}`}>
													<button type="button" onClick={() => setExpandedPubkey(isExpanded ? null : pubkey)}>
														<IconGear /> {isExpanded ? "Скрыть права" : "Права"}
													</button>
													<button
														type="button"
														disabled={busy}
														onClick={() => runRowAction(() => blockContactAction(pubkey))}
													>
														<IconLockClosed /> Заблокировать
													</button>
													<button
														type="button"
														class="danger"
														disabled={busy}
														onClick={() => runRowAction(() => removeContactAction(pubkey))}
													>
														<IconTrash /> Удалить
													</button>
												</ActionsMenu>
											</div>
										</div>

										<div class="contact-row-groups">
											{memberOfGroups.map((g) => (
												<span key={g.id} class="group-chip">
													{g.name}
													<button
														type="button"
														disabled={busy}
														aria-label={`Убрать из группы ${g.name}`}
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
								{contacts.value.length === 0 ? "Пока нет ни одного контакта." : "Ни один контакт не входит в выбранные группы."}
							</p>
						)}
					</section>

					<section class="flow" aria-labelledby="requests-heading" style={{ "--flow-space": "var(--space-s)" }}>
						<h2 id="requests-heading">Входящие заявки ({incomingRequests.value.length})</h2>
						{incomingRequests.value.length === 0 ? (
							<p style={{ color: "var(--muted)" }}>Нет входящих запросов на добавление в контакты.</p>
						) : (
							<ul role="list" class="contact-row-list">
								{incomingRequests.value.map((req) => (
									<li key={req.peerPubkey} class="contact-row">
										<ContactIdentity pubkey={req.peerPubkey} />
										<div class="contact-row-actions">
											<button type="button" disabled={busy} onClick={() => handleAcceptContactRequest(req.peerPubkey)}>
												Принять
											</button>
											<button type="button" disabled={busy} onClick={() => handleRejectContactRequest(req.peerPubkey)}>
												Отклонить
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
					<div class="requests">
						<details class="req">
							<summary>
								Отправленные заявки <span class="req__count">{outgoingRequests.value.length}</span>
								<IconChevronRight class="icon req__chev" aria-hidden="true" />
							</summary>
							<div class="req__body">
								{outgoingRequests.value.length === 0 ? (
									<p style={{ color: "var(--muted)" }}>Нет отправленных заявок на знакомство.</p>
								) : (
									<ul role="list" class="contact-row-list">
										{outgoingRequests.value.map((req) => (
											<li key={req.peerPubkey} class="contact-row">
												<ContactIdentity pubkey={req.peerPubkey} />
												<div class="contact-row-actions">
													<button type="button" disabled={busy} onClick={() => runRowAction(() => cancelContactRequestAction(req.peerPubkey))}>
														Отменить
													</button>
												</div>
											</li>
										))}
									</ul>
								)}
							</div>
						</details>

						<details class="req">
							<summary>
								Отклонённые <span class="req__count">{rejectedByMe.value.length}</span>
								<IconChevronRight class="icon req__chev" aria-hidden="true" />
							</summary>
							<div class="req__body">
								{rejectedByMe.value.length === 0 ? (
									<p style={{ color: "var(--muted)" }}>Нет отклонённых заявок.</p>
								) : (
									<ul role="list" class="contact-row-list">
										{rejectedByMe.value.map((req) => (
											<li key={req.peerPubkey} class="contact-row">
												<ContactIdentity pubkey={req.peerPubkey} />
												{/* Отказ — не блокировка (CONTACTS-FSM.md, I6): можно передумать и
												написать самому тому, чью заявку отклонил(а) раньше. */}
												<div class="contact-row-actions">
													<button
														type="button"
														disabled={busy}
														onClick={() => runRowAction(() => sendContactRequestAction(req.peerPubkey, ""))}
													>
														Добавить всё же
													</button>
												</div>
											</li>
										))}
									</ul>
								)}
							</div>
						</details>
					</div>

					<div class="requests">
						<details class="req">
							<summary>
								Заблокированные <span class="req__count">{blockedContacts.value.length}</span>
								<IconChevronRight class="icon req__chev" aria-hidden="true" />
							</summary>
							<div class="req__body">
								<ul role="list" class="contact-row-list">
									{blockedContacts.value.map((pubkey) => (
										<li key={pubkey} class="contact-row">
											<ContactIdentity pubkey={pubkey} />
											<div class="contact-row-actions">
												<button type="button" disabled={busy} onClick={() => runRowAction(() => unblockContactAction(pubkey))}>
													Разблокировать
												</button>
											</div>
										</li>
									))}
								</ul>
								{blockedContacts.value.length === 0 && (
									<p style={{ color: "var(--muted)" }}>Нет заблокированных.</p>
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
			<summary class="chip" style={{ cursor: "pointer" }}>
				<IconPlus /> в группу
			</summary>
			<div class="menu__pop">
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
