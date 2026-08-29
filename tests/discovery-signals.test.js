import "fake-indexeddb/auto";
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { db } from "../src/core/store/database.js";
import { getPublicKey } from "../src/core/crypto/keys.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { contacts, discoveryProfiles, refreshDiscoveryProfiles } from "../src/ui/signals/contacts.js";

const ALICE_PRIV = new Uint8Array(32).fill(9);
const ALICE_PUB = bytesToHex(getPublicKey(ALICE_PRIV));
const BOB_PRIV = new Uint8Array(32).fill(10);
const BOB_PUB = bytesToHex(getPublicKey(BOB_PRIV));
const CAROL_PRIV = new Uint8Array(32).fill(11);
const CAROL_PUB = bytesToHex(getPublicKey(CAROL_PRIV));

before(async () => {
	await db.open();
});

beforeEach(async () => {
	contacts.value = [];
	discoveryProfiles.value = [];
	await db.table("discoveryProfiles").clear();
	await db.table("contacts").clear();
});

after(() => {
	db.close();
});

// Этап 49 — sendAcquaintanceRequestAction/cancelAcquaintanceRequestAction/
// outgoingRequests/refreshOutgoingRequests убраны отсюда: оба пути отправки
// заявки ("Добавить контакт" И "Обзор") унифицированы в signals/contacts.js
// (sendContactRequestAction/cancelContactRequestAction/outgoingRequests) — их
// поведение (включая ЭТУ гарантию — "Обзор" не добавляет адресата оптимистично,
// это уже структурно верно для ОБОИХ путей теперь) покрыто contacts-signals.test.js.
// refreshDiscoveryProfiles — единственное, что осталось от discovery-специфичной
// логики (kind 30073, не связано с contact-relationship FSM); физически теперь в
// signals/contacts.js (этап 7, CONTRACTS.md — грид переехал на экран "Люди").

const FAR_FUTURE = Math.floor(Date.now() / 1000) + 86400;

test("refreshDiscoveryProfiles: показывает только visible=true И НЕ уже существующих контактов", async () => {
	await db.table("discoveryProfiles").bulkPut([
		{ pubkey: BOB_PUB, visible: true, showChannels: false, channels: [], visibleUntil: FAR_FUTURE, updatedAt: 1 },
		{ pubkey: CAROL_PUB, visible: true, showChannels: false, channels: [], visibleUntil: FAR_FUTURE, updatedAt: 1 },
		{ pubkey: "invisible-pub", visible: false, showChannels: false, channels: [], visibleUntil: FAR_FUTURE, updatedAt: 1 },
	]);
	await db.table("contacts").put({ owner: ALICE_PUB, pubkey: CAROL_PUB });
	contacts.value = [CAROL_PUB];

	await refreshDiscoveryProfiles(ALICE_PUB);

	const pubkeys = discoveryProfiles.value.map((p) => p.pubkey);
	assert.deepEqual(pubkeys, [BOB_PUB], "Кэрол уже контакт — скрыта; invisible-pub — не visible, тоже скрыт");
});

// CONTRACTS.md §DISCOVERY, T4 — читатель обязан отсеивать протухшие карточки
// сам (реле может не поддерживать NIP-40 expiration).
test("refreshDiscoveryProfiles: отсеивает записи с истёкшим visibleUntil", async () => {
	const past = Math.floor(Date.now() / 1000) - 10;
	await db.table("discoveryProfiles").bulkPut([
		{ pubkey: BOB_PUB, visible: true, showChannels: false, channels: [], visibleUntil: FAR_FUTURE, updatedAt: 1 },
		{ pubkey: CAROL_PUB, visible: true, showChannels: false, channels: [], visibleUntil: past, updatedAt: 1 },
	]);

	await refreshDiscoveryProfiles(ALICE_PUB);

	const pubkeys = discoveryProfiles.value.map((p) => p.pubkey);
	assert.deepEqual(pubkeys, [BOB_PUB], "у Кэрол visibleUntil в прошлом — протухла, скрыта");
});
