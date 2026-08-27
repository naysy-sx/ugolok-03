import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { place, DEFAULT_PLACE, goTo, openChat, openChannel, openChannelPost } from "../src/ui/signals/place.js";
import { applyNavTarget } from "../src/ui/signals/notification-nav.js";

beforeEach(() => {
	place.value = DEFAULT_PLACE;
});

// Редизайн интерфейса, этап 10.1 (CONTRACTS.md/DESIGN.md) — place как
// единственный источник "где я нахожусь".

test("DEFAULT_PLACE: kind='journal'", () => {
	assert.deepEqual(place.value, { kind: "journal" });
});

test("goTo: полная замена, не merge — старые postId/commentId не переживают смену kind", () => {
	place.value = { kind: "channel", id: "chan-1", postId: "p1", commentId: "c1", subTab: "posts" };
	goTo({ kind: "journal" });
	assert.deepEqual(place.value, { kind: "journal" });
});

test("openChat(pubkey): kind='chat', id=pubkey", () => {
	openChat("bob-pub");
	assert.deepEqual(place.value, { kind: "chat", id: "bob-pub" });
});

test("openChat(null): kind='chat', id не определён (режим списка)", () => {
	openChat("bob-pub");
	openChat(null);
	assert.equal(place.value.kind, "chat");
	assert.equal(place.value.id, undefined);
});

test("openChannel(id): kind='channel', id=channelId, без subTab/postId/commentId по умолчанию", () => {
	openChannel("chan-1");
	assert.deepEqual(place.value, { kind: "channel", id: "chan-1", subTab: undefined, postId: undefined, commentId: undefined });
});

test("openChannel(id, target): переносит subTab/postId/commentId ОДНИМ атомарным присваиванием", () => {
	openChannel("chan-1", { postId: "p1", commentId: "c1", subTab: "posts" });
	assert.deepEqual(place.value, { kind: "channel", id: "chan-1", subTab: "posts", postId: "p1", commentId: "c1" });
});

test("openChannel(null): kind='channels' (список), не 'channel' с пустым id", () => {
	openChannel("chan-1");
	openChannel(null);
	assert.deepEqual(place.value, { kind: "channels" });
});

test("openChannelPost: kind='channel' с postId/commentId, не сбрасывает их", () => {
	openChannelPost("chan-1", "p1", "c1");
	assert.deepEqual(place.value, { kind: "channel", id: "chan-1", postId: "p1", commentId: "c1" });
	openChannelPost("chan-1", "p2");
	assert.equal(place.value.postId, "p2");
	assert.equal(place.value.commentId, undefined);
});

test("АДВЕРСАРНО: смена канала БЕЗ target сбрасывает postId/commentId предыдущего канала (не утекают в новый)", () => {
	openChannel("chan-1", { postId: "p1", commentId: "c1" });
	openChannel("chan-2");
	assert.equal(place.value.id, "chan-2");
	assert.equal(place.value.postId, undefined);
	assert.equal(place.value.commentId, undefined);
});

// applyNavTarget — разбор всех форм navTarget из уведомлений (DESIGN.md, таблица)

test("applyNavTarget: {screen:'contacts'} -> {kind:'people'}", () => {
	applyNavTarget({ screen: "contacts" });
	assert.deepEqual(place.value, { kind: "people" });
});

test("applyNavTarget: {screen:'messages', contactPubkey} -> {kind:'chat', id}", () => {
	applyNavTarget({ screen: "messages", contactPubkey: "bob-pub" });
	assert.deepEqual(place.value, { kind: "chat", id: "bob-pub" });
});

test("applyNavTarget: {screen:'messages'} (без contactPubkey) -> {kind:'chat'} (список)", () => {
	applyNavTarget({ screen: "messages" });
	assert.equal(place.value.kind, "chat");
	assert.equal(place.value.id, undefined);
});

test("applyNavTarget: {screen:'channels'} (канал удалён, без channelId) -> {kind:'channels'}", () => {
	applyNavTarget({ screen: "channels" });
	assert.deepEqual(place.value, { kind: "channels" });
});

test("applyNavTarget: {screen:'channels', channelId, postId, subTab:'posts'} (новый пост) -> {kind:'channel', id, postId, subTab}", () => {
	applyNavTarget({ screen: "channels", channelId: "chan-1", postId: "post-1", subTab: "posts" });
	assert.deepEqual(place.value, { kind: "channel", id: "chan-1", subTab: "posts", postId: "post-1", commentId: undefined });
});

test("applyNavTarget: {screen:'channels', channelId, postId, commentId, subTab:'posts'} (комментарий) -> все поля перенесены", () => {
	applyNavTarget({ screen: "channels", channelId: "chan-1", postId: "post-1", commentId: "comment-1", subTab: "posts" });
	assert.deepEqual(place.value, { kind: "channel", id: "chan-1", subTab: "posts", postId: "post-1", commentId: "comment-1" });
});

test("applyNavTarget: {screen:'channels', channelId, subTab:'chat'} (сообщение чата канала) -> {kind:'channel', id, subTab:'chat'}", () => {
	applyNavTarget({ screen: "channels", channelId: "chan-1", subTab: "chat" });
	assert.deepEqual(place.value, { kind: "channel", id: "chan-1", subTab: "chat", postId: undefined, commentId: undefined });
});

test("applyNavTarget: {screen:'channels', channelId, subTab:'moderation'} (бан/жалоба) -> {kind:'channel', id, subTab:'moderation'}", () => {
	applyNavTarget({ screen: "channels", channelId: "chan-1", subTab: "moderation" });
	assert.deepEqual(place.value, { kind: "channel", id: "chan-1", subTab: "moderation", postId: undefined, commentId: undefined });
});
