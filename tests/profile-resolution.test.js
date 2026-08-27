import "fake-indexeddb/auto";
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { db } from "../src/core/store/database.js";
import { getPublicKey } from "../src/core/crypto/keys.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
	contacts,
	profiles,
	configureContactRuntime,
	applyProfileUpdates,
	ensureProfilesFresh,
	resetProfileRetryState,
	trimWatchedProfiles,
	watchProfiles,
	listWatchedProfiles,
} from "../src/ui/signals/contacts.js";
import { fromEncryptedRow, toEncryptedRow } from "../src/core/store/encrypted-table.js";
import { CONTACT_PROFILES_PLAINTEXT_FIELDS } from "../src/core/store/table-fields.js";

// CHANNEL-V2, часть A (ТЗ: PROCESS-DOCS/REDESIGN/CHANNEL-2/CHANNEL-V2-TASK.md, §A5).
// Приёмочные тесты для четырёх точечных правок "коды вместо имён".

const PRIV_KEY = new Uint8Array(32).fill(21);
const OWNER_PUBKEY = bytesToHex(getPublicKey(PRIV_KEY));
const DB_KEY = crypto.getRandomValues(new Uint8Array(32));

const ALICE_PK = "a".repeat(64);
const BOB_PK = "b".repeat(64);

const okPublish = async () => ({ ok: true });

before(async () => {
	await db.open();
});

beforeEach(async () => {
	contacts.value = [];
	profiles.value = {};
	resetProfileRetryState();
	await db.table("contactProfiles").clear();
	await configureContactRuntime({ ownerPubkey: OWNER_PUBKEY, privKey: PRIV_KEY, dbKey: DB_KEY, publish: okPublish });
});

after(() => {
	db.close();
});

// --- ensureProfilesFresh (A2) ---

test("ensureProfilesFresh: не запрашивает pubkey, по которому в profiles.value лежит объект", async () => {
	profiles.value = { [ALICE_PK]: { name: "Алиса", createdAt: 1, id: "e1" } };
	let called = false;
	await ensureProfilesFresh([ALICE_PK], async () => {
		called = true;
		return new Map();
	});
	assert.equal(called, false);
});

test("ensureProfilesFresh: запрашивает pubkey с null в кэше; сразу повторённый вызов не запрашивает; с force:true — запрашивает", async () => {
	profiles.value = { [ALICE_PK]: null };
	let calls = 0;
	const fetchStub = async (pks) => {
		calls++;
		return new Map();
	};
	await ensureProfilesFresh([ALICE_PK], fetchStub);
	assert.equal(calls, 1, "первый вызов после null в кэше обязан запросить");

	await ensureProfilesFresh([ALICE_PK], fetchStub);
	assert.equal(calls, 1, "повтор сразу же — под остыванием, запрос не повторяется");

	await ensureProfilesFresh([ALICE_PK], fetchStub, { force: true });
	assert.equal(calls, 2, "force игнорирует остывание");
});

test("ensureProfilesFresh: force:true не перезапрашивает уже известный (непустой) профиль", async () => {
	profiles.value = { [ALICE_PK]: { name: "Алиса", createdAt: 1, id: "e1" } };
	let called = false;
	await ensureProfilesFresh([ALICE_PK], async () => {
		called = true;
		return new Map();
	}, { force: true });
	assert.equal(called, false);
});

// --- applyProfileUpdates: watched (A4) ---

test("applyProfileUpdates: не-контакт персистится в contactProfiles с watched:1", async () => {
	contacts.value = [];
	await applyProfileUpdates(new Map([[ALICE_PK, { name: "Алиса", createdAt: 1000, id: "ev1" }]]));
	const raw = await db.table("contactProfiles").get([OWNER_PUBKEY, ALICE_PK]);
	assert.ok(raw, "не-контакт теперь тоже персистируется (CHANNEL-V2 A4)");
	const row = fromEncryptedRow(raw, DB_KEY);
	assert.equal(row.watched, 1);
});

test("applyProfileUpdates: контакт персистится с watched:0", async () => {
	contacts.value = [ALICE_PK];
	await applyProfileUpdates(new Map([[ALICE_PK, { name: "Алиса", createdAt: 1000, id: "ev1" }]]));
	const raw = await db.table("contactProfiles").get([OWNER_PUBKEY, ALICE_PK]);
	const row = fromEncryptedRow(raw, DB_KEY);
	assert.equal(row.watched, 0);
});

// --- trimWatchedProfiles (A4.4) ---

// Строки заведены напрямую (не через applyProfileUpdates) — seenAt должен
// быть детерминированно РАЗНЫМ по строкам, а applyProfileUpdates всегда
// ставит Math.floor(Date.now()/1000), и тесты в одном тике легко получают
// одинаковую секунду (тай-брейк по seenAt тогда не проверялся бы).
async function seedContactProfileRow(contactPubkey, { watched, seenAt }) {
	await db.table("contactProfiles").put(
		toEncryptedRow(
			{ ownerPubkey: OWNER_PUBKEY, contactPubkey, name: `w-${contactPubkey.slice(0, 4)}`, watched, seenAt },
			CONTACT_PROFILES_PLAINTEXT_FIELDS,
			DB_KEY,
		),
	);
}

test("trimWatchedProfiles: оставляет ровно keep самых свежих watched:1, не трогает watched:0", async () => {
	await seedContactProfileRow(ALICE_PK, { watched: 0, seenAt: 1 }); // контакт — не чистится, независимо от seenAt

	const watchedPubkeys = [];
	for (let i = 0; i < 5; i++) {
		const pk = i.toString(16).padStart(64, "0");
		watchedPubkeys.push(pk);
		await seedContactProfileRow(pk, { watched: 1, seenAt: 1000 + i });
	}

	await trimWatchedProfiles(OWNER_PUBKEY, 2);

	const rows = await db.table("contactProfiles").where("ownerPubkey").equals(OWNER_PUBKEY).toArray();
	const decoded = rows.map((r) => fromEncryptedRow(r, DB_KEY));

	const aliceRow = decoded.find((r) => r.contactPubkey === ALICE_PK);
	assert.ok(aliceRow, "watched:0 (контакт) не должен был быть удалён");

	const remainingWatched = decoded.filter((r) => r.watched === 1);
	assert.equal(remainingWatched.length, 2, "должно остаться ровно keep=2 watched:1 записей");
	const remainingPubkeys = remainingWatched.map((r) => r.contactPubkey).sort();
	// Самые свежие по seenAt — последние два добавленных (i=3, i=4, seenAt=1003/1004).
	assert.deepEqual(remainingPubkeys, [watchedPubkeys[3], watchedPubkeys[4]].sort());
});

// --- watchProfiles (A3) — адверсарная фаза (skill п.19) ---

test("watchProfiles: повторное добавление того же pubkey -> added:false, не дублируется", () => {
	const pk = "watch-dup-test-pubkey";
	assert.equal(watchProfiles([pk]), true, "первое добавление — added:true");
	assert.equal(watchProfiles([pk]), false, "то же самое ещё раз — added:false");
	assert.equal(listWatchedProfiles().filter((p) => p === pk).length, 1, "не должно быть дубликата");
});

test("watchProfiles: пустой список -> added:false, не бросает", () => {
	assert.equal(watchProfiles([]), false);
});

test("watchProfiles АДВЕРСАРНО: переполнение MAX_WATCHED_PROFILES (256) вытесняет самые старые (FIFO)", () => {
	const before = listWatchedProfiles().length; // всё, что накопили предыдущие тесты этого файла
	const batch = [];
	for (let i = 0; i < 260; i++) batch.push(`fifo-${i}-${"f".repeat(50)}`);
	watchProfiles(batch);

	const after = listWatchedProfiles();
	assert.equal(after.length, 256, "размер множества не должен превышать MAX_WATCHED_PROFILES");

	// Set хранит порядок вставки: сначала выбывает всё, что было ДО этого батча
	// (оно старше), затем — самые ранние элементы САМОГО батча. Всего избыток —
	// before + 260 - 256, из них "before" уже покрыты старыми записями, значит
	// из батча выбывает ровно (before + 260 - 256 - before) = 4 самых первых.
	const evictedFromBatch = 4;
	for (let i = 0; i < evictedFromBatch; i++) {
		assert.ok(!after.includes(batch[i]), `batch[${i}] — среди самых старых, обязан был выбыть`);
	}
	for (let i = evictedFromBatch; i < 260; i++) {
		assert.ok(after.includes(batch[i]), `batch[${i}] — обязан остаться (более свежий)`);
	}
});
