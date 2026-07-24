import "fake-indexeddb/auto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { db, resetLocalDatabase } from "../src/core/store/database.js";

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
	"channelMessages",
	"channelReaders",
	"channelReports",
	"channelIgnores",
	"bannedMembers",
	"uiSettings",
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
	"discoverySettings",
	"discoveryProfiles",
	"outgoingAcquaintanceRequests",
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

test("channelMessages (этап 32, owner-scoped с рождения): составной первичный ключ, индекс для windowed-загрузки чата", async () => {
	await db.open();
	const channelMessages = db.table("channelMessages");
	assert.ok(
		Array.isArray(channelMessages.schema.primKey.keyPath) && channelMessages.schema.primKey.keyPath.join("+") === "ownerPubkey+id",
		"channelMessages: составной первичный ключ [ownerPubkey+id]",
	);
	assert.ok(
		channelMessages.schema.indexes.some((i) => Array.isArray(i.keyPath) && i.keyPath.join("+") === "ownerPubkey+channelId+createdAt"),
		"channelMessages: индекс [ownerPubkey+channelId+createdAt] для windowed-загрузки чата канала",
	);
	db.close();
});

test("channelReaders/channelReports/channelIgnores/bannedMembers (этап 33): owner-scoped составные ключи", async () => {
	await db.open();
	const channelReaders = db.table("channelReaders");
	assert.ok(
		Array.isArray(channelReaders.schema.primKey.keyPath) && channelReaders.schema.primKey.keyPath.join("+") === "ownerPubkey+channelId+readerPubkey",
		"channelReaders: составной первичный ключ [ownerPubkey+channelId+readerPubkey]",
	);

	const channelReports = db.table("channelReports");
	assert.ok(
		Array.isArray(channelReports.schema.primKey.keyPath) && channelReports.schema.primKey.keyPath.join("+") === "ownerPubkey+id",
		"channelReports: составной первичный ключ [ownerPubkey+id]",
	);
	assert.ok(
		channelReports.schema.indexes.some((i) => Array.isArray(i.keyPath) && i.keyPath.join("+") === "ownerPubkey+channelId"),
		"channelReports: индекс [ownerPubkey+channelId]",
	);

	const channelIgnores = db.table("channelIgnores");
	assert.ok(
		Array.isArray(channelIgnores.schema.primKey.keyPath) && channelIgnores.schema.primKey.keyPath.join("+") === "ownerPubkey+channelId+ignoredPubkey",
		"channelIgnores: составной первичный ключ [ownerPubkey+channelId+ignoredPubkey]",
	);

	const bannedMembers = db.table("bannedMembers");
	assert.ok(
		Array.isArray(bannedMembers.schema.primKey.keyPath) && bannedMembers.schema.primKey.keyPath.join("+") === "ownerPubkey+channelId+pubkey",
		"bannedMembers: составной первичный ключ [ownerPubkey+channelId+pubkey]",
	);
	db.close();
});

test("uiSettings (этап 34): голый ownerPubkey как первичный ключ — сам по себе owner-scoped", async () => {
	await db.open();
	const uiSettings = db.table("uiSettings");
	assert.equal(uiSettings.schema.primKey.name, "ownerPubkey", "uiSettings: первичный ключ — сам ownerPubkey, не составной и не голый id");
	db.close();
});

// Найдено живым использованием (не юнит-тестом): реальный браузер с непустыми
// таблицами, чей primary key менялся между версиями (channels/posts/comments),
// падает на db.open() с UpgradeError "Not yet support for changing primary key" —
// Onboarding/Unlock зависали на "Проверка…" навсегда. resetLocalDatabase — способ
// восстановления (снести базу целиком, дев-стадия не подразумевает миграции).
// Тест — последний в файле: db.delete() уничтожает данные, следующие файлы
// запускаются в отдельном процессе node --test и не разделяют это состояние.
test("discoverySettings/discoveryProfiles/outgoingAcquaintanceRequests (этап 46): первичные ключи", async () => {
	await db.open();
	const discoverySettings = db.table("discoverySettings");
	assert.equal(discoverySettings.schema.primKey.keyPath, "ownerPubkey");

	const discoveryProfiles = db.table("discoveryProfiles");
	assert.equal(discoveryProfiles.schema.primKey.keyPath, "pubkey");

	const outgoingAcquaintanceRequests = db.table("outgoingAcquaintanceRequests");
	assert.ok(
		Array.isArray(outgoingAcquaintanceRequests.schema.primKey.keyPath) &&
			outgoingAcquaintanceRequests.schema.primKey.keyPath.join("+") === "owner+targetPubkey",
		"outgoingAcquaintanceRequests: составной первичный ключ [owner+targetPubkey]",
	);
	assert.ok(outgoingAcquaintanceRequests.schema.indexes.some((i) => i.name === "owner"));
	db.close();
});

test("channelSyncState (этап 47 — оживление мёртвой таблицы этапа 1): owner-scoped составной первичный ключ", async () => {
	await db.open();
	const channelSyncState = db.table("channelSyncState");
	assert.ok(
		Array.isArray(channelSyncState.schema.primKey.keyPath) &&
			channelSyncState.schema.primKey.keyPath.join("+") === "ownerPubkey+channelId",
		"channelSyncState: составной первичный ключ [ownerPubkey+channelId]",
	);
	db.close();
});

test("resetLocalDatabase: удаляет базу, повторный db.open() создаёт её заново с полной схемой", async () => {
	await db.open();
	db.close();
	await resetLocalDatabase();

	await db.open();
	const names = db.tables.map((t) => t.name);
	for (const name of EXPECTED_TABLES) {
		assert.ok(names.includes(name), `после сброса нет таблицы "${name}"`);
	}
	db.close();
});
