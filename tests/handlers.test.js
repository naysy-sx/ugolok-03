import "fake-indexeddb/auto";
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { db } from "../src/core/store/database.js";
import { getPublicKey } from "../src/core/crypto/keys.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { buildContactListEvent, buildMuteListEvent } from "../src/domain/contacts/contacts.js";
import { buildGroupEvent } from "../src/domain/contacts/groups.js";
import { ACTIONS } from "../src/domain/auth/bitset.js";
import {
	foldContactList,
	foldMuteList,
	foldGroup,
	buildPermissionEvent,
	parsePermissionEvent,
	rebuildEffectivePermissions,
	validateDeletion,
} from "../src/domain/events/handlers.js";

const PRIV_KEY = new Uint8Array(32).fill(3);
const OWNER_PUBKEY = bytesToHex(getPublicKey(PRIV_KEY));

before(async () => {
	await db.open();
});

beforeEach(async () => {
	await db.table("contacts").clear();
	await db.table("blockedContacts").clear();
	await db.table("groups").clear();
	await db.table("groupMembers").clear();
	await db.table("effectivePerms").clear();
	await db.table("events").clear();
});

after(() => {
	db.close();
});

test("foldContactList: записывает строки {owner, pubkey} для каждого контакта", async () => {
	const event = buildContactListEvent(PRIV_KEY, ["alice", "bob"]);
	await foldContactList(event);
	const rows = await db.table("contacts").where("owner").equals(OWNER_PUBKEY).toArray();
	assert.deepEqual(rows.map((r) => r.pubkey).sort(), ["alice", "bob"]);
});

test("foldContactList: повторный fold с новым списком полностью замещает старый (replaceable)", async () => {
	await foldContactList(buildContactListEvent(PRIV_KEY, ["alice", "bob"]));
	await foldContactList(buildContactListEvent(PRIV_KEY, ["carol"]));
	const rows = await db.table("contacts").where("owner").equals(OWNER_PUBKEY).toArray();
	assert.deepEqual(rows.map((r) => r.pubkey), ["carol"]);
});

test("foldMuteList: записывает строки {owner, pubkey} для заблокированных", async () => {
	const event = buildMuteListEvent(PRIV_KEY, ["evil-pk"]);
	await foldMuteList(event);
	const rows = await db.table("blockedContacts").where("owner").equals(OWNER_PUBKEY).toArray();
	assert.deepEqual(rows.map((r) => r.pubkey), ["evil-pk"]);
});

test("foldGroup: upsert в db.groups + замена db.groupMembers", async () => {
	const event = buildGroupEvent(PRIV_KEY, { groupId: "g1", name: "Друзья", memberPubkeys: ["alice", "bob"] });
	await foldGroup(event, PRIV_KEY);
	const group = await db.table("groups").get([OWNER_PUBKEY, "g1"]);
	assert.equal(group.name, "Друзья");
	const members = await db.table("groupMembers").where("groupId").equals("g1").toArray();
	assert.deepEqual(members.map((m) => m.pubkey).sort(), ["alice", "bob"]);
});

test("foldGroup: повторный fold с новым составом полностью замещает членство", async () => {
	await foldGroup(buildGroupEvent(PRIV_KEY, { groupId: "g1", name: "Друзья", memberPubkeys: ["alice", "bob"] }), PRIV_KEY);
	await foldGroup(buildGroupEvent(PRIV_KEY, { groupId: "g1", name: "Друзья", memberPubkeys: ["carol"] }), PRIV_KEY);
	const members = await db.table("groupMembers").where("groupId").equals("g1").toArray();
	assert.deepEqual(members.map((m) => m.pubkey), ["carol"]);
});

test("buildPermissionEvent/parsePermissionEvent: round-trip (kind 5051, self-encrypt)", () => {
	const event = buildPermissionEvent(PRIV_KEY, {
		subject: "alice-pk",
		resource: "channel-1",
		allowMask: ACTIONS.VIEW | ACTIONS.COMMENT,
		denyMask: 0,
		lamportTs: 5,
	});
	assert.equal(event.kind, 5051);
	const parsed = parsePermissionEvent(event, PRIV_KEY);
	assert.deepEqual(parsed, { subject: "alice-pk", resource: "channel-1", allowMask: ACTIONS.VIEW | ACTIONS.COMMENT, denyMask: 0, lamportTs: 5 });
});

test("критерий PLAN.md через ПОЛНУЮ цепочку: build -> store -> rebuildEffectivePermissions -> effectivePerms", async () => {
	const grant = buildPermissionEvent(PRIV_KEY, {
		subject: "alice-pk",
		resource: "channel-1",
		allowMask: ACTIONS.VIEW | ACTIONS.COMMENT,
		denyMask: 0,
		lamportTs: 1,
	});
	const revokeComment = buildPermissionEvent(PRIV_KEY, {
		subject: "alice-pk",
		resource: "channel-1",
		allowMask: 0,
		denyMask: ACTIONS.COMMENT,
		lamportTs: 2,
	});
	await db.table("events").add({ ...grant, flatTags: [] });
	await db.table("events").add({ ...revokeComment, flatTags: [] });

	await rebuildEffectivePermissions(OWNER_PUBKEY, PRIV_KEY);

	const row = await db.table("effectivePerms").get([OWNER_PUBKEY, "alice-pk", "channel-1"]);
	assert.equal(row.mask, ACTIONS.VIEW);
});

test("rebuildEffectivePermissions: повторный вызов замещает старый кэш owner'а, не аккумулирует", async () => {
	const first = buildPermissionEvent(PRIV_KEY, { subject: "alice-pk", resource: "r1", allowMask: ACTIONS.VIEW, lamportTs: 1 });
	await db.table("events").add({ ...first, flatTags: [] });
	await rebuildEffectivePermissions(OWNER_PUBKEY, PRIV_KEY);

	await db.table("events").clear();
	const second = buildPermissionEvent(PRIV_KEY, { subject: "bob-pk", resource: "r2", allowMask: ACTIONS.ADMIN, lamportTs: 1 });
	await db.table("events").add({ ...second, flatTags: [] });
	await rebuildEffectivePermissions(OWNER_PUBKEY, PRIV_KEY);

	const aliceRow = await db.table("effectivePerms").get([OWNER_PUBKEY, "alice-pk", "r1"]);
	const bobRow = await db.table("effectivePerms").get([OWNER_PUBKEY, "bob-pk", "r2"]);
	assert.equal(aliceRow, undefined);
	assert.equal(bobRow.mask, ACTIONS.ADMIN);
});

test("validateDeletion (AC-17): автор удаляет своё событие -> true", () => {
	const target = { id: "target-1", pubkey: "author-pk" };
	const del = { kind: 5, pubkey: "author-pk" };
	assert.equal(validateDeletion(del, target), true);
});

test("validateDeletion (AC-17): чужое kind 5 на чужой ивент -> false", () => {
	const target = { id: "target-1", pubkey: "author-pk" };
	const del = { kind: 5, pubkey: "someone-else-pk" };
	assert.equal(validateDeletion(del, target), false);
});
