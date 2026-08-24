import "fake-indexeddb/auto";
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { db } from "../src/core/store/database.js";
import { writeJournalEntry } from "../src/domain/notifications/journal.js";
import { journalEntries, refreshJournal, openJournalEntry, markAllRead, markOneRead } from "../src/ui/signals/journal.js";
import { pendingNavTarget } from "../src/ui/signals/notification-nav.js";

const OWNER_PUBKEY = "a".repeat(64);
const DB_KEY = crypto.getRandomValues(new Uint8Array(32));

before(async () => {
	await db.open();
});

beforeEach(async () => {
	journalEntries.value = [];
	pendingNavTarget.value = null;
	await db.table("journalEntries").clear();
});

after(() => {
	db.close();
});

test("refreshJournal: заполняет сигнал из БД", async () => {
	await writeJournalEntry(OWNER_PUBKEY, DB_KEY, { category: "messages", title: "t1", body: "", navTarget: { screen: "messages" } });
	await refreshJournal(OWNER_PUBKEY, DB_KEY);
	assert.equal(journalEntries.value.length, 1);
	assert.equal(journalEntries.value[0].title, "t1");
});

test("openJournalEntry: непрочитанная запись -> помечает read, обновляет сигнал, навигирует", async () => {
	const entry = await writeJournalEntry(OWNER_PUBKEY, DB_KEY, {
		category: "channels",
		title: "пост",
		body: "",
		navTarget: { screen: "channels", channelId: "c1", subTab: "posts" },
	});
	await refreshJournal(OWNER_PUBKEY, DB_KEY);
	assert.equal(journalEntries.value[0].read, false);

	await openJournalEntry(OWNER_PUBKEY, DB_KEY, entry);

	assert.equal(journalEntries.value[0].read, true, "сигнал должен перечитаться после markRead");
	assert.deepEqual(pendingNavTarget.value, { screen: "channels", channelId: "c1", subTab: "posts" });
});

test("openJournalEntry: уже прочитанная запись — не трогает read повторно, но всё равно навигирует", async () => {
	const entry = await writeJournalEntry(OWNER_PUBKEY, DB_KEY, { category: "messages", title: "t", body: "", navTarget: { screen: "messages", contactPubkey: "bob" } });
	await refreshJournal(OWNER_PUBKEY, DB_KEY);
	await openJournalEntry(OWNER_PUBKEY, DB_KEY, journalEntries.value[0]);
	pendingNavTarget.value = null;

	await openJournalEntry(OWNER_PUBKEY, DB_KEY, { ...journalEntries.value[0], read: true });

	assert.deepEqual(pendingNavTarget.value, { screen: "messages", contactPubkey: "bob" });
});

test("markAllRead: помечает все записи прочитанными и обновляет сигнал", async () => {
	await writeJournalEntry(OWNER_PUBKEY, DB_KEY, { category: "messages", title: "1", body: "", navTarget: {} });
	await writeJournalEntry(OWNER_PUBKEY, DB_KEY, { category: "channels", title: "2", body: "", navTarget: {} });
	await refreshJournal(OWNER_PUBKEY, DB_KEY);
	assert.ok(journalEntries.value.some((e) => !e.read));

	await markAllRead(OWNER_PUBKEY, DB_KEY);

	assert.ok(journalEntries.value.every((e) => e.read === true));
});

test("markOneRead: помечает одну запись прочитанной, остальные не трогает", async () => {
	const a = await writeJournalEntry(OWNER_PUBKEY, DB_KEY, { category: "messages", title: "a", body: "", navTarget: { screen: "messages" } });
	await writeJournalEntry(OWNER_PUBKEY, DB_KEY, { category: "calls", title: "b", body: "", navTarget: { screen: "messages" } });
	await refreshJournal(OWNER_PUBKEY, DB_KEY);

	await markOneRead(OWNER_PUBKEY, DB_KEY, a.id);

	const byId = Object.fromEntries(journalEntries.value.map((e) => [e.id, e]));
	assert.equal(byId[a.id].read, true);
	assert.equal(journalEntries.value.filter((e) => !e.read).length, 1);
});

test("markOneRead: не выполняет навигацию (в отличие от openJournalEntry)", async () => {
	const entry = await writeJournalEntry(OWNER_PUBKEY, DB_KEY, { category: "messages", title: "a", body: "", navTarget: { screen: "messages" } });
	await refreshJournal(OWNER_PUBKEY, DB_KEY);

	await markOneRead(OWNER_PUBKEY, DB_KEY, entry.id);

	assert.equal(pendingNavTarget.value, null);
});
