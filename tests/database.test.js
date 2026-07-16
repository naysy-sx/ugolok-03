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
