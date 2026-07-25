import "fake-indexeddb/auto";
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { db } from "../src/core/store/database.js";
import { getPublicKey } from "../src/core/crypto/keys.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { toEncryptedRow } from "../src/core/store/encrypted-table.js";
import { POSTS_PLAINTEXT_FIELDS, COMMENTS_PLAINTEXT_FIELDS, CHANNEL_MESSAGES_PLAINTEXT_FIELDS } from "../src/core/store/table-fields.js";
import {
	CHANNEL_READ_STATUS_KIND,
	buildChannelReadStatusEvent,
	parseChannelReadStatusEvent,
	foldChannelReadStatus,
	markChannelAsRead,
	rebuildChannelReadStatus,
	getChannelUnreadCount,
	isChannelContentRead,
} from "../src/domain/content/channel-read-status.js";

const ALICE_PRIV = new Uint8Array(32).fill(21);
const ALICE_PUB = bytesToHex(getPublicKey(ALICE_PRIV));
const BOB_PUB = "b".repeat(64);
const DB_KEY = crypto.getRandomValues(new Uint8Array(32));
const CHAN_A = "chan-a";
const CHAN_B = "chan-b";

before(async () => {
	await db.open();
});

beforeEach(async () => {
	await db.table("channelSyncState").clear();
	await db.table("posts").clear();
	await db.table("comments").clear();
	await db.table("channelMessages").clear();
	await db.table("events").clear();
});

after(() => {
	db.close();
});

test("CHANNEL_READ_STATUS_KIND: 30074", () => {
	assert.equal(CHANNEL_READ_STATUS_KIND, 30074);
});

test("buildChannelReadStatusEvent/parseChannelReadStatusEvent: round-trip, d-tag = channelId в открытом виде", () => {
	const event = buildChannelReadStatusEvent(ALICE_PRIV, { channelId: CHAN_A, lastReadAt: 1000 });
	assert.equal(event.kind, 30074);
	assert.deepEqual(event.tags, [["d", CHAN_A]]);
	const parsed = parseChannelReadStatusEvent(event, ALICE_PRIV);
	assert.deepEqual(parsed, { channelId: CHAN_A, lastReadAt: 1000 });
});

test("foldChannelReadStatus: сохраняет lastReadAt в channelSyncState (голый put, без шифрования)", async () => {
	const event = buildChannelReadStatusEvent(ALICE_PRIV, { channelId: CHAN_A, lastReadAt: 500 });
	await foldChannelReadStatus(event, ALICE_PRIV);
	const row = await db.table("channelSyncState").get([ALICE_PUB, CHAN_A]);
	assert.equal(row.lastReadAt, 500);
	assert.equal(row.nonce, undefined, "таблица целиком plaintext — нет шифрования");
});

test("foldChannelReadStatus: monotonic guard — не откатывает назад более свежее локальное значение", async () => {
	await foldChannelReadStatus(buildChannelReadStatusEvent(ALICE_PRIV, { channelId: CHAN_A, lastReadAt: 900 }), ALICE_PRIV);
	await foldChannelReadStatus(buildChannelReadStatusEvent(ALICE_PRIV, { channelId: CHAN_A, lastReadAt: 100 }), ALICE_PRIV);
	const row = await db.table("channelSyncState").get([ALICE_PUB, CHAN_A]);
	assert.equal(row.lastReadAt, 900);
});

test("markChannelAsRead: публикует событие и применяет fold локально сразу", async () => {
	let publishedEvent;
	const publish = async (event) => {
		publishedEvent = event;
		return { ok: true };
	};
	await markChannelAsRead(ALICE_PUB, ALICE_PRIV, CHAN_A, 42, publish);
	assert.equal(publishedEvent.kind, 30074);
	const row = await db.table("channelSyncState").get([ALICE_PUB, CHAN_A]);
	assert.equal(row.lastReadAt, 42);
});

test("markChannelAsRead: сбой публикации -> throw, не применяет fold локально", async () => {
	const publish = async () => ({ ok: false, reason: "отклонено" });
	await assert.rejects(() => markChannelAsRead(ALICE_PUB, ALICE_PRIV, CHAN_A, 42, publish), /отклонено/);
	assert.equal(await db.table("channelSyncState").get([ALICE_PUB, CHAN_A]), undefined);
});

test("rebuildChannelReadStatus: восстанавливает несколько каналов независимо, LWW по created_at на дубли", async () => {
	const eventA = buildChannelReadStatusEvent(ALICE_PRIV, { channelId: CHAN_A, lastReadAt: 10 }, 1000);
	const olderA = buildChannelReadStatusEvent(ALICE_PRIV, { channelId: CHAN_A, lastReadAt: 999 }, 500);
	const eventB = buildChannelReadStatusEvent(ALICE_PRIV, { channelId: CHAN_B, lastReadAt: 20 }, 1000);
	await db.table("events").bulkAdd([eventA, olderA, eventB]);

	await rebuildChannelReadStatus(ALICE_PUB, ALICE_PRIV);

	assert.equal((await db.table("channelSyncState").get([ALICE_PUB, CHAN_A])).lastReadAt, 10, "новее по created_at побеждает старую версию с БОЛЬШИМ lastReadAt");
	assert.equal((await db.table("channelSyncState").get([ALICE_PUB, CHAN_B])).lastReadAt, 20);
});

test("rebuildChannelReadStatus АДВЕРСАРНО: нет ни одного kind 30074 в events — no-op, не бросает", async () => {
	await assert.doesNotReject(() => rebuildChannelReadStatus(ALICE_PUB, ALICE_PRIV));
});

// --- getChannelUnreadCount: три таблицы, разная доступность полей без расшифровки ---

test("getChannelUnreadCount: без read-status — все чужие posts/comments/channelMessages непрочитаны, свои не считаются", async () => {
	await db.table("posts").bulkAdd([
		toEncryptedRow({ ownerPubkey: ALICE_PUB, id: "p1", channelId: CHAN_A, createdAt: 100, deleted: false, status: "published", keyVersion: 1, authorPubkey: BOB_PUB, text: "x", attachments: [] }, POSTS_PLAINTEXT_FIELDS, DB_KEY),
		toEncryptedRow({ ownerPubkey: ALICE_PUB, id: "p2", channelId: CHAN_A, createdAt: 200, deleted: false, status: "published", keyVersion: 1, authorPubkey: ALICE_PUB, text: "моё", attachments: [] }, POSTS_PLAINTEXT_FIELDS, DB_KEY),
	]);
	await db.table("comments").bulkAdd([
		toEncryptedRow({ ownerPubkey: ALICE_PUB, id: "c1", postId: "p1", parentId: "p1", deleted: false, channelId: CHAN_A, authorPubkey: BOB_PUB, createdAt: 150, text: "y", attachments: [], keyVersion: 1 }, COMMENTS_PLAINTEXT_FIELDS, DB_KEY),
	]);
	await db.table("channelMessages").bulkAdd([
		toEncryptedRow({ ownerPubkey: ALICE_PUB, id: "m1", channelId: CHAN_A, createdAt: 120, deleted: false, authorPubkey: BOB_PUB, text: "z", attachments: [], keyVersion: 1 }, CHANNEL_MESSAGES_PLAINTEXT_FIELDS, DB_KEY),
	]);

	const count = await getChannelUnreadCount(ALICE_PUB, CHAN_A, DB_KEY);
	assert.equal(count, 3, "p1 (чужой пост) + c1 (чужой коммент) + m1 (чужое сообщение чата) = 3, p2 (свой пост) не считается");
});

test("getChannelUnreadCount: после markChannelAsRead — только контент новее курсора", async () => {
	await db.table("posts").bulkAdd([
		toEncryptedRow({ ownerPubkey: ALICE_PUB, id: "p1", channelId: CHAN_A, createdAt: 100, deleted: false, status: "published", keyVersion: 1, authorPubkey: BOB_PUB, text: "старый", attachments: [] }, POSTS_PLAINTEXT_FIELDS, DB_KEY),
		toEncryptedRow({ ownerPubkey: ALICE_PUB, id: "p2", channelId: CHAN_A, createdAt: 300, deleted: false, status: "published", keyVersion: 1, authorPubkey: BOB_PUB, text: "новый", attachments: [] }, POSTS_PLAINTEXT_FIELDS, DB_KEY),
	]);
	await foldChannelReadStatus(buildChannelReadStatusEvent(ALICE_PRIV, { channelId: CHAN_A, lastReadAt: 200 }), ALICE_PRIV);

	const count = await getChannelUnreadCount(ALICE_PUB, CHAN_A, DB_KEY);
	assert.equal(count, 1, "только p2 (createdAt=300 > курсора 200)");
});

test("getChannelUnreadCount: не путает каналы (chan-a и chan-b независимы)", async () => {
	await db.table("posts").bulkAdd([
		toEncryptedRow({ ownerPubkey: ALICE_PUB, id: "p1", channelId: CHAN_A, createdAt: 100, deleted: false, status: "published", keyVersion: 1, authorPubkey: BOB_PUB, text: "a", attachments: [] }, POSTS_PLAINTEXT_FIELDS, DB_KEY),
		toEncryptedRow({ ownerPubkey: ALICE_PUB, id: "p2", channelId: CHAN_B, createdAt: 100, deleted: false, status: "published", keyVersion: 1, authorPubkey: BOB_PUB, text: "b", attachments: [] }, POSTS_PLAINTEXT_FIELDS, DB_KEY),
	]);
	assert.equal(await getChannelUnreadCount(ALICE_PUB, CHAN_A, DB_KEY), 1);
	assert.equal(await getChannelUnreadCount(ALICE_PUB, CHAN_B, DB_KEY), 1);
});

test("getChannelUnreadCount: удалённые (deleted=true) не считаются", async () => {
	await db.table("channelMessages").bulkAdd([
		toEncryptedRow({ ownerPubkey: ALICE_PUB, id: "m1", channelId: CHAN_A, createdAt: 100, deleted: true, authorPubkey: BOB_PUB, text: "z", attachments: [], keyVersion: 1 }, CHANNEL_MESSAGES_PLAINTEXT_FIELDS, DB_KEY),
	]);
	assert.equal(await getChannelUnreadCount(ALICE_PUB, CHAN_A, DB_KEY), 0);
});

// Этап 50 — инвариант N1 (CONTACTS-FSM.md §6, приложение А).
test("isChannelContentRead: нет курсора вовсе -> false", async () => {
	assert.equal(await isChannelContentRead(ALICE_PUB, CHAN_A, 1), false);
});

test("isChannelContentRead: createdAt <= курсора -> true (уже прочитано)", async () => {
	await foldChannelReadStatus(buildChannelReadStatusEvent(ALICE_PRIV, { channelId: CHAN_A, lastReadAt: 500 }), ALICE_PRIV);
	assert.equal(await isChannelContentRead(ALICE_PUB, CHAN_A, 500), true, "ровно на курсоре");
	assert.equal(await isChannelContentRead(ALICE_PUB, CHAN_A, 100), true, "старее курсора");
});

test("isChannelContentRead: createdAt > курсора -> false", async () => {
	await foldChannelReadStatus(buildChannelReadStatusEvent(ALICE_PRIV, { channelId: CHAN_A, lastReadAt: 500 }), ALICE_PRIV);
	assert.equal(await isChannelContentRead(ALICE_PUB, CHAN_A, 501), false);
});

test("isChannelContentRead: курсор ДРУГОГО канала не влияет", async () => {
	await foldChannelReadStatus(buildChannelReadStatusEvent(ALICE_PRIV, { channelId: CHAN_B, lastReadAt: 999 }), ALICE_PRIV);
	assert.equal(await isChannelContentRead(ALICE_PUB, CHAN_A, 1), false);
});
