import { signal } from "@preact/signals";
import { db } from "../../core/store/database.js";
import { decode as nip19Decode } from "nostr-tools/nip19";
import { buildContactListEvent, buildMuteListEvent, addContact, removeContact } from "../../domain/contacts/contacts.js";
import { buildGroupEvent, addMember, removeMember, renameGroup } from "../../domain/contacts/groups.js";
import { foldContactList, foldMuteList, foldGroup, buildAddressableDeletionEvent } from "../../domain/events/handlers.js";

export const contacts = signal([]);
export const blockedContacts = signal([]);
export const groups = signal([]);
export const profiles = signal({}); // pubkey -> { name?, about?, picture? } | null (запрошен, но не найден)

export async function refreshContacts(ownerPubkey) {
	const rows = await db.table("contacts").where("owner").equals(ownerPubkey).toArray();
	contacts.value = rows.map((r) => r.pubkey);
}

export async function refreshBlockedContacts(ownerPubkey) {
	const rows = await db.table("blockedContacts").where("owner").equals(ownerPubkey).toArray();
	blockedContacts.value = rows.map((r) => r.pubkey);
}

export async function refreshGroups(ownerPubkey) {
	const groupRows = await db.table("groups").where("owner").equals(ownerPubkey).toArray();
	const result = [];
	for (const g of groupRows) {
		const members = await db.table("groupMembers").where("groupId").equals(g.id).toArray();
		result.push({ id: g.id, name: g.name, memberPubkeys: members.map((m) => m.pubkey) });
	}
	groups.value = result;
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

export async function refreshAll(ownerPubkey) {
	await Promise.all([refreshContacts(ownerPubkey), refreshBlockedContacts(ownerPubkey), refreshGroups(ownerPubkey)]);
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

async function requirePublishOk(publish, event) {
	const result = await publish(event);
	if (!result.ok) {
		throw new Error(result.reason || "relay отклонил публикацию");
	}
}

export async function addContactAction(ownerPubkey, privKey, npubOrHex, publish) {
	const pubkeyToAdd = decodePubkeyInput(npubOrHex);
	const updated = addContact(contacts.value, pubkeyToAdd);
	const event = buildContactListEvent(privKey, updated);
	await requirePublishOk(publish, event);
	await foldContactList(event);
	await refreshContacts(ownerPubkey);
}

export async function removeContactAction(ownerPubkey, privKey, pubkeyToRemove, publish) {
	const updated = removeContact(contacts.value, pubkeyToRemove);
	const event = buildContactListEvent(privKey, updated);
	await requirePublishOk(publish, event);
	await foldContactList(event);
	await refreshContacts(ownerPubkey);
}

export async function blockContactAction(ownerPubkey, privKey, npubOrHex, publish) {
	const pubkeyToBlock = decodePubkeyInput(npubOrHex);
	const updated = addContact(blockedContacts.value, pubkeyToBlock);
	const event = buildMuteListEvent(privKey, updated);
	await requirePublishOk(publish, event);
	await foldMuteList(event);
	await refreshBlockedContacts(ownerPubkey);
}

export async function unblockContactAction(ownerPubkey, privKey, npubOrHex, publish) {
	const pubkeyToUnblock = decodePubkeyInput(npubOrHex);
	const updated = removeContact(blockedContacts.value, pubkeyToUnblock);
	const event = buildMuteListEvent(privKey, updated);
	await requirePublishOk(publish, event);
	await foldMuteList(event);
	await refreshBlockedContacts(ownerPubkey);
}

export async function createGroupAction(ownerPubkey, privKey, name, publish) {
	const groupId = crypto.randomUUID();
	const event = buildGroupEvent(privKey, { groupId, name, memberPubkeys: [] });
	await requirePublishOk(publish, event);
	await foldGroup(event, privKey);
	await refreshGroups(ownerPubkey);
}

function requireGroup(groupId) {
	const group = groups.value.find((g) => g.id === groupId);
	if (!group) throw new Error("группа не найдена: " + groupId);
	return { groupId: group.id, name: group.name, memberPubkeys: group.memberPubkeys };
}

export async function renameGroupAction(ownerPubkey, privKey, groupId, newName, publish) {
	const updated = renameGroup(requireGroup(groupId), newName);
	const event = buildGroupEvent(privKey, updated);
	await requirePublishOk(publish, event);
	await foldGroup(event, privKey);
	await refreshGroups(ownerPubkey);
}

export async function addGroupMemberAction(ownerPubkey, privKey, groupId, pubkey, publish) {
	const updated = addMember(requireGroup(groupId), pubkey);
	const event = buildGroupEvent(privKey, updated);
	await requirePublishOk(publish, event);
	await foldGroup(event, privKey);
	await refreshGroups(ownerPubkey);
}

export async function removeGroupMemberAction(ownerPubkey, privKey, groupId, pubkey, publish) {
	const updated = removeMember(requireGroup(groupId), pubkey);
	const event = buildGroupEvent(privKey, updated);
	await requirePublishOk(publish, event);
	await foldGroup(event, privKey);
	await refreshGroups(ownerPubkey);
}

export async function deleteGroupAction(ownerPubkey, privKey, groupId, publish) {
	const event = buildAddressableDeletionEvent(privKey, 30050, groupId);
	await requirePublishOk(publish, event);
	await db.transaction("rw", db.table("groups"), db.table("groupMembers"), async () => {
		await db.table("groups").delete([ownerPubkey, groupId]);
		await db.table("groupMembers").where("groupId").equals(groupId).delete();
	});
	await refreshGroups(ownerPubkey);
}
