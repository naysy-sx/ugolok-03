import "fake-indexeddb/auto";
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { db } from "../src/core/store/database.js";
import { getPublicKey } from "../src/core/crypto/keys.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
	buildReadStatusEvent,
	parseReadStatusEvent,
	foldReadStatus,
	markChatAsRead,
	getUnreadCount,
	rebuildReadStatus,
} from "../src/domain/messaging/read-status.js";

const ALICE_PRIV = new Uint8Array(32).fill(1);
const BOB_PRIV = new Uint8Array(32).fill(2);
const CAROL_PRIV = new Uint8Array(32).fill(3);
const ALICE_PUB = bytesToHex(getPublicKey(ALICE_PRIV));
const BOB_PUB = bytesToHex(getPublicKey(BOB_PRIV));
const CAROL_PUB = bytesToHex(getPublicKey(CAROL_PRIV));
const DB_KEY = crypto.getRandomValues(new Uint8Array(32));

before(async () => {
	await db.open();
});

beforeEach(async () => {
	await db.table("chatSyncState").clear();
	await db.table("messages").clear();
	await db.table("events").clear();
});

after(() => {
	db.close();
});

test("buildReadStatusEvent/parseReadStatusEvent: round-trip, d-tag = chatId в открытом виде", () => {
	const event = buildReadStatusEvent(ALICE_PRIV, { chatId: BOB_PUB, lastReadLamportTs: 5 });
	assert.equal(event.kind, 30070);
	assert.deepEqual(event.tags, [["d", BOB_PUB]]);
	const parsed = parseReadStatusEvent(event, ALICE_PRIV);
	assert.deepEqual(parsed, { chatId: BOB_PUB, lastReadLamportTs: 5 });
});

test("foldReadStatus: сохраняет lastReadLamportTs в chatSyncState", async () => {
	const event = buildReadStatusEvent(ALICE_PRIV, { chatId: BOB_PUB, lastReadLamportTs: 10 });
	await foldReadStatus(event, ALICE_PRIV, DB_KEY);
	const row = await db.table("chatSyncState").get([ALICE_PUB, BOB_PUB]);
	assert.equal(row.lastReadLamportTs, 10);
});

test("foldReadStatus: monotonic guard — не откатывает назад более свежее локальное значение", async () => {
	await foldReadStatus(buildReadStatusEvent(ALICE_PRIV, { chatId: BOB_PUB, lastReadLamportTs: 20 }), ALICE_PRIV, DB_KEY);
	await foldReadStatus(buildReadStatusEvent(ALICE_PRIV, { chatId: BOB_PUB, lastReadLamportTs: 5 }), ALICE_PRIV, DB_KEY);
	const row = await db.table("chatSyncState").get([ALICE_PUB, BOB_PUB]);
	assert.equal(row.lastReadLamportTs, 20, "более старая версия не должна откатить назад");
});

test("foldReadStatus: переводит sent->read ТОЛЬКО входящие сообщения (не свои же исходящие)", async () => {
	await db.table("messages").bulkAdd([
		{ ownerPubkey: ALICE_PUB, chatId: BOB_PUB, lamportTs: 1, senderPubkey: BOB_PUB, id: "in1", text: "от Боба", status: "sent", msgId: "m1" },
		{ ownerPubkey: ALICE_PUB, chatId: BOB_PUB, lamportTs: 2, senderPubkey: ALICE_PUB, id: "out1", text: "от меня", status: "sent", msgId: "m2" },
		{ ownerPubkey: ALICE_PUB, chatId: BOB_PUB, lamportTs: 3, senderPubkey: BOB_PUB, id: "in2", text: "ещё от Боба, позже прочитанного", status: "sent", msgId: "m3" },
	]);
	const event = buildReadStatusEvent(ALICE_PRIV, { chatId: BOB_PUB, lastReadLamportTs: 2 });
	// событие "прочитано" в этом чате публикует САМА Алиса — event.pubkey === ALICE_PUB
	await foldReadStatus(event, ALICE_PRIV, DB_KEY);

	const in1 = await db.table("messages").where("id").equals("in1").first();
	assert.equal(in1.status, "read", "входящее до lastReadLamportTs -> read");
	const out1 = await db.table("messages").where("id").equals("out1").first();
	assert.equal(out1.status, "sent", "своё собственное сообщение не переводится этим механизмом");
	const in2 = await db.table("messages").where("id").equals("in2").first();
	assert.equal(in2.status, "sent", "входящее ПОСЛЕ lastReadLamportTs остаётся sent");
});

test("foldReadStatus: идемпотентность — повторный fold той же версии не бросает (уже read)", async () => {
	await db.table("messages").add({
		ownerPubkey: ALICE_PUB,
		chatId: BOB_PUB,
		lamportTs: 1,
		senderPubkey: BOB_PUB,
		id: "in1",
		text: "от Боба",
		status: "sent",
		msgId: "m1",
	});
	const event = buildReadStatusEvent(ALICE_PRIV, { chatId: BOB_PUB, lastReadLamportTs: 5 });
	await foldReadStatus(event, ALICE_PRIV, DB_KEY);
	await foldReadStatus(event, ALICE_PRIV, DB_KEY); // повтор — не должен бросить
	const in1 = await db.table("messages").where("id").equals("in1").first();
	assert.equal(in1.status, "read");
});

test("markChatAsRead: публикует событие и применяет fold локально сразу", async () => {
	await db.table("messages").add({
		ownerPubkey: ALICE_PUB,
		chatId: BOB_PUB,
		lamportTs: 1,
		senderPubkey: BOB_PUB,
		id: "in1",
		text: "от Боба",
		status: "sent",
		msgId: "m1",
	});
	let publishedEvent;
	const publish = async (event) => {
		publishedEvent = event;
		return { ok: true };
	};
	await markChatAsRead(ALICE_PUB, ALICE_PRIV, DB_KEY, BOB_PUB, 1, publish);
	assert.equal(publishedEvent.kind, 30070);
	const in1 = await db.table("messages").where("id").equals("in1").first();
	assert.equal(in1.status, "read");
});

test("markChatAsRead: сбой публикации -> throw, не применяет fold локально", async () => {
	const publish = async () => ({ ok: false, reason: "отклонено" });
	await assert.rejects(() => markChatAsRead(ALICE_PUB, ALICE_PRIV, DB_KEY, BOB_PUB, 1, publish), /отклонено/);
	assert.equal(await db.table("chatSyncState").get([ALICE_PUB, BOB_PUB]), undefined);
});

test("getUnreadCount: считает входящие сообщения после lastReadLamportTs", async () => {
	await db.table("messages").bulkAdd([
		{ ownerPubkey: ALICE_PUB, chatId: BOB_PUB, lamportTs: 1, senderPubkey: BOB_PUB, id: "in1", text: "1", status: "sent", msgId: "m1" },
		{ ownerPubkey: ALICE_PUB, chatId: BOB_PUB, lamportTs: 2, senderPubkey: BOB_PUB, id: "in2", text: "2", status: "sent", msgId: "m2" },
		{ ownerPubkey: ALICE_PUB, chatId: BOB_PUB, lamportTs: 3, senderPubkey: ALICE_PUB, id: "out1", text: "3", status: "sent", msgId: "m3" },
	]);
	assert.equal(await getUnreadCount(ALICE_PUB, BOB_PUB), 2, "без read-status всё входящее непрочитано");
	await foldReadStatus(buildReadStatusEvent(ALICE_PRIV, { chatId: BOB_PUB, lastReadLamportTs: 1 }), ALICE_PRIV, DB_KEY);
	assert.equal(await getUnreadCount(ALICE_PUB, BOB_PUB), 1);
});

// AC-06 (TECH.md §15): read-status обязан синхронизироваться МЕЖДУ устройствами.
// До rebuildReadStatus markChatAsRead публиковала kind 30070, но НИ ОДНО устройство
// (включая то же самое при холодном рестарте) никогда не читало его обратно —
// foldReadStatus вызывалась ТОЛЬКО из markChatAsRead на устройстве-публикаторе сразу
// после публикации. rebuildReadStatus — тот же паттерн, что rebuildUiSettings (этап
// 34): читает уже накопленный локальный кэш bootstrap'а (широкий REQ authors:[me]
// без ограничения по kind, см. bootstrap.js) по [pubkey+kind], а не сеть напрямую.
test("rebuildReadStatus: восстанавливает read-status из локального кэша events (AC-06 — кросс-device sync)", async () => {
	await db.table("messages").add({
		ownerPubkey: ALICE_PUB,
		chatId: BOB_PUB,
		lamportTs: 5,
		senderPubkey: BOB_PUB,
		id: "in1",
		text: "от Боба",
		status: "sent",
		msgId: "m1",
	});
	const event = buildReadStatusEvent(ALICE_PRIV, { chatId: BOB_PUB, lastReadLamportTs: 5 });
	await db.table("events").add(event);

	assert.equal(await db.table("chatSyncState").get([ALICE_PUB, BOB_PUB]), undefined, "до rebuild — ничего не применено");
	await rebuildReadStatus(ALICE_PUB, ALICE_PRIV, DB_KEY);

	const state = await db.table("chatSyncState").get([ALICE_PUB, BOB_PUB]);
	assert.equal(state.lastReadLamportTs, 5);
	const in1 = await db.table("messages").where("id").equals("in1").first();
	assert.equal(in1.status, "read", "сообщение реально помечено прочитанным на этом устройстве");
});

test("rebuildReadStatus: несколько чатов — независимый read-status на каждый (не путает по chatId)", async () => {
	const eventBob = buildReadStatusEvent(ALICE_PRIV, { chatId: BOB_PUB, lastReadLamportTs: 3 });
	const eventCarol = buildReadStatusEvent(ALICE_PRIV, { chatId: CAROL_PUB, lastReadLamportTs: 7 });
	await db.table("events").bulkAdd([eventBob, eventCarol]);

	await rebuildReadStatus(ALICE_PUB, ALICE_PRIV, DB_KEY);

	assert.equal((await db.table("chatSyncState").get([ALICE_PUB, BOB_PUB])).lastReadLamportTs, 3);
	assert.equal((await db.table("chatSyncState").get([ALICE_PUB, CAROL_PUB])).lastReadLamportTs, 7);
});

test("rebuildReadStatus: несколько версий для ОДНОГО чата — берёт ПОСЛЕДНЮЮ (LWW по created_at), не первую попавшуюся", async () => {
	const older = buildReadStatusEvent(ALICE_PRIV, { chatId: BOB_PUB, lastReadLamportTs: 2 }, 1000);
	const newer = buildReadStatusEvent(ALICE_PRIV, { chatId: BOB_PUB, lastReadLamportTs: 9 }, 2000);
	await db.table("events").bulkAdd([older, newer]);

	await rebuildReadStatus(ALICE_PUB, ALICE_PRIV, DB_KEY);
	assert.equal((await db.table("chatSyncState").get([ALICE_PUB, BOB_PUB])).lastReadLamportTs, 9);
});

test("rebuildReadStatus АДВЕРСАРНО: нет ни одного kind 30070 в events — no-op, не бросает", async () => {
	await assert.doesNotReject(() => rebuildReadStatus(ALICE_PUB, ALICE_PRIV, DB_KEY));
});
