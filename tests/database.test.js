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

test("messages (этап 27, owner-scoping): unique compound-индекс [ownerPubkey+chatId+msgId] для upsertMessage", async () => {
	await db.open();
	const messages = db.table("messages");
	const uniqueIdx = messages.schema.indexes.find(
		(i) => Array.isArray(i.keyPath) && i.keyPath.join("+") === "ownerPubkey+chatId+msgId",
	);
	assert.ok(uniqueIdx, "должен быть compound-индекс [ownerPubkey+chatId+msgId]");
	assert.ok(uniqueIdx.unique, "индекс должен быть unique (& в Dexie-нотации)");
	const oldIdx = messages.schema.indexes.find(
		(i) => Array.isArray(i.keyPath) && i.keyPath.join("+") === "ownerPubkey+chatId+lamportTs+senderPubkey+id",
	);
	assert.ok(oldIdx, "сортировочный индекс должен быть тоже owner-scoped");
	assert.ok(!oldIdx.unique, "сортировочный индекс остаётся неуникальным");
	db.close();
});

test("mlsGroups/ownKeyPackage/chatSyncState (этап 27, owner-scoping — критическая находка мультиаккаунта): составные/owner-based первичные ключи", async () => {
	await db.open();
	assert.equal(db.table("ownKeyPackage").schema.primKey.name, "ownerPubkey", "ownKeyPackage: ключ = сам ownerPubkey, не голый 'self'");
	const mlsGroups = db.table("mlsGroups");
	assert.ok(
		Array.isArray(mlsGroups.schema.primKey.keyPath) && mlsGroups.schema.primKey.keyPath.join("+") === "ownerPubkey+groupId",
		"mlsGroups: составной первичный ключ [ownerPubkey+groupId]",
	);
	const chatSyncState = db.table("chatSyncState");
	assert.ok(
		Array.isArray(chatSyncState.schema.primKey.keyPath) && chatSyncState.schema.primKey.keyPath.join("+") === "ownerPubkey+chatId",
		"chatSyncState: составной первичный ключ [ownerPubkey+chatId]",
	);
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

test("channels/channelKeys/channelKeyMeta/commentAllowlists (этап 30, owner-scoping — найдено рассуждением до кода): составные owner-scoped ключи, channelTopics больше не отдельная таблица", async () => {
	await db.open();
	const names = db.tables.map((t) => t.name);
	assert.ok(!names.includes("channelTopics"), "channelTopics свёрнута в channels.channelTopic, отдельной таблицы больше нет");

	const channels = db.table("channels");
	assert.ok(
		Array.isArray(channels.schema.primKey.keyPath) && channels.schema.primKey.keyPath.join("+") === "ownerPubkey+id",
		"channels: составной первичный ключ [ownerPubkey+id]",
	);
	assert.ok(
		channels.schema.indexes.some((i) => i.name === "channelTopic"),
		"channels: индекс channelTopic для обратного поиска (topic -> канал)",
	);

	const channelKeys = db.table("channelKeys");
	assert.ok(
		Array.isArray(channelKeys.schema.primKey.keyPath) &&
			channelKeys.schema.primKey.keyPath.join("+") === "ownerPubkey+channelId+keyVersion",
		"channelKeys: составной первичный ключ [ownerPubkey+channelId+keyVersion]",
	);

	const channelKeyMeta = db.table("channelKeyMeta");
	assert.ok(
		Array.isArray(channelKeyMeta.schema.primKey.keyPath) &&
			channelKeyMeta.schema.primKey.keyPath.join("+") === "ownerPubkey+channelId",
		"channelKeyMeta: составной первичный ключ [ownerPubkey+channelId]",
	);

	const commentAllowlists = db.table("commentAllowlists");
	assert.ok(
		Array.isArray(commentAllowlists.schema.primKey.keyPath) &&
			commentAllowlists.schema.primKey.keyPath.join("+") === "ownerPubkey+channelId+keyVersion",
		"commentAllowlists: составной первичный ключ [ownerPubkey+channelId+keyVersion]",
	);
	db.close();
});

test("posts/comments (этап 31, owner-scoping — найдено рассуждением до кода): составные owner-scoped ключи", async () => {
	await db.open();
	const posts = db.table("posts");
	assert.ok(
		Array.isArray(posts.schema.primKey.keyPath) && posts.schema.primKey.keyPath.join("+") === "ownerPubkey+id",
		"posts: составной первичный ключ [ownerPubkey+id]",
	);
	assert.ok(
		posts.schema.indexes.some((i) => Array.isArray(i.keyPath) && i.keyPath.join("+") === "ownerPubkey+channelId+createdAt"),
		"posts: индекс [ownerPubkey+channelId+createdAt] для windowed-загрузки ленты",
	);

	const comments = db.table("comments");
	assert.ok(
		Array.isArray(comments.schema.primKey.keyPath) && comments.schema.primKey.keyPath.join("+") === "ownerPubkey+id",
		"comments: составной первичный ключ [ownerPubkey+id]",
	);
	assert.ok(
		comments.schema.indexes.some((i) => Array.isArray(i.keyPath) && i.keyPath.join("+") === "ownerPubkey+postId"),
		"comments: индекс [ownerPubkey+postId] для выборки дерева комментариев поста",
	);
	db.close();
});
