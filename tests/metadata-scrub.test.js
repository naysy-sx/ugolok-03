import "fake-indexeddb/auto";
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db } from "../src/core/store/database.js";
import { getPublicKey } from "../src/core/crypto/keys.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { sign } from "../src/core/crypto/sign.js";
import { encrypt as nip44Encrypt } from "../src/core/crypto/nip44.js";
import { toEncryptedRow } from "../src/core/store/encrypted-table.js";
import { CHAT_SYNC_STATE_PLAINTEXT_FIELDS } from "../src/core/store/table-fields.js";
import { scrubLegacyMetadata } from "../src/domain/messaging/metadata-scrub.js";

// AUDIT-EGOROD J1: зачистка старых событий с открытыми d-тегами.

const PRIV = new Uint8Array(32).fill(1);
const PUB = bytesToHex(getPublicKey(PRIV));
const BOB = bytesToHex(getPublicKey(new Uint8Array(32).fill(2)));
const DB_KEY = crypto.getRandomValues(new Uint8Array(32));

const legacy = (kind, dTag, body, at = 1000) => ({
	...sign({ kind, tags: [["d", dTag]], content: nip44Encrypt(JSON.stringify(body), PRIV, PUB), created_at: at }, PRIV),
	flatTags: [],
});

beforeEach(async () => {
	for (const t of ["events", "chatSyncState", "keystore", "channelSyncState"]) await db.table(t).clear();
	await db.table("keystore").put({ id: PUB });
});

function recorder(ok = true) {
	const published = [];
	return { published, publish: async (e) => (published.push(e), { ok }) };
}

test("старое событие 30070 -> состояние переопубликовано под непрозрачным тегом, затем удалено по NIP-09", async () => {
	await db.table("events").add(legacy(30070, BOB, { lastReadLamportTs: 7 }));
	await db.table("chatSyncState").put(toEncryptedRow({ ownerPubkey: PUB, chatId: BOB, lastReadLamportTs: 7 }, CHAT_SYNC_STATE_PLAINTEXT_FIELDS, DB_KEY));
	const { published, publish } = recorder();
	const res = await scrubLegacyMetadata(PUB, PRIV, DB_KEY, publish);
	assert.deepEqual(res, { scrubbed: true, deleted: 1 });
	assert.equal(published[0].kind, 30070);
	assert.ok(!JSON.stringify(published[0]).includes(BOB), "новое событие не светит pubkey");
	assert.equal(published[1].kind, 5, "удаление — после публикации нового");
	assert.deepEqual(published[1].tags, [["a", `30070:${PUB}:${BOB}`]]);
	assert.equal(await db.table("events").count(), 0, "старая строка убрана из локального журнала");
	assert.equal((await db.table("keystore").get(PUB)).metadataScrubV1, true);
});

test("повторный запуск после флага — ничего не публикует", async () => {
	await db.table("events").add(legacy(30070, BOB, { lastReadLamportTs: 7 }));
	const first = recorder();
	await scrubLegacyMetadata(PUB, PRIV, DB_KEY, first.publish);
	const second = recorder();
	const res = await scrubLegacyMetadata(PUB, PRIV, DB_KEY, second.publish);
	assert.equal(res.skipped, true);
	assert.equal(second.published.length, 0);
});

test("сбой публикации — флаг не ставится, старые события не удаляются (повтор при следующем подключении)", async () => {
	await db.table("events").add(legacy(30070, BOB, { lastReadLamportTs: 7 }));
	await db.table("chatSyncState").put(toEncryptedRow({ ownerPubkey: PUB, chatId: BOB, lastReadLamportTs: 7 }, CHAT_SYNC_STATE_PLAINTEXT_FIELDS, DB_KEY));
	const { published, publish } = recorder(false);
	const res = await scrubLegacyMetadata(PUB, PRIV, DB_KEY, publish);
	assert.equal(res.scrubbed, false);
	assert.ok(published.every((e) => e.kind !== 5), "удаление не отправляется, пока новое не принято relay");
	assert.equal(await db.table("events").count(), 1);
	assert.equal((await db.table("keystore").get(PUB)).metadataScrubV1, undefined);
});

test("нет старых событий -> флаг ставится сразу, без публикаций", async () => {
	const { published, publish } = recorder();
	assert.deepEqual(await scrubLegacyMetadata(PUB, PRIV, DB_KEY, publish), { scrubbed: true, deleted: 0 });
	assert.equal(published.length, 0);
});

test("событие нового формата (chatId в шифртексте) зачистке не подлежит", async () => {
	await db.table("events").add(legacy(30070, "f".repeat(64), { lastReadLamportTs: 7, chatId: BOB }));
	const { published, publish } = recorder();
	await scrubLegacyMetadata(PUB, PRIV, DB_KEY, publish);
	assert.equal(published.length, 0);
});
