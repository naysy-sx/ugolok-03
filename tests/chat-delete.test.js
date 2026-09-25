import "fake-indexeddb/auto";
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { bytesToHex } from "@noble/hashes/utils.js";
import { db } from "../src/core/store/database.js";
import { getPublicKey } from "../src/core/crypto/keys.js";
import { toEncryptedRow } from "../src/core/store/encrypted-table.js";
import { MLS_GROUPS_PLAINTEXT_FIELDS } from "../src/core/store/table-fields.js";
import { computeGroupId, upsertMessage } from "../src/domain/messaging/chat.js";
import { touchChatActivity } from "../src/domain/messaging/chat-activity.js";
import { deleteChatForever } from "../src/domain/messaging/chat-delete.js";
import { isBeforeChatDeletion, isBeforeChatDeletionByGroup, getChatTombstone } from "../src/domain/messaging/chat-tombstone.js";

const ALICE = bytesToHex(getPublicKey(new Uint8Array(32).fill(1)));
const BOB = bytesToHex(getPublicKey(new Uint8Array(32).fill(2)));
const CAROL = bytesToHex(getPublicKey(new Uint8Array(32).fill(3)));
const DB_KEY = crypto.getRandomValues(new Uint8Array(32));
const T0 = 1_800_000_000; // «сейчас» для теста, секунды

before(async () => {
	await db.open();
});
beforeEach(async () => {
	for (const t of ["messages", "mlsGroups", "chatActivity", "chatSyncState", "peerCursors", "chatTombstones", "chatGeneration", "pendingOutgoingMessages"]) {
		await db.table(t).clear();
	}
});
after(() => db.close());

async function seedChat(peer, lastAt) {
	const groupIdHex = bytesToHex(computeGroupId(ALICE, peer));
	await db.table("mlsGroups").put(toEncryptedRow({ ownerPubkey: ALICE, groupId: groupIdHex, contactPubkey: peer, state: "x", generation: 0 }, MLS_GROUPS_PLAINTEXT_FIELDS, DB_KEY));
	for (let i = 1; i <= 3; i++) {
		await upsertMessage({ ownerPubkey: ALICE, chatId: peer, lamportTs: i, senderPubkey: i % 2 ? ALICE : peer, id: `e${peer.slice(0, 4)}${i}`, text: `m${i}`, status: "sent", msgId: `${peer.slice(0, 4)}-${i}`, sentAt: lastAt - 100 + i }, DB_KEY);
	}
	await touchChatActivity(ALICE, DB_KEY, peer, peer, lastAt);
	await db.table("peerCursors").put({ ownerPubkey: ALICE, contactPubkey: peer, deliveredUpTo: 3, readUpTo: 3 });
	return groupIdHex;
}

test("deleteChatForever стирает сообщения, группу, запись списка и курсоры этого чата", async () => {
	const groupIdHex = await seedChat(BOB, T0 - 3600);
	await deleteChatForever(ALICE, DB_KEY, BOB, T0);
	assert.equal(await db.table("messages").where("[ownerPubkey+chatId]").equals([ALICE, BOB]).count(), 0);
	assert.equal(await db.table("mlsGroups").get([ALICE, groupIdHex]), undefined);
	assert.equal(await db.table("chatActivity").get([ALICE, BOB]), undefined);
	assert.equal(await db.table("peerCursors").get([ALICE, BOB]), undefined);
});

test("удаление одного чата не трогает переписку с другим человеком", async () => {
	await seedChat(BOB, T0 - 3600);
	const carolGroup = await seedChat(CAROL, T0 - 3600);
	await deleteChatForever(ALICE, DB_KEY, BOB, T0);
	assert.equal(await db.table("messages").where("[ownerPubkey+chatId]").equals([ALICE, CAROL]).count(), 3);
	assert.ok(await db.table("mlsGroups").get([ALICE, carolGroup]));
	assert.equal(await getChatTombstone(ALICE, CAROL), null);
});

test("надгробие: deletedAt не раньше последней известной активности и не позже «сейчас»", async () => {
	await seedChat(BOB, T0 - 60);
	const { deletedAt } = await deleteChatForever(ALICE, DB_KEY, BOB, T0);
	assert.ok(deletedAt >= T0 - 60);
	assert.ok(deletedAt <= T0);
	const tomb = await getChatTombstone(ALICE, BOB);
	assert.equal(tomb.deletedAt, deletedAt);
});

test("после удаления старое сообщение (зеркало/живой путь) не возвращается, новое — проходит", async () => {
	await seedChat(BOB, T0 - 3600);
	const { deletedAt } = await deleteChatForever(ALICE, DB_KEY, BOB, T0);
	await upsertMessage({ ownerPubkey: ALICE, chatId: BOB, lamportTs: 9, senderPubkey: ALICE, id: "old", text: "старое", status: "sent", msgId: "old", sentAt: deletedAt - 10 }, DB_KEY, "mirror");
	assert.equal(await db.table("messages").where("[ownerPubkey+chatId]").equals([ALICE, BOB]).count(), 0);
	await upsertMessage({ ownerPubkey: ALICE, chatId: BOB, lamportTs: 10, senderPubkey: BOB, id: "new", text: "новое", status: "sent", msgId: "new", sentAt: deletedAt + 10 }, DB_KEY);
	assert.equal(await db.table("messages").where("[ownerPubkey+chatId]").equals([ALICE, BOB]).count(), 1);
});

test("проверки надгробия: по контакту и по группе, граница включительно, чужие пары не затронуты", async () => {
	const groupIdHex = await seedChat(BOB, T0 - 3600);
	const { deletedAt } = await deleteChatForever(ALICE, DB_KEY, BOB, T0);
	assert.equal(await isBeforeChatDeletion(ALICE, BOB, deletedAt), true);
	assert.equal(await isBeforeChatDeletion(ALICE, BOB, deletedAt + 1), false);
	assert.equal(await isBeforeChatDeletionByGroup(ALICE, groupIdHex, deletedAt - 5), true);
	assert.equal(await isBeforeChatDeletionByGroup(ALICE, groupIdHex, deletedAt + 5), false);
	assert.equal(await isBeforeChatDeletion(ALICE, CAROL, 1), false);
});

test("поколение разговора растёт: новый Welcome после удаления заменит группу у собеседника", async () => {
	await seedChat(BOB, T0 - 3600);
	await deleteChatForever(ALICE, DB_KEY, BOB, T0);
	const row = await db.table("chatGeneration").get([ALICE, BOB]);
	assert.equal(row.generation, 1);
});
