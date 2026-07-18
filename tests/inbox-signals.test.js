import "fake-indexeddb/auto";
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { db } from "../src/core/store/database.js";
import { getPublicKey } from "../src/core/crypto/keys.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { refreshInboxRequests, acceptInboxRequestAction, rejectInboxRequestAction } from "../src/ui/signals/inbox.js";
import { activeChatPubkey } from "../src/ui/signals/chat.js";
import { storeInboxRequest } from "../src/domain/messaging/inbox-requests.js";
import { createOwnKeyPackage } from "../src/core/crypto/mls-session.js";
import { ensureChatEstablished } from "../src/domain/messaging/chat.js";
import { unwrap as nip59Unwrap } from "../src/core/crypto/nip59.js";

const ALICE_PRIV = new Uint8Array(32).fill(1);
const STRANGER_PRIV = new Uint8Array(32).fill(9);
const ALICE_PUB = bytesToHex(getPublicKey(ALICE_PRIV));
const STRANGER_PUB = bytesToHex(getPublicKey(STRANGER_PRIV));

before(async () => {
	await db.open();
});

beforeEach(async () => {
	await db.table("inboxRequests").clear();
	await db.table("mlsGroups").clear();
	await db.table("ownKeyPackage").clear();
	activeChatPubkey.value = null;
});

after(() => {
	db.close();
});

test("refreshInboxRequests: возвращает owner-scoped список", async () => {
	await storeInboxRequest(ALICE_PUB, STRANGER_PUB, new Uint8Array([1, 2, 3]), 100);
	const rows = await refreshInboxRequests(ALICE_PUB);
	assert.equal(rows.length, 1);
	assert.equal(rows[0].senderPubkey, STRANGER_PUB);
});

test("acceptInboxRequestAction: присоединяется к MLS-группе, вызывает refresh-подписку и переключает на чат", async () => {
	const aliceOwnKeyPackage = await createOwnKeyPackage(ALICE_PUB, "alice-device");
	await db.table("ownKeyPackage").put({
		id: "self",
		publicPackage: aliceOwnKeyPackage.publicPackage,
		privatePackage: aliceOwnKeyPackage.privatePackage,
		wireBytes: aliceOwnKeyPackage.wireBytes,
	});
	let welcomeGiftWrap;
	const publish = async (event) => {
		if (event.kind === 1059) welcomeGiftWrap = event;
		return { ok: true };
	};
	await ensureChatEstablished(STRANGER_PUB, STRANGER_PRIV, ALICE_PUB, publish, async () => aliceOwnKeyPackage.wireBytes);
	await db.table("mlsGroups").clear();

	const rumor = nip59Unwrap(welcomeGiftWrap, ALICE_PRIV);
	const welcomeWireBytes = Uint8Array.from(atob(rumor.content), (c) => c.charCodeAt(0));
	await storeInboxRequest(ALICE_PUB, STRANGER_PUB, welcomeWireBytes, rumor.created_at);

	let refreshCalls = 0;
	const refreshGroupMessageSubscription = async () => {
		refreshCalls++;
	};
	await acceptInboxRequestAction(ALICE_PUB, ALICE_PRIV, STRANGER_PUB, refreshGroupMessageSubscription, publish);

	assert.equal(refreshCalls, 1, "refreshGroupMessageSubscription обязана быть вызвана (находка 3)");
	assert.equal(activeChatPubkey.value, STRANGER_PUB, "должен переключить UI на новый чат");
	assert.equal((await refreshInboxRequests(ALICE_PUB)).length, 0, "запись должна быть удалена");
});

test("rejectInboxRequestAction: удаляет запись, не создаёт MLS-группу", async () => {
	await storeInboxRequest(ALICE_PUB, STRANGER_PUB, new Uint8Array([1]), 100);
	await rejectInboxRequestAction(ALICE_PUB, STRANGER_PUB);
	assert.equal((await refreshInboxRequests(ALICE_PUB)).length, 0);
	assert.equal(await db.table("mlsGroups").count(), 0);
});
