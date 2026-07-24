import "fake-indexeddb/auto";
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { db } from "../src/core/store/database.js";
import { getPublicKey } from "../src/core/crypto/keys.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { unwrap as nip59Unwrap } from "../src/core/crypto/nip59.js";
import { CONTACT_REQUEST_KIND, ACQUAINT_CANCELLED_KIND } from "../src/domain/contacts/requests.js";
import { contacts } from "../src/ui/signals/contacts.js";
import {
	discoveryProfiles,
	outgoingRequests,
	refreshDiscoveryProfiles,
	refreshOutgoingRequests,
	sendAcquaintanceRequestAction,
	cancelAcquaintanceRequestAction,
} from "../src/ui/signals/discovery.js";

const ALICE_PRIV = new Uint8Array(32).fill(9);
const ALICE_PUB = bytesToHex(getPublicKey(ALICE_PRIV));
const BOB_PRIV = new Uint8Array(32).fill(10);
const BOB_PUB = bytesToHex(getPublicKey(BOB_PRIV));
const CAROL_PRIV = new Uint8Array(32).fill(11);
const CAROL_PUB = bytesToHex(getPublicKey(CAROL_PRIV));

const okPublish = async () => ({ ok: true });

before(async () => {
	await db.open();
});

beforeEach(async () => {
	contacts.value = [];
	discoveryProfiles.value = [];
	outgoingRequests.value = [];
	await db.table("discoveryProfiles").clear();
	await db.table("outgoingAcquaintanceRequests").clear();
	await db.table("contacts").clear();
});

after(() => {
	db.close();
});

test("refreshDiscoveryProfiles: показывает только visible=true И НЕ уже существующих контактов", async () => {
	await db.table("discoveryProfiles").bulkPut([
		{ pubkey: BOB_PUB, visible: true, showChannels: false, channels: [], updatedAt: 1 },
		{ pubkey: CAROL_PUB, visible: true, showChannels: false, channels: [], updatedAt: 1 },
		{ pubkey: "invisible-pub", visible: false, showChannels: false, channels: [], updatedAt: 1 },
	]);
	await db.table("contacts").put({ owner: ALICE_PUB, pubkey: CAROL_PUB });
	contacts.value = [CAROL_PUB];

	await refreshDiscoveryProfiles(ALICE_PUB);

	const pubkeys = discoveryProfiles.value.map((p) => p.pubkey);
	assert.deepEqual(pubkeys, [BOB_PUB], "Кэрол уже контакт — скрыта; invisible-pub — не visible, тоже скрыт");
});

test("sendAcquaintanceRequestAction: НЕ добавляет адресата в контакты (в отличие от sendContactRequestAction) — только pending-запись + gift-wrap", async () => {
	let sentGiftWrap;
	const publish = async (event) => {
		if (event.kind === 1059) sentGiftWrap = event;
		return { ok: true };
	};

	await sendAcquaintanceRequestAction(ALICE_PUB, ALICE_PRIV, BOB_PUB, publish);

	assert.deepEqual(contacts.value, [], "адресат НЕ должен появиться в контактах до его ответа");
	const row = await db.table("outgoingAcquaintanceRequests").get([ALICE_PUB, BOB_PUB]);
	assert.ok(row, "локальная pending-запись должна быть создана");
	assert.equal(typeof row.createdAt, "number");

	assert.ok(sentGiftWrap, "должен быть отправлен gift-wrap");
	const rumor = nip59Unwrap(sentGiftWrap, BOB_PRIV);
	assert.equal(rumor.kind, CONTACT_REQUEST_KIND, "получатель видит ТОТ ЖЕ kind, что форма 'Добавить контакт' — не различает источник");
});

test("sendAcquaintanceRequestAction -> refreshOutgoingRequests: заявка появляется в списке отправленных", async () => {
	await sendAcquaintanceRequestAction(ALICE_PUB, ALICE_PRIV, BOB_PUB, okPublish);
	await refreshOutgoingRequests(ALICE_PUB);
	assert.deepEqual(outgoingRequests.value.map((r) => r.targetPubkey), [BOB_PUB]);
});

test("cancelAcquaintanceRequestAction: удаляет локальную запись НЕМЕДЛЕННО (оптимистично), даже если publish падает", async () => {
	await sendAcquaintanceRequestAction(ALICE_PUB, ALICE_PRIV, BOB_PUB, okPublish);
	await refreshOutgoingRequests(ALICE_PUB);
	assert.equal(outgoingRequests.value.length, 1);

	const failingPublish = async () => {
		throw new Error("нет соединения");
	};
	await cancelAcquaintanceRequestAction(ALICE_PUB, ALICE_PRIV, BOB_PUB, failingPublish);

	assert.equal(await db.table("outgoingAcquaintanceRequests").get([ALICE_PUB, BOB_PUB]), undefined);
	await refreshOutgoingRequests(ALICE_PUB);
	assert.equal(outgoingRequests.value.length, 0, "галочка должна исчезнуть даже при сбое сети");
});

test("cancelAcquaintanceRequestAction: отправляет ACQUAINT_CANCELLED_KIND адресату", async () => {
	await sendAcquaintanceRequestAction(ALICE_PUB, ALICE_PRIV, BOB_PUB, okPublish);

	let sentGiftWrap;
	const publish = async (event) => {
		if (event.kind === 1059) sentGiftWrap = event;
		return { ok: true };
	};
	await cancelAcquaintanceRequestAction(ALICE_PUB, ALICE_PRIV, BOB_PUB, publish);

	assert.ok(sentGiftWrap, "должен быть отправлен gift-wrap об отмене");
	const rumor = nip59Unwrap(sentGiftWrap, BOB_PRIV);
	assert.equal(rumor.kind, ACQUAINT_CANCELLED_KIND);
	assert.equal(rumor.pubkey, ALICE_PUB, "получатель узнаёт, КТО отменил, из аутентичного unwrap, не из тега");
});

test("cancelAcquaintanceRequestAction: на несуществующую запись — не бросает (уже отменено/принято ранее)", async () => {
	await assert.doesNotReject(() => cancelAcquaintanceRequestAction(ALICE_PUB, ALICE_PRIV, "no-such-pubkey", okPublish));
});
