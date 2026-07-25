import "fake-indexeddb/auto";
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { db } from "../src/core/store/database.js";
import { writeJournalEntry, listJournalEntries, markJournalEntryRead, markAllJournalEntriesRead, notifyAndLog } from "../src/domain/notifications/journal.js";
import { DEFAULT_SETTINGS } from "../src/domain/settings/ui-settings.js";

const OWNER_PUBKEY = "a".repeat(64);
const OTHER_OWNER = "b".repeat(64);
const DB_KEY = crypto.getRandomValues(new Uint8Array(32));

function fakeBackend() {
	const popups = [];
	let soundPlays = 0;
	return {
		backend: {
			showPopup: (title, body, onClick) => popups.push({ title, body, onClick }),
			playSound: () => {
				soundPlays++;
			},
			setBadgeCount: () => {},
		},
		popups,
		getSoundPlays: () => soundPlays,
	};
}

before(async () => {
	await db.open();
});

beforeEach(async () => {
	await db.table("journalEntries").clear();
});

after(() => {
	db.close();
});

test("writeJournalEntry: пишет запись с сгенерированными id/createdAt, read=false по умолчанию", async () => {
	const entry = await writeJournalEntry(OWNER_PUBKEY, DB_KEY, {
		category: "messages",
		title: "Новое сообщение от Боба",
		body: "привет",
		navTarget: { screen: "messages", contactPubkey: "bob-pk" },
	});
	assert.equal(typeof entry.id, "string");
	assert.equal(typeof entry.createdAt, "number");
	assert.equal(entry.read, false);
	assert.equal(entry.owner, OWNER_PUBKEY);
});

test("writeJournalEntry: сырая запись в IndexedDB не содержит title/body/navTarget открытым текстом (AC-16)", async () => {
	const entry = await writeJournalEntry(OWNER_PUBKEY, DB_KEY, {
		category: "messages",
		title: "секретный заголовок",
		body: "секретное тело",
		navTarget: { screen: "messages", contactPubkey: "secret-pk" },
	});
	const raw = await db.table("journalEntries").get(entry.id);
	assert.equal(raw.id, entry.id);
	assert.equal(raw.owner, OWNER_PUBKEY);
	assert.equal("title" in raw, false);
	assert.equal("body" in raw, false);
	assert.equal("navTarget" in raw, false);
	assert.ok(raw.nonce instanceof Uint8Array);
	assert.ok(raw.ciphertext instanceof Uint8Array);
});

test("listJournalEntries: сортировка по occurredAt (не createdAt) — самое свежее СОБЫТИЕ первым", async () => {
	await writeJournalEntry(OWNER_PUBKEY, DB_KEY, { category: "messages", title: "первое", body: "", navTarget: { screen: "messages" } });
	await new Promise((r) => setTimeout(r, 5));
	await writeJournalEntry(OWNER_PUBKEY, DB_KEY, { category: "channels", title: "второе", body: "", navTarget: { screen: "channels" } });

	const list = await listJournalEntries(OWNER_PUBKEY, DB_KEY);
	assert.equal(list.length, 2);
	assert.equal(list[0].title, "второе", "свежее — первым");
	assert.equal(list[1].title, "первое");
});

// Этап 50-довесок (пользователь) — occurredAt (реальное время события) может
// РАСХОДИТЬСЯ с createdAt (когда устройство записало уведомление) — например,
// догнали историю после offline. Сортировка обязана идти по occurredAt.
test("listJournalEntries: occurredAt переопределяет порядок сортировки относительно createdAt", async () => {
	await writeJournalEntry(OWNER_PUBKEY, DB_KEY, { category: "messages", title: "записано первым, но событие СТАРОЕ", body: "", navTarget: {}, occurredAt: 1000 });
	await new Promise((r) => setTimeout(r, 5));
	await writeJournalEntry(OWNER_PUBKEY, DB_KEY, { category: "messages", title: "записано вторым, но событие НОВОЕ", body: "", navTarget: {}, occurredAt: 999999999999 });

	const list = await listJournalEntries(OWNER_PUBKEY, DB_KEY);
	assert.equal(list[0].title, "записано вторым, но событие НОВОЕ");
	assert.equal(list[1].title, "записано первым, но событие СТАРОЕ");
});

test("writeJournalEntry: occurredAt не передан -> по умолчанию равен createdAt", async () => {
	const entry = await writeJournalEntry(OWNER_PUBKEY, DB_KEY, { category: "calls", title: "звонок", body: "", navTarget: {} });
	assert.equal(entry.occurredAt, entry.createdAt);
});

test("writeJournalEntry: occurredAt передан явно -> сохраняется как есть, НЕ равен createdAt", async () => {
	const entry = await writeJournalEntry(OWNER_PUBKEY, DB_KEY, { category: "channels", title: "старый пост", body: "", navTarget: {}, occurredAt: 12345 });
	assert.equal(entry.occurredAt, 12345);
	assert.notEqual(entry.occurredAt, entry.createdAt);
});

test("listJournalEntries: owner-scoped — не видит чужие записи", async () => {
	await writeJournalEntry(OWNER_PUBKEY, DB_KEY, { category: "messages", title: "моё", body: "", navTarget: { screen: "messages" } });
	await writeJournalEntry(OTHER_OWNER, DB_KEY, { category: "messages", title: "чужое", body: "", navTarget: { screen: "messages" } });

	const list = await listJournalEntries(OWNER_PUBKEY, DB_KEY);
	assert.equal(list.length, 1);
	assert.equal(list[0].title, "моё");
});

test("markJournalEntryRead: помечает read=true, НЕ трогая зашифрованные поля", async () => {
	const entry = await writeJournalEntry(OWNER_PUBKEY, DB_KEY, {
		category: "messages",
		title: "заголовок",
		body: "тело",
		navTarget: { screen: "messages", contactPubkey: "x" },
	});
	await markJournalEntryRead(entry.id);

	const list = await listJournalEntries(OWNER_PUBKEY, DB_KEY);
	assert.equal(list[0].read, true);
	assert.equal(list[0].title, "заголовок", "заголовок должен остаться читаемым после update()");
	assert.deepEqual(list[0].navTarget, { screen: "messages", contactPubkey: "x" });
});

test("markAllJournalEntriesRead: помечает ВСЕ непрочитанные владельца, не трогает чужие", async () => {
	const e1 = await writeJournalEntry(OWNER_PUBKEY, DB_KEY, { category: "messages", title: "1", body: "", navTarget: {} });
	const e2 = await writeJournalEntry(OWNER_PUBKEY, DB_KEY, { category: "messages", title: "2", body: "", navTarget: {} });
	const other = await writeJournalEntry(OTHER_OWNER, DB_KEY, { category: "messages", title: "чужое", body: "", navTarget: {} });
	await markJournalEntryRead(e1.id); // уже прочитано — не должно сломаться от повторной пометки

	await markAllJournalEntriesRead(OWNER_PUBKEY, DB_KEY);

	const list = await listJournalEntries(OWNER_PUBKEY, DB_KEY);
	assert.ok(list.every((e) => e.read === true));
	const otherRaw = await db.table("journalEntries").get(other.id);
	assert.equal(otherRaw.read, false, "чужая запись не тронута");
});

test("markAllJournalEntriesRead: пустой журнал -> no-op, не бросает", async () => {
	await assert.doesNotReject(() => markAllJournalEntriesRead(OWNER_PUBKEY, DB_KEY));
});

// --- notifyAndLog: обёртка над notify() ---

test("notifyAndLog: level='off' -> ни backend, ни журнал не трогаются", async () => {
	const { backend, popups, getSoundPlays } = fakeBackend();
	const settings = { ...DEFAULT_SETTINGS, notifications: { ...DEFAULT_SETTINGS.notifications, enabled: false } };
	const level = await notifyAndLog(OWNER_PUBKEY, DB_KEY, settings, "messages", null, { title: "t", body: "b" }, "bob", backend);
	assert.equal(level, "off");
	assert.equal(popups.length, 0);
	assert.equal(getSoundPlays(), 0);
	assert.equal((await listJournalEntries(OWNER_PUBKEY, DB_KEY)).length, 0);
});

test("notifyAndLog: level!='off' -> backend сработал КАК И notify() раньше, И запись в Журнал появилась", async () => {
	const { backend, popups } = fakeBackend();
	const settings = {
		...DEFAULT_SETTINGS,
		notifications: { ...DEFAULT_SETTINGS.notifications, channels: { posts: "popup", comments: "popup", chat: "popup", overrides: {} } },
	};
	const navTarget = { screen: "channels", channelId: "chan-1", subTab: "posts" };
	const level = await notifyAndLog(
		OWNER_PUBKEY,
		DB_KEY,
		settings,
		"channels",
		"posts",
		{ title: "Новый пост", body: "текст поста", navTarget },
		"chan-1",
		backend,
	);
	assert.equal(level, "popup");
	assert.equal(popups.length, 1, "notify() отработал как раньше — тост показан");

	const list = await listJournalEntries(OWNER_PUBKEY, DB_KEY);
	assert.equal(list.length, 1);
	assert.equal(list[0].category, "channels");
	assert.equal(list[0].title, "Новый пост");
	assert.equal(list[0].body, "текст поста");
	assert.deepEqual(list[0].navTarget, navTarget);
	assert.equal(list[0].read, false);
});

test("notifyAndLog: onClick пробрасывается в backend как раньше (notify() не менялся)", async () => {
	const { backend, popups } = fakeBackend();
	const onClick = () => {};
	await notifyAndLog(OWNER_PUBKEY, DB_KEY, DEFAULT_SETTINGS, "messages", null, { title: "t", body: "b", onClick, navTarget: { screen: "messages" } }, "bob", backend);
	assert.equal(popups[0].onClick, onClick);
});

test("notifyAndLog: options.occurredAt пробрасывается в запись Журнала", async () => {
	const { backend } = fakeBackend();
	await notifyAndLog(
		OWNER_PUBKEY,
		DB_KEY,
		DEFAULT_SETTINGS,
		"messages",
		null,
		{ title: "старое сообщение", body: "", navTarget: { screen: "messages" }, occurredAt: 555 },
		"bob",
		backend,
	);
	const list = await listJournalEntries(OWNER_PUBKEY, DB_KEY);
	assert.equal(list[0].occurredAt, 555);
});

test("notifyAndLog: moderation/бан (level всегда 'sound', даже enabled=false) — тоже попадает в Журнал", async () => {
	const { backend } = fakeBackend();
	const settings = { ...DEFAULT_SETTINGS, notifications: { ...DEFAULT_SETTINGS.notifications, enabled: false } };
	await notifyAndLog(OWNER_PUBKEY, DB_KEY, settings, "moderation", "ban", { title: "Бан", body: "", navTarget: { screen: "channels", channelId: "c1" } }, null, backend);

	const list = await listJournalEntries(OWNER_PUBKEY, DB_KEY);
	assert.equal(list.length, 1);
	assert.equal(list[0].category, "moderation");
});
