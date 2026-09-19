import "fake-indexeddb/auto";
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { db } from "../src/core/store/database.js";
import { getPublicKey } from "../src/core/crypto/keys.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { buildDraftEvent, parseDraftEvent, foldDraft, saveDraft, getDraft, draftDTag } from "../src/domain/messaging/drafts.js";
import { sign } from "../src/core/crypto/sign.js";
import { encrypt as nip44Encrypt } from "../src/core/crypto/nip44.js";
import { toEncryptedRow, fromEncryptedRow } from "../src/core/store/encrypted-table.js";
import { CHAT_SYNC_STATE_PLAINTEXT_FIELDS } from "../src/core/store/table-fields.js";

const ALICE_PRIV = new Uint8Array(32).fill(1);
const BOB_PRIV = new Uint8Array(32).fill(2);
const ALICE_PUB = bytesToHex(getPublicKey(ALICE_PRIV));
const BOB_PUB = bytesToHex(getPublicKey(BOB_PRIV));
const DB_KEY = crypto.getRandomValues(new Uint8Array(32));

before(async () => {
	await db.open();
});

beforeEach(async () => {
	await db.table("chatSyncState").clear();
});

after(() => {
	db.close();
});

test("buildDraftEvent/parseDraftEvent: round-trip, d-tag непрозрачен (AUDIT-EGOROD J1)", () => {
	const event = buildDraftEvent(ALICE_PRIV, { chatId: BOB_PUB, text: "не дописал" });
	assert.equal(event.kind, 30071);
	assert.equal(event.tags[0][1], draftDTag(ALICE_PRIV, BOB_PUB));
	assert.ok(!JSON.stringify(event).includes(BOB_PUB), "pubkey собеседника не в открытой части");
	assert.deepEqual(parseDraftEvent(event, ALICE_PRIV), { chatId: BOB_PUB, text: "не дописал", legacy: false });
});

test("parseDraftEvent: старый черновик (chatId в d-теге) читается", () => {
	const legacy = sign({ kind: 30071, tags: [["d", BOB_PUB]], content: nip44Encrypt(JSON.stringify({ text: "старый" }), ALICE_PRIV, ALICE_PUB), created_at: 5 }, ALICE_PRIV);
	assert.deepEqual(parseDraftEvent(legacy, ALICE_PRIV), { chatId: BOB_PUB, text: "старый", legacy: true });
});

test("foldDraft: запоздавшее СТАРОЕ событие не затирает более новый черновик (LWW, B2)", async () => {
	await foldDraft(buildDraftEvent(ALICE_PRIV, { chatId: BOB_PUB, text: "новый" }, 2000), ALICE_PRIV, DB_KEY);
	await foldDraft(buildDraftEvent(ALICE_PRIV, { chatId: BOB_PUB, text: "старый" }, 1000), ALICE_PRIV, DB_KEY);
	assert.equal(await getDraft(ALICE_PUB, DB_KEY, BOB_PUB), "новый");
	await foldDraft(buildDraftEvent(ALICE_PRIV, { chatId: BOB_PUB, text: "тоже новый, та же секунда" }, 2000), ALICE_PRIV, DB_KEY);
	assert.equal(await getDraft(ALICE_PUB, DB_KEY, BOB_PUB), "тоже новый, та же секунда");
});

test("buildDraftEvent: пустой text валиден (стирание черновика)", () => {
	const event = buildDraftEvent(ALICE_PRIV, { chatId: BOB_PUB, text: "" });
	assert.deepEqual(parseDraftEvent(event, ALICE_PRIV), { chatId: BOB_PUB, text: "", legacy: false });
});

// AC-16 (найдено пользователем прямым осмотром IndexedDB) — черновик (ещё не
// отправленное сообщение) содержательно приватнее уже прочитанного текста.
test("AC-16: chatSyncState хранится зашифрованным — сырой дамп не содержит draftText", async () => {
	await foldDraft(buildDraftEvent(ALICE_PRIV, { chatId: BOB_PUB, text: "секретный черновик" }), ALICE_PRIV, DB_KEY);
	const raw = await db.table("chatSyncState").get([ALICE_PUB, BOB_PUB]);
	assert.equal(raw.ownerPubkey, ALICE_PUB);
	assert.equal("draftText" in raw, false);
	assert.ok(raw.nonce instanceof Uint8Array);
	assert.ok(raw.ciphertext instanceof Uint8Array);

	const decrypted = fromEncryptedRow(raw, DB_KEY);
	assert.equal(decrypted.draftText, "секретный черновик");
});

test("foldDraft/getDraft: сохраняет и возвращает текст черновика по chatId", async () => {
	const event = buildDraftEvent(ALICE_PRIV, { chatId: BOB_PUB, text: "привет, как дела" });
	await foldDraft(event, ALICE_PRIV, DB_KEY);
	assert.equal(await getDraft(ALICE_PUB, DB_KEY, BOB_PUB), "привет, как дела");
});

test("getDraft: нет черновика -> пустая строка, не throw/undefined", async () => {
	assert.equal(await getDraft(ALICE_PUB, DB_KEY, BOB_PUB), "");
});

test("foldDraft: не путает черновики разных чатов", async () => {
	const carolPub = "c".repeat(64);
	await foldDraft(buildDraftEvent(ALICE_PRIV, { chatId: BOB_PUB, text: "для Боба" }), ALICE_PRIV, DB_KEY);
	await foldDraft(buildDraftEvent(ALICE_PRIV, { chatId: carolPub, text: "для Кэрол" }), ALICE_PRIV, DB_KEY);
	assert.equal(await getDraft(ALICE_PUB, DB_KEY, BOB_PUB), "для Боба");
	assert.equal(await getDraft(ALICE_PUB, DB_KEY, carolPub), "для Кэрол");
});

test("saveDraft: публикует и применяет fold сразу", async () => {
	let publishedEvent;
	const publish = async (event) => {
		publishedEvent = event;
		return { ok: true };
	};
	await saveDraft(ALICE_PUB, ALICE_PRIV, DB_KEY, BOB_PUB, "черновик", publish);
	assert.equal(publishedEvent.kind, 30071);
	assert.equal(await getDraft(ALICE_PUB, DB_KEY, BOB_PUB), "черновик");
});

// AUDIT-EGOROD D2: оффлайн черновик больше не пропадает — локально сохраняется ДО публикации.
test("saveDraft: сбой публикации -> throw, но черновик сохранён локально", async () => {
	const publish = async () => ({ ok: false, reason: "отклонено" });
	await assert.rejects(() => saveDraft(ALICE_PUB, ALICE_PRIV, DB_KEY, BOB_PUB, "текст", publish), /отклонено/);
	assert.equal(await getDraft(ALICE_PUB, DB_KEY, BOB_PUB), "текст");
});

test("foldDraft: не затирает lastReadLamportTs той же строки chatSyncState (общая таблица с read-status)", async () => {
	await db.table("chatSyncState").put(toEncryptedRow({ ownerPubkey: ALICE_PUB, chatId: BOB_PUB, lastReadLamportTs: 42 }, CHAT_SYNC_STATE_PLAINTEXT_FIELDS, DB_KEY));
	await foldDraft(buildDraftEvent(ALICE_PRIV, { chatId: BOB_PUB, text: "новый черновик" }), ALICE_PRIV, DB_KEY);
	const row = fromEncryptedRow(await db.table("chatSyncState").get([ALICE_PUB, BOB_PUB]), DB_KEY);
	assert.equal(row.lastReadLamportTs, 42, "foldDraft не должен затирать другие поля той же строки");
	assert.equal(row.draftText, "новый черновик");
});
