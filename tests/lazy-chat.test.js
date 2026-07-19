import "fake-indexeddb/auto";
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { db } from "../src/core/store/database.js";
import { getPublicKey } from "../src/core/crypto/keys.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { loadChatWindow, markWindowLoaded } from "../src/core/sync/lazy-chat.js";
import { toEncryptedRow } from "../src/core/store/encrypted-table.js";
import { MESSAGES_PLAINTEXT_FIELDS } from "../src/core/store/table-fields.js";
import { buildDeletionText } from "../src/domain/messaging/deletions.js";
import { buildEditText } from "../src/domain/messaging/edits.js";

const BOB_PUB = bytesToHex(getPublicKey(new Uint8Array(32).fill(2)));
const ALICE_PUB = bytesToHex(getPublicKey(new Uint8Array(32).fill(1)));
const DB_KEY = crypto.getRandomValues(new Uint8Array(32));

before(async () => {
	await db.open();
});

beforeEach(async () => {
	await db.table("messages").clear();
	await db.table("chatSyncState").clear();
});

after(() => {
	db.close();
});

async function seedMessages(count) {
	const rows = [];
	for (let i = 1; i <= count; i++) {
		rows.push(
			toEncryptedRow(
				{
					ownerPubkey: ALICE_PUB,
					chatId: BOB_PUB,
					lamportTs: i,
					senderPubkey: i % 2 === 0 ? ALICE_PUB : BOB_PUB,
					id: `e${i}`,
					text: `сообщение ${i}`,
					status: "sent",
					msgId: `m${i}`,
				},
				MESSAGES_PLAINTEXT_FIELDS,
				DB_KEY,
			),
		);
	}
	await db.table("messages").bulkAdd(rows);
}

test("loadChatWindow: без курсора возвращает последние N сообщений (самые свежие)", async () => {
	await seedMessages(250);
	const { messages, hasMore } = await loadChatWindow(ALICE_PUB, BOB_PUB, DB_KEY, { limit: 100 });
	assert.equal(messages.length, 100);
	assert.equal(messages[0].lamportTs, 151);
	assert.equal(messages[99].lamportTs, 250);
	assert.equal(hasMore, true);
});

test("loadChatWindow: меньше сообщений, чем limit -> hasMore=false", async () => {
	await seedMessages(30);
	const { messages, hasMore } = await loadChatWindow(ALICE_PUB, BOB_PUB, DB_KEY, { limit: 100 });
	assert.equal(messages.length, 30);
	assert.equal(hasMore, false);
});

test("loadChatWindow: beforeSeq подгружает более старое окно (пагинация вверх)", async () => {
	await seedMessages(250);
	const first = await loadChatWindow(ALICE_PUB, BOB_PUB, DB_KEY, { limit: 100 });
	const oldestLoaded = first.messages[0]; // lamportTs=151
	const second = await loadChatWindow(ALICE_PUB, BOB_PUB, DB_KEY, { limit: 100, beforeSeq: oldestLoaded.seq });
	assert.equal(second.messages.length, 100);
	assert.equal(second.messages[0].lamportTs, 51);
	assert.equal(second.messages[99].lamportTs, 150);
	assert.equal(second.hasMore, true);

	const third = await loadChatWindow(ALICE_PUB, BOB_PUB, DB_KEY, { limit: 100, beforeSeq: second.messages[0].seq });
	assert.equal(third.messages.length, 50);
	assert.equal(third.hasMore, false);
});

test("loadChatWindow: устаревший/невалидный beforeSeq не бросает — просто отдаёт с начала", async () => {
	await seedMessages(30);
	const { messages, hasMore } = await loadChatWindow(ALICE_PUB, BOB_PUB, DB_KEY, { limit: 100, beforeSeq: 999999 });
	assert.equal(messages.length, 30);
	assert.equal(hasMore, false);
});

test("loadChatWindow: не путает разные чаты", async () => {
	await seedMessages(5);
	const carolPub = "c".repeat(64);
	await db.table("messages").add(
		toEncryptedRow(
			{
				ownerPubkey: ALICE_PUB,
				chatId: carolPub,
				lamportTs: 1,
				senderPubkey: carolPub,
				id: "carol1",
				text: "для Кэрол",
				status: "sent",
				msgId: "cm1",
			},
			MESSAGES_PLAINTEXT_FIELDS,
			DB_KEY,
		),
	);
	const { messages } = await loadChatWindow(ALICE_PUB, carolPub, DB_KEY, { limit: 100 });
	assert.equal(messages.length, 1);
	assert.equal(messages[0].text, "для Кэрол");
});

test("loadChatWindow: не включает 'сиротские' строки delete/edit-маркеров в отдаваемую историю (этап 27-довесок-6)", async () => {
	await seedMessages(3);
	await db.table("messages").bulkAdd([
		toEncryptedRow(
			{
				ownerPubkey: ALICE_PUB,
				chatId: BOB_PUB,
				lamportTs: 4,
				senderPubkey: ALICE_PUB,
				id: "del-evt",
				text: buildDeletionText("m2"),
				status: "sent",
				msgId: "del-msgid",
			},
			MESSAGES_PLAINTEXT_FIELDS,
			DB_KEY,
		),
		toEncryptedRow(
			{
				ownerPubkey: ALICE_PUB,
				chatId: BOB_PUB,
				lamportTs: 5,
				senderPubkey: ALICE_PUB,
				id: "edit-evt",
				text: buildEditText("m1", "правка"),
				status: "sent",
				msgId: "edit-msgid",
			},
			MESSAGES_PLAINTEXT_FIELDS,
			DB_KEY,
		),
	]);
	const { messages } = await loadChatWindow(ALICE_PUB, BOB_PUB, DB_KEY, { limit: 100 });
	assert.equal(messages.length, 3, "маркерные строки не попадают в окно, только 3 исходных сообщения");
	assert.ok(messages.every((m) => m.msgId !== "del-msgid" && m.msgId !== "edit-msgid"));
});

test("markWindowLoaded: сохраняет курсор, не затирая другие поля chatSyncState", async () => {
	await db.table("chatSyncState").put({ ownerPubkey: ALICE_PUB, chatId: BOB_PUB, lastReadLamportTs: 42 });
	await markWindowLoaded(ALICE_PUB, BOB_PUB, 12345);
	const row = await db.table("chatSyncState").get([ALICE_PUB, BOB_PUB]);
	assert.equal(row.oldestLoadedSeq, 12345);
	assert.equal(row.lastReadLamportTs, 42, "не должен затирать другие поля той же строки");
});
