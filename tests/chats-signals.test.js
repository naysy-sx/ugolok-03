import "fake-indexeddb/auto";
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { db } from "../src/core/store/database.js";
import { getPublicKey } from "../src/core/crypto/keys.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { createOwnKeyPackage } from "../src/core/crypto/mls-session.js";
import { ensureChatEstablished, isCommitter } from "../src/domain/messaging/chat.js";
import {
	messagingActivity,
	bumpMessagingActivity,
	listChatPartners,
	sendChatMessageAction,
	deleteChatMessageAction,
	deleteMessageForMeAction,
	clearChatHistoryAction,
	markChatReadAction,
	saveChatDraftAction,
} from "../src/ui/signals/chats.js";
import { toEncryptedRow, fromEncryptedRow } from "../src/core/store/encrypted-table.js";
import { MLS_GROUPS_PLAINTEXT_FIELDS } from "../src/core/store/table-fields.js";

const ALICE_PRIV = new Uint8Array(32).fill(1);
const BOB_PRIV = new Uint8Array(32).fill(2);
const ALICE_PUB = bytesToHex(getPublicKey(ALICE_PRIV));
const BOB_PUB = bytesToHex(getPublicKey(BOB_PRIV));
const DB_KEY = crypto.getRandomValues(new Uint8Array(32));

before(async () => {
	await db.open();
});

beforeEach(async () => {
	await db.table("ownKeyPackage").clear();
	await db.table("mlsGroups").clear();
	await db.table("messages").clear();
	await db.table("chatSyncState").clear();
	await db.table("knownContactDevices").clear();
	await db.table("pendingOutgoingMessages").clear();
});

after(() => {
	db.close();
});

test("bumpMessagingActivity: инкрементирует сигнал", () => {
	const before = messagingActivity.value;
	bumpMessagingActivity();
	assert.equal(messagingActivity.value, before + 1);
});

test("listChatPartners: возвращает уникальные contactPubkey активных MLS-групп", async () => {
	await db.table("mlsGroups").bulkAdd([
		toEncryptedRow({ ownerPubkey: ALICE_PUB, groupId: "g1", contactPubkey: BOB_PUB, state: new Uint8Array([1]) }, MLS_GROUPS_PLAINTEXT_FIELDS, DB_KEY),
		toEncryptedRow({ ownerPubkey: ALICE_PUB, groupId: "g2", contactPubkey: "carol-pub", state: new Uint8Array([2]) }, MLS_GROUPS_PLAINTEXT_FIELDS, DB_KEY),
	]);
	const partners = await listChatPartners(ALICE_PUB, DB_KEY);
	assert.deepEqual(partners.sort(), [BOB_PUB, "carol-pub"].sort());
});

test("listChatPartners: owner-scoping — не путает чаты РАЗНЫХ локальных аккаунтов на одном устройстве (критическая находка)", async () => {
	await db.table("mlsGroups").bulkAdd([
		toEncryptedRow({ ownerPubkey: ALICE_PUB, groupId: "g1", contactPubkey: BOB_PUB, state: new Uint8Array([1]) }, MLS_GROUPS_PLAINTEXT_FIELDS, DB_KEY),
		toEncryptedRow({ ownerPubkey: "matero-pub", groupId: "g2", contactPubkey: "someone-else", state: new Uint8Array([2]) }, MLS_GROUPS_PLAINTEXT_FIELDS, DB_KEY),
	]);
	const alicePartners = await listChatPartners(ALICE_PUB, DB_KEY);
	assert.deepEqual(alicePartners, [BOB_PUB], "Алиса не должна видеть чаты аккаунта matero");
});

test("listChatPartners: без активных чатов -> пустой массив", async () => {
	assert.deepEqual(await listChatPartners(ALICE_PUB, DB_KEY), []);
});

// Этап 56 (найдено живой проверкой, реальный аккаунт в Safari) — переписка,
// полученная ТОЛЬКО через зеркалирование с другого устройства (syncMirroredHistory,
// этап 25), пишет напрямую в messages, НЕ создавая mlsGroups на этом устройстве —
// та появляется лишь при первой ОТПРАВКЕ (ensureChatEstablished). Список "Сообщения"
// смотрел только на mlsGroups — пассивно прочитанная зеркалом переписка была
// невидима в списке, хотя открывалась и полностью работала через "Контакты".
test("listChatPartners: партнёр без mlsGroups, но с историей в messages (зеркалирование) — тоже попадает в список", async () => {
	await db.table("messages").bulkAdd([
		{ ownerPubkey: ALICE_PUB, chatId: BOB_PUB, msgId: "m1", id: "m1", lamportTs: 1, senderPubkey: BOB_PUB, status: "sent", deleted: false },
		{ ownerPubkey: ALICE_PUB, chatId: BOB_PUB, msgId: "m2", id: "m2", lamportTs: 2, senderPubkey: ALICE_PUB, status: "sent", deleted: false },
	]);
	const partners = await listChatPartners(ALICE_PUB, DB_KEY);
	assert.deepEqual(partners, [BOB_PUB], "чат виден по messages, даже когда mlsGroups для этого владельца пуста");
});

test("listChatPartners: партнёр из mlsGroups И messages — не дублируется", async () => {
	await db.table("mlsGroups").add(toEncryptedRow({ ownerPubkey: ALICE_PUB, groupId: "g1", contactPubkey: BOB_PUB, state: new Uint8Array([1]) }, MLS_GROUPS_PLAINTEXT_FIELDS, DB_KEY));
	await db.table("messages").add({ ownerPubkey: ALICE_PUB, chatId: BOB_PUB, msgId: "m1", id: "m1", lamportTs: 1, senderPubkey: BOB_PUB, status: "sent", deleted: false });
	const partners = await listChatPartners(ALICE_PUB, DB_KEY);
	assert.deepEqual(partners, [BOB_PUB]);
});

test("listChatPartners: messages-источник тоже owner-scoped — не путает чаты разных локальных аккаунтов", async () => {
	await db.table("messages").bulkAdd([
		{ ownerPubkey: ALICE_PUB, chatId: BOB_PUB, msgId: "m1", id: "m1", lamportTs: 1, senderPubkey: BOB_PUB, status: "sent", deleted: false },
		{ ownerPubkey: "matero-pub", chatId: "someone-else", msgId: "m2", id: "m2", lamportTs: 1, senderPubkey: "someone-else", status: "sent", deleted: false },
	]);
	assert.deepEqual(await listChatPartners(ALICE_PUB, DB_KEY), [BOB_PUB], "Алиса не должна видеть чаты аккаунта matero через messages");
});

test("sendChatMessageAction: устанавливает чат при первой отправке (ensureChatEstablished no-op при повторе) и вызывает refresh-подписку", async () => {
	const bobKeyPackage = await createOwnKeyPackage(BOB_PUB, "bob-device");
	const fetchDeviceKeyPackages = async () => new Map([["bob-device", { wireBytes: bobKeyPackage.wireBytes, createdAt: 1000 }]]);
	let refreshCalls = 0;
	const refreshGroupMessageSubscription = async () => {
		refreshCalls++;
	};
	const publish = async () => ({ ok: true });

	const { eventId } = await sendChatMessageAction(
		ALICE_PUB,
		ALICE_PRIV,
		DB_KEY,
		BOB_PUB,
		"привет",
		1,
		publish,
		fetchDeviceKeyPackages,
		refreshGroupMessageSubscription,
	);
	assert.ok(eventId);
	assert.equal(refreshCalls, 1, "refreshGroupMessageSubscription обязана вызываться (находка 3)");
	assert.equal((await db.table("mlsGroups").toArray()).length, 1);

	// повторная отправка — чат уже установлен (ensureChatEstablished no-op), fetchDeviceKeyPackages
	// не должен вызываться повторно
	const fetchDeviceKeyPackagesShouldNotBeCalled = async () => {
		throw new Error("не должен вызываться повторно");
	};
	await sendChatMessageAction(
		ALICE_PUB,
		ALICE_PRIV,
		DB_KEY,
		BOB_PUB,
		"второе",
		2,
		publish,
		fetchDeviceKeyPackagesShouldNotBeCalled,
		refreshGroupMessageSubscription,
	);
	assert.equal(refreshCalls, 2, "refresh всё равно вызывается на каждую отправку (безусловно, идемпотентно)");
});

test("этап 29/этап B: sendChatMessageAction — attachments (массив) пробрасывается в sendMessage как есть", async () => {
	const bobKeyPackage = await createOwnKeyPackage(BOB_PUB, "bob-device");
	const attachments = [{ type: "file", sha256: "b".repeat(64), blossomUrl: "http://127.0.0.1:8080", encryptionKey: "key==", mime: "application/pdf", size: 999, name: "doc.pdf" }];
	const { eventId } = await sendChatMessageAction(
		ALICE_PUB,
		ALICE_PRIV,
		DB_KEY,
		BOB_PUB,
		"",
		1,
		async () => ({ ok: true }),
		async () => new Map([["bob-device", { wireBytes: bobKeyPackage.wireBytes, createdAt: 1000 }]]),
		async () => {},
		attachments,
	);
	const row = fromEncryptedRow(await db.table("messages").where("id").equals(eventId).first(), DB_KEY);
	assert.deepEqual(row.attachments, attachments);
});

test("sendChatMessageAction: fetchDeviceKeyPackages не находит адресата -> понятная ошибка всплывает как есть", async () => {
	const fetchDeviceKeyPackages = async () => {
		throw new Error("у контакта нет опубликованного ключа для сообщений");
	};
	await assert.rejects(
		() => sendChatMessageAction(ALICE_PUB, ALICE_PRIV, DB_KEY,
		BOB_PUB, "привет", 1, async () => ({ ok: true }), fetchDeviceKeyPackages, async () => {}),
		/ключ/,
	);
});

// Этап 73.3 — И3/И4: ensureChatEstablished бросает DomainError вместо создания
// второй независимой группы — sendChatMessageAction обязана ставить в очередь,
// НЕ пробрасывать ошибку наружу (иначе пользователь видел бы "не отправилось",
// хотя на самом деле сообщение просто ждёт установления переписки).
test("sendChatMessageAction: И4 (mirror-история уже есть) — НЕ бросает, ставит в очередь, возвращает {status:'awaiting_committer'}", async () => {
	await db.table("messages").add({ ownerPubkey: ALICE_PUB, chatId: BOB_PUB, lamportTs: 1, senderPubkey: BOB_PUB, id: "mirrored-ev", status: "sent", msgId: "mirrored-msg" });
	const result = await sendChatMessageAction(ALICE_PUB, ALICE_PRIV, DB_KEY, BOB_PUB, "привет", 5, async () => ({ ok: true }), async () => new Map(), async () => {});
	// Этап 1 (MESSAGE-DELIVERY-TZ.md, З1.1) — result.status ЧИТАЕТСЯ наверху
	// (chat.jsx), msgId — новое аддитивное поле (тождественно строке, уже
	// записанной в messages со статусом "queued" ДО этого вызова).
	assert.equal(result.status, "awaiting_committer");
	assert.equal(typeof result.msgId, "string");
	assert.ok(result.msgId.length > 0);
	const queued = await db.table("pendingOutgoingMessages").where("[ownerPubkey+contactPubkey]").equals([ALICE_PUB, BOB_PUB]).toArray();
	assert.equal(queued.length, 1);
	// Этап 1, З1.3 (вариант A) — строка уже в ленте СРАЗУ, до любого сетевого
	// вызова, со статусом "queued", тем же msgId, что и в очереди.
	const queuedRow = fromEncryptedRow(await db.table("messages").where("[ownerPubkey+chatId+msgId]").equals([ALICE_PUB, BOB_PUB, result.msgId]).first(), DB_KEY);
	assert.equal(queuedRow.status, "queued");
	assert.equal(queuedRow.text, "привет");
});

// Этап 1 (MESSAGE-DELIVERY-TZ.md, приёмка Этапа 1) — И3 (коммиттер этой пары
// не я): строка обязана появиться в ленте СРАЗУ, ДО любого сетевого вызова —
// publish/fetchDeviceKeyPackages не должны быть вызваны вообще, если группы
// ещё нет и я не коммиттер. Именно это устраняет пользовательский симптом
// "нажал Отправить — ничего не произошло" (MESSAGE-DELIVERY-AUDIT-BRIEFING.md
// §0/H1): раньше строка не существовала до конца ensureChatEstablished/sendMessage.
// Этап 4 (MESSAGE-DELIVERY-TZ.md, вариант A) — правка контракта: не-коммиттер
// теперь публикует РОВНО одно событие — gift-wrap "chat-open-request" (kind
// 3012, chats.js), пингующий коммиттера, чтобы не ждать месяцами, пока тот
// сам решит написать. fetchDeviceKeyPackages по-прежнему не его забота — это
// дело коммиттера, получившего сигнал (transport.js giftWrapSubscriber).
test("sendChatMessageAction: И3 (не-коммиттер, contact уже подтверждён) — строка 'queued' в ленте появляется ДО любого сетевого вызова; публикует РОВНО один gift-wrap 'открой переписку', fetchDeviceKeyPackages не трогает", async () => {
	// Определяем, кто НЕ коммиттер в паре ALICE/BOB — не жёстко кодируем
	// порядок ключей (тест не должен зависеть от конкретных fill()-значений).
	const aliceIsCommitter = isCommitter(ALICE_PUB, BOB_PUB);
	const [nonCommitterPub, nonCommitterPriv, peerPub] = aliceIsCommitter ? [BOB_PUB, BOB_PRIV, ALICE_PUB] : [ALICE_PUB, ALICE_PRIV, BOB_PUB];

	await db.table("contactRelationships").put({ owner: nonCommitterPub, peer: peerPub, state: "CONTACT" });

	const published = [];
	let fetchCalled = false;
	const publish = async (event) => {
		published.push(event);
		return { ok: true };
	};
	const fetchDeviceKeyPackages = async () => {
		fetchCalled = true;
		return new Map();
	};

	const result = await sendChatMessageAction(nonCommitterPub, nonCommitterPriv, DB_KEY, peerPub, "жду коммиттера", 1, publish, fetchDeviceKeyPackages, async () => {});

	assert.equal(result.status, "awaiting_committer");
	assert.equal(published.length, 1, "не-коммиттер должен опубликовать РОВНО один gift-wrap — сигнал 'открой переписку', не Welcome и не kind 445");
	assert.equal(published[0].kind, 1059, "это обязан быть gift-wrap (NIP-59), содержимое (kind 3012) скрыто внутри");
	assert.ok(published[0].tags.some((t) => t[0] === "p" && t[1] === peerPub), "gift-wrap обязан быть адресован коммиттеру (#p)");
	assert.equal(fetchCalled, false, "не-коммиттер не должен запрашивать KeyPackage контакта — это дело коммиттера");

	const row = fromEncryptedRow(await db.table("messages").where("[ownerPubkey+chatId+msgId]").equals([nonCommitterPub, peerPub, result.msgId]).first(), DB_KEY);
	assert.equal(row.status, "queued");
	assert.equal(row.text, "жду коммиттера");
});

test("sendChatMessageAction: И3 повторно (второе сообщение той же очереди) — НЕ шлёт второй gift-wrap 'открой переписку' (не спамит коммиттера)", async () => {
	const aliceIsCommitter = isCommitter(ALICE_PUB, BOB_PUB);
	const [nonCommitterPub, nonCommitterPriv, peerPub] = aliceIsCommitter ? [BOB_PUB, BOB_PRIV, ALICE_PUB] : [ALICE_PUB, ALICE_PRIV, BOB_PUB];
	await db.table("contactRelationships").put({ owner: nonCommitterPub, peer: peerPub, state: "CONTACT" });

	const published = [];
	const publish = async (event) => {
		published.push(event);
		return { ok: true };
	};
	const fetchDeviceKeyPackages = async () => new Map();

	await sendChatMessageAction(nonCommitterPub, nonCommitterPriv, DB_KEY, peerPub, "первое", 1, publish, fetchDeviceKeyPackages, async () => {});
	assert.equal(published.length, 1);

	const secondResult = await sendChatMessageAction(nonCommitterPub, nonCommitterPriv, DB_KEY, peerPub, "второе", 2, publish, fetchDeviceKeyPackages, async () => {});
	assert.equal(secondResult.status, "awaiting_committer");
	assert.equal(published.length, 1, "второе сообщение в ТУ ЖЕ уже непустую очередь не должно слать повторный пинг");
});

test("deleteChatMessageAction/markChatReadAction/saveChatDraftAction: делегируют в domain-модули этапов 25-26", async () => {
	const bobKeyPackage = await createOwnKeyPackage(BOB_PUB, "bob-device");
	const publish = async () => ({ ok: true });
	const { eventId } = await sendChatMessageAction(
		ALICE_PUB,
		ALICE_PRIV,
		DB_KEY,
		BOB_PUB,
		"привет",
		1,
		publish,
		async () => new Map([["bob-device", { wireBytes: bobKeyPackage.wireBytes, createdAt: 1000 }]]),
		async () => {},
	);
	const row = await db.table("messages").where("id").equals(eventId).first();

	await markChatReadAction(ALICE_PUB, ALICE_PRIV, DB_KEY, BOB_PUB, 1, publish);
	// своё же сообщение не переводится в read этим механизмом (F-MS-07, этап 26) — просто
	// проверяем, что вызов не бросает и chatSyncState обновился
	assert.equal((await db.table("chatSyncState").get([ALICE_PUB, BOB_PUB])).lastReadLamportTs, 1);

	await saveChatDraftAction(ALICE_PUB, ALICE_PRIV, DB_KEY, BOB_PUB, "черновик", publish);
	assert.equal(fromEncryptedRow(await db.table("chatSyncState").get([ALICE_PUB, BOB_PUB]), DB_KEY).draftText, "черновик");

	await deleteChatMessageAction(ALICE_PUB, ALICE_PRIV, DB_KEY, BOB_PUB, row.msgId, 3, publish);
	const updated = await db.table("messages").where("id").equals(eventId).first();
	assert.equal(updated.deleted, true);
});

test("deleteMessageForMeAction/clearChatHistoryAction: делегируют в deletions.js (этап 27-довесок-5)", async () => {
	const bobKeyPackage = await createOwnKeyPackage(BOB_PUB, "bob-device");
	const publish = async () => ({ ok: true });
	const { eventId } = await sendChatMessageAction(
		ALICE_PUB,
		ALICE_PRIV,
		DB_KEY,
		BOB_PUB,
		"привет",
		1,
		publish,
		async () => new Map([["bob-device", { wireBytes: bobKeyPackage.wireBytes, createdAt: 1000 }]]),
		async () => {},
	);
	const row = await db.table("messages").where("id").equals(eventId).first();

	await deleteMessageForMeAction(ALICE_PUB, BOB_PUB, row.msgId);
	assert.equal(await db.table("messages").where("id").equals(eventId).first(), undefined);

	await sendChatMessageAction(ALICE_PUB, ALICE_PRIV, DB_KEY,
		BOB_PUB, "ещё одно", 2, publish, async () => new Map([["bob-device", { wireBytes: bobKeyPackage.wireBytes, createdAt: 1000 }]]), async () => {});
	await clearChatHistoryAction(ALICE_PUB, BOB_PUB);
	const remaining = await db.table("messages").where("[ownerPubkey+chatId]").equals([ALICE_PUB, BOB_PUB]).toArray();
	assert.deepEqual(remaining, []);
});
