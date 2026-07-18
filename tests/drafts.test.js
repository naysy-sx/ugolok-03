import "fake-indexeddb/auto";
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { db } from "../src/core/store/database.js";
import { getPublicKey } from "../src/core/crypto/keys.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { buildDraftEvent, parseDraftEvent, foldDraft, saveDraft, getDraft } from "../src/domain/messaging/drafts.js";

const ALICE_PRIV = new Uint8Array(32).fill(1);
const BOB_PRIV = new Uint8Array(32).fill(2);
const ALICE_PUB = bytesToHex(getPublicKey(ALICE_PRIV));
const BOB_PUB = bytesToHex(getPublicKey(BOB_PRIV));

before(async () => {
	await db.open();
});

beforeEach(async () => {
	await db.table("chatSyncState").clear();
});

after(() => {
	db.close();
});

test("buildDraftEvent/parseDraftEvent: round-trip, d-tag = chatId в открытом виде", () => {
	const event = buildDraftEvent(ALICE_PRIV, { chatId: BOB_PUB, text: "не дописал" });
	assert.equal(event.kind, 30071);
	assert.deepEqual(event.tags, [["d", BOB_PUB]]);
	assert.deepEqual(parseDraftEvent(event, ALICE_PRIV), { chatId: BOB_PUB, text: "не дописал" });
});

test("buildDraftEvent: пустой text валиден (стирание черновика)", () => {
	const event = buildDraftEvent(ALICE_PRIV, { chatId: BOB_PUB, text: "" });
	assert.deepEqual(parseDraftEvent(event, ALICE_PRIV), { chatId: BOB_PUB, text: "" });
});

test("foldDraft/getDraft: сохраняет и возвращает текст черновика по chatId", async () => {
	const event = buildDraftEvent(ALICE_PRIV, { chatId: BOB_PUB, text: "привет, как дела" });
	await foldDraft(event, ALICE_PRIV);
	assert.equal(await getDraft(ALICE_PUB, BOB_PUB), "привет, как дела");
});

test("getDraft: нет черновика -> пустая строка, не throw/undefined", async () => {
	assert.equal(await getDraft(ALICE_PUB, BOB_PUB), "");
});

test("foldDraft: не путает черновики разных чатов", async () => {
	const carolPub = "c".repeat(64);
	await foldDraft(buildDraftEvent(ALICE_PRIV, { chatId: BOB_PUB, text: "для Боба" }), ALICE_PRIV);
	await foldDraft(buildDraftEvent(ALICE_PRIV, { chatId: carolPub, text: "для Кэрол" }), ALICE_PRIV);
	assert.equal(await getDraft(ALICE_PUB, BOB_PUB), "для Боба");
	assert.equal(await getDraft(ALICE_PUB, carolPub), "для Кэрол");
});

test("saveDraft: публикует и применяет fold сразу", async () => {
	let publishedEvent;
	const publish = async (event) => {
		publishedEvent = event;
		return { ok: true };
	};
	await saveDraft(ALICE_PUB, ALICE_PRIV, BOB_PUB, "черновик", publish);
	assert.equal(publishedEvent.kind, 30071);
	assert.equal(await getDraft(ALICE_PUB, BOB_PUB), "черновик");
});

test("saveDraft: сбой публикации -> throw, локально не применяется", async () => {
	const publish = async () => ({ ok: false, reason: "отклонено" });
	await assert.rejects(() => saveDraft(ALICE_PUB, ALICE_PRIV, BOB_PUB, "текст", publish), /отклонено/);
	assert.equal(await getDraft(ALICE_PUB, BOB_PUB), "");
});

test("foldDraft: не затирает lastReadLamportTs той же строки chatSyncState (общая таблица с read-status)", async () => {
	await db.table("chatSyncState").put({ ownerPubkey: ALICE_PUB, chatId: BOB_PUB, lastReadLamportTs: 42 });
	await foldDraft(buildDraftEvent(ALICE_PRIV, { chatId: BOB_PUB, text: "новый черновик" }), ALICE_PRIV);
	const row = await db.table("chatSyncState").get([ALICE_PUB, BOB_PUB]);
	assert.equal(row.lastReadLamportTs, 42, "foldDraft не должен затирать другие поля той же строки");
	assert.equal(row.draftText, "новый черновик");
});
