import "fake-indexeddb/auto";
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { db } from "../src/core/store/database.js";
import { loadPostsWindow, loadCommentsWindow, loadChannelChatWindow } from "../src/core/sync/lazy-channel.js";

const OWNER = "owner-pub";
const CHANNEL_ID = "channel-1";

before(async () => {
	await db.open();
});

beforeEach(async () => {
	await db.table("posts").clear();
	await db.table("comments").clear();
	await db.table("channelMessages").clear();
});

after(() => {
	db.close();
});

async function seedPosts(count, { channelId = CHANNEL_ID, ownerPubkey = OWNER, statusFor = () => "published" } = {}) {
	const rows = [];
	for (let i = 1; i <= count; i++) {
		rows.push({
			ownerPubkey,
			id: `${channelId}-post-${i}`,
			channelId,
			authorPubkey: ownerPubkey,
			text: `пост ${i}`,
			attachments: [],
			status: statusFor(i),
			keyVersion: 1,
			createdAt: i,
			deleted: false,
		});
	}
	await db.table("posts").bulkAdd(rows);
}

test("loadPostsWindow: возвращает последние N постов (самые свежие по createdAt)", async () => {
	await seedPosts(25);
	const { posts, hasMore } = await loadPostsWindow(OWNER, CHANNEL_ID, { limit: 10 });
	assert.equal(posts.length, 10);
	assert.equal(posts[0].createdAt, 16);
	assert.equal(posts[9].createdAt, 25);
	assert.equal(hasMore, true);
});

test("loadPostsWindow: меньше постов, чем limit -> hasMore=false", async () => {
	await seedPosts(5);
	const { posts, hasMore } = await loadPostsWindow(OWNER, CHANNEL_ID, { limit: 10 });
	assert.equal(posts.length, 5);
	assert.equal(hasMore, false);
});

test("loadPostsWindow: beforeCreatedAt подгружает более старое окно (пагинация вверх)", async () => {
	await seedPosts(25);
	const first = await loadPostsWindow(OWNER, CHANNEL_ID, { limit: 10 });
	const oldestLoaded = first.posts[0]; // createdAt=16
	const second = await loadPostsWindow(OWNER, CHANNEL_ID, { limit: 10, beforeCreatedAt: oldestLoaded.createdAt });
	assert.equal(second.posts.length, 10);
	assert.equal(second.posts[0].createdAt, 6);
	assert.equal(second.posts[9].createdAt, 15);
	assert.equal(second.hasMore, true);
});

test("loadPostsWindow: черновики НЕ попадают в окно вовсе (только published/archived)", async () => {
	await seedPosts(5, { statusFor: (i) => (i === 3 ? "draft" : "published") });
	const { posts } = await loadPostsWindow(OWNER, CHANNEL_ID, { limit: 10 });
	assert.equal(posts.length, 4);
	assert.ok(!posts.some((p) => p.id === `${CHANNEL_ID}-post-3`));
});

test("loadPostsWindow: не путает разные каналы", async () => {
	await seedPosts(3, { channelId: "channel-A" });
	await seedPosts(2, { channelId: "channel-B" });
	const { posts } = await loadPostsWindow(OWNER, "channel-B", { limit: 10 });
	assert.equal(posts.length, 2);
});

test("loadCommentsWindow: возвращает до 50 комментариев поста, отсортированных по времени", async () => {
	const rows = [];
	for (let i = 1; i <= 60; i++) {
		rows.push({
			ownerPubkey: OWNER,
			id: `c${i}`,
			postId: "post-1",
			parentId: "post-1",
			channelId: CHANNEL_ID,
			authorPubkey: OWNER,
			text: `комментарий ${i}`,
			attachments: [],
			keyVersion: 1,
			createdAt: i,
			deleted: false,
		});
	}
	await db.table("comments").bulkAdd(rows);
	const { comments, hasMore } = await loadCommentsWindow(OWNER, "post-1", { limit: 50 });
	assert.equal(comments.length, 50);
	assert.equal(hasMore, true);
	assert.equal(comments[0].createdAt, 11);
	assert.equal(comments[49].createdAt, 60);
});

test("loadCommentsWindow: не путает разные посты", async () => {
	await db.table("comments").bulkAdd([
		{ ownerPubkey: OWNER, id: "c1", postId: "post-1", parentId: "post-1", channelId: CHANNEL_ID, authorPubkey: OWNER, text: "a", attachments: [], keyVersion: 1, createdAt: 1, deleted: false },
		{ ownerPubkey: OWNER, id: "c2", postId: "post-2", parentId: "post-2", channelId: CHANNEL_ID, authorPubkey: OWNER, text: "b", attachments: [], keyVersion: 1, createdAt: 1, deleted: false },
	]);
	const { comments } = await loadCommentsWindow(OWNER, "post-1", { limit: 50 });
	assert.equal(comments.length, 1);
	assert.equal(comments[0].text, "a");
});

async function seedChannelMessages(count, { channelId = CHANNEL_ID, ownerPubkey = OWNER } = {}) {
	const rows = [];
	for (let i = 1; i <= count; i++) {
		rows.push({
			ownerPubkey,
			id: `${channelId}-msg-${i}`,
			channelId,
			authorPubkey: ownerPubkey,
			text: `сообщение ${i}`,
			attachments: [],
			keyVersion: 1,
			createdAt: i,
		});
	}
	await db.table("channelMessages").bulkAdd(rows);
}

test("loadChannelChatWindow: возвращает последние N сообщений (лимит 15 по ТЗ)", async () => {
	await seedChannelMessages(20);
	const { messages, hasMore } = await loadChannelChatWindow(OWNER, CHANNEL_ID, { limit: 15 });
	assert.equal(messages.length, 15);
	assert.equal(messages[0].createdAt, 6);
	assert.equal(messages[14].createdAt, 20);
	assert.equal(hasMore, true);
});

test("loadChannelChatWindow: меньше сообщений, чем limit -> hasMore=false", async () => {
	await seedChannelMessages(5);
	const { messages, hasMore } = await loadChannelChatWindow(OWNER, CHANNEL_ID, { limit: 15 });
	assert.equal(messages.length, 5);
	assert.equal(hasMore, false);
});

test("loadChannelChatWindow: beforeCreatedAt подгружает более старое окно", async () => {
	await seedChannelMessages(20);
	const first = await loadChannelChatWindow(OWNER, CHANNEL_ID, { limit: 15 });
	const oldestLoaded = first.messages[0]; // createdAt=6
	const second = await loadChannelChatWindow(OWNER, CHANNEL_ID, { limit: 15, beforeCreatedAt: oldestLoaded.createdAt });
	assert.equal(second.messages.length, 5);
	assert.equal(second.messages[0].createdAt, 1);
	assert.equal(second.hasMore, false);
});

test("loadChannelChatWindow: не путает разные каналы", async () => {
	await seedChannelMessages(3, { channelId: "channel-A" });
	await seedChannelMessages(2, { channelId: "channel-B" });
	const { messages } = await loadChannelChatWindow(OWNER, "channel-B", { limit: 15 });
	assert.equal(messages.length, 2);
});
