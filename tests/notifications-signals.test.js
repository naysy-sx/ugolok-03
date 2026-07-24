import "fake-indexeddb/auto";
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { db } from "../src/core/store/database.js";
import { getPublicKey } from "../src/core/crypto/keys.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { toEncryptedRow } from "../src/core/store/encrypted-table.js";
import { CHANNELS_PLAINTEXT_FIELDS, CHANNEL_MESSAGES_PLAINTEXT_FIELDS } from "../src/core/store/table-fields.js";
import { contacts } from "../src/ui/signals/contacts.js";
import { foldChannelReadStatus, buildChannelReadStatusEvent } from "../src/domain/content/channel-read-status.js";
import { unreadMessagesCount, unreadChannelsCount, refreshUnreadMessagesCount, refreshUnreadChannelsCount } from "../src/ui/signals/notifications.js";

const ALICE_PRIV = new Uint8Array(32).fill(31);
const ALICE_PUB = bytesToHex(getPublicKey(ALICE_PRIV));
const BOB_PUB = "b".repeat(64);
const CAROL_PUB = "c".repeat(64);
const DB_KEY = crypto.getRandomValues(new Uint8Array(32));

before(async () => {
	await db.open();
});

beforeEach(async () => {
	contacts.value = [];
	unreadMessagesCount.value = 0;
	unreadChannelsCount.value = 0;
	await db.table("messages").clear();
	await db.table("chatSyncState").clear();
	await db.table("channels").clear();
	await db.table("channelMessages").clear();
	await db.table("channelSyncState").clear();
});

after(() => {
	db.close();
});

test("refreshUnreadMessagesCount: суммирует непрочитанное по ВСЕМ контактам", async () => {
	contacts.value = [BOB_PUB, CAROL_PUB];
	await db.table("messages").bulkAdd([
		{ ownerPubkey: ALICE_PUB, chatId: BOB_PUB, lamportTs: 1, senderPubkey: BOB_PUB, id: "m1", status: "sent", msgId: "m1" },
		{ ownerPubkey: ALICE_PUB, chatId: BOB_PUB, lamportTs: 2, senderPubkey: BOB_PUB, id: "m2", status: "sent", msgId: "m2" },
		{ ownerPubkey: ALICE_PUB, chatId: CAROL_PUB, lamportTs: 1, senderPubkey: CAROL_PUB, id: "m3", status: "sent", msgId: "m3" },
	]);
	await refreshUnreadMessagesCount(ALICE_PUB);
	assert.equal(unreadMessagesCount.value, 3);
});

test("refreshUnreadMessagesCount: без контактов -> 0", async () => {
	contacts.value = [];
	await refreshUnreadMessagesCount(ALICE_PUB);
	assert.equal(unreadMessagesCount.value, 0);
});

test("refreshUnreadChannelsCount: суммирует непрочитанное по владельческим+подписным каналам", async () => {
	await db.table("channels").bulkAdd([
		toEncryptedRow({ ownerPubkey: ALICE_PUB, id: "chan-1", role: "owner", channelTopic: "t1", creatorPubkey: ALICE_PUB, createdAt: 1, allowChatAttachments: true, name: "A", description: "", rules: "", avatar: null }, CHANNELS_PLAINTEXT_FIELDS, DB_KEY),
		toEncryptedRow({ ownerPubkey: ALICE_PUB, id: "chan-2", role: "subscriber", channelTopic: "t2", creatorPubkey: BOB_PUB, createdAt: 1, allowChatAttachments: true, name: "B", description: "", rules: "", avatar: null }, CHANNELS_PLAINTEXT_FIELDS, DB_KEY),
		toEncryptedRow({ ownerPubkey: ALICE_PUB, id: "chan-3", role: "available", channelTopic: "t3", creatorPubkey: BOB_PUB, createdAt: 1, allowChatAttachments: true, name: "C", description: "", rules: "", avatar: null }, CHANNELS_PLAINTEXT_FIELDS, DB_KEY),
	]);
	await db.table("channelMessages").bulkAdd([
		toEncryptedRow({ ownerPubkey: ALICE_PUB, id: "cm1", channelId: "chan-1", createdAt: 100, deleted: false, authorPubkey: BOB_PUB, text: "x", attachments: [], keyVersion: 1 }, CHANNEL_MESSAGES_PLAINTEXT_FIELDS, DB_KEY),
		toEncryptedRow({ ownerPubkey: ALICE_PUB, id: "cm2", channelId: "chan-2", createdAt: 100, deleted: false, authorPubkey: BOB_PUB, text: "y", attachments: [], keyVersion: 1 }, CHANNEL_MESSAGES_PLAINTEXT_FIELDS, DB_KEY),
		toEncryptedRow({ ownerPubkey: ALICE_PUB, id: "cm3", channelId: "chan-3", createdAt: 100, deleted: false, authorPubkey: BOB_PUB, text: "z", attachments: [], keyVersion: 1 }, CHANNEL_MESSAGES_PLAINTEXT_FIELDS, DB_KEY),
	]);

	await refreshUnreadChannelsCount(ALICE_PUB, DB_KEY);
	assert.equal(unreadChannelsCount.value, 2, "chan-1 (owner) + chan-2 (subscriber) считаются, chan-3 (available, не подписан) — нет");
});

test("refreshUnreadChannelsCount: учитывает read-tracking курсор (прочитанное не считается)", async () => {
	await db.table("channels").bulkAdd([
		toEncryptedRow({ ownerPubkey: ALICE_PUB, id: "chan-1", role: "owner", channelTopic: "t1", creatorPubkey: ALICE_PUB, createdAt: 1, allowChatAttachments: true, name: "A", description: "", rules: "", avatar: null }, CHANNELS_PLAINTEXT_FIELDS, DB_KEY),
	]);
	await db.table("channelMessages").bulkAdd([
		toEncryptedRow({ ownerPubkey: ALICE_PUB, id: "cm1", channelId: "chan-1", createdAt: 100, deleted: false, authorPubkey: BOB_PUB, text: "x", attachments: [], keyVersion: 1 }, CHANNEL_MESSAGES_PLAINTEXT_FIELDS, DB_KEY),
	]);
	await foldChannelReadStatus(buildChannelReadStatusEvent(ALICE_PRIV, { channelId: "chan-1", lastReadAt: 200 }), ALICE_PRIV);

	await refreshUnreadChannelsCount(ALICE_PUB, DB_KEY);
	assert.equal(unreadChannelsCount.value, 0);
});
