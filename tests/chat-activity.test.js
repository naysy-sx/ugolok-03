import "fake-indexeddb/auto";
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { db } from "../src/core/store/database.js";
import { getPublicKey } from "../src/core/crypto/keys.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { touchChatActivity, listConversations } from "../src/domain/messaging/chat-activity.js";

const ALICE_PRIV = new Uint8Array(32).fill(1);
const BOB_PRIV = new Uint8Array(32).fill(2);
const MALLORY_PRIV = new Uint8Array(32).fill(3);
const ALICE_PUB = bytesToHex(getPublicKey(ALICE_PRIV));
const BOB_PUB = bytesToHex(getPublicKey(BOB_PRIV));
const MALLORY_PUB = bytesToHex(getPublicKey(MALLORY_PRIV));
const DB_KEY = crypto.getRandomValues(new Uint8Array(32));

before(async () => {
	await db.open();
});

beforeEach(async () => {
	await db.table("chatActivity").clear();
});

after(() => {
	db.close();
});

test("touchChatActivity/listConversations: пустой аккаунт -> []", async () => {
	assert.deepEqual(await listConversations(ALICE_PUB, DB_KEY), []);
});

test("touchChatActivity: upsert перезаписывает, не копит историю (одна строка на чат)", async () => {
	await touchChatActivity(ALICE_PUB, DB_KEY, BOB_PUB, ALICE_PUB, 1000);
	await touchChatActivity(ALICE_PUB, DB_KEY, BOB_PUB, BOB_PUB, 2000);
	const rows = await listConversations(ALICE_PUB, DB_KEY);
	assert.equal(rows.length, 1);
	assert.equal(rows[0].lastAt, 2000);
	assert.equal(rows[0].lastFrom, BOB_PUB);
});

test("listConversations: сортировка по lastAt УБЫВАНИЕМ", async () => {
	await touchChatActivity(ALICE_PUB, DB_KEY, "chat-old", ALICE_PUB, 1000);
	await touchChatActivity(ALICE_PUB, DB_KEY, "chat-new", ALICE_PUB, 3000);
	await touchChatActivity(ALICE_PUB, DB_KEY, "chat-mid", ALICE_PUB, 2000);
	const rows = await listConversations(ALICE_PUB, DB_KEY);
	assert.deepEqual(rows.map((r) => r.chatId), ["chat-new", "chat-mid", "chat-old"]);
});

test("listConversations: межвладельческая изоляция — чужой ownerPubkey не подмешивается", async () => {
	await touchChatActivity(ALICE_PUB, DB_KEY, BOB_PUB, ALICE_PUB, 1000);
	await touchChatActivity(MALLORY_PUB, DB_KEY, BOB_PUB, MALLORY_PUB, 5000);
	const aliceRows = await listConversations(ALICE_PUB, DB_KEY);
	assert.equal(aliceRows.length, 1);
	assert.equal(aliceRows[0].chatId, BOB_PUB);
});

test("AC-16: chatActivity — все поля plaintext (сырой дамп читается без dbKey)", async () => {
	await touchChatActivity(ALICE_PUB, DB_KEY, BOB_PUB, ALICE_PUB, 1000);
	const raw = await db.table("chatActivity").get([ALICE_PUB, BOB_PUB]);
	assert.equal(raw.lastAt, 1000);
	assert.equal(raw.lastFrom, ALICE_PUB);
	assert.equal(raw.chatId, BOB_PUB);
});
