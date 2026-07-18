import "fake-indexeddb/auto";
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { db } from "../src/core/store/database.js";
import { getPublicKey } from "../src/core/crypto/keys.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { npubEncode, nsecEncode } from "nostr-tools/nip19";
import {
	contacts,
	blockedContacts,
	groups,
	refreshContacts,
	refreshBlockedContacts,
	refreshGroups,
	refreshAll,
	decodePubkeyInput,
	addContactAction,
	removeContactAction,
	blockContactAction,
	unblockContactAction,
	createGroupAction,
	renameGroupAction,
	addGroupMemberAction,
	removeGroupMemberAction,
	deleteGroupAction,
} from "../src/ui/signals/contacts.js";

const PRIV_KEY = new Uint8Array(32).fill(5);
const OWNER_PUBKEY = bytesToHex(getPublicKey(PRIV_KEY));

const okPublish = async () => ({ ok: true });
const failPublish = async () => ({ ok: false, reason: "relay отклонил" });

before(async () => {
	await db.open();
});

beforeEach(async () => {
	contacts.value = [];
	blockedContacts.value = [];
	groups.value = [];
	await db.table("contacts").clear();
	await db.table("blockedContacts").clear();
	await db.table("groups").clear();
	await db.table("groupMembers").clear();
	await db.table("events").clear();
});

after(() => {
	db.close();
});

test("decodePubkeyInput: 64-hex строка проходит как есть (lowercase)", () => {
	const hex = "AB".repeat(32);
	assert.equal(decodePubkeyInput(hex), hex.toLowerCase());
});

test("decodePubkeyInput: npub декодируется в hex", () => {
	const pubBytes = getPublicKey(PRIV_KEY);
	const npub = npubEncode(bytesToHex(pubBytes));
	assert.equal(decodePubkeyInput(npub), bytesToHex(pubBytes));
});

test("decodePubkeyInput: мусорная строка -> throw", () => {
	assert.throws(() => decodePubkeyInput("не-ключ-и-не-npub"));
});

test("decodePubkeyInput: nsec (валидный bech32, но не npub) -> throw", () => {
	const nsec = nsecEncode(PRIV_KEY);
	assert.throws(() => decodePubkeyInput(nsec));
});

const ALICE_PK = "a".repeat(64);
const BOB_PK = "b".repeat(64);
const EVIL_PK = "e".repeat(64);

test("addContactAction: publish ok -> фолдит локально и обновляет сигнал contacts", async () => {
	await addContactAction(OWNER_PUBKEY, PRIV_KEY, ALICE_PK, okPublish);
	assert.deepEqual(contacts.value, [ALICE_PK]);
	const rows = await db.table("contacts").where("owner").equals(OWNER_PUBKEY).toArray();
	assert.deepEqual(rows.map((r) => r.pubkey), [ALICE_PK]);
});

test("addContactAction: publish fail -> НЕ фолдит, НЕ обновляет сигнал, бросает", async () => {
	await refreshContacts(OWNER_PUBKEY);
	const before = contacts.value;
	await assert.rejects(() => addContactAction(OWNER_PUBKEY, PRIV_KEY, ALICE_PK, failPublish));
	assert.deepEqual(contacts.value, before);
	const rows = await db.table("contacts").where("owner").equals(OWNER_PUBKEY).toArray();
	assert.equal(rows.length, 0);
});

test("addContactAction: принимает npub, декодирует перед сборкой события", async () => {
	const otherPriv = new Uint8Array(32).fill(9);
	const otherPub = bytesToHex(getPublicKey(otherPriv));
	const npub = npubEncode(otherPub);
	await addContactAction(OWNER_PUBKEY, PRIV_KEY, npub, okPublish);
	assert.deepEqual(contacts.value, [otherPub]);
});

test("removeContactAction: удаляет контакт и переиздаёт список", async () => {
	await addContactAction(OWNER_PUBKEY, PRIV_KEY, ALICE_PK, okPublish);
	await addContactAction(OWNER_PUBKEY, PRIV_KEY, BOB_PK, okPublish);
	await removeContactAction(OWNER_PUBKEY, PRIV_KEY, ALICE_PK, okPublish);
	assert.deepEqual(contacts.value, [BOB_PK]);
});

test("blockContactAction/unblockContactAction: обновляют blockedContacts", async () => {
	await blockContactAction(OWNER_PUBKEY, PRIV_KEY, EVIL_PK, okPublish);
	assert.deepEqual(blockedContacts.value, [EVIL_PK]);
	await unblockContactAction(OWNER_PUBKEY, PRIV_KEY, EVIL_PK, okPublish);
	assert.deepEqual(blockedContacts.value, []);
});

test("createGroupAction: создаёт группу, обновляет groups сигнал", async () => {
	await createGroupAction(OWNER_PUBKEY, PRIV_KEY, "Друзья", okPublish);
	assert.equal(groups.value.length, 1);
	assert.equal(groups.value[0].name, "Друзья");
	assert.deepEqual(groups.value[0].memberPubkeys, []);
});

test("renameGroupAction/addGroupMemberAction/removeGroupMemberAction: полный цикл редактирования", async () => {
	await createGroupAction(OWNER_PUBKEY, PRIV_KEY, "Старое имя", okPublish);
	const groupId = groups.value[0].id;

	await renameGroupAction(OWNER_PUBKEY, PRIV_KEY, groupId, "Новое имя", okPublish);
	assert.equal(groups.value.find((g) => g.id === groupId).name, "Новое имя");

	await addGroupMemberAction(OWNER_PUBKEY, PRIV_KEY, groupId, "alice-pk", okPublish);
	assert.deepEqual(groups.value.find((g) => g.id === groupId).memberPubkeys, ["alice-pk"]);

	await removeGroupMemberAction(OWNER_PUBKEY, PRIV_KEY, groupId, "alice-pk", okPublish);
	assert.deepEqual(groups.value.find((g) => g.id === groupId).memberPubkeys, []);
});

test("deleteGroupAction: группа исчезает из groups сигнала и из БД", async () => {
	await createGroupAction(OWNER_PUBKEY, PRIV_KEY, "Временная", okPublish);
	const groupId = groups.value[0].id;

	await deleteGroupAction(OWNER_PUBKEY, PRIV_KEY, groupId, okPublish);

	assert.equal(groups.value.find((g) => g.id === groupId), undefined);
	assert.equal(await db.table("groups").get([OWNER_PUBKEY, groupId]), undefined);
});

test("F-GR-02 через UI-действия: один pubkey в нескольких группах одновременно", async () => {
	await createGroupAction(OWNER_PUBKEY, PRIV_KEY, "Друзья", okPublish);
	await createGroupAction(OWNER_PUBKEY, PRIV_KEY, "Работа", okPublish);
	const [g1, g2] = groups.value;
	await addGroupMemberAction(OWNER_PUBKEY, PRIV_KEY, g1.id, "shared-pk", okPublish);
	await addGroupMemberAction(OWNER_PUBKEY, PRIV_KEY, g2.id, "shared-pk", okPublish);

	assert.ok(groups.value.find((g) => g.id === g1.id).memberPubkeys.includes("shared-pk"));
	assert.ok(groups.value.find((g) => g.id === g2.id).memberPubkeys.includes("shared-pk"));
});

test("refreshAll: подтягивает все три сигнала параллельно из БД без действий", async () => {
	await db.table("contacts").add({ owner: OWNER_PUBKEY, pubkey: "x" });
	await db.table("blockedContacts").add({ owner: OWNER_PUBKEY, pubkey: "y" });
	await db.table("groups").add({ owner: OWNER_PUBKEY, id: "g1", name: "Z" });
	await db.table("groupMembers").add({ groupId: "g1", pubkey: "z" });

	await refreshAll(OWNER_PUBKEY);

	assert.deepEqual(contacts.value, ["x"]);
	assert.deepEqual(blockedContacts.value, ["y"]);
	assert.deepEqual(groups.value, [{ id: "g1", name: "Z", memberPubkeys: ["z"] }]);
});
