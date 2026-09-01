// Глобальный поиск, этап И2, задачи 2.2/2.3 (PROCESS-DOCS/PLAN.md). Контракт
// источника — SEARCH-SPEC.md §3.2, с двумя правками из И0 (CONTRACTS.md
// §SEARCH): источник contacts фильтрует по contactRelationships (не по
// присутствию строки в contactProfiles), источник posts исключает
// status==="draft" сверх !deleted. Написаны ДО реализации src/domain/
// search/sources/*.js (orchestrate-workers, правило 14).

import "fake-indexeddb/auto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { db } from "../src/core/store/database.js";
import { toEncryptedRow } from "../src/core/store/encrypted-table.js";
import {
	CONTACT_PROFILES_PLAINTEXT_FIELDS,
	CONTACT_RELATIONSHIPS_PLAINTEXT_FIELDS,
	CHANNELS_PLAINTEXT_FIELDS,
	MESSAGES_PLAINTEXT_FIELDS,
	POSTS_PLAINTEXT_FIELDS,
	COMMENTS_PLAINTEXT_FIELDS,
	CHANNEL_MESSAGES_PLAINTEXT_FIELDS,
} from "../src/core/store/table-fields.js";

import { contactsSource } from "../src/domain/search/sources/contacts.js";
import { channelsSource } from "../src/domain/search/sources/channels.js";
import { commentsSource } from "../src/domain/search/sources/comments.js";
import { messagesSource } from "../src/domain/search/sources/messages.js";
import { postsSource } from "../src/domain/search/sources/posts.js";
import { channelMessagesSource } from "../src/domain/search/sources/channel-messages.js";

const OWNER = "o".repeat(64);
const OTHER_OWNER = "z".repeat(64);
const dbKey = crypto.getRandomValues(new Uint8Array(32));

async function collect(source, ctx, signal = new AbortController().signal) {
	const out = [];
	for await (const item of source.scan(ctx, { signal })) out.push(item);
	return out;
}

test.beforeEach(async () => {
	await db.delete();
	await db.open();
});

// --- метаданные источника (контракт §3.2) ---
test("метаданные источников: type/order по таблице распределения §3.2", () => {
	assert.equal(contactsSource.type, "contact");
	assert.equal(contactsSource.order, "unordered");
	assert.equal(channelsSource.type, "channel");
	assert.equal(channelsSource.order, "unordered");
	assert.equal(commentsSource.type, "comment");
	assert.equal(commentsSource.order, "unordered");
	assert.equal(messagesSource.type, "message");
	assert.equal(messagesSource.order, "recent");
	assert.equal(postsSource.type, "post");
	assert.equal(postsSource.order, "recent");
	assert.equal(channelMessagesSource.type, "channelMessage");
	assert.equal(channelMessagesSource.order, "recent");
});

// --- contacts: правка П-3 — фильтр по contactRelationships, не по присутствию строки ---
test("contacts: находит только peer'ов в state=CONTACT, поля [name, about]", async () => {
	await db.table("contactRelationships").bulkAdd([
		toEncryptedRow({ owner: OWNER, peer: "1".repeat(64), state: "CONTACT" }, CONTACT_RELATIONSHIPS_PLAINTEXT_FIELDS, dbKey),
		toEncryptedRow({ owner: OWNER, peer: "2".repeat(64), state: "BLOCKED" }, CONTACT_RELATIONSHIPS_PLAINTEXT_FIELDS, dbKey),
		toEncryptedRow({ owner: OWNER, peer: "3".repeat(64), state: "OUTGOING_PENDING" }, CONTACT_RELATIONSHIPS_PLAINTEXT_FIELDS, dbKey),
	]);
	await db.table("contactProfiles").bulkAdd([
		toEncryptedRow({ ownerPubkey: OWNER, contactPubkey: "1".repeat(64), name: "kukusya", about: "обожает питона", watched: 0, seenAt: 1 }, CONTACT_PROFILES_PLAINTEXT_FIELDS, dbKey),
		toEncryptedRow({ ownerPubkey: OWNER, contactPubkey: "2".repeat(64), name: "заблокированный", about: "", watched: 0, seenAt: 1 }, CONTACT_PROFILES_PLAINTEXT_FIELDS, dbKey),
		toEncryptedRow({ ownerPubkey: OWNER, contactPubkey: "3".repeat(64), name: "ещё не принят", about: "", watched: 0, seenAt: 1 }, CONTACT_PROFILES_PLAINTEXT_FIELDS, dbKey),
	]);

	const got = await collect(contactsSource, { ownerPubkey: OWNER, dbKey });
	assert.equal(got.length, 1, "источник обязан вернуть ровно одного активного контакта");
	assert.equal(got[0].key, "1".repeat(64));
	assert.deepEqual(got[0].fields, ["kukusya", "обожает питона"]);
});

test("contacts: profile-строка без contactRelationships вовсе — не найден (переживший removeContact, И0 П-3)", async () => {
	// Реальный пробел, найденный в И0: contactProfiles не чистится при
	// removeContact/blockContact. Строка-сирота без КАКОЙ-ЛИБО записи в
	// contactRelationships не должна попадать в выдачу.
	await db.table("contactProfiles").add(
		toEncryptedRow({ ownerPubkey: OWNER, contactPubkey: "9".repeat(64), name: "давно удалённый", about: "призрак", watched: 0, seenAt: 1 }, CONTACT_PROFILES_PLAINTEXT_FIELDS, dbKey),
	);
	const got = await collect(contactsSource, { ownerPubkey: OWNER, dbKey });
	assert.equal(got.length, 0);
});

test("contacts: чужой owner не просачивается", async () => {
	await db.table("contactRelationships").add(toEncryptedRow({ owner: OTHER_OWNER, peer: "1".repeat(64), state: "CONTACT" }, CONTACT_RELATIONSHIPS_PLAINTEXT_FIELDS, dbKey));
	await db.table("contactProfiles").add(toEncryptedRow({ ownerPubkey: OTHER_OWNER, contactPubkey: "1".repeat(64), name: "чужой контакт", about: "", watched: 0, seenAt: 1 }, CONTACT_PROFILES_PLAINTEXT_FIELDS, dbKey));
	const got = await collect(contactsSource, { ownerPubkey: OWNER, dbKey });
	assert.equal(got.length, 0);
});

// --- channels: без deleted-фильтра (жёсткое удаление — И0), поля [name, description, rules] ---
test("channels: поля [name, description, rules], owner-скоуп", async () => {
	await db.table("channels").bulkAdd([
		toEncryptedRow({ ownerPubkey: OWNER, id: "ch1", role: "owner", creatorPubkey: OWNER, createdAt: 1, updatedAt: 1, allowChatAttachments: true, name: "Тестовый канал", description: "описание", rules: "протухшее мясо нельзя обсуждать" }, CHANNELS_PLAINTEXT_FIELDS, dbKey),
		toEncryptedRow({ ownerPubkey: OTHER_OWNER, id: "ch2", role: "owner", creatorPubkey: OTHER_OWNER, createdAt: 1, updatedAt: 1, allowChatAttachments: true, name: "Чужой канал", description: "", rules: "" }, CHANNELS_PLAINTEXT_FIELDS, dbKey),
	]);
	const got = await collect(channelsSource, { ownerPubkey: OWNER, dbKey });
	assert.equal(got.length, 1);
	assert.equal(got[0].key, "ch1");
	assert.deepEqual(got[0].fields, ["Тестовый канал", "описание", "протухшее мясо нельзя обсуждать"]);
});

// --- comments: unordered, поле [text], !deleted ---
test("comments: исключает deleted, поле [text]", async () => {
	await db.table("comments").bulkAdd([
		toEncryptedRow({ ownerPubkey: OWNER, id: "c1", postId: "p1", parentId: null, deleted: false, text: "живой комментарий" }, COMMENTS_PLAINTEXT_FIELDS, dbKey),
		toEncryptedRow({ ownerPubkey: OWNER, id: "c2", postId: "p1", parentId: null, deleted: true, text: "удалённый комментарий" }, COMMENTS_PLAINTEXT_FIELDS, dbKey),
	]);
	const got = await collect(commentsSource, { ownerPubkey: OWNER, dbKey });
	assert.equal(got.length, 1);
	assert.deepEqual(got[0].fields, ["живой комментарий"]);
});

// --- messages: recent (paginateReverseByPrimaryKey), !deleted, поле [text] ---
test("messages: свежие первыми, исключает deleted, поле [text]", async () => {
	const rows = [];
	for (let i = 0; i < 5; i++) {
		rows.push(toEncryptedRow({ ownerPubkey: OWNER, chatId: "chat1", msgId: `m${i}`, lamportTs: i, senderPubkey: OWNER, id: `id${i}`, status: "sent", deleted: i === 2, text: `сообщение ${i}` }, MESSAGES_PLAINTEXT_FIELDS, dbKey));
	}
	await db.table("messages").bulkAdd(rows);
	const got = await collect(messagesSource, { ownerPubkey: OWNER, dbKey });
	assert.equal(got.length, 4, "удалённое сообщение попало в выдачу");
	assert.deepEqual(got.map((g) => g.fields[0]), ["сообщение 4", "сообщение 3", "сообщение 1", "сообщение 0"], "не в порядке от свежих к старым");
});

// --- posts: recent, !deleted && status!=="draft" (правка И0), поля [title, text] ---
test("posts: исключает deleted И draft, свежие первыми, поля [title, text]", async () => {
	await db.table("posts").bulkAdd([
		toEncryptedRow({ ownerPubkey: OWNER, id: "p1", channelId: "ch1", createdAt: 10, deleted: false, status: "published", title: "Заголовок 1", text: "текст 1" }, POSTS_PLAINTEXT_FIELDS, dbKey),
		toEncryptedRow({ ownerPubkey: OWNER, id: "p2", channelId: "ch1", createdAt: 20, deleted: false, status: "draft", title: "Черновик", text: "не публиковался" }, POSTS_PLAINTEXT_FIELDS, dbKey),
		toEncryptedRow({ ownerPubkey: OWNER, id: "p3", channelId: "ch1", createdAt: 30, deleted: true, status: "published", title: "Удалённый", text: "удалён" }, POSTS_PLAINTEXT_FIELDS, dbKey),
		toEncryptedRow({ ownerPubkey: OWNER, id: "p4", channelId: "ch1", createdAt: 5, deleted: false, status: "published", title: "Заголовок 4", text: "текст 4" }, POSTS_PLAINTEXT_FIELDS, dbKey),
	]);
	const got = await collect(postsSource, { ownerPubkey: OWNER, dbKey });
	assert.equal(got.length, 2, "черновик или удалённый пост попал в выдачу");
	assert.deepEqual(got.map((g) => g.key), ["p1", "p4"], "не в порядке от свежих к старым");
	assert.deepEqual(got[0].fields, ["Заголовок 1", "текст 1"]);
});

// --- channelMessages: recent, !deleted, поле [text] ---
test("channelMessages: исключает deleted, свежие первыми, поле [text]", async () => {
	await db.table("channelMessages").bulkAdd([
		toEncryptedRow({ ownerPubkey: OWNER, id: "cm1", channelId: "ch1", createdAt: 10, deleted: false, authorPubkey: OWNER, text: "привет" }, CHANNEL_MESSAGES_PLAINTEXT_FIELDS, dbKey),
		toEncryptedRow({ ownerPubkey: OWNER, id: "cm2", channelId: "ch1", createdAt: 20, deleted: true, authorPubkey: OWNER, text: "стёртое" }, CHANNEL_MESSAGES_PLAINTEXT_FIELDS, dbKey),
	]);
	const got = await collect(channelMessagesSource, { ownerPubkey: OWNER, dbKey });
	assert.equal(got.length, 1);
	assert.deepEqual(got[0].fields, ["привет"]);
});

// --- AbortSignal: recent-источники обязаны остановиться, unordered — тоже
// не должны игнорировать signal (контракт §3.2 общий для всех) ---
test("messages: уже отменённый signal — источник не читает ничего", async () => {
	const rows = [];
	for (let i = 0; i < 10; i++) rows.push(toEncryptedRow({ ownerPubkey: OWNER, chatId: "c", msgId: `m${i}`, lamportTs: i, senderPubkey: OWNER, id: `id${i}`, status: "sent", deleted: false, text: `t${i}` }, MESSAGES_PLAINTEXT_FIELDS, dbKey));
	await db.table("messages").bulkAdd(rows);
	const controller = new AbortController();
	controller.abort();
	const got = await collect(messagesSource, { ownerPubkey: OWNER, dbKey }, controller.signal);
	assert.equal(got.length, 0);
});
