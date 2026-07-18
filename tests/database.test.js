import "fake-indexeddb/auto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { db } from "../src/core/store/database.js";

const EXPECTED_TABLES = [
	"events",
	"contacts",
	"blockedContacts",
	"groups",
	"groupMembers",
	"permissions",
	"effectivePerms",
	"channelKeys",
	"channelKeyMeta",
	"channelTopics",
	"commentAllowlists",
	"messages",
	"channels",
	"posts",
	"comments",
	"attachments",
	"keystore",
	"clock",
	"syncState",
	"chatSyncState",
	"channelSyncState",
	"outbox",
	"inboxRequests",
	"deletions",
	"mlsGroups",
	"ownKeyPackage",
	"contactRequests",
	"deviceIdentity",
	"knownDevices",
];

test("схема Dexie (раздел 10 TECH.md): все таблицы созданы", async () => {
	await db.open();
	const names = db.tables.map((t) => t.name);
	for (const name of EXPECTED_TABLES) {
		assert.ok(names.includes(name), `нет таблицы "${name}"`);
	}
	db.close();
});

test("events: первичный ключ seq (autoincrement), индексы id/[pubkey+kind]/created_at/*flatTags", async () => {
	await db.open();
	const events = db.table("events");
	assert.equal(events.schema.primKey.name, "seq");
	assert.ok(events.schema.primKey.auto, "seq должен быть autoincrement (++seq)");
	const indexNames = events.schema.indexes.map((i) => i.name);
	assert.ok(indexNames.includes("id"));
	assert.ok(indexNames.includes("created_at"));
	assert.ok(indexNames.includes("flatTags"));
	const flatTagsIdx = events.schema.indexes.find((i) => i.name === "flatTags");
	assert.ok(flatTagsIdx.multi, "flatTags должен быть multi-entry (*flatTags)");
	const compoundIdx = events.schema.indexes.find(
		(i) => Array.isArray(i.keyPath) && i.keyPath.join("+") === "pubkey+kind",
	);
	assert.ok(compoundIdx, "должен быть compound-индекс [pubkey+kind]");
	db.close();
});

test("messages (этап 25): unique compound-индекс [chatId+msgId] для upsertMessage", async () => {
	await db.open();
	const messages = db.table("messages");
	const uniqueIdx = messages.schema.indexes.find(
		(i) => Array.isArray(i.keyPath) && i.keyPath.join("+") === "chatId+msgId",
	);
	assert.ok(uniqueIdx, "должен быть compound-индекс [chatId+msgId]");
	assert.ok(uniqueIdx.unique, "индекс должен быть unique (& в Dexie-нотации)");
	const oldIdx = messages.schema.indexes.find(
		(i) => Array.isArray(i.keyPath) && i.keyPath.join("+") === "chatId+lamportTs+senderPubkey+id",
	);
	assert.ok(oldIdx, "старый неуникальный индекс с id не должен быть удалён");
	assert.ok(!oldIdx.unique, "старый индекс остаётся неуникальным");
	db.close();
});

test("inboxRequests (этап 25): owner-scoped составной первичный ключ (правка version(1)'s голого id)", async () => {
	await db.open();
	const inboxRequests = db.table("inboxRequests");
	assert.ok(
		Array.isArray(inboxRequests.schema.primKey.keyPath) &&
			inboxRequests.schema.primKey.keyPath.join("+") === "owner+senderPubkey",
		"inboxRequests: составной первичный ключ [owner+senderPubkey], не голый id",
	);
	db.close();
});

test("deviceIdentity/knownDevices (этап 25): первичные ключи схемы", async () => {
	await db.open();
	assert.equal(db.table("deviceIdentity").schema.primKey.name, "id");
	const knownDevices = db.table("knownDevices");
	assert.ok(
		Array.isArray(knownDevices.schema.primKey.keyPath) &&
			knownDevices.schema.primKey.keyPath.join("+") === "ownerPubkey+deviceId",
		"knownDevices: составной первичный ключ [ownerPubkey+deviceId]",
	);
	db.close();
});
