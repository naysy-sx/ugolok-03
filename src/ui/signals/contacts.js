import { signal } from "@preact/signals";
import { db } from "../../core/store/database.js";
import { decode as nip19Decode } from "nostr-tools/nip19";
import { parseContactListEvent, parseMuteListEvent } from "../../domain/contacts/contacts.js";
import { buildGroupEvent, addMember, removeMember, renameGroup } from "../../domain/contacts/groups.js";
import { foldGroup, buildAddressableDeletionEvent } from "../../domain/events/handlers.js";
import { createContactRuntime } from "../../domain/contacts/contact-runtime.js";
import { pickLatest } from "../../core/sync/lww.js";
import { revokeIfNoLongerVisible } from "../../domain/content/channel-visibility.js";
import { fromEncryptedRow } from "../../core/store/encrypted-table.js";
import { loadUiSettings } from "../../domain/settings/ui-settings.js";
import { notifyAndLog } from "../../domain/notifications/journal.js";
import { navigateFromNotification } from "./notification-nav.js";
import { t } from "./i18n.js";

// Этап 49 — contacts/blockedContacts остаются pubkey[] (форма, на которую уже
// завязан остальной UI — discovery.jsx/settings.jsx/call.js), outgoingRequests/
// incomingRequests/rejectedByMe — полные peerState[] (нужны greeting/sentAt/
// resolvedAt для отображения, разделы новые или изменившие форму данных).
export const contacts = signal([]);
export const blockedContacts = signal([]);
export const outgoingRequests = signal([]); // [{peerPubkey, name:"OUTGOING_PENDING", sentAt, resolvedAt}]
export const incomingRequests = signal([]); // [{peerPubkey, name:"INCOMING_PENDING", greeting, resolvedAt}] — было contactRequests
export const rejectedByMe = signal([]); // [{peerPubkey, name:"REJECTED_BY_ME", resolvedAt}] — НОВЫЙ раздел (CONTACTS-FSM.md)
export const groups = signal([]);
export const profiles = signal({}); // pubkey -> { name?, about?, picture? } | null (запрошен, но не найден)

let runtime = null;

function recomputeContactSignals() {
	if (!runtime) return;
	contacts.value = runtime.listPeersByState("CONTACT").map((s) => s.peerPubkey);
	blockedContacts.value = runtime.listPeersByState("BLOCKED").map((s) => s.peerPubkey);
	outgoingRequests.value = runtime.listPeersByState("OUTGOING_PENDING");
	incomingRequests.value = runtime.listPeersByState("INCOMING_PENDING");
	rejectedByMe.value = runtime.listPeersByState("REJECTED_BY_ME");
}

function requireRuntime() {
	if (!runtime) throw new Error("contact-runtime не настроен — вызовите configureContactRuntime() после ensureConnected()");
	return runtime;
}

let ownerPubkeyRef = null;
let dbKeyRef = null;

function usernameFor(pubkeyHex) {
	const name = profiles.value[pubkeyHex]?.name?.trim();
	return name || `${pubkeyHex.slice(0, 8)}…`;
}

// LOG_JOURNAL -> notifyAndLog() (этап 50 — реальная персистентная запись в
// journalEntries появилась здесь, раньше был no-op-заглушка на будущее).
// "newRequest"/"accepted" — существующие настраиваемые категории (settings.jsx);
// "rejected"/"crossed" — новые по смыслу (раньше отказ вообще не сигнализировался
// отправителю), сознательно повешены на тот же тумблер "accepted" — оба это
// "моя исходящая заявка решилась", отдельный тумблер не заводим ради двух редких
// случаев. Best-effort (тот же принцип, что notifyIncomingCall, call.js этап 48).
// Этап 64 — titleKey берётся из entry.category напрямую (уже однозначно
// определяет один из 4 вариантов, contact-fsm.js), а не из entry.message
// (тот остаётся как есть, "message" — часть форм-контракта FSM, свой тест —
// не трогаем ради этого этапа, см. tests/contact-fsm.test.js).
const CONTACT_TITLE_KEY = {
	newRequest: "journal.contactNewRequestTitle",
	accepted: "journal.contactAcceptedTitle",
	rejected: "journal.contactRejectedTitle",
	crossed: "journal.contactCrossedTitle",
};

async function notifyContactJournalEntry(entry) {
	try {
		const settings = await loadUiSettings(ownerPubkeyRef, dbKeyRef);
		const titleKey = CONTACT_TITLE_KEY[entry.category];
		const titleParams = { username: usernameFor(entry.peer) };
		const subcategory = entry.category === "newRequest" ? "newRequests" : "accepted";
		const navTarget = { screen: "contacts" };
		await notifyAndLog(ownerPubkeyRef, dbKeyRef, settings, "contacts", subcategory, {
			title: t(titleKey, titleParams),
			body: "",
			titleKey,
			titleParams,
			navTarget,
			onClick: () => navigateFromNotification(navTarget),
			occurredAt: entry.createdAt * 1000,
		});
	} catch {
		// нет настроек/сети — состояние уже применено (peerState/EMIT), уведомление необязательно
	}
}

// Вызывается ОДИН раз из transport.js's connect() (тот же принцип, что
// configureCallRuntime, этап 48) — publish уже готов на этот момент. load()
// внутри себя мигрирует legacy-таблицы (contacts/blockedContacts/contactRequests)
// и читает contactRelationships — см. contact-runtime.js.
export async function configureContactRuntime({ ownerPubkey, privKey, dbKey, publish }) {
	ownerPubkeyRef = ownerPubkey;
	dbKeyRef = dbKey;
	runtime = createContactRuntime({
		ownerPubkey,
		privKey,
		dbKey,
		publish,
		onStateChange: () => recomputeContactSignals(),
		onJournal: (entry) => {
			notifyContactJournalEntry(entry);
		},
	});
	await runtime.load();
	recomputeContactSignals();
}

// transport.js's giftWrapSubscriber маршрутизирует сюда входящие contact-request
// rumor'ы (kind 3001/3004/3005/3006) вместо прямой обработки в самом transport.js.
export async function handleIncomingContactRumor(rumor) {
	if (!runtime) return;
	await runtime.handleIncomingRumor(rumor);
}

// Реконсиляция kind-3/kind-10000 (замена foldContactList/foldMuteList — этап 49
// §1.6, CONTACTS-FSM.md) — вызывается из transport.js на тех же точках, что
// раньше rebuildContactsAndGroups: подключение и каждый onEvent инкрементального
// sync. pickLatest — та же LWW-семантика, что и раньше (см. lww.js).
export async function reconcileContactsFromEventLog(ownerPubkey) {
	if (!runtime) return;
	const contactEvents = await db.table("events").where("[pubkey+kind]").equals([ownerPubkey, 3]).toArray();
	if (contactEvents.length > 0) {
		const winner = pickLatest(contactEvents);
		await runtime.reconcileContactList(new Set(parseContactListEvent(winner)), winner.created_at);
	}
	const muteEvents = await db.table("events").where("[pubkey+kind]").equals([ownerPubkey, 10000]).toArray();
	if (muteEvents.length > 0) {
		const winner = pickLatest(muteEvents);
		await runtime.reconcileMuteList(new Set(parseMuteListEvent(winner)), winner.created_at);
	}
}

export function decodePubkeyInput(input) {
	const trimmed = input.trim();
	if (/^[0-9a-f]{64}$/i.test(trimmed)) return trimmed.toLowerCase();
	const decoded = nip19Decode(trimmed);
	if (decoded.type !== "npub") {
		throw new Error("не похоже на npub или hex-ключ: " + decoded.type);
	}
	return decoded.data;
}

// Обратная совместимость с существующими вызывающими (discovery.jsx/settings.jsx
// зовут refreshContacts()/refreshAll() ПОСЛЕ ensureConnected() — к этому моменту
// runtime уже сконфигурирован внутри connect(), поэтому это просто пересчёт
// сигналов из уже загруженной Map, без обращения к Dexie).
export async function refreshContacts() {
	recomputeContactSignals();
}

export async function refreshAll() {
	recomputeContactSignals();
}

// --- Единая точка отправки заявки (этап 49 — полная унификация: раньше
// "Добавить контакт" (эта форма) и "Обзор" (discovery.js) были ДВУМЯ разными
// путями с разными побочными эффектами — источник обеих багов пользователя
// (дублирование, заявки не синхронизировались). greeting="" для потока "Обзор".
export async function sendContactRequestAction(peerPubkeyOrNpub, greeting = "") {
	const peer = decodePubkeyInput(peerPubkeyOrNpub);
	await requireRuntime().sendRequest(peer, greeting);
}

export async function acceptContactRequestAction(peer) {
	await requireRuntime().accept(peer);
}

export async function rejectContactRequestAction(peer) {
	await requireRuntime().reject(peer);
}

export async function cancelContactRequestAction(peer) {
	await requireRuntime().cancel(peer);
}

export async function blockContactAction(peerPubkeyOrNpub) {
	const peer = decodePubkeyInput(peerPubkeyOrNpub);
	await requireRuntime().block(peer);
}

export async function unblockContactAction(peerPubkeyOrNpub) {
	const peer = decodePubkeyInput(peerPubkeyOrNpub);
	await requireRuntime().unblock(peer);
}

export async function removeContactAction(peerPubkeyOrNpub) {
	const peer = decodePubkeyInput(peerPubkeyOrNpub);
	await requireRuntime().removeContact(peer);
}

// F-CT-04 — запрос профиля контакта. fetchProfilesFn инъецируется (по образцу publish) —
// реально transport.fetchProfiles, тесты дают stub. Пропускает уже закэшированные pubkey
// (в т.ч. null — "запрошен, не найден", не повторяет запрос бесконечно на каждый рендер).
export async function ensureProfilesFetched(pubkeys, fetchProfilesFn) {
	const missing = pubkeys.filter((pk) => !(pk in profiles.value));
	if (missing.length === 0) return;
	const fetched = await fetchProfilesFn(missing);
	const next = { ...profiles.value };
	for (const pk of missing) {
		next[pk] = fetched.get(pk) ?? null;
	}
	profiles.value = next;
}

// Найденный баг (пользователь, F-CT-04-довесок): ensureProfilesFetched пропускает уже
// закэшированные pubkey навсегда — обновление био/имени собеседником никогда не долетало
// до UI. refreshProfiles безусловно перезапрашивает переданные pubkey и перезаписывает
// кэш — вызывать в точках "открыт экран" (чат, список чатов), а не на каждый рендер.
export async function refreshProfiles(pubkeys, fetchProfilesFn) {
	if (pubkeys.length === 0) return;
	const fetched = await fetchProfilesFn(pubkeys);
	const next = { ...profiles.value };
	for (const pk of pubkeys) {
		next[pk] = fetched.get(pk) ?? null;
	}
	profiles.value = next;
}

// --- Группы (не затронуто этапом 49 — отдельная структура, kind 30050) ---

export async function refreshGroups(ownerPubkey, dbKey) {
	const groupRowsRaw = await db.table("groups").where("owner").equals(ownerPubkey).toArray();
	const groupRows = groupRowsRaw.map((g) => fromEncryptedRow(g, dbKey));
	const result = [];
	for (const g of groupRows) {
		const members = await db.table("groupMembers").where("groupId").equals(g.id).toArray();
		result.push({ id: g.id, name: g.name, memberPubkeys: members.map((m) => m.pubkey) });
	}
	groups.value = result;
}

async function requirePublishOk(publish, event) {
	const result = await publish(event);
	if (!result.ok) {
		throw new Error(result.reason || "relay отклонил публикацию");
	}
}

// Монотонный created_at по kind (только группы теперь — kind-3/kind-10000 обзавелись
// СВОИМ монотонным счётчиком внутри contact-runtime.js). См. обоснование там же —
// тот же класс коллизии (lww.js тай-брейкает по id, не связанному с реальным
// порядком публикации, при совпадении created_at в ту же wall-clock секунду).
const lastCreatedAtByKind = new Map();
function nextCreatedAt(kind) {
	const now = Math.floor(Date.now() / 1000);
	const value = Math.max(now, (lastCreatedAtByKind.get(kind) ?? 0) + 1);
	lastCreatedAtByKind.set(kind, value);
	return value;
}

export async function createGroupAction(ownerPubkey, privKey, dbKey, name, publish) {
	const groupId = crypto.randomUUID();
	const event = buildGroupEvent(privKey, { groupId, name, memberPubkeys: [] }, nextCreatedAt("group:" + groupId));
	await requirePublishOk(publish, event);
	await foldGroup(event, privKey, dbKey);
	await refreshGroups(ownerPubkey, dbKey);
}

function requireGroup(groupId) {
	const group = groups.value.find((g) => g.id === groupId);
	if (!group) throw new Error("группа не найдена: " + groupId);
	return { groupId: group.id, name: group.name, memberPubkeys: group.memberPubkeys };
}

export async function renameGroupAction(ownerPubkey, privKey, dbKey, groupId, newName, publish) {
	const updated = renameGroup(requireGroup(groupId), newName);
	const event = buildGroupEvent(privKey, updated, nextCreatedAt("group:" + groupId));
	await requirePublishOk(publish, event);
	await foldGroup(event, privKey, dbKey);
	await refreshGroups(ownerPubkey, dbKey);
}

export async function addGroupMemberAction(ownerPubkey, privKey, dbKey, groupId, pubkey, publish) {
	const updated = addMember(requireGroup(groupId), pubkey);
	const event = buildGroupEvent(privKey, updated, nextCreatedAt("group:" + groupId));
	await requirePublishOk(publish, event);
	await foldGroup(event, privKey, dbKey);
	await refreshGroups(ownerPubkey, dbKey);
}

export async function removeGroupMemberAction(ownerPubkey, privKey, dbKey, groupId, pubkey, publish) {
	const updated = removeMember(requireGroup(groupId), pubkey);
	const event = buildGroupEvent(privKey, updated, nextCreatedAt("group:" + groupId));
	await requirePublishOk(publish, event);
	await foldGroup(event, privKey, dbKey);
	// Этап 36 (DESIGN.md) — foldGroup уже обновил groupMembers (удалил pubkey из
	// groupId), значит проверка "виден ли ещё через другую группу" читает АКТУАЛЬНОЕ
	// состояние. Отзывает VIEW только если pubkey не виден каналу ни через одну
	// ДРУГУЮ группу, привязанную к нему при создании (F-CH-06).
	await revokeIfNoLongerVisible(ownerPubkey, privKey, dbKey, pubkey, groupId, publish);
	await refreshGroups(ownerPubkey, dbKey);
}

export async function deleteGroupAction(ownerPubkey, privKey, dbKey, groupId, publish) {
	const event = buildAddressableDeletionEvent(privKey, 30050, groupId);
	await requirePublishOk(publish, event);
	await db.transaction("rw", db.table("groups"), db.table("groupMembers"), async () => {
		await db.table("groups").delete([ownerPubkey, groupId]);
		await db.table("groupMembers").where("groupId").equals(groupId).delete();
	});
	await refreshGroups(ownerPubkey, dbKey);
}
