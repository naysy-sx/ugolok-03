import "fake-indexeddb/auto";
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { db } from "../src/core/store/database.js";
import { getPublicKey } from "../src/core/crypto/keys.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { unwrap as nip59Unwrap, wrap as nip59Wrap } from "../src/core/crypto/nip59.js";
import { createContactRuntime, migrateLegacyContactTables, SelfContactRequestError } from "../src/domain/contacts/contact-runtime.js";
import { CONTACT_REQUEST_KIND, CONTACT_ACCEPTED_KIND, CONTACT_REJECTED_KIND, ACQUAINT_CANCELLED_KIND, buildContactRequestRumor } from "../src/domain/contacts/requests.js";
import { parseContactListEvent, parseMuteListEvent } from "../src/domain/contacts/contacts.js";
import { toEncryptedRow, fromEncryptedRow } from "../src/core/store/encrypted-table.js";
import { CONTACT_REQUESTS_PLAINTEXT_FIELDS } from "../src/core/store/table-fields.js";

const OWNER_PRIV = new Uint8Array(32).fill(5);
const OWNER_PUBKEY = bytesToHex(getPublicKey(OWNER_PRIV));
const BOB_PRIV = new Uint8Array(32).fill(7);
const BOB_PUBKEY = bytesToHex(getPublicKey(BOB_PRIV));
const ALICE_PRIV = new Uint8Array(32).fill(9);
const ALICE_PUBKEY = bytesToHex(getPublicKey(ALICE_PRIV));
const DB_KEY = crypto.getRandomValues(new Uint8Array(32));

before(async () => {
	await db.open();
});

beforeEach(async () => {
	await db.table("contacts").clear();
	await db.table("blockedContacts").clear();
	await db.table("contactRequests").clear();
	await db.table("contactRelationships").clear();
});

after(() => {
	db.close();
});

function collectingPublish(sink) {
	return async (event) => {
		sink.push(event);
		return { ok: true };
	};
}

function findGiftWrapOfKind(events, kind, unwrapPrivKey) {
	for (const event of events) {
		if (event.kind !== 1059) continue;
		try {
			const rumor = nip59Unwrap(event, unwrapPrivKey);
			if (rumor.kind === kind) return rumor;
		} catch {
			continue;
		}
	}
	return null;
}

async function readRelationship(owner, peer) {
	const row = await db.table("contactRelationships").get([owner, peer]);
	if (!row) return null;
	return fromEncryptedRow(row, DB_KEY);
}

function incomingRequestRumor(senderPriv, ownerPubkey, greeting, createdAt) {
	const rumorTemplate = buildContactRequestRumor(greeting);
	const giftWrap = nip59Wrap(rumorTemplate, senderPriv, ownerPubkey);
	const rumor = nip59Unwrap(giftWrap, OWNER_PRIV);
	if (createdAt !== undefined) rumor.created_at = createdAt;
	return rumor;
}

function makeRuntime(extra = {}) {
	const published = [];
	const journal = [];
	const stateChanges = [];
	const runtime = createContactRuntime({
		ownerPubkey: OWNER_PUBKEY,
		privKey: OWNER_PRIV,
		dbKey: DB_KEY,
		publish: collectingPublish(published),
		onStateChange: (peer, stateName) => stateChanges.push({ peer, stateName }),
		onJournal: (entry) => journal.push(entry),
		...extra,
	});
	return { runtime, published, journal, stateChanges };
}

// --- sendRequest ---
test("sendRequest: публикует gift-wrapped CONTACT_REQUEST_KIND, персистит OUTGOING_PENDING", async () => {
	const { runtime, published, stateChanges } = makeRuntime();
	await runtime.load();
	await runtime.sendRequest(BOB_PUBKEY, "привет");

	const rumor = findGiftWrapOfKind(published, CONTACT_REQUEST_KIND, BOB_PRIV);
	assert.ok(rumor, "должен быть отправлен gift-wrap с CONTACT_REQUEST_KIND");
	assert.equal(rumor.content, "привет");

	const row = await readRelationship(OWNER_PUBKEY, BOB_PUBKEY);
	assert.equal(row.state, "OUTGOING_PENDING");
	assert.ok(stateChanges.some((c) => c.peer === BOB_PUBKEY && c.stateName === "OUTGOING_PENDING"));
});

// Живой фидбек пользователя — заявка самому себе реально уходила и реально
// "приходила" (kukusya мог добавиться к kukusya). sendRequest — единственная
// точка входа для ЛЮБОГО вызывающего (discovery.jsx/contacts.jsx), поэтому
// гейт стоит здесь, не в UI.
test("sendRequest: себе самому — SelfContactRequestError, ничего не публикуется и не персистится", async () => {
	const { runtime, published, stateChanges } = makeRuntime();
	await runtime.load();
	await assert.rejects(async () => runtime.sendRequest(OWNER_PUBKEY, "привет"), SelfContactRequestError);

	assert.equal(published.length, 0, "gift-wrap не должен был уйти на relay");
	assert.equal(stateChanges.length, 0, "состояние не должно было измениться");
	const row = await readRelationship(OWNER_PUBKEY, OWNER_PUBKEY);
	assert.equal(row, null, "запись отношения с самим собой не должна была появиться");
});

// --- handleIncomingRumor: REMOTE_REQUEST ---
test("handleIncomingRumor: CONTACT_REQUEST_KIND -> INCOMING_PENDING, greeting сохранён", async () => {
	const { runtime } = makeRuntime();
	await runtime.load();

	const rumorTemplate = buildContactRequestRumor("хочу дружить");
	const giftWrap = nip59Wrap(rumorTemplate, BOB_PRIV, OWNER_PUBKEY);
	const rumor = nip59Unwrap(giftWrap, OWNER_PRIV);

	await runtime.handleIncomingRumor(rumor);

	const state = runtime.getPeerState(BOB_PUBKEY);
	assert.equal(state.name, "INCOMING_PENDING");
	assert.equal(state.greeting, "хочу дружить");

	const row = await readRelationship(OWNER_PUBKEY, BOB_PUBKEY);
	assert.equal(row.state, "INCOMING_PENDING");
	assert.equal(row.greeting, "хочу дружить");
});

// --- accept ---
test("accept: публикует PUBLISH_ACCEPT rumor И обновлённый kind-3 (с добавленным peer), персистит CONTACT", async () => {
	const { runtime, published } = makeRuntime();
	await runtime.load();
	await runtime.handleIncomingRumor(incomingRequestRumor(BOB_PRIV, OWNER_PUBKEY, "x", 100));
	await runtime.accept(BOB_PUBKEY);

	const acceptRumor = findGiftWrapOfKind(published, CONTACT_ACCEPTED_KIND, BOB_PRIV);
	assert.ok(acceptRumor, "PUBLISH_ACCEPT должен уйти адресату");

	const contactListEvent = published.find((e) => e.kind === 3);
	assert.ok(contactListEvent, "UPDATE_CONTACTS_LIST должен опубликовать kind-3");
	assert.deepEqual(parseContactListEvent(contactListEvent), [BOB_PUBKEY]);

	const row = await readRelationship(OWNER_PUBKEY, BOB_PUBKEY);
	assert.equal(row.state, "CONTACT");
});

// --- reject ---
test("reject: публикует CONTACT_REJECTED_KIND, персистит REJECTED_BY_ME", async () => {
	const { runtime, published } = makeRuntime();
	await runtime.load();
	await runtime.handleIncomingRumor(incomingRequestRumor(BOB_PRIV, OWNER_PUBKEY, "x", 100));
	await runtime.reject(BOB_PUBKEY);

	const rejectRumor = findGiftWrapOfKind(published, CONTACT_REJECTED_KIND, BOB_PRIV);
	assert.ok(rejectRumor, "PUBLISH_REJECT должен уйти адресату (раньше такого сигнала не существовало вовсе)");

	const row = await readRelationship(OWNER_PUBKEY, BOB_PUBKEY);
	assert.equal(row.state, "REJECTED_BY_ME");
});

// --- cancel ---
test("cancel: OUTGOING_PENDING -> публикует ACQUAINT_CANCELLED_KIND, персистит NONE", async () => {
	const { runtime, published } = makeRuntime();
	await runtime.load();
	await runtime.sendRequest(BOB_PUBKEY, "привет");
	await runtime.cancel(BOB_PUBKEY);

	const cancelRumor = findGiftWrapOfKind(published, ACQUAINT_CANCELLED_KIND, BOB_PRIV);
	assert.ok(cancelRumor);

	const row = await readRelationship(OWNER_PUBKEY, BOB_PUBKEY);
	assert.equal(row.state, "NONE");
});

// --- block/unblock ---
test("block: из CONTACT -> публикует kind-3 (без peer) И kind-10000 (с peer), персистит BLOCKED", async () => {
	const { runtime, published } = makeRuntime();
	await runtime.load();
	await runtime.handleIncomingRumor(incomingRequestRumor(BOB_PRIV, OWNER_PUBKEY, "x", 100));
	await runtime.accept(BOB_PUBKEY);
	published.length = 0; // сброс — интересует только результат block()

	await runtime.block(BOB_PUBKEY);

	const contactListEvent = published.find((e) => e.kind === 3);
	assert.deepEqual(parseContactListEvent(contactListEvent), [], "peer убран из кontacts-списка");
	const muteListEvent = published.find((e) => e.kind === 10000);
	assert.deepEqual(parseMuteListEvent(muteListEvent), [BOB_PUBKEY], "peer добавлен в mute-список");

	const row = await readRelationship(OWNER_PUBKEY, BOB_PUBKEY);
	assert.equal(row.state, "BLOCKED");
});

test("unblock: BLOCKED -> публикует kind-10000 без peer, персистит NONE", async () => {
	const { runtime, published } = makeRuntime();
	await runtime.load();
	await runtime.block(BOB_PUBKEY);
	published.length = 0;

	await runtime.unblock(BOB_PUBKEY);

	const muteListEvent = published.find((e) => e.kind === 10000);
	assert.deepEqual(parseMuteListEvent(muteListEvent), []);
	const row = await readRelationship(OWNER_PUBKEY, BOB_PUBKEY);
	assert.equal(row.state, "NONE");
});

// --- removeContact ---
test("removeContact: CONTACT -> публикует kind-3 без peer, персистит NONE", async () => {
	const { runtime, published } = makeRuntime();
	await runtime.load();
	await runtime.handleIncomingRumor(incomingRequestRumor(BOB_PRIV, OWNER_PUBKEY, "x", 100));
	await runtime.accept(BOB_PUBKEY);
	published.length = 0;

	await runtime.removeContact(BOB_PUBKEY);

	const contactListEvent = published.find((e) => e.kind === 3);
	assert.deepEqual(parseContactListEvent(contactListEvent), []);
	const row = await readRelationship(OWNER_PUBKEY, BOB_PUBKEY);
	assert.equal(row.state, "NONE");
});

// --- I2, ГЛАВНЫЙ регресс-тест бага пользователя, теперь на уровне runtime ---
test("I2 (регресс, runtime): CONTACT + входящий REMOTE_REQUEST (даже далёкий createdAt) -> остаётся CONTACT, НЕ создаёт дубликат во входящих", async () => {
	const { runtime, journal } = makeRuntime();
	await runtime.load();
	await runtime.handleIncomingRumor(incomingRequestRumor(BOB_PRIV, OWNER_PUBKEY, "x", 100));
	await runtime.accept(BOB_PUBKEY);

	await runtime.handleIncomingRumor(incomingRequestRumor(BOB_PRIV, OWNER_PUBKEY, "снова привет", 99999999999));

	const state = runtime.getPeerState(BOB_PUBKEY);
	assert.equal(state.name, "CONTACT", "уже принятый контакт не должен снова попасть во входящие — это и есть найденный пользователем баг");
	assert.equal(
		journal.length,
		1,
		"единственная запись — от ПЕРВОГО REMOTE_REQUEST (категория newRequest); USER_ACCEPT не порождает LOG_JOURNAL по дизайну, а второй (проигнорированный I2) REMOTE_REQUEST — тем более",
	);
	assert.equal(journal[0].category, "newRequest");
});

// --- I3, crossed-requests: LOG_JOURNAL должен реально дойти до onJournal ---
test("I3, crossed-requests: OUTGOING_PENDING + встречный REMOTE_REQUEST -> CONTACT, LOG_JOURNAL долетает до onJournal", async () => {
	const { runtime, journal, published } = makeRuntime();
	await runtime.load();
	await runtime.sendRequest(BOB_PUBKEY, "я первый");

	const rumorTemplate = buildContactRequestRumor("а я тебе тоже писал");
	const giftWrap = nip59Wrap(rumorTemplate, BOB_PRIV, OWNER_PUBKEY);
	const rumor = nip59Unwrap(giftWrap, OWNER_PRIV);
	rumor.created_at = 5000;
	await runtime.handleIncomingRumor(rumor);

	const state = runtime.getPeerState(BOB_PUBKEY);
	assert.equal(state.name, "CONTACT");
	assert.ok(journal.some((e) => e.peer === BOB_PUBKEY), "crossed-requests обязана долететь до Журнала");
	assert.ok(published.some((e) => e.kind === 3), "crossed-requests обязана обновить kind-3 (peer теперь в контактах)");
});

// --- reconcileContactList / reconcileMuteList ---
test("reconcileContactList: peer появляется в списке с другого устройства -> CONTACT локально", async () => {
	const { runtime, stateChanges } = makeRuntime();
	await runtime.load();

	await runtime.reconcileContactList(new Set([BOB_PUBKEY]), 5000);

	const state = runtime.getPeerState(BOB_PUBKEY);
	assert.equal(state.name, "CONTACT");
	assert.equal(state.resolvedAt, 5000);
	const row = await readRelationship(OWNER_PUBKEY, BOB_PUBKEY);
	assert.equal(row.state, "CONTACT");
	assert.ok(stateChanges.some((c) => c.peer === BOB_PUBKEY && c.stateName === "CONTACT"));
});

test("reconcileContactList: peer пропал из списка -> демотирован в NONE (если локальное resolvedAt не новее)", async () => {
	const { runtime } = makeRuntime();
	await runtime.load();
	await runtime.reconcileContactList(new Set([BOB_PUBKEY]), 1000);
	await runtime.reconcileContactList(new Set(), 2000);

	const state = runtime.getPeerState(BOB_PUBKEY);
	assert.equal(state.name, "NONE");
	const row = await readRelationship(OWNER_PUBKEY, BOB_PUBKEY);
	assert.equal(row.state, "NONE");
});

test("reconcileMuteList: peer появляется в mute-списке с другого устройства -> BLOCKED локально", async () => {
	const { runtime } = makeRuntime();
	await runtime.load();
	await runtime.reconcileMuteList(new Set([BOB_PUBKEY]), 3000);

	const state = runtime.getPeerState(BOB_PUBKEY);
	assert.equal(state.name, "BLOCKED");
});

// --- listPeersByState / getPeerState ---
test("listPeersByState: фильтрует Map по состоянию", async () => {
	const { runtime } = makeRuntime();
	await runtime.load();
	await runtime.sendRequest(BOB_PUBKEY, "x");
	await runtime.handleIncomingRumor(incomingRequestRumor(ALICE_PRIV, OWNER_PUBKEY, "y", 100));

	assert.equal(runtime.listPeersByState("OUTGOING_PENDING").length, 1);
	assert.equal(runtime.listPeersByState("INCOMING_PENDING").length, 1);
	assert.equal(runtime.listPeersByState("CONTACT").length, 0);
});

test("getPeerState: неизвестный peer -> null", async () => {
	const { runtime } = makeRuntime();
	await runtime.load();
	assert.equal(runtime.getPeerState(BOB_PUBKEY), null);
});

// --- Миграция legacy-таблиц ---
test("migrateLegacyContactTables: contacts/blockedContacts -> CONTACT/BLOCKED с resolvedAt=момент миграции", async () => {
	await db.table("contacts").put({ owner: OWNER_PUBKEY, pubkey: BOB_PUBKEY });
	await db.table("blockedContacts").put({ owner: OWNER_PUBKEY, pubkey: ALICE_PUBKEY });

	const before = Math.floor(Date.now() / 1000);
	await migrateLegacyContactTables(OWNER_PUBKEY, DB_KEY);

	const bobRow = await readRelationship(OWNER_PUBKEY, BOB_PUBKEY);
	assert.equal(bobRow.state, "CONTACT");
	assert.ok(bobRow.resolvedAt >= before);

	const aliceRow = await readRelationship(OWNER_PUBKEY, ALICE_PUBKEY);
	assert.equal(aliceRow.state, "BLOCKED");

	assert.equal((await db.table("contacts").where("owner").equals(OWNER_PUBKEY).toArray()).length, 0, "исходная таблица очищена после переноса");
	assert.equal((await db.table("blockedContacts").where("owner").equals(OWNER_PUBKEY).toArray()).length, 0);
});

test("migrateLegacyContactTables: contactRequests (зашифрована) -> INCOMING_PENDING, greeting расшифрован", async () => {
	await db.table("contactRequests").put(
		toEncryptedRow({ owner: OWNER_PUBKEY, senderPubkey: BOB_PUBKEY, greeting: "давно ждёт", createdAt: 42 }, CONTACT_REQUESTS_PLAINTEXT_FIELDS, DB_KEY),
	);

	await migrateLegacyContactTables(OWNER_PUBKEY, DB_KEY);

	const row = await readRelationship(OWNER_PUBKEY, BOB_PUBKEY);
	assert.equal(row.state, "INCOMING_PENDING");
	assert.equal(row.greeting, "давно ждёт");
});

test("migrateLegacyContactTables: BLOCKED приоритетнее одновременной входящей заявки от того же peer", async () => {
	await db.table("blockedContacts").put({ owner: OWNER_PUBKEY, pubkey: BOB_PUBKEY });
	await db.table("contactRequests").put(
		toEncryptedRow({ owner: OWNER_PUBKEY, senderPubkey: BOB_PUBKEY, greeting: "пусти", createdAt: 1 }, CONTACT_REQUESTS_PLAINTEXT_FIELDS, DB_KEY),
	);

	await migrateLegacyContactTables(OWNER_PUBKEY, DB_KEY);

	const row = await readRelationship(OWNER_PUBKEY, BOB_PUBKEY);
	assert.equal(row.state, "BLOCKED", "блокировка не должна перезаписаться входящей заявкой при переносе");
});

test("migrateLegacyContactTables: идемпотентна — повторный вызов после успешного переноса ничего не меняет", async () => {
	await db.table("contacts").put({ owner: OWNER_PUBKEY, pubkey: BOB_PUBKEY });
	await migrateLegacyContactTables(OWNER_PUBKEY, DB_KEY);
	const firstRow = await readRelationship(OWNER_PUBKEY, BOB_PUBKEY);

	await migrateLegacyContactTables(OWNER_PUBKEY, DB_KEY);
	const secondRow = await readRelationship(OWNER_PUBKEY, BOB_PUBKEY);

	assert.deepEqual(secondRow, firstRow, "повторный перенос — no-op, исходные таблицы уже пусты");
});

test("load(): вызывает миграцию, затем читает contactRelationships в Map", async () => {
	await db.table("contacts").put({ owner: OWNER_PUBKEY, pubkey: BOB_PUBKEY });
	const { runtime } = makeRuntime();
	await runtime.load();

	const state = runtime.getPeerState(BOB_PUBKEY);
	assert.equal(state.name, "CONTACT");
});
