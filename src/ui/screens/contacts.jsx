import { useState, useEffect, useId, useRef } from "preact/hooks";
import { BUILD_DEFAULT_RELAYS as DEFAULT_RELAYS } from "../../config.js";
import { shortPubkey } from "../format.js";
import { currentUser, privKeySig, dbKeySig } from "../signals/auth.js";
import { ensureConnected, publish, fetchProfiles, refreshLiveProfileSubscription, connState, synced } from "../signals/transport.js";
import { openChat } from "../signals/chat.js";
import { placeCall } from "../signals/call.js";
import IconPhoneCall from "../icons/phone-call.jsx";
import {
	contacts,
	blockedContacts,
	groups,
	profiles,
	contactRequests,
	refreshAll,
	refreshContactRequests,
	ensureProfilesFetched,
	refreshProfiles,
	addContactAction,
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
} from "../signals/contacts.js";
import { messagingActivity } from "../signals/chats.js";
import { outgoingRequests, refreshOutgoingRequests, cancelAcquaintanceRequestAction } from "../signals/discovery.js";
import SyncIndicator from "../components/sync-indicator.jsx";
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
		<img
			src={profile.picture}
			alt=""
			width="40"
			height="40"
			style={{
				width: "2.5rem",
				height: "2.5rem",
				borderRadius: "50%",
				border: "var(--border-width) solid var(--border)",
			}}
		/>
	) : (
		<div
			aria-hidden="true"
			style={{
				width: "2.5rem",
				height: "2.5rem",
				borderRadius: "50%",
				display: "flex",
				alignItems: "center",
				justifyContent: "center",
				background: "var(--surface)",
				border: "var(--border-width) solid var(--border)",
				color: "var(--muted)",
			}}
		>
			{(displayName || "?").trim().charAt(0).toUpperCase()}
		</div>
	);

	const text = (
		<span class="flow" style={{ "--flow-space": "var(--space-3xs)" }}>
			<span style={profile?.name ? {} : { fontFamily: "var(--font-mono)" }}>{displayName}</span>
			{profile?.about && <small style={{ color: "var(--muted)" }}>{profile.about}</small>}
		</span>
	);

	if (!onClick) {
		return (
			<div class="cluster" style={{ alignItems: "center" }}>
				{avatar}
				{text}
			</div>
		);
	}

	return (
		<button
			type="button"
			onClick={onClick}
			aria-label={`Открыть чат с ${displayName}`}
			class="cluster"
			style={{
				alignItems: "center",
				background: "none",
				border: "none",
				padding: 0,
				cursor: "pointer",
				textAlign: "left",
				font: "inherit",
				color: "inherit",
			}}
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
	const relayUrl = DEFAULT_RELAYS[0] ?? "ws://127.0.0.1:7777";

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
		refreshAll(ownerPubkey, dbKey);
		refreshContactRequests(ownerPubkey, dbKey);
		ensureConnected(ownerPubkey, privKey, dbKey)
			.then(async () => {
				await refreshAll(ownerPubkey, dbKey);
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

	// F-CT-04: подтягиваем профиль и для контактов, добавленных ПОСЛЕ того, как
	// соединение уже установлено (эффект выше покрывает только первичную загрузку).
	// Пока соединения ещё нет, fetchProfiles бросает — ensureProfilesFetched тогда
	// ничего не кэширует, .catch(() => {}) просто откладывает до следующего триггера.
	useEffect(() => {
		if (contacts.value.length > 0) {
			ensureProfilesFetched(contacts.value, fetchProfiles).catch(() => {});
			// Новый контакт — переподписка (идемпотентно, тот же приём, что
			// refreshGroupMessageSubscription на каждую отправку) подхватывает его в live-набор.
			refreshLiveProfileSubscription(ownerPubkey).catch(() => {});
		}
	}, [contacts.value]);

	// Живое обновление входящих contact-request (этап 27, находка 2) — диспетчер
	// transport.js инкрементирует messagingActivity при получении нового запроса,
	// пока пользователь уже смотрит этот экран.
	useEffect(() => {
		refreshContactRequests(ownerPubkey, dbKey).then(() => {
			if (contactRequests.value.length > 0) {
				ensureProfilesFetched(
					contactRequests.value.map((r) => r.senderPubkey),
					fetchProfiles,
				).catch(() => {});
			}
		});
		// Этап 46 — CONTACT_ACCEPTED_KIND чистит outgoingAcquaintanceRequests
		// (transport.js), ACQUAINT_CANCELLED_KIND не трогает эту сторону вовсе —
		// обновляем на тот же триггер, что входящие запросы, чтобы список
		// "Отправленные заявки" не расходился с реальностью на уже открытом экране.
		refreshOutgoingRequests(ownerPubkey).then(() => {
			if (outgoingRequests.value.length > 0) {
				ensureProfilesFetched(
					outgoingRequests.value.map((r) => r.targetPubkey),
					fetchProfiles,
				).catch(() => {});
			}
		});
	}, [ownerPubkey, messagingActivity.value]);

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
			// Находка 1 (CONTRACTS.md, этап 27): инициатор сразу видит адресата у себя
			// (addContactAction внутри) И отправляет ему запрос — тот увидит его во
			// "Входящих" и решит сам, добавлять ли взаимно.
			await sendContactRequestAction(ownerPubkey, privKey, npubInput, "", publish);
			setNpubInput("");
		} catch (err) {
			setAddError(err?.message || String(err));
		} finally {
			busyRef.current = false;
			setBusy(false);
		}
	}

	async function handleAcceptContactRequest(senderPubkey) {
		if (busyRef.current) return;
		busyRef.current = true;
		setRowError("");
		setBusy(true);
		try {
			await acceptContactRequestAction(ownerPubkey, privKey, dbKey, senderPubkey, publish);
		} catch (err) {
			setRowError(err?.message || String(err));
		} finally {
			busyRef.current = false;
			setBusy(false);
		}
	}

	async function handleRejectContactRequest(senderPubkey) {
		if (busyRef.current) return;
		busyRef.current = true;
		setRowError("");
		setBusy(true);
		try {
			await rejectContactRequestAction(ownerPubkey, privKey, dbKey, senderPubkey, publish);
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

	// Контакты и заблокированные — взаимоисключающие категории в UI (blockContactAction
	// уже гарантирует это на уровне данных, см. signals/contacts.js), но фильтр здесь
	// не помешает, если данные пришли извне (другое устройство, будущий импорт).
	const nonBlockedContacts = contacts.value.filter((pk) => !blockedContacts.value.includes(pk));
	const visibleContacts =
		selectedGroupIds.size === 0
			? nonBlockedContacts
			: nonBlockedContacts.filter((pk) => groupsForContact(pk).some((g) => selectedGroupIds.has(g.id)));

	return (
		<Screen title="Контакты">
			<p class="cluster" style={{ alignItems: "center", color: "var(--muted)" }}>
				Соединение: <SyncIndicator state={connState.value} synced={synced.value} url={relayUrl} />
			</p>
			{connectionError && (
				<p role="alert" style={{ color: "var(--bad, oklch(0.58 0.21 25))" }}>
					{connectionError}
				</p>
			)}

			<form class="cluster" onSubmit={handleAddContact} style={{ alignItems: "flex-end" }}>
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

			<div class="cluster" style={{ alignItems: "flex-start" }}>
				<section
					class="flow"
					aria-labelledby="groups-heading"
					style={{ "--flow-space": "var(--space-s)", minWidth: "16rem" }}
				>
					<h2 id="groups-heading">Группы</h2>
					<ul role="list" style={{ listStyle: "none", paddingInlineStart: 0 }}>
						<li>
							<span class="cluster" style={{ "--cluster-gap": "var(--space-3xs)", alignItems: "center" }}>
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
								<div class="cluster" style={{ "--cluster-gap": "var(--space-3xs)", alignItems: "center" }}>
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
											<button
												type="button"
												onClick={() => {
													setRenamingGroupId(g.id);
													setRenameValue(g.name);
												}}
											>
												Переименовать
											</button>
											<button
												type="button"
												disabled={busy}
												onClick={() =>
													runRowAction(() => deleteGroupAction(ownerPubkey, privKey, dbKey, g.id, publish))
												}
											>
												Удалить
											</button>
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
				</section>

				<div class="flow" style={{ "--flow-space": "var(--space-l)", flex: 1 }}>
					<section class="flow" aria-labelledby="requests-heading" style={{ "--flow-space": "var(--space-s)" }}>
						<h2 id="requests-heading">Запросы ({contactRequests.value.length})</h2>
						{contactRequests.value.length === 0 ? (
							<p style={{ color: "var(--muted)" }}>Нет входящих запросов на добавление в контакты.</p>
						) : (
							<ul role="list" style={{ listStyle: "none", paddingInlineStart: 0 }}>
								{contactRequests.value.map((req) => (
									<li
										key={req.senderPubkey}
										class="cluster"
										style={{
											alignItems: "center",
											justifyContent: "space-between",
											paddingBlock: "var(--space-s)",
											borderBlockEnd: "var(--border-width) solid var(--border)",
										}}
									>
										<ContactIdentity pubkey={req.senderPubkey} />
										<div class="cluster">
											<button type="button" disabled={busy} onClick={() => handleAcceptContactRequest(req.senderPubkey)}>
												Принять
											</button>
											<button type="button" disabled={busy} onClick={() => handleRejectContactRequest(req.senderPubkey)}>
												Отклонить
											</button>
										</div>
									</li>
								))}
							</ul>
						)}
					</section>

					<section class="flow" aria-labelledby="outgoing-requests-heading" style={{ "--flow-space": "var(--space-s)" }}>
						<h2 id="outgoing-requests-heading">Отправленные заявки ({outgoingRequests.value.length})</h2>
						{outgoingRequests.value.length === 0 ? (
							<p style={{ color: "var(--muted)" }}>Нет отправленных заявок на знакомство.</p>
						) : (
							<ul role="list" style={{ listStyle: "none", paddingInlineStart: 0 }}>
								{outgoingRequests.value.map((req) => (
									<li
										key={req.targetPubkey}
										class="cluster"
										style={{
											alignItems: "center",
											justifyContent: "space-between",
											paddingBlock: "var(--space-s)",
											borderBlockEnd: "var(--border-width) solid var(--border)",
										}}
									>
										<ContactIdentity pubkey={req.targetPubkey} />
										<button
											type="button"
											disabled={busy}
											onClick={() =>
												runRowAction(() => cancelAcquaintanceRequestAction(ownerPubkey, privKey, req.targetPubkey, publish))
											}
										>
											Отменить
										</button>
									</li>
								))}
							</ul>
						)}
					</section>

					<section class="flow" aria-labelledby="contacts-heading" style={{ "--flow-space": "var(--space-s)" }}>
						<h2 id="contacts-heading">Контакты ({visibleContacts.length})</h2>
						{rowError && (
							<p role="alert" style={{ color: "var(--bad, oklch(0.58 0.21 25))" }}>
								{rowError}
							</p>
						)}
						<ul role="list" style={{ listStyle: "none", paddingInlineStart: 0 }}>
							{visibleContacts.map((pubkey) => {
								const memberOfGroups = groupsForContact(pubkey);
								const isExpanded = expandedPubkey === pubkey;
								return (
									<li
										key={pubkey}
										class="flow"
										style={{
											"--flow-space": "var(--space-2xs)",
											paddingBlock: "var(--space-s)",
											borderBlockEnd: "var(--border-width) solid var(--border)",
										}}
									>
										<div class="cluster" style={{ alignItems: "center", justifyContent: "space-between" }}>
											<ContactIdentity pubkey={pubkey} onClick={() => openChat(pubkey)} />
											<div class="cluster">
												<button type="button" onClick={() => placeCall(pubkey)} aria-label={`Позвонить ${profiles.value[pubkey]?.name || shortPubkey(pubkey)}`}>
													<IconPhoneCall /> Позвонить
												</button>
												<button type="button" onClick={() => setExpandedPubkey(isExpanded ? null : pubkey)}>
													{isExpanded ? "Скрыть права" : "Права"}
												</button>
												<button
													type="button"
													disabled={busy}
													onClick={() =>
														runRowAction(() => blockContactAction(ownerPubkey, privKey, pubkey, publish))
													}
												>
													Заблокировать
												</button>
												<button
													type="button"
													disabled={busy}
													onClick={() =>
														runRowAction(() => removeContactAction(ownerPubkey, privKey, pubkey, publish))
													}
												>
													Удалить
												</button>
											</div>
										</div>

										<div class="cluster">
											{memberOfGroups.map((g) => (
												<span
													key={g.id}
													class="cluster"
													style={{
														"--cluster-gap": "var(--space-3xs)",
														alignItems: "center",
														background: "var(--surface)",
														paddingInline: "var(--space-2xs)",
														borderRadius: "var(--radius)",
													}}
												>
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
								{nonBlockedContacts.length === 0 ? "Пока нет ни одного контакта." : "Ни один контакт не входит в выбранные группы."}
							</p>
						)}
					</section>

					<section class="flow" aria-labelledby="blocked-heading" style={{ "--flow-space": "var(--space-s)" }}>
						<h2 id="blocked-heading">Заблокированные ({blockedContacts.value.length})</h2>
						<ul role="list" style={{ listStyle: "none", paddingInlineStart: 0 }}>
							{blockedContacts.value.map((pubkey) => (
								<li
									key={pubkey}
									class="cluster"
									style={{
										alignItems: "center",
										justifyContent: "space-between",
										paddingBlock: "var(--space-s)",
										borderBlockEnd: "var(--border-width) solid var(--border)",
									}}
								>
									<ContactIdentity pubkey={pubkey} />
									<button
										type="button"
										disabled={busy}
										onClick={() =>
											runRowAction(() => unblockContactAction(ownerPubkey, privKey, pubkey, publish))
										}
									>
										Разблокировать
									</button>
								</li>
							))}
						</ul>
						{blockedContacts.value.length === 0 && (
							<p style={{ color: "var(--muted)" }}>Нет заблокированных.</p>
						)}
					</section>
				</div>
			</div>
		</Screen>
	);
}

function AddToGroupControl({ groups, excludeGroupIds, onAdd, disabled }) {
	const instanceId = useId();
	const [selected, setSelected] = useState("");
	const available = groups.filter((g) => !excludeGroupIds.includes(g.id));
	if (available.length === 0) return null;

	const selectId = `add-to-group-select-${instanceId}`;

	return (
		<form
			class="cluster"
			style={{ "--cluster-gap": "var(--space-3xs)", alignItems: "center" }}
			onSubmit={(e) => {
				e.preventDefault();
				if (!selected) return;
				onAdd(selected);
				setSelected("");
			}}
		>
			<label class="visually-hidden" for={selectId}>
				Добавить в группу
			</label>
			<select id={selectId} value={selected} disabled={disabled} onChange={(e) => setSelected(e.currentTarget.value)}>
				<option value="">+ в группу…</option>
				{available.map((g) => (
					<option key={g.id} value={g.id}>
						{g.name}
					</option>
				))}
			</select>
			<button type="submit" disabled={!selected || disabled}>
				Добавить
			</button>
		</form>
	);
}
