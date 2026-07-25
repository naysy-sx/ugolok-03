import "fake-indexeddb/auto";
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { db } from "../src/core/store/database.js";
import { getPublicKey } from "../src/core/crypto/keys.js";
import { sign } from "../src/core/crypto/sign.js";
import { encrypt as nip44Encrypt } from "../src/core/crypto/nip44.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { buildGroupEvent } from "../src/domain/contacts/groups.js";
import { ACTIONS } from "../src/domain/auth/bitset.js";
import {
	foldGroup,
	buildPermissionEvent,
	parsePermissionEvent,
	rebuildEffectivePermissions,
	validateDeletion,
	buildAddressableDeletionEvent,
	rebuildGroups,
} from "../src/domain/events/handlers.js";
import { fromEncryptedRow } from "../src/core/store/encrypted-table.js";

const PRIV_KEY = new Uint8Array(32).fill(3);
const OWNER_PUBKEY = bytesToHex(getPublicKey(PRIV_KEY));
const DB_KEY = crypto.getRandomValues(new Uint8Array(32));

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

test("foldGroup: upsert в db.groups + замена db.groupMembers", async () => {
	const event = buildGroupEvent(PRIV_KEY, { groupId: "g1", name: "Друзья", memberPubkeys: ["alice", "bob"] });
	await foldGroup(event, PRIV_KEY, DB_KEY);
	const group = fromEncryptedRow(await db.table("groups").get([OWNER_PUBKEY, "g1"]), DB_KEY);
	assert.equal(group.name, "Друзья");
	const members = await db.table("groupMembers").where("groupId").equals("g1").toArray();
	assert.deepEqual(members.map((m) => m.pubkey).sort(), ["alice", "bob"]);
});

test("foldGroup: повторный fold с новым составом полностью замещает членство", async () => {
	await foldGroup(buildGroupEvent(PRIV_KEY, { groupId: "g1", name: "Друзья", memberPubkeys: ["alice", "bob"] }), PRIV_KEY, DB_KEY);
	await foldGroup(buildGroupEvent(PRIV_KEY, { groupId: "g1", name: "Друзья", memberPubkeys: ["carol"] }), PRIV_KEY, DB_KEY);
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

test("buildAddressableDeletionEvent: kind 5, a-тег в форме kind:pubkey:dtag", () => {
	const event = buildAddressableDeletionEvent(PRIV_KEY, 30050, "group-1");
	assert.equal(event.kind, 5);
	assert.deepEqual(event.tags, [["a", `30050:${OWNER_PUBKEY}:group-1`]]);
});

// Этап 50-довесок-2 — extraTags (нужен h-тег для удаления канала, чтобы попасть
// под фильтр channelContentSubscriber "#h": topics).
test("buildAddressableDeletionEvent: extraTags добавляются ПОСЛЕ a-тега, существующие вызовы (без 4-го аргумента) не меняются", () => {
	const event = buildAddressableDeletionEvent(PRIV_KEY, 30060, "chan-1", [["h", "topic-hex"]]);
	assert.deepEqual(event.tags, [["a", `30060:${OWNER_PUBKEY}:chan-1`], ["h", "topic-hex"]]);
});

function rawGroupEvent(privKey, { groupId, name, memberPubkeys }, createdAt) {
	const ownPubHex = bytesToHex(getPublicKey(privKey));
	const content = nip44Encrypt(JSON.stringify({ name, memberPubkeys }), privKey, ownPubHex);
	return sign({ kind: 30050, tags: [["d", groupId]], content, created_at: createdAt }, privKey);
}

test("rebuildGroups: несколько версий ОДНОГО d-tag, материализуется последняя", async () => {
	const older = rawGroupEvent(PRIV_KEY, { groupId: "g1", name: "Старое имя", memberPubkeys: ["a"] }, 1000);
	const newer = rawGroupEvent(PRIV_KEY, { groupId: "g1", name: "Новое имя", memberPubkeys: ["a", "b"] }, 2000);
	await db.table("events").add({ ...older, flatTags: [] });
	await db.table("events").add({ ...newer, flatTags: [] });

	await rebuildGroups(OWNER_PUBKEY, PRIV_KEY, DB_KEY);

	const group = fromEncryptedRow(await db.table("groups").get([OWNER_PUBKEY, "g1"]), DB_KEY);
	assert.equal(group.name, "Новое имя");
	const members = await db.table("groupMembers").where("groupId").equals("g1").toArray();
	assert.deepEqual(members.map((m) => m.pubkey).sort(), ["a", "b"]);
});

test("rebuildGroups: РАЗНЫЕ d-tag — независимые группы, не путаются", async () => {
	const g1 = rawGroupEvent(PRIV_KEY, { groupId: "g1", name: "Друзья", memberPubkeys: ["a"] }, 1000);
	const g2 = rawGroupEvent(PRIV_KEY, { groupId: "g2", name: "Работа", memberPubkeys: ["b"] }, 1000);
	await db.table("events").add({ ...g1, flatTags: [] });
	await db.table("events").add({ ...g2, flatTags: [] });

	await rebuildGroups(OWNER_PUBKEY, PRIV_KEY, DB_KEY);

	assert.equal(fromEncryptedRow(await db.table("groups").get([OWNER_PUBKEY, "g1"]), DB_KEY).name, "Друзья");
	assert.equal(fromEncryptedRow(await db.table("groups").get([OWNER_PUBKEY, "g2"]), DB_KEY).name, "Работа");
});

test("rebuildGroups: удалённая (a-тег) группа НЕ материализуется", async () => {
	const groupEvent = rawGroupEvent(PRIV_KEY, { groupId: "g-deleted", name: "Удалённая", memberPubkeys: ["a"] }, 1000);
	const deletionEvent = buildAddressableDeletionEvent(PRIV_KEY, 30050, "g-deleted");
	await db.table("events").add({ ...groupEvent, flatTags: [] });
	await db.table("events").add({ ...deletionEvent, flatTags: [] });

	await rebuildGroups(OWNER_PUBKEY, PRIV_KEY, DB_KEY);

	const group = await db.table("groups").get([OWNER_PUBKEY, "g-deleted"]);
	assert.equal(group, undefined);
});

test("rebuildGroups: группа, ранее смэтериализованная, а ПОТОМ удалённая — убирается при пересчёте", async () => {
	const groupEvent = rawGroupEvent(PRIV_KEY, { groupId: "g-to-delete", name: "Скоро удалю", memberPubkeys: ["a"] }, 1000);
	await db.table("events").add({ ...groupEvent, flatTags: [] });
	await rebuildGroups(OWNER_PUBKEY, PRIV_KEY, DB_KEY);
	assert.ok(await db.table("groups").get([OWNER_PUBKEY, "g-to-delete"]));

	const deletionEvent = buildAddressableDeletionEvent(PRIV_KEY, 30050, "g-to-delete");
	await db.table("events").add({ ...deletionEvent, flatTags: [] });
	await rebuildGroups(OWNER_PUBKEY, PRIV_KEY, DB_KEY);

	assert.equal(await db.table("groups").get([OWNER_PUBKEY, "g-to-delete"]), undefined);
	const members = await db.table("groupMembers").where("groupId").equals("g-to-delete").toArray();
	assert.equal(members.length, 0);
});
