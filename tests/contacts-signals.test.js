import "fake-indexeddb/auto";
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { db } from "../src/core/store/database.js";
import { getPublicKey } from "../src/core/crypto/keys.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { npubEncode, nsecEncode } from "nostr-tools/nip19";
import {
	contacts,
	blockedContacts,
	outgoingRequests,
	incomingRequests,
	rejectedByMe,
	groups,
	profiles,
	refreshGroups,
	refreshAll,
	ensureProfilesFetched,
	refreshProfiles,
	decodePubkeyInput,
	configureContactRuntime,
	handleIncomingContactRumor,
	sendContactRequestAction,
	acceptContactRequestAction,
	rejectContactRequestAction,
	cancelContactRequestAction,
	blockContactAction,
	unblockContactAction,
	removeContactAction,
	createGroupAction,
	renameGroupAction,
	addGroupMemberAction,
	removeGroupMemberAction,
	deleteGroupAction,
} from "../src/ui/signals/contacts.js";
import { unwrap as nip59Unwrap, wrap as nip59Wrap } from "../src/core/crypto/nip59.js";
import { CONTACT_REQUEST_KIND, CONTACT_ACCEPTED_KIND, CONTACT_REJECTED_KIND, buildContactRequestRumor } from "../src/domain/contacts/requests.js";
import { toEncryptedRow } from "../src/core/store/encrypted-table.js";
import { GROUPS_PLAINTEXT_FIELDS } from "../src/core/store/table-fields.js";

const PRIV_KEY = new Uint8Array(32).fill(5);
const OWNER_PUBKEY = bytesToHex(getPublicKey(PRIV_KEY));
const DB_KEY = crypto.getRandomValues(new Uint8Array(32));

// Настоящие secp256k1-ключи (не "a".repeat(64) заглушки) — nip59.wrap делает
// реальный ECDH, невалидная точка на кривой бросит исключение.
const BOB_PRIV = new Uint8Array(32).fill(7);
const BOB_PUBKEY = bytesToHex(getPublicKey(BOB_PRIV));
const ALICE_PRIV = new Uint8Array(32).fill(9);
const ALICE_PUBKEY = bytesToHex(getPublicKey(ALICE_PRIV));

const okPublish = async () => ({ ok: true });
const failPublish = async () => ({ ok: false, reason: "relay отклонил" });

before(async () => {
	await db.open();
});

beforeEach(async () => {
	groups.value = [];
	profiles.value = {};
	await db.table("contacts").clear();
	await db.table("blockedContacts").clear();
	await db.table("contactRequests").clear();
	await db.table("contactRelationships").clear();
	await db.table("groups").clear();
	await db.table("groupMembers").clear();
	await db.table("events").clear();
});

after(() => {
	db.close();
});

// Этап 49 — configureContactRuntime — модульный синглтон (тот же приём, что
// configureCallRuntime, call.js), каждый тест переконфигурирует его заново со
// СВОИМ publish (для перехвата отправленных событий).
async function setupRuntime(publish = okPublish) {
	await configureContactRuntime({ ownerPubkey: OWNER_PUBKEY, privKey: PRIV_KEY, dbKey: DB_KEY, publish });
}

function incomingRequestRumor(senderPriv, greeting, createdAt) {
	const rumor = nip59Wrap(buildContactRequestRumor(greeting), senderPriv, OWNER_PUBKEY);
	const unwrapped = nip59Unwrap(rumor, PRIV_KEY);
	if (createdAt !== undefined) unwrapped.created_at = createdAt;
	return unwrapped;
}

test("decodePubkeyInput: 64-hex строка проходит как есть (lowercase)", () => {
	const hex = "AB".repeat(32);
	assert.equal(decodePubkeyInput(hex), hex.toLowerCase());
});

test("decodePubkeyInput: npub декодируется в hex", () => {
	const pubBytes = getPublicKey(PRIV_KEY);
	const npub = npubEncode(bytesToHex(pubBytes));
	assert.equal(decodePubkeyInput(npub), bytesToHex(pubBytes));
});

test("decodePubkeyInput: мусорная строка -> throw", () => {
	assert.throws(() => decodePubkeyInput("не-ключ-и-не-npub"));
});

test("decodePubkeyInput: nsec (валидный bech32, но не npub) -> throw", () => {
	const nsec = nsecEncode(PRIV_KEY);
	assert.throws(() => decodePubkeyInput(nsec));
});

// --- Единая точка отправки/приёма заявки (этап 49) ---

test("sendContactRequestAction: публикует gift-wrapped CONTACT_REQUEST_KIND, попадает в outgoingRequests (НЕ в contacts — до ответа адресата)", async () => {
	let sentGiftWrap;
	await setupRuntime(async (event) => {
		if (event.kind === 1059) sentGiftWrap = event;
		return { ok: true };
	});

	await sendContactRequestAction(BOB_PUBKEY, "привет, добавь меня");

	assert.deepEqual(contacts.value, [], "адресат НЕ должен появиться в контактах до его ответа — находка 1 больше не даёт ложный оптимизм");
	assert.equal(outgoingRequests.value.length, 1);
	assert.equal(outgoingRequests.value[0].peerPubkey, BOB_PUBKEY);

	assert.ok(sentGiftWrap, "должен быть отправлен gift-wrap (kind 1059)");
	const rumor = nip59Unwrap(sentGiftWrap, BOB_PRIV);
	assert.equal(rumor.kind, CONTACT_REQUEST_KIND);
	assert.equal(rumor.content, "привет, добавь меня");
});

test("sendContactRequestAction: принимает npub, декодирует перед сборкой события", async () => {
	await setupRuntime();
	const npub = npubEncode(BOB_PUBKEY);
	await sendContactRequestAction(npub, "");
	assert.equal(outgoingRequests.value[0].peerPubkey, BOB_PUBKEY);
});

test("sendContactRequestAction: невалидный ключ -> throw, ничего не публикуется", async () => {
	let publishCount = 0;
	await setupRuntime(async () => {
		publishCount++;
		return { ok: true };
	});
	await assert.rejects(() => sendContactRequestAction("мусор", "привет"));
	assert.equal(publishCount, 0);
});

test("handleIncomingContactRumor: CONTACT_REQUEST_KIND -> появляется в incomingRequests с greeting", async () => {
	await setupRuntime();
	await handleIncomingContactRumor(incomingRequestRumor(BOB_PRIV, "хочу дружить", 100));

	assert.equal(incomingRequests.value.length, 1);
	assert.equal(incomingRequests.value[0].peerPubkey, BOB_PUBKEY);
	assert.equal(incomingRequests.value[0].greeting, "хочу дружить");
});

test("acceptContactRequestAction: переводит в contacts, публикует CONTACT_ACCEPTED_KIND отправителю (этап 34/49)", async () => {
	const published = [];
	await setupRuntime(async (event) => {
		published.push(event);
		return { ok: true };
	});
	await handleIncomingContactRumor(incomingRequestRumor(BOB_PRIV, "hi", 100));

	await acceptContactRequestAction(BOB_PUBKEY);

	assert.deepEqual(contacts.value, [BOB_PUBKEY]);
	assert.equal(incomingRequests.value.length, 0);

	const giftWrap = published.find((e) => e.kind === 1059);
	assert.ok(giftWrap, "должен быть отправлен gift-wrap отправителю запроса");
	const rumor = nip59Unwrap(giftWrap, BOB_PRIV);
	assert.equal(rumor.kind, CONTACT_ACCEPTED_KIND);

	const contactListEvent = published.find((e) => e.kind === 3);
	assert.ok(contactListEvent, "kind-3 обязан republish-нуться с новым контактом");
});

test("rejectContactRequestAction: публикует CONTACT_REJECTED_KIND, переводит в rejectedByMe (НЕ blockedContacts — раньше отказ реализовывался через блокировку)", async () => {
	const published = [];
	await setupRuntime(async (event) => {
		published.push(event);
		return { ok: true };
	});
	await handleIncomingContactRumor(incomingRequestRumor(BOB_PRIV, "hi", 100));

	await rejectContactRequestAction(BOB_PUBKEY);

	assert.deepEqual(blockedContacts.value, [], "отказ — не блокировка (CONTACTS-FSM.md, разделены явно по решению пользователя)");
	assert.equal(rejectedByMe.value.length, 1);
	assert.equal(rejectedByMe.value[0].peerPubkey, BOB_PUBKEY);
	assert.equal(incomingRequests.value.length, 0);

	const giftWrap = published.find((e) => e.kind === 1059);
	assert.ok(giftWrap, "PUBLISH_REJECT — раньше такого сигнала не существовало вовсе");
	assert.equal(nip59Unwrap(giftWrap, BOB_PRIV).kind, CONTACT_REJECTED_KIND);
});

test("cancelContactRequestAction: OUTGOING_PENDING -> отзывается, пропадает из outgoingRequests", async () => {
	await setupRuntime();
	await sendContactRequestAction(BOB_PUBKEY, "");
	assert.equal(outgoingRequests.value.length, 1);

	await cancelContactRequestAction(BOB_PUBKEY);
	assert.equal(outgoingRequests.value.length, 0);
});

test("crossed-requests (I3): обе стороны отправили заявку друг другу -> сразу CONTACT, без отдельного accept", async () => {
	await setupRuntime();
	await sendContactRequestAction(BOB_PUBKEY, "я первый");
	await handleIncomingContactRumor(incomingRequestRumor(BOB_PRIV, "и я тоже", 999999));

	assert.deepEqual(contacts.value, [BOB_PUBKEY]);
	assert.equal(outgoingRequests.value.length, 0);
	assert.equal(incomingRequests.value.length, 0);
});

test("I2 (регресс-тест бага пользователя): CONTACT + повторный REMOTE_REQUEST -> остаётся CONTACT, НЕ дублируется во входящих", async () => {
	await setupRuntime();
	await handleIncomingContactRumor(incomingRequestRumor(BOB_PRIV, "hi", 100));
	await acceptContactRequestAction(BOB_PUBKEY);

	await handleIncomingContactRumor(incomingRequestRumor(BOB_PRIV, "снова привет", 99999999999));

	assert.deepEqual(contacts.value, [BOB_PUBKEY]);
	assert.equal(incomingRequests.value.length, 0, "уже принятый контакт не должен снова оказаться во входящих — найденный пользователем баг");
});

test("blockContactAction: из CONTACT — убирает из contacts И добавляет в blockedContacts одновременно", async () => {
	await setupRuntime();
	await handleIncomingContactRumor(incomingRequestRumor(BOB_PRIV, "hi", 100));
	await acceptContactRequestAction(BOB_PUBKEY);
	assert.deepEqual(contacts.value, [BOB_PUBKEY]);

	await blockContactAction(BOB_PUBKEY);

	assert.deepEqual(blockedContacts.value, [BOB_PUBKEY]);
	assert.deepEqual(contacts.value, [], "заблокированный контакт не должен оставаться в contacts — структурно взаимоисключающие состояния");
});

test("blockContactAction: работает и без предыстории (блокировка постороннего)", async () => {
	await setupRuntime();
	await blockContactAction(BOB_PUBKEY);
	assert.deepEqual(blockedContacts.value, [BOB_PUBKEY]);
});

test("unblockContactAction: НЕ возвращает разблокированного обратно в contacts автоматически", async () => {
	await setupRuntime();
	await blockContactAction(BOB_PUBKEY);
	await unblockContactAction(BOB_PUBKEY);
	assert.deepEqual(blockedContacts.value, []);
	assert.deepEqual(contacts.value, [], "разблокировка не должна сама по себе восстанавливать контакт");
});

test("removeContactAction: удаляет из contacts", async () => {
	await setupRuntime();
	await handleIncomingContactRumor(incomingRequestRumor(BOB_PRIV, "hi", 100));
	await acceptContactRequestAction(BOB_PUBKEY);
	await removeContactAction(BOB_PUBKEY);
	assert.deepEqual(contacts.value, []);
});

test("refreshContacts/refreshAll: пересчитывают сигналы из уже загруженного runtime (без Dexie-запроса)", async () => {
	await setupRuntime();
	await sendContactRequestAction(BOB_PUBKEY, "");
	await handleIncomingContactRumor(incomingRequestRumor(ALICE_PRIV, "hi", 100));

	outgoingRequests.value = [];
	incomingRequests.value = [];
	await refreshAll();

	assert.equal(outgoingRequests.value.length, 1);
	assert.equal(incomingRequests.value.length, 1);
});

test("миграция (задача 3, этап 49): configureContactRuntime подхватывает legacy contacts/blockedContacts/contactRequests", async () => {
	await db.table("contacts").put({ owner: OWNER_PUBKEY, pubkey: BOB_PUBKEY });
	await db.table("blockedContacts").put({ owner: OWNER_PUBKEY, pubkey: ALICE_PUBKEY });

	await setupRuntime();

	assert.deepEqual(contacts.value, [BOB_PUBKEY]);
	assert.deepEqual(blockedContacts.value, [ALICE_PUBKEY]);
});

// --- Группы (не затронуто этапом 49) ---

test("AC-16: groups хранится зашифрованным — сырой дамп не содержит name", async () => {
	await createGroupAction(OWNER_PUBKEY, PRIV_KEY, DB_KEY, "Секретная группа", okPublish);
	const groupId = groups.value[0].id;
	const raw = await db.table("groups").get([OWNER_PUBKEY, groupId]);
	assert.equal(raw.id, groupId);
	assert.equal("name" in raw, false);
	assert.ok(raw.nonce instanceof Uint8Array);
	assert.ok(raw.ciphertext instanceof Uint8Array);
});

test("createGroupAction: создаёт группу, обновляет groups сигнал", async () => {
	await createGroupAction(OWNER_PUBKEY, PRIV_KEY, DB_KEY, "Друзья", okPublish);
	assert.equal(groups.value.length, 1);
	assert.equal(groups.value[0].name, "Друзья");
	assert.deepEqual(groups.value[0].memberPubkeys, []);
});

test("renameGroupAction/addGroupMemberAction/removeGroupMemberAction: полный цикл редактирования", async () => {
	await createGroupAction(OWNER_PUBKEY, PRIV_KEY, DB_KEY, "Старое имя", okPublish);
	const groupId = groups.value[0].id;

	await renameGroupAction(OWNER_PUBKEY, PRIV_KEY, DB_KEY, groupId, "Новое имя", okPublish);
	assert.equal(groups.value.find((g) => g.id === groupId).name, "Новое имя");

	await addGroupMemberAction(OWNER_PUBKEY, PRIV_KEY, DB_KEY, groupId, "alice-pk", okPublish);
	assert.deepEqual(groups.value.find((g) => g.id === groupId).memberPubkeys, ["alice-pk"]);

	await removeGroupMemberAction(OWNER_PUBKEY, PRIV_KEY, DB_KEY, groupId, "alice-pk", okPublish);
	assert.deepEqual(groups.value.find((g) => g.id === groupId).memberPubkeys, []);
});

test("deleteGroupAction: группа исчезает из groups сигнала и из БД", async () => {
	await createGroupAction(OWNER_PUBKEY, PRIV_KEY, DB_KEY, "Временная", okPublish);
	const groupId = groups.value[0].id;

	await deleteGroupAction(OWNER_PUBKEY, PRIV_KEY, DB_KEY, groupId, okPublish);

	assert.equal(groups.value.find((g) => g.id === groupId), undefined);
	assert.equal(await db.table("groups").get([OWNER_PUBKEY, groupId]), undefined);
});

test("F-GR-02 через UI-действия: один pubkey в нескольких группах одновременно", async () => {
	await createGroupAction(OWNER_PUBKEY, PRIV_KEY, DB_KEY, "Друзья", okPublish);
	await createGroupAction(OWNER_PUBKEY, PRIV_KEY, DB_KEY, "Работа", okPublish);
	const [g1, g2] = groups.value;
	await addGroupMemberAction(OWNER_PUBKEY, PRIV_KEY, DB_KEY, g1.id, "shared-pk", okPublish);
	await addGroupMemberAction(OWNER_PUBKEY, PRIV_KEY, DB_KEY, g2.id, "shared-pk", okPublish);

	assert.ok(groups.value.find((g) => g.id === g1.id).memberPubkeys.includes("shared-pk"));
	assert.ok(groups.value.find((g) => g.id === g2.id).memberPubkeys.includes("shared-pk"));
});

test("refreshGroups: подтягивает группы из БД без действий", async () => {
	await db.table("groups").add(toEncryptedRow({ owner: OWNER_PUBKEY, id: "g1", name: "Z" }, GROUPS_PLAINTEXT_FIELDS, DB_KEY));
	await db.table("groupMembers").add({ groupId: "g1", pubkey: "z" });

	await refreshGroups(OWNER_PUBKEY, DB_KEY);

	assert.deepEqual(groups.value, [{ id: "g1", name: "Z", memberPubkeys: ["z"] }]);
});

// --- Профили (не затронуто этапом 49) ---

const ALICE_STUB_PK = "a".repeat(64);
const BOB_STUB_PK = "b".repeat(64);

test("ensureProfilesFetched: заполняет profiles найденными записями", async () => {
	const fetchStub = async (pubkeys) => {
		assert.deepEqual(pubkeys, [ALICE_STUB_PK]);
		return new Map([[ALICE_STUB_PK, { name: "Алиса", about: "био" }]]);
	};
	await ensureProfilesFetched([ALICE_STUB_PK], fetchStub);
	assert.deepEqual(profiles.value[ALICE_STUB_PK], { name: "Алиса", about: "био" });
});

test("ensureProfilesFetched: не найденный профиль кэшируется как null (не запрашивается повторно)", async () => {
	let calls = 0;
	const fetchStub = async () => {
		calls++;
		return new Map();
	};
	await ensureProfilesFetched([BOB_STUB_PK], fetchStub);
	assert.equal(profiles.value[BOB_STUB_PK], null);
	await ensureProfilesFetched([BOB_STUB_PK], fetchStub);
	assert.equal(calls, 1, "второй вызов не должен снова запрашивать уже известный (пусть и пустой) результат");
});

test("ensureProfilesFetched: уже закэшированные pubkey исключаются из запроса", async () => {
	profiles.value = { [ALICE_STUB_PK]: { name: "Алиса" } };
	const fetchStub = async (pubkeys) => {
		assert.deepEqual(pubkeys, [BOB_STUB_PK]);
		return new Map([[BOB_STUB_PK, { name: "Боб" }]]);
	};
	await ensureProfilesFetched([ALICE_STUB_PK, BOB_STUB_PK], fetchStub);
	assert.deepEqual(profiles.value[ALICE_STUB_PK], { name: "Алиса" });
	assert.deepEqual(profiles.value[BOB_STUB_PK], { name: "Боб" });
});

test("ensureProfilesFetched: пустой список отсутствующих pubkey не вызывает fetch вовсе", async () => {
	profiles.value = { [ALICE_STUB_PK]: { name: "Алиса" } };
	let called = false;
	await ensureProfilesFetched([ALICE_STUB_PK], async () => {
		called = true;
		return new Map();
	});
	assert.equal(called, false);
});

test("refreshProfiles: перезаписывает УЖЕ закэшированный профиль свежими данными (найденный баг — био не обновлялось)", async () => {
	profiles.value = { [ALICE_STUB_PK]: { name: "Алиса", about: "старое био" } };
	const fetchStub = async (pubkeys) => {
		assert.deepEqual(pubkeys, [ALICE_STUB_PK], "refreshProfiles НЕ должен исключать уже закэшированные из запроса");
		return new Map([[ALICE_STUB_PK, { name: "Алиса", about: "новое био" }]]);
	};
	await refreshProfiles([ALICE_STUB_PK], fetchStub);
	assert.deepEqual(profiles.value[ALICE_STUB_PK], { name: "Алиса", about: "новое био" });
});

test("refreshProfiles: пустой список -> не вызывает fetch", async () => {
	let called = false;
	await refreshProfiles([], async () => {
		called = true;
		return new Map();
	});
	assert.equal(called, false);
});

test("refreshProfiles: контакт больше не найден -> обновляет на null (не оставляет устаревшую запись)", async () => {
	profiles.value = { [ALICE_STUB_PK]: { name: "Алиса" } };
	await refreshProfiles([ALICE_STUB_PK], async () => new Map());
	assert.equal(profiles.value[ALICE_STUB_PK], null);
});
