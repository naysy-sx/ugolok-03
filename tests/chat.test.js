import "fake-indexeddb/auto";
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { db } from "../src/core/store/database.js";
import { getPublicKey } from "../src/core/crypto/keys.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { decrypt as nip44Decrypt } from "../src/core/crypto/nip44.js";
import { unwrap as nip59Unwrap } from "../src/core/crypto/nip59.js";
import {
	joinFromWelcome,
	createOwnKeyPackage,
	deserializeState,
	serializeState,
	encryptApplicationMessage,
	deriveNostrEnvelopeKeys,
} from "../src/core/crypto/mls-session.js";
import { encrypt as nip44Encrypt } from "../src/core/crypto/nip44.js";
import { toEncryptedRow, fromEncryptedRow } from "../src/core/store/encrypted-table.js";
import { MLS_GROUPS_PLAINTEXT_FIELDS, MESSAGES_PLAINTEXT_FIELDS } from "../src/core/store/table-fields.js";
import {
	computeGroupId,
	isCommitter,
	ensureOwnKeyPackagePublished,
	ensureChatEstablished,
	acceptWelcome,
	sendMessage,
	receiveGroupMessageEvent,
	getChatHistory,
	normalizeMessageAttachments,
	hasAnyMessagesFor,
	enqueuePendingOutgoingMessage,
	drainPendingOutgoingMessages,
	recordGroupDecryptFailure,
	listDesyncedChats,
	recreateChatConversation,
	upsertMessage,
	requirePublishOk,
	sendExplicitAck,
	sweepPendingAcks,
} from "../src/domain/messaging/chat.js";
import { listConversations } from "../src/domain/messaging/chat-activity.js";
import { getPeerCursor, resetCursorRuntime } from "../src/domain/messaging/peer-cursors.js";

const ALICE_PRIV = new Uint8Array(32).fill(1);
const BOB_PRIV = new Uint8Array(32).fill(2);
const ALICE_PUB = bytesToHex(getPublicKey(ALICE_PRIV));
const BOB_PUB = bytesToHex(getPublicKey(BOB_PRIV));
// Этап 39 (AC-16) — один dbKey на весь тестовый процесс (реально у каждого
// аккаунта свой, но тут Алиса и Боб делят один процесс/БД уже по прежней
// договорённости теста, см. asBob ниже — тот же принцип, dbKey тоже общий).
const DB_KEY = crypto.getRandomValues(new Uint8Array(32));

before(async () => {
	await db.open();
});

beforeEach(async () => {
	await db.table("ownKeyPackage").clear();
	await db.table("mlsGroups").clear();
	await db.table("messages").clear();
	await db.table("outbox").clear();
	await db.table("knownContactDevices").clear();
	await db.table("contactRelationships").clear();
	await db.table("pendingOutgoingMessages").clear();
	await db.table("processedGroupEvents").clear();
	await db.table("chatActivity").clear();
	await db.table("chatGeneration").clear();
	await db.table("peerCursors").clear();
	await db.table("peerPresence").clear();
	resetCursorRuntime();
});

after(() => {
	db.close();
});

function toHex(bytes) {
	return bytesToHex(bytes);
}

test("computeGroupId: детерминирован и симметричен относительно порядка аргументов", () => {
	const g1 = computeGroupId(ALICE_PUB, BOB_PUB);
	const g2 = computeGroupId(BOB_PUB, ALICE_PUB);
	assert.deepEqual(g1, g2);
	assert.equal(g1.length, 32);
});

test("computeGroupId: разные пары дают разные groupId", () => {
	const carolPub = bytesToHex(getPublicKey(new Uint8Array(32).fill(3)));
	const g1 = computeGroupId(ALICE_PUB, BOB_PUB);
	const g2 = computeGroupId(ALICE_PUB, carolPub);
	assert.notDeepEqual(g1, g2);
});

test("ensureOwnKeyPackagePublished: публикует kind 443 и персистирует ownKeyPackage один раз", async () => {
	let publishCount = 0;
	const publish = async (event) => {
		publishCount++;
		assert.equal(event.kind, 443);
		return { ok: true };
	};
	await ensureOwnKeyPackagePublished(ALICE_PUB, ALICE_PRIV, DB_KEY, publish);
	const row = await db.table("ownKeyPackage").get(ALICE_PUB);
	assert.ok(row);
	assert.equal(publishCount, 1);

	await ensureOwnKeyPackagePublished(ALICE_PUB, ALICE_PRIV, DB_KEY, publish);
	assert.equal(publishCount, 1, "повторный вызов не должен публиковать снова");
});

// AC-16 — прямой дамп таблицы (в обход домена) не должен выдавать приватный
// материал MLS KeyPackage в открытом виде.
test("AC-16: ownKeyPackage хранится зашифрованным — сырой дамп не содержит privatePackage/wireBytes", async () => {
	await ensureOwnKeyPackagePublished(ALICE_PUB, ALICE_PRIV, DB_KEY, async () => ({ ok: true }));
	const raw = await db.table("ownKeyPackage").get(ALICE_PUB);
	assert.equal(raw.ownerPubkey, ALICE_PUB);
	assert.equal("privatePackage" in raw, false);
	assert.equal("wireBytes" in raw, false);
	assert.ok(raw.nonce instanceof Uint8Array);
	assert.ok(raw.ciphertext instanceof Uint8Array);

	const decrypted = fromEncryptedRow(raw, DB_KEY);
	assert.ok(decrypted.privatePackage);
});

// Этап 72 — fetchKeyPackage (один wireBytes) заменён на fetchDeviceKeyPackages
// (Map<deviceId, {wireBytes, createdAt}> — может быть НЕСКОЛЬКО устройств
// контакта, см. CONTRACTS.md "Этап 72"). Хелпер по умолчанию — одно
// устройство Боба, для многоустройственных сценариев см. отдельные тесты ниже.
async function establishAliceToBob() {
	// Боб публикует свой KeyPackage (симулируем то, что реально произошло бы на его стороне)
	const bobKeyPackage = await createOwnKeyPackage(BOB_PUB, "bob-device");
	const fetchDeviceKeyPackages = async (pubkey) => {
		assert.equal(pubkey, BOB_PUB);
		return new Map([["bob-device", { wireBytes: bobKeyPackage.wireBytes, createdAt: 1000 }]]);
	};
	const publishedEvents = [];
	const publish = async (event) => {
		publishedEvents.push(event);
		return { ok: true };
	};

	await ensureChatEstablished(ALICE_PUB, ALICE_PRIV, DB_KEY, BOB_PUB, publish, fetchDeviceKeyPackages);

	const welcomeGiftWrap = publishedEvents.find((e) => e.kind === 1059);
	assert.ok(welcomeGiftWrap, "должен опубликовать gift wrap с Welcome");

	// Боб получает и разворачивает Welcome (то, что сделает диспетчер входящих gift-wrap, этап 24 CONTRACTS.md п.6).
	// ВАЖНО: состояние Боба НЕ пишется в общую db.mlsGroups под тем же groupId — в реальности
	// у Алисы и Боба РАЗНЫЕ базы (каждый на своём устройстве); тут они делят один процесс/db
	// только ради теста, поэтому состояние Боба держим ОТДЕЛЬНО и явно "переключаем" db на
	// него там, где тест играет роль Боба (см. asBob ниже) — иначе строка Алисы затирается.
	const rumor = nip59Unwrap(welcomeGiftWrap, BOB_PRIV);
	assert.equal(rumor.kind, 444);
	const welcomeWireBytes = Uint8Array.from(atob(rumor.content), (c) => c.charCodeAt(0));
	const bobState = await joinFromWelcome(bobKeyPackage, welcomeWireBytes);
	const groupId = computeGroupId(ALICE_PUB, BOB_PUB);

	return { fetchDeviceKeyPackages, publish, groupId, bobSerializedState: serializeState(bobState) };
}

// Симулирует "теперь мы на устройстве Боба": подкладывает его копию состояния в
// db.mlsGroups (единственная база в этом тестовом процессе), не трогая копию Алисы,
// которую вызывающий тест обязан сохранить/восстановить сам при необходимости.
// Этап 39 — строка теперь зашифрована DB_KEY (toEncryptedRow/fromEncryptedRow),
// как и в реальном коде.
async function asBob(groupIdHex, bobSerializedState, fn) {
	await db.table("mlsGroups").put(
		toEncryptedRow({ ownerPubkey: BOB_PUB, groupId: groupIdHex, contactPubkey: ALICE_PUB, state: bobSerializedState }, MLS_GROUPS_PLAINTEXT_FIELDS, DB_KEY),
	);
	const result = await fn();
	const updatedBobRaw = await db.table("mlsGroups").get([BOB_PUB, groupIdHex]);
	const updatedBobRow = fromEncryptedRow(updatedBobRaw, DB_KEY);
	return { result, updatedBobSerializedState: updatedBobRow.state };
}

test("ensureChatEstablished: полный флоу — mlsGroups получает запись у A, Welcome доходит до B и применяется", async () => {
	const { groupId, bobSerializedState } = await establishAliceToBob();
	const aliceRow = await db.table("mlsGroups").get([ALICE_PUB, toHex(groupId)]);
	assert.ok(aliceRow, "у Алисы есть своя запись");
	assert.ok(bobSerializedState, "Боб успешно применил Welcome и получил рабочее состояние");
});

// AC-16 — mlsGroups.state — MLS-ратчет-секреты; contactPubkey — с кем разговор.
// Оба относятся к forward-secrecy-критичному состоянию (Tier 0, DESIGN.md этап 39).
test("AC-16: mlsGroups хранится зашифрованным — сырой дамп не содержит state/contactPubkey", async () => {
	const { groupId } = await establishAliceToBob();
	const raw = await db.table("mlsGroups").get([ALICE_PUB, toHex(groupId)]);
	assert.equal(raw.ownerPubkey, ALICE_PUB);
	assert.equal(raw.groupId, toHex(groupId));
	assert.equal("state" in raw, false);
	assert.equal("contactPubkey" in raw, false);
	assert.ok(raw.nonce instanceof Uint8Array);
	assert.ok(raw.ciphertext instanceof Uint8Array);

	const decrypted = fromEncryptedRow(raw, DB_KEY);
	assert.equal(decrypted.contactPubkey, BOB_PUB);
	assert.ok(decrypted.state);
});

test("ensureChatEstablished: повторный вызов — no-op, не публикует Welcome снова", async () => {
	const fetchDeviceKeyPackages = async () => {
		throw new Error("не должен вызываться повторно");
	};
	let publishCount = 0;
	const publish = async () => {
		publishCount++;
		return { ok: true };
	};
	await establishAliceToBob();
	await ensureChatEstablished(ALICE_PUB, ALICE_PRIV, DB_KEY, BOB_PUB, publish, fetchDeviceKeyPackages);
	assert.equal(publishCount, 0);
});

test("ensureChatEstablished: fetchDeviceKeyPackages не находит адресата — понятная ошибка, не тихий сбой", async () => {
	const fetchDeviceKeyPackages = async () => {
		throw new Error("у контакта нет опубликованного ключа для сообщений");
	};
	await assert.rejects(
		() => ensureChatEstablished(ALICE_PUB, ALICE_PRIV, DB_KEY, BOB_PUB, async () => ({ ok: true }), fetchDeviceKeyPackages),
		/ключ/,
	);
});

// Этап 72 — ядро фикса split-brain: у Боба ДВА устройства с независимо
// опубликованными KeyPackage — ensureChatEstablished обязана добавить ОБА
// ОДНИМ commit'ом/welcome, а не выбрать одно произвольно (старый баг:
// разные инициаторы могли выбрать РАЗНОЕ устройство контакта -> два
// непересекающихся MLS-состояния под одним и тем же #h-тегом).
test("ensureChatEstablished: у контакта ДВА устройства — оба добавлены ОДНИМ welcome, оба независимо принимают его", async () => {
	const bobDevice1 = await createOwnKeyPackage(BOB_PUB, "bob-phone");
	const bobDevice2 = await createOwnKeyPackage(BOB_PUB, "bob-laptop");
	const fetchDeviceKeyPackages = async (pubkey) => {
		assert.equal(pubkey, BOB_PUB);
		return new Map([
			["bob-phone", { wireBytes: bobDevice1.wireBytes, createdAt: 1000 }],
			["bob-laptop", { wireBytes: bobDevice2.wireBytes, createdAt: 2000 }],
		]);
	};
	const publishedEvents = [];
	const publish = async (event) => {
		publishedEvents.push(event);
		return { ok: true };
	};

	await ensureChatEstablished(ALICE_PUB, ALICE_PRIV, DB_KEY, BOB_PUB, publish, fetchDeviceKeyPackages);

	const welcomeGiftWraps = publishedEvents.filter((e) => e.kind === 1059);
	assert.equal(welcomeGiftWraps.length, 1, "ОДИН welcome-конверт обслуживает оба устройства, не два отдельных");

	const rumor = nip59Unwrap(welcomeGiftWraps[0], BOB_PRIV);
	const welcomeWireBytes = Uint8Array.from(atob(rumor.content), (c) => c.charCodeAt(0));

	// Оба устройства НЕЗАВИСИМО извлекают свои секреты из ОДНОГО и того же welcome.
	const bobPhoneState = await joinFromWelcome(bobDevice1, welcomeWireBytes);
	const bobLaptopState = await joinFromWelcome(bobDevice2, welcomeWireBytes);
	assert.ok(bobPhoneState);
	assert.ok(bobLaptopState);

	// Бухгалтерия: оба устройства Боба отмечены как уже добавленные в knownContactDevices,
	// чтобы реактивная досинхронизация (этап 72, devices.js) их не задваивала.
	const groupIdHex = toHex(computeGroupId(ALICE_PUB, BOB_PUB));
	const knownRows = await db.table("knownContactDevices").where("[ownerPubkey+contactPubkey]").equals([ALICE_PUB, BOB_PUB]).toArray();
	assert.equal(knownRows.length, 2);
	assert.deepEqual(
		knownRows.map((r) => r.deviceId).sort(),
		["bob-laptop", "bob-phone"],
	);
});

// Этап 73.3 — И3 (единственный коммиттер): ALICE_PUB < BOB_PUB лексикографически
// (проверено против реальных значений фикстур, не предположение).
test("isCommitter: детерминирован, симметричен (ровно одна сторона — коммиттер)", () => {
	assert.equal(isCommitter(ALICE_PUB, BOB_PUB), true);
	assert.equal(isCommitter(BOB_PUB, ALICE_PUB), false);
});

test("ensureChatEstablished: коммиттер (меньший pubkey) создаёт группу как раньше, даже с подтверждённым контактом", async () => {
	await db.table("contactRelationships").put({ owner: ALICE_PUB, peer: BOB_PUB, state: "CONTACT", resolvedAt: 1, sentAt: null });
	const bobKeyPackage = await createOwnKeyPackage(BOB_PUB, "bob-device");
	const fetchDeviceKeyPackages = async () => new Map([["bob-device", { wireBytes: bobKeyPackage.wireBytes, createdAt: 1000 }]]);
	await ensureChatEstablished(ALICE_PUB, ALICE_PRIV, DB_KEY, BOB_PUB, async () => ({ ok: true }), fetchDeviceKeyPackages);
	const groupIdHex = toHex(computeGroupId(ALICE_PUB, BOB_PUB));
	assert.ok(await db.table("mlsGroups").get([ALICE_PUB, groupIdHex]), "коммиттер обязан создать группу немедленно");
});

test("ensureChatEstablished: НЕ-коммиттер (больший pubkey) с ПОДТВЕРЖДЁННЫМ контактом — бросает DomainError('errors.awaitingCommitter'), группу НЕ создаёт", async () => {
	await db.table("contactRelationships").put({ owner: BOB_PUB, peer: ALICE_PUB, state: "CONTACT", resolvedAt: 1, sentAt: null });
	let publishCalled = false;
	const publish = async () => {
		publishCalled = true;
		return { ok: true };
	};
	await assert.rejects(
		() => ensureChatEstablished(BOB_PUB, BOB_PRIV, DB_KEY, ALICE_PUB, publish, async () => new Map()),
		(e) => e.key === "errors.awaitingCommitter",
	);
	const groupIdHex = toHex(computeGroupId(ALICE_PUB, BOB_PUB));
	assert.equal(await db.table("mlsGroups").get([BOB_PUB, groupIdHex]), undefined, "проигравшая сторона не должна создавать группу");
	assert.equal(publishCalled, false, "не должно быть попытки опубликовать Welcome");
});

test("ensureChatEstablished: НЕ-коммиттер БЕЗ подтверждённого контакта (холодное обращение к незнакомцу) — создаёт группу как раньше, гейт НЕ применяется", async () => {
	// НАЙДЕНО ПРОВЕРКОЙ ПРОТИВ РЕАЛЬНЫХ ТЕСТОВ (не домысел): без этого условия
	// inbox-signals.test.js/inbox-requests.test.js (STRANGER_PUB > ALICE_PUB
	// лексикографически) сломали бы холодное обращение к незнакомцу — see
	// CONTRACTS.md/DESIGN.md "Этап 73.3" для полного обоснования.
	// contactRelationships НЕ содержит запись BOB->ALICE — они не контакты.
	const aliceKeyPackage = await createOwnKeyPackage(ALICE_PUB, "alice-device");
	const fetchDeviceKeyPackages = async () => new Map([["alice-device", { wireBytes: aliceKeyPackage.wireBytes, createdAt: 1000 }]]);
	await ensureChatEstablished(BOB_PUB, BOB_PRIV, DB_KEY, ALICE_PUB, async () => ({ ok: true }), fetchDeviceKeyPackages);
	const groupIdHex = toHex(computeGroupId(ALICE_PUB, BOB_PUB));
	assert.ok(await db.table("mlsGroups").get([BOB_PUB, groupIdHex]), "холодное обращение к незнакомцу должно работать как раньше");
});

// Этап 73.3 — И4 (device-level, найдено харнессом: И3 сам по себе НЕ закрывал
// М1 — гонка МЕЖДУ УСТРОЙСТВАМИ одной identity, не между identity).
test("hasAnyMessagesFor: false для пустой истории, true после появления хотя бы одного сообщения", async () => {
	assert.equal(await hasAnyMessagesFor(ALICE_PUB, BOB_PUB), false);
	await db.table("messages").add(
		toEncryptedRow({ ownerPubkey: ALICE_PUB, chatId: BOB_PUB, lamportTs: 1, senderPubkey: BOB_PUB, id: "ev1", text: "x", status: "sent", msgId: "m1" }, MESSAGES_PLAINTEXT_FIELDS, DB_KEY),
	);
	assert.equal(await hasAnyMessagesFor(ALICE_PUB, BOB_PUB), true);
	assert.equal(await hasAnyMessagesFor(ALICE_PUB, "другой-контакт-не-затронут"), false, "не путает разных контактов");
});

test("ensureChatEstablished: И4 — непустая mirror-история блокирует создание, ДАЖЕ если owner — коммиттер (И3 бы разрешил)", async () => {
	// ALICE_PUB — коммиттер относительно BOB_PUB (isCommitter(ALICE,BOB)===true,
	// см. тест выше) — БЕЗ И4 этот вызов прошёл бы гейт И3 беспрепятственно.
	// Симулируем: другое устройство Алисы уже намирорило сообщение с Бобом
	// (kind:446, этап 25) — есть в messages, но mlsGroups у ЭТОГО процесса пуст.
	await db.table("messages").add(
		toEncryptedRow({ ownerPubkey: ALICE_PUB, chatId: BOB_PUB, lamportTs: 1, senderPubkey: ALICE_PUB, id: "mirrored-ev", text: "уже было", status: "sent", msgId: "mirrored-msg" }, MESSAGES_PLAINTEXT_FIELDS, DB_KEY),
	);
	let publishCalled = false;
	const publish = async () => {
		publishCalled = true;
		return { ok: true };
	};
	await assert.rejects(
		() => ensureChatEstablished(ALICE_PUB, ALICE_PRIV, DB_KEY, BOB_PUB, publish, async () => new Map()),
		(e) => e.key === "errors.awaitingSiblingSync",
	);
	const groupIdHex = toHex(computeGroupId(ALICE_PUB, BOB_PUB));
	assert.equal(await db.table("mlsGroups").get([ALICE_PUB, groupIdHex]), undefined, "не должно создавать вторую независимую группу");
	assert.equal(publishCalled, false, "не должно быть попытки опубликовать Welcome");
});

test("ensureChatEstablished: И4 срабатывает БЕЗ подтверждённого контакта (безусловно, в отличие от И3)", async () => {
	// contactRelationships пуст (BOB и ALICE не контакты формально) — И3 бы
	// пропустил (см. тест "холодное обращение к незнакомцу" выше), но mirror-
	// история — прямое доказательство состоявшейся переписки, этого достаточно.
	await db.table("messages").add(
		toEncryptedRow({ ownerPubkey: BOB_PUB, chatId: ALICE_PUB, lamportTs: 1, senderPubkey: ALICE_PUB, id: "mirrored-ev2", text: "уже было", status: "sent", msgId: "mirrored-msg2" }, MESSAGES_PLAINTEXT_FIELDS, DB_KEY),
	);
	await assert.rejects(
		() => ensureChatEstablished(BOB_PUB, BOB_PRIV, DB_KEY, ALICE_PUB, async () => ({ ok: true }), async () => new Map()),
		(e) => e.key === "errors.awaitingSiblingSync",
	);
});

// Этап 1 (MESSAGE-DELIVERY-TZ.md, З1.3, вариант A) — pendingOutgoingMessages
// больше НЕ несёт text/attachments: строка со статусом "queued" уже лежит в
// messages (это то, что реально пишет sendChatMessageAction ДО сети) — drain
// читает содержимое оттуда по msgId. Тест сеет обе таблицы так, как их
// реально оставляет sendChatMessageAction, не напрямую через старый API.
test("enqueuePendingOutgoingMessage/drainPendingOutgoingMessages: очередь копится, drain отправляет по порядку lamportTs, опустошает очередь и переводит ТЕ ЖЕ строки messages (тот же msgId) в 'sent' — без дубля", async () => {
	const msgIdSecond = "queued-msg-second";
	const msgIdFirst = "queued-msg-first";
	await upsertMessage({ ownerPubkey: BOB_PUB, chatId: ALICE_PUB, lamportTs: 2, senderPubkey: BOB_PUB, id: "", text: "второе", status: "queued", msgId: msgIdSecond, sentAt: 2000 }, DB_KEY);
	await upsertMessage({ ownerPubkey: BOB_PUB, chatId: ALICE_PUB, lamportTs: 1, senderPubkey: BOB_PUB, id: "", text: "первое", status: "queued", msgId: msgIdFirst, sentAt: 1000 }, DB_KEY);
	await enqueuePendingOutgoingMessage(BOB_PUB, DB_KEY, { contactPubkey: ALICE_PUB, lamportTs: 2, msgId: msgIdSecond });
	await enqueuePendingOutgoingMessage(BOB_PUB, DB_KEY, { contactPubkey: ALICE_PUB, lamportTs: 1, msgId: msgIdFirst });

	// Группа должна СУЩЕСТВОВАТЬ к моменту drain (создаётся коммиттером/через Welcome —
	// drain сама группу не создаёт, только шлёт УЖЕ существующей).
	const bobKeyPackage = await createOwnKeyPackage(BOB_PUB, "bob-device");
	const fetchDeviceKeyPackages = async () => new Map([["bob-device", { wireBytes: bobKeyPackage.wireBytes, createdAt: 1000 }]]);
	await ensureChatEstablished(ALICE_PUB, ALICE_PRIV, DB_KEY, BOB_PUB, async () => ({ ok: true }), fetchDeviceKeyPackages);
	const groupIdHex = toHex(computeGroupId(ALICE_PUB, BOB_PUB));
	const groupRaw = await db.table("mlsGroups").get([ALICE_PUB, groupIdHex]);
	const group = fromEncryptedRow(groupRaw, DB_KEY);
	await db.table("mlsGroups").put(toEncryptedRow({ ownerPubkey: BOB_PUB, groupId: groupIdHex, contactPubkey: ALICE_PUB, state: group.state }, MLS_GROUPS_PLAINTEXT_FIELDS, DB_KEY));

	const publishedEvents = [];
	const publish = async (event) => {
		publishedEvents.push(event);
		return { ok: true };
	};
	await drainPendingOutgoingMessages(BOB_PUB, BOB_PRIV, DB_KEY, ALICE_PUB, publish);

	const remaining = await db.table("pendingOutgoingMessages").where("[ownerPubkey+contactPubkey]").equals([BOB_PUB, ALICE_PUB]).toArray();
	assert.equal(remaining.length, 0, "очередь должна опустеть после drain");
	assert.equal(publishedEvents.filter((e) => e.kind === 445).length, 2, "оба сообщения должны быть реально отправлены (kind 445)");

	const bobMessages = await db.table("messages").where("[ownerPubkey+chatId]").equals([BOB_PUB, ALICE_PUB]).toArray();
	assert.equal(bobMessages.length, 2, "drain не создаёт вторую строку на то же сообщение — тот же msgId, обновление на месте");
	const byMsgId = Object.fromEntries(bobMessages.map((r) => [r.msgId, fromEncryptedRow(r, DB_KEY)]));
	assert.equal(byMsgId[msgIdFirst].status, "sent");
	assert.equal(byMsgId[msgIdFirst].text, "первое");
	assert.ok(byMsgId[msgIdFirst].id, "id обязан заполниться реальным eventId после публикации");
	assert.equal(byMsgId[msgIdSecond].status, "sent");
	assert.equal(byMsgId[msgIdSecond].text, "второе");
});

test("sendMessage: бросает, если чат ещё не установлен (нет mlsGroups записи)", async () => {
	await assert.rejects(() => sendMessage(ALICE_PUB, ALICE_PRIV, DB_KEY, BOB_PUB, "привет", 1, async () => ({ ok: true })));
});

test("sendMessage/receiveGroupMessageEvent: полный цикл — B реально получает и расшифровывает сообщение от A", async () => {
	const { groupId, bobSerializedState } = await establishAliceToBob();
	const groupIdHex = toHex(groupId);

	const publishedEvents = [];
	const publish = async (event) => {
		publishedEvents.push(event);
		return { ok: true };
	};
	// db.mlsGroups сейчас содержит запись АЛИСЫ (establishAliceToBob оставил её последней)
	// sendMessage публикует ДВА события (этап 25): живой kind 445 и зеркало kind 446 (best-effort)
	const { eventId } = await sendMessage(ALICE_PUB, ALICE_PRIV, DB_KEY, BOB_PUB, "привет, Боб", 5, publish);
	const sentEvent = publishedEvents.find((e) => e.kind === 445);
	assert.ok(sentEvent, "должен опубликовать живое MLS-сообщение (kind 445)");
	assert.ok(publishedEvents.some((e) => e.kind === 446), "должен зеркалировать (kind 446)");
	assert.equal(sentEvent.kind, 445);
	assert.equal(eventId, sentEvent.id);
	assert.deepEqual(sentEvent.tags, [["h", groupIdHex]]);
	// эфемерный ключ — pubkey события НЕ равен identity-ключу отправителя
	assert.notEqual(sentEvent.pubkey, ALICE_PUB);

	// "Переключаемся" на Боба (его отдельная копия состояния, не запись Алисы) — см. asBob
	const { result: received } = await asBob(groupIdHex, bobSerializedState, () =>
		receiveGroupMessageEvent(BOB_PUB, BOB_PRIV, DB_KEY, sentEvent, async () => ({ ok: true })),
	);
	// sentAt (этап 29) — sendMessage теперь ВСЕГДА генерирует его, поэтому появляется и
	// здесь (в отличие от devices.test.js, где payload собран вручную БЕЗ sentAt —
	// та ветка обратной совместимости покрыта отдельно, см. chat.js).
	assert.equal(received.text, "привет, Боб");
	assert.equal(received.lamportTs, 5);
	assert.equal(typeof received.sentAt, "number");
	assert.equal(received.attachments, undefined, "без вложения — поле отсутствует, не undefined-значение");
});

// AC-FS-02 (TECH.md §15, метод "Перемешать доставку") — уровень приложения, не
// только сырое ts-mls API (см. mls-session.test.js): relay не гарантирует порядок
// доставки live-событий, значит receiveGroupMessageEvent обязан корректно
// обрабатывать реальные kind 445, пришедшие в произвольном порядке, ПЕРСИСТИРУЯ
// состояние между вызовами так же, как это реально происходит в приложении между
// приёмами сообщений (не всё в одной функции без сериализации).
test("AC-FS-02 (уровень приложения): receiveGroupMessageEvent обрабатывает реальные kind 445, пришедшие НЕ ПО ПОРЯДКУ (2, 3, 1)", async () => {
	const { groupId, bobSerializedState } = await establishAliceToBob();
	const groupIdHex = toHex(groupId);
	const sentEvents = [];
	const publish = async (event) => {
		sentEvents.push(event);
		return { ok: true };
	};

	await sendMessage(ALICE_PUB, ALICE_PRIV, DB_KEY, BOB_PUB, "первое", 1, publish);
	await sendMessage(ALICE_PUB, ALICE_PRIV, DB_KEY, BOB_PUB, "второе", 2, publish);
	await sendMessage(ALICE_PUB, ALICE_PRIV, DB_KEY, BOB_PUB, "третье", 3, publish);
	const [event1, event2, event3] = sentEvents.filter((e) => e.kind === 445);

	let bobState = bobSerializedState;

	let step = await asBob(groupIdHex, bobState, () => receiveGroupMessageEvent(BOB_PUB, BOB_PRIV, DB_KEY, event2, async () => ({ ok: true })));
	bobState = step.updatedBobSerializedState;
	assert.equal(step.result.text, "второе");

	step = await asBob(groupIdHex, bobState, () => receiveGroupMessageEvent(BOB_PUB, BOB_PRIV, DB_KEY, event3, async () => ({ ok: true })));
	bobState = step.updatedBobSerializedState;
	assert.equal(step.result.text, "третье");

	step = await asBob(groupIdHex, bobState, () => receiveGroupMessageEvent(BOB_PUB, BOB_PRIV, DB_KEY, event1, async () => ({ ok: true })));
	assert.equal(step.result.text, "первое", "пропущенное первое сообщение всё равно расшифровывается корректно после персистенции состояния между приёмами");
});

// Этап 3 (MESSAGE-DELIVERY-TZ.md, З3.1/З3.2) — правка контракта: раньше ОДИН
// провал publish() сразу ставил messages.status="failed" — теперь событие
// уже в outbox ДО попытки публикации (не только в catch), а локальный статус
// остаётся "sending", пока outbox не исчерпает MAX_ATTEMPTS (drainOutboxSafely,
// transport.js) — "failed" означает "больше не пытаемся", не "одна неудача".
test("AC-09: sendMessage — publish возвращает {ok:false} — НЕ бросает, ставит event в outbox целиком (уже там ДО попытки, не только в catch), статус остаётся 'sending', возвращает {eventId, queued:true}", async () => {
	await establishAliceToBob();
	const publish = async () => ({ ok: false, reason: "relay недоступен" });

	const result = await sendMessage(ALICE_PUB, ALICE_PRIV, DB_KEY, BOB_PUB, "не долетит", 7, publish);
	assert.equal(result.queued, true);
	assert.equal(typeof result.eventId, "string");

	const outboxRows = (await db.table("outbox").where("eventId").equals(result.eventId).toArray()).map((r) => fromEncryptedRow(r, DB_KEY));
	assert.equal(outboxRows.length, 1, "событие должно быть поставлено в outbox");
	assert.equal(outboxRows[0].status, "pending");
	assert.equal(outboxRows[0].retryCount, 1, "markFailed уже отработал один раз внутри requirePublishOk-неудачи");
	assert.equal(outboxRows[0].event.kind, 445, "в outbox должен лежать ВЕСЬ подписанный event (МЛС-ратчет уже продвинут — регенерировать нельзя), не только id");
	assert.equal(outboxRows[0].event.id, result.eventId);

	const messageRows = (await db.table("messages").where("id").equals(result.eventId).toArray()).map((r) => fromEncryptedRow(r, DB_KEY));
	assert.equal(messageRows.length, 1, "сообщение должно остаться в локальной истории, не потеряно молча");
	assert.equal(messageRows[0].status, "sending", "ОДНА неудача больше не хоронит статус — outbox ещё будет пытаться");
	assert.equal(messageRows[0].text, "не долетит");
});

test("AC-09 АДВЕРСАРНО: sendMessage — publish() бросает исключение напрямую (не {ok:false}) — тоже перехватывается, тоже enqueue, не роняет вызывающий код", async () => {
	await establishAliceToBob();
	const publish = async () => {
		throw new Error("сеть недоступна");
	};

	const result = await sendMessage(ALICE_PUB, ALICE_PRIV, DB_KEY, BOB_PUB, "тоже не долетит", 8, publish);
	assert.equal(result.queued, true);
	const outboxRows = await db.table("outbox").where("eventId").equals(result.eventId).toArray();
	assert.equal(outboxRows.length, 1);
});

// Этап 5 (MESSAGE-DELIVERY-TZ.md, З5.2) — strfry отвечает OK:false с сырым
// текстом "invalid: created_at too late"/"...too early" на расхождение
// часов (проверено чтением server/strfry/strfry-src/src/events.cpp и
// apps/relay/RelayIngester.cpp, не домысел) — requirePublishOk обязана
// превратить это в понятную, переведённую причину, а не пробрасывать
// строку от relay как есть.
test("requirePublishOk: OK:false с 'invalid: created_at too late' -> DomainError('errors.clockAhead')", async () => {
	const event = { id: "ev-clock-1", kind: 445 };
	const publish = async () => ({ ok: false, reason: "invalid: created_at too late" });
	await assert.rejects(
		() => requirePublishOk(publish, event),
		(e) => {
			assert.equal(e.name, "DomainError");
			assert.equal(e.key, "errors.clockAhead");
			return true;
		},
	);
});

test("requirePublishOk: OK:false с 'invalid: created_at too early' -> DomainError('errors.clockBehind')", async () => {
	const event = { id: "ev-clock-2", kind: 445 };
	const publish = async () => ({ ok: false, reason: "invalid: created_at too early" });
	await assert.rejects(
		() => requirePublishOk(publish, event),
		(e) => {
			assert.equal(e.name, "DomainError");
			assert.equal(e.key, "errors.clockBehind");
			return true;
		},
	);
});

test("requirePublishOk: OK:false с прочей причиной -> обычный Error(reason), не DomainError (не за что зацепиться классификации)", async () => {
	const event = { id: "ev-other", kind: 445 };
	const publish = async () => ({ ok: false, reason: "blocked: pubkey not on whitelist" });
	await assert.rejects(() => requirePublishOk(publish, event), /blocked: pubkey not on whitelist/);
});

// Этап 5 (З5.2) — sendMessage/finishOutgoingMessage: расхождение часов
// обязано ВСПЛЫТЬ к вызывающему коду (chat.jsx показывает пользователю
// понятную причину сразу), а не молча уйти в тот же "sending"+outbox-retry
// путь, что обычный сетевой сбой — но событие ВСЁ РАВНО остаётся в outbox
// (вдруг часы поправятся сами, retry той же попытки тогда пройдёт).
test("sendMessage: publish возвращает 'created_at too late' -> бросает DomainError('errors.clockAhead') вызывающему коду, НО событие всё равно уже в outbox", async () => {
	await establishAliceToBob();
	const publish = async () => ({ ok: false, reason: "invalid: created_at too late" });

	await assert.rejects(
		() => sendMessage(ALICE_PUB, ALICE_PRIV, DB_KEY, BOB_PUB, "часы врут", 9, publish),
		(e) => {
			assert.equal(e.key, "errors.clockAhead");
			return true;
		},
	);

	const outboxRows = await db.table("outbox").toArray();
	assert.equal(outboxRows.filter((r) => r.status === "pending").length, 1, "событие обязано остаться в outbox, а не потеряться из-за немедленного throw");
});

// Этап 5 (МESSAGE-DELIVERY-TZ.md, З5.3) — проверка размера ДО encryptApplicationMessage:
// раньше nip44.js бросала СВОЙ предел УЖЕ ПОСЛЕ того, как MLS-ратчет продвинулся
// (encryptApplicationMessage успевала отработать) — слишком большое сообщение
// теряло бы генерацию ратчета впустую, тот же класс дыры, что AC-09 до Этапа 3.
test("sendMessage: слишком большой payload (много вложений) -> DomainError('errors.messageTooLargeForEvent') ДО того, как MLS-ратчет продвинется", async () => {
	const { groupId } = await establishAliceToBob();
	const groupIdHex = toHex(groupId);
	const groupRawBefore = await db.table("mlsGroups").get([ALICE_PUB, groupIdHex]);
	const stateBefore = fromEncryptedRow(groupRawBefore, DB_KEY).state;

	// 80 фиктивных вложений с длинными полями — JSON.stringify этого payload
	// даёт ~61KB (проверено эмпирически), заведомо выше порога ~44KB
	// (floor(65535*3/4)-4096), не полагаясь на точный подсчёт байт руками.
	const attachments = Array.from({ length: 80 }, (_, i) => ({
		type: "file",
		sha256: "a".repeat(64),
		blossomUrl: "http://127.0.0.1:8080/" + "x".repeat(400),
		encryptionKey: "k".repeat(150),
		mime: "application/octet-stream",
		size: 1000 + i,
		name: "file-" + i + ".bin",
	}));

	await assert.rejects(
		() => sendMessage(ALICE_PUB, ALICE_PRIV, DB_KEY, BOB_PUB, "много вложений", 10, async () => ({ ok: true }), attachments),
		(e) => {
			assert.equal(e.name, "DomainError");
			assert.equal(e.key, "errors.messageTooLargeForEvent");
			return true;
		},
	);

	const groupRawAfter = await db.table("mlsGroups").get([ALICE_PUB, groupIdHex]);
	const stateAfter = fromEncryptedRow(groupRawAfter, DB_KEY).state;
	assert.deepEqual(stateAfter, stateBefore, "MLS-состояние не должно измениться — ратчет не должен был продвинуться на отклонённой попытке");

	const outboxRows = await db.table("outbox").toArray();
	assert.equal(outboxRows.length, 0, "ничего не должно попасть в outbox — событие ещё даже не подписано");
});

// Этап 5 (З5.3) — ensureChatEstablished: слишком много устройств контакта раздувает
// Welcome (каждое устройство — отдельный получатель addMembers, накладные расходы
// TreeKEM растут с числом листьев) настолько, что он не влезет в конверт NIP-59/NIP-44.
// Порог подобран эмпирически (см. коммит Этапа 5): 50 устройств стабильно даёт
// welcomeWireBytes ~21KB (> порога 20000), 30 устройств — ~13KB (заведомо ниже).
test("ensureChatEstablished: контакт с 50 устройствами -> DomainError('errors.welcomeTooLargeForDeviceCount'), группа НЕ создаётся", async () => {
	const deviceEntries = [];
	for (let i = 0; i < 50; i++) {
		const kp = await createOwnKeyPackage(BOB_PUB, "bob-device-" + i);
		deviceEntries.push(["bob-device-" + i, { wireBytes: kp.wireBytes, createdAt: 1000 + i }]);
	}
	const fetchDeviceKeyPackages = async (pubkey) => {
		assert.equal(pubkey, BOB_PUB);
		return new Map(deviceEntries);
	};

	await assert.rejects(
		() => ensureChatEstablished(ALICE_PUB, ALICE_PRIV, DB_KEY, BOB_PUB, async () => ({ ok: true }), fetchDeviceKeyPackages),
		(e) => {
			assert.equal(e.name, "DomainError");
			assert.equal(e.key, "errors.welcomeTooLargeForDeviceCount");
			return true;
		},
	);

	const groupIdHex = toHex(computeGroupId(ALICE_PUB, BOB_PUB));
	assert.equal(await db.table("mlsGroups").get([ALICE_PUB, groupIdHex]), undefined, "группа не должна персистироваться — Welcome для неё всё равно недоставим");
});

// Редизайн интерфейса, этап 5 (CONTRACTS.md) — chatActivity: три точки
// записи внутри chat.js (doSendMessage x2, doReceiveGroupMessageEvent).

test("Этап 5: sendMessage (успех) пишет chatActivity — chatId=BOB_PUB, lastFrom=ALICE_PUB, lastAt=sentAt", async () => {
	await establishAliceToBob();
	const before = Math.floor(Date.now() / 1000);
	await sendMessage(ALICE_PUB, ALICE_PRIV, DB_KEY, BOB_PUB, "активность", 1, async () => ({ ok: true }));
	const after = Math.floor(Date.now() / 1000);

	const rows = await listConversations(ALICE_PUB, DB_KEY);
	assert.equal(rows.length, 1);
	assert.equal(rows[0].chatId, BOB_PUB);
	assert.equal(rows[0].lastFrom, ALICE_PUB);
	assert.ok(rows[0].lastAt >= before && rows[0].lastAt <= after);
});

test("Этап 5: sendMessage (publish упал, ветка failed) ВСЁ РАВНО пишет chatActivity — локальное действие пользователя учитывается", async () => {
	await establishAliceToBob();
	await sendMessage(ALICE_PUB, ALICE_PRIV, DB_KEY, BOB_PUB, "не долетит", 2, async () => ({ ok: false, reason: "нет сети" }));

	const rows = await listConversations(ALICE_PUB, DB_KEY);
	assert.equal(rows.length, 1);
	assert.equal(rows[0].lastFrom, ALICE_PUB);
});

test("Этап 5: receiveGroupMessageEvent пишет chatActivity владельцу-получателю — lastFrom=senderPubkey", async () => {
	const { groupId, bobSerializedState } = await establishAliceToBob();
	const groupIdHex = toHex(groupId);
	const publishedEvents = [];
	const publish = async (event) => {
		publishedEvents.push(event);
		return { ok: true };
	};
	await sendMessage(ALICE_PUB, ALICE_PRIV, DB_KEY, BOB_PUB, "для Боба", 1, publish);
	const realEvent = publishedEvents.find((e) => e.kind === 445);

	await asBob(groupIdHex, bobSerializedState, () => receiveGroupMessageEvent(BOB_PUB, BOB_PRIV, DB_KEY, realEvent, async () => ({ ok: true })));

	const bobRows = await listConversations(BOB_PUB, DB_KEY);
	assert.equal(bobRows.length, 1);
	assert.equal(bobRows[0].chatId, ALICE_PUB);
	assert.equal(bobRows[0].lastFrom, ALICE_PUB, "отправитель — Алиса, не Боб");
});

test("Этап 5: старый формат payload БЕЗ sentAt — chatActivity всё равно пишется, lastAt = момент приёма", async () => {
	const { groupId, bobSerializedState } = await establishAliceToBob();
	const groupIdHex = toHex(groupId);
	const aliceGroupRow = fromEncryptedRow(await db.table("mlsGroups").get([ALICE_PUB, groupIdHex]), DB_KEY);
	const aliceState = deserializeState(aliceGroupRow.state);
	const legacyPayload = { text: "старое сообщение без sentAt", lamportTs: 1, msgId: "legacy-activity-1", senderPubkey: ALICE_PUB };
	const sendResult = await encryptApplicationMessage(aliceState, new TextEncoder().encode(JSON.stringify(legacyPayload)));
	const aliceEnvKeys = await deriveNostrEnvelopeKeys(aliceState);
	const legacyEvent = {
		kind: 445,
		tags: [["h", groupIdHex]],
		content: nip44Encrypt(encodeBase64(sendResult.wireBytes), aliceEnvKeys.privateKey, bytesToHex(aliceEnvKeys.publicKey)),
		id: "legacy-activity-event",
		pubkey: "irrelevant",
	};

	const before = Math.floor(Date.now() / 1000);
	await asBob(groupIdHex, bobSerializedState, () => receiveGroupMessageEvent(BOB_PUB, BOB_PRIV, DB_KEY, legacyEvent, async () => ({ ok: true })));
	const after = Math.floor(Date.now() / 1000);

	const bobRows = await listConversations(BOB_PUB, DB_KEY);
	assert.equal(bobRows.length, 1);
	assert.ok(bobRows[0].lastAt >= before && bobRows[0].lastAt <= after, "без sentAt в payload используется момент приёма, запись не пропадает");
});

test("receiveGroupMessageEvent: неизвестный groupId (h-тег) — discard, не бросает", async () => {
	const fakeEvent = { kind: 445, tags: [["h", "00".repeat(32)]], content: "irrelevant", pubkey: "x", id: "y" };
	const result = await receiveGroupMessageEvent(BOB_PUB, BOB_PRIV, DB_KEY, fakeEvent, async () => ({ ok: true }));
	assert.equal(result, null);
});

test("contactPubkey переживает put() из sendMessage — второй приём после второй отправки всё ещё резолвит нужного контакта", async () => {
	const { groupId, bobSerializedState } = await establishAliceToBob();
	const groupIdHex = toHex(groupId);
	const sentEvents = [];
	const publish = async (event) => {
		sentEvents.push(event);
		return { ok: true };
	};
	await sendMessage(ALICE_PUB, ALICE_PRIV, DB_KEY, BOB_PUB, "первое", 1, publish);
	// contactPubkey должен пережить put() внутри sendMessage (это был реальный найденный баг)
	const rowAfterFirstSend = fromEncryptedRow(await db.table("mlsGroups").get([ALICE_PUB, groupIdHex]), DB_KEY);
	assert.equal(rowAfterFirstSend.contactPubkey, BOB_PUB);

	await asBob(groupIdHex, bobSerializedState, () =>
		receiveGroupMessageEvent(BOB_PUB, BOB_PRIV, DB_KEY, sentEvents[0], async () => ({ ok: true })),
	);
	const bobRowAfterReceive = fromEncryptedRow(await db.table("mlsGroups").get([BOB_PUB, groupIdHex]), DB_KEY);
	assert.equal(bobRowAfterReceive.contactPubkey, ALICE_PUB, "и после приёма (put в receiveGroupMessageEvent) тоже");
});

test("acceptWelcome: требует опубликованный собственный ownKeyPackage", async () => {
	await assert.rejects(() => acceptWelcome(BOB_PUB, DB_KEY, ALICE_PUB, new Uint8Array(10)), /KeyPackage/);
});

// AC-16 (найдено пользователем прямым осмотром IndexedDB) — пользователь буквально
// увидел "ну чё" открытым текстом в этой таблице.
test("AC-16: messages хранится зашифрованным — сырой дамп не содержит text/attachment", async () => {
	await establishAliceToBob();
	const { eventId } = await sendMessage(ALICE_PUB, ALICE_PRIV, DB_KEY, BOB_PUB, "секретное сообщение", 1, async () => ({ ok: true }));
	const raw = await db.table("messages").where("id").equals(eventId).first();
	assert.equal(raw.id, eventId);
	assert.equal("text" in raw, false);
	assert.equal("sentAt" in raw, false);
	assert.ok(raw.nonce instanceof Uint8Array);
	assert.ok(raw.ciphertext instanceof Uint8Array);

	const decrypted = fromEncryptedRow(raw, DB_KEY);
	assert.equal(decrypted.text, "секретное сообщение");
});

test("sendMessage: каждое сообщение публикуется с НОВЫМ эфемерным ключом (не переиспользуется)", async () => {
	await establishAliceToBob();
	const events = [];
	const publish = async (event) => {
		events.push(event);
		return { ok: true };
	};
	await sendMessage(ALICE_PUB, ALICE_PRIV, DB_KEY, BOB_PUB, "первое", 1, publish);
	await sendMessage(ALICE_PUB, ALICE_PRIV, DB_KEY, BOB_PUB, "второе", 2, publish);
	assert.notEqual(events[0].pubkey, events[1].pubkey);
});

test("getChatHistory: сортировка по (lamportTs, senderPubkey, eventId) — F-MS-05/AC-05", async () => {
	await db.table("messages").bulkAdd([
		toEncryptedRow({ ownerPubkey: ALICE_PUB, chatId: BOB_PUB, lamportTs: 2, senderPubkey: ALICE_PUB, id: "e2", text: "b", status: "sent" }, MESSAGES_PLAINTEXT_FIELDS, DB_KEY),
		toEncryptedRow({ ownerPubkey: ALICE_PUB, chatId: BOB_PUB, lamportTs: 1, senderPubkey: BOB_PUB, id: "e1", text: "a", status: "sent" }, MESSAGES_PLAINTEXT_FIELDS, DB_KEY),
		toEncryptedRow({ ownerPubkey: ALICE_PUB, chatId: BOB_PUB, lamportTs: 2, senderPubkey: ALICE_PUB, id: "e0", text: "c-tiebreak-by-id", status: "sent" }, MESSAGES_PLAINTEXT_FIELDS, DB_KEY),
	]);
	const history = await getChatHistory(ALICE_PUB, BOB_PUB, DB_KEY);
	assert.deepEqual(
		history.map((m) => m.id),
		["e1", "e0", "e2"],
	);
});

test("getChatHistory: не путает разные чаты (chatId изоляция)", async () => {
	const carolPub = bytesToHex(getPublicKey(new Uint8Array(32).fill(3)));
	await db.table("messages").bulkAdd([
		toEncryptedRow({ ownerPubkey: ALICE_PUB, chatId: BOB_PUB, lamportTs: 1, senderPubkey: ALICE_PUB, id: "e1", text: "for bob", status: "sent" }, MESSAGES_PLAINTEXT_FIELDS, DB_KEY),
		toEncryptedRow({ ownerPubkey: ALICE_PUB, chatId: carolPub, lamportTs: 1, senderPubkey: ALICE_PUB, id: "e2", text: "for carol", status: "sent" }, MESSAGES_PLAINTEXT_FIELDS, DB_KEY),
	]);
	const history = await getChatHistory(ALICE_PUB, BOB_PUB, DB_KEY);
	assert.deepEqual(history.map((m) => m.text), ["for bob"]);
});

test("getChatHistory: owner-scoping — не путает переписки РАЗНЫХ локальных аккаунтов на одном устройстве (критическая находка)", async () => {
	await db.table("messages").bulkAdd([
		toEncryptedRow({ ownerPubkey: ALICE_PUB, chatId: BOB_PUB, lamportTs: 1, senderPubkey: BOB_PUB, id: "e1", text: "alice's copy", status: "sent" }, MESSAGES_PLAINTEXT_FIELDS, DB_KEY),
		toEncryptedRow({ ownerPubkey: "matero-pub", chatId: BOB_PUB, lamportTs: 1, senderPubkey: BOB_PUB, id: "e2", text: "matero's unrelated copy", status: "sent" }, MESSAGES_PLAINTEXT_FIELDS, DB_KEY),
	]);
	const aliceHistory = await getChatHistory(ALICE_PUB, BOB_PUB, DB_KEY);
	assert.deepEqual(aliceHistory.map((m) => m.text), ["alice's copy"]);
});

test("этап 29: sendMessage — sentAt (wall-clock) генерируется всегда, попадает в локальную строку", async () => {
	await establishAliceToBob();
	const before = Math.floor(Date.now() / 1000);
	const { eventId } = await sendMessage(ALICE_PUB, ALICE_PRIV, DB_KEY, BOB_PUB, "привет", 1, async () => ({ ok: true }));
	const after = Math.floor(Date.now() / 1000);

	const row = fromEncryptedRow(await db.table("messages").where("id").equals(eventId).first(), DB_KEY);
	assert.equal(typeof row.sentAt, "number");
	assert.ok(row.sentAt >= before && row.sentAt <= after, "sentAt — реальное время отправки, не что попало");
	assert.equal(row.attachments, undefined, "без вложения — поле отсутствует");
});

test("этап 29/этап B: sendMessage(attachments) — массив вложений попадает в локальную строку и доходит до собеседника", async () => {
	const { groupId, bobSerializedState } = await establishAliceToBob();
	const groupIdHex = toHex(groupId);
	const attachment = {
		type: "image",
		sha256: "a".repeat(64),
		blossomUrl: "http://127.0.0.1:8080",
		encryptionKey: "base64keyplaceholder==",
		mime: "image/jpeg",
		size: 12345,
		name: "photo.jpg",
		position: "above",
	};
	const attachments = [attachment];
	const publish = async () => ({ ok: true });
	const { eventId } = await sendMessage(ALICE_PUB, ALICE_PRIV, DB_KEY, BOB_PUB, "смотри", 1, publish, attachments);

	const aliceRow = fromEncryptedRow(await db.table("messages").where("id").equals(eventId).first(), DB_KEY);
	assert.deepEqual(aliceRow.attachments, attachments, "своя копия сразу содержит вложения (оптимистично, как text)");

	const sentEvents = [];
	const publishCapture = async (event) => {
		sentEvents.push(event);
		return { ok: true };
	};
	await sendMessage(ALICE_PUB, ALICE_PRIV, DB_KEY, BOB_PUB, "ещё одна с вложением", 2, publishCapture, attachments);
	const sentEvent = sentEvents.find((e) => e.kind === 445);

	const { result: received } = await asBob(groupIdHex, bobSerializedState, () =>
		receiveGroupMessageEvent(BOB_PUB, BOB_PRIV, DB_KEY, sentEvent, async () => ({ ok: true })),
	);
	assert.deepEqual(received.attachments, attachments, "вложения доходят до собеседника без искажений");

	const bobRow = fromEncryptedRow(await db.table("messages").where("id").equals(sentEvent.id).first(), DB_KEY);
	assert.deepEqual(bobRow.attachments, attachments, "и попадают в его локальную строку тоже");
});

function encodeBase64(bytes) {
	return btoa(String.fromCharCode.apply(null, bytes));
}

test("этап B: doReceiveGroupMessageEvent нормализует старый формат payload (attachment, единственное число) в attachments-массив", async () => {
	const { groupId, bobSerializedState } = await establishAliceToBob();
	const groupIdHex = toHex(groupId);
	const legacyAttachment = { type: "image", sha256: "b".repeat(64), blossomUrl: "http://127.0.0.1:8080", encryptionKey: "key==", mime: "image/png", size: 999, name: "old.png" };

	// Сообщение старого формата (payload.attachment, единственное число, не
	// payload.attachments) — собрано вручную мимо sendMessage (тот уже пишет
	// только новый формат), тот же приём, что devices.test.js использует для
	// проверки совместимости с payload без sentAt/attachment (строки ~326-336).
	const aliceGroupRow = fromEncryptedRow(await db.table("mlsGroups").get([ALICE_PUB, groupIdHex]), DB_KEY);
	const aliceState = deserializeState(aliceGroupRow.state);
	const legacyPayload = { text: "старое вложение", lamportTs: 1, msgId: "legacy-1", senderPubkey: ALICE_PUB, attachment: legacyAttachment };
	const sendResult = await encryptApplicationMessage(aliceState, new TextEncoder().encode(JSON.stringify(legacyPayload)));
	const aliceEnvKeys = await deriveNostrEnvelopeKeys(aliceState);
	const legacyEvent = {
		kind: 445,
		tags: [["h", groupIdHex]],
		content: nip44Encrypt(encodeBase64(sendResult.wireBytes), aliceEnvKeys.privateKey, bytesToHex(aliceEnvKeys.publicKey)),
		id: "legacy-event-1",
		pubkey: "irrelevant",
	};

	const { result } = await asBob(groupIdHex, bobSerializedState, () =>
		receiveGroupMessageEvent(BOB_PUB, BOB_PRIV, DB_KEY, legacyEvent, async () => ({ ok: true })),
	);
	assert.deepEqual(result.attachments, [legacyAttachment], "старый формат (attachment) нормализуется в attachments-массив на чтении");

	const bobRow = fromEncryptedRow(await db.table("messages").where("id").equals(legacyEvent.id).first(), DB_KEY);
	assert.deepEqual(bobRow.attachments, [legacyAttachment], "нормализованный массив попадает и в локальную строку получателя");
});

test("normalizeMessageAttachments: пустой row без attachment/attachments не меняется", () => {
	const row = { text: "привет" };
	assert.equal(normalizeMessageAttachments(row), row, "нет изменений — тот же объект, не копия");
});

test("normalizeMessageAttachments: attachment (старый формат) -> attachments-массив, старое поле остаётся", () => {
	const attachment = { type: "file", mime: "application/pdf" };
	const row = { text: "", attachment };
	const result = normalizeMessageAttachments(row);
	assert.deepEqual(result.attachments, [attachment]);
	assert.equal(result.attachment, attachment);
});

test("normalizeMessageAttachments: attachments уже есть (новый формат) — attachment игнорируется, если тоже присутствует", () => {
	const attachments = [{ type: "image" }];
	const row = { attachments, attachment: { type: "file" } };
	assert.equal(normalizeMessageAttachments(row), row, "attachments уже есть — приоритет у него, объект не трогаем");
});

test("getChatHistory: нормализует старый формат вложения (attachment) уже сохранённой строки", async () => {
	await establishAliceToBob();
	const legacyAttachment = { type: "image", mime: "image/png", size: 1 };
	await upsertMessage(
		{ ownerPubkey: ALICE_PUB, chatId: BOB_PUB, lamportTs: 1, senderPubkey: ALICE_PUB, id: "hist-legacy", text: "старое", status: "sent", msgId: "m-hist-legacy", attachment: legacyAttachment },
		DB_KEY,
	);
	const history = await getChatHistory(ALICE_PUB, BOB_PUB, DB_KEY);
	assert.deepEqual(history[0].attachments, [legacyAttachment]);
});

// Обратная совместимость (старый формат payload без sentAt/attachment — сообщение,
// отправленное ДО этапа 29, или сиблинг с более старой версией клиента) уже покрыта
// tests/devices.test.js ("...сиблинг шлёт НОВОЕ сообщение..." — payload там собран
// вручную БЕЗ sentAt/attachment, assert.deepEqual(decryptedByBob, {text, lamportTs})
// проверяет ИМЕННО отсутствие лишних ключей, не просто "не бросает"). Не дублируется
// здесь намеренно.

// Этап 73.5 — М6 (детект расхождения).
test("recordGroupDecryptFailure: копит счётчик, desynced становится true ровно на пороге (3), не раньше", async () => {
	const { groupId } = await establishAliceToBob();
	const groupIdHex = toHex(groupId);

	await recordGroupDecryptFailure(ALICE_PUB, groupIdHex, DB_KEY);
	let row = fromEncryptedRow(await db.table("mlsGroups").get([ALICE_PUB, groupIdHex]), DB_KEY);
	assert.equal(row.consecutiveDecryptFailures, 1);
	assert.equal(row.desynced, false);

	await recordGroupDecryptFailure(ALICE_PUB, groupIdHex, DB_KEY);
	row = fromEncryptedRow(await db.table("mlsGroups").get([ALICE_PUB, groupIdHex]), DB_KEY);
	assert.equal(row.consecutiveDecryptFailures, 2);
	assert.equal(row.desynced, false, "ниже порога — ещё не desynced");

	await recordGroupDecryptFailure(ALICE_PUB, groupIdHex, DB_KEY);
	row = fromEncryptedRow(await db.table("mlsGroups").get([ALICE_PUB, groupIdHex]), DB_KEY);
	assert.equal(row.consecutiveDecryptFailures, 3);
	assert.equal(row.desynced, true, "на пороге (3 подряд) — уже desynced");
});

test("receiveGroupMessageEvent: успешный приём СБРАСЫВАЕТ consecutiveDecryptFailures/desynced в 0/false", async () => {
	const { groupId, bobSerializedState } = await establishAliceToBob();
	const groupIdHex = toHex(groupId);
	await recordGroupDecryptFailure(ALICE_PUB, groupIdHex, DB_KEY);
	await recordGroupDecryptFailure(ALICE_PUB, groupIdHex, DB_KEY);
	await recordGroupDecryptFailure(ALICE_PUB, groupIdHex, DB_KEY);
	let aliceRow = fromEncryptedRow(await db.table("mlsGroups").get([ALICE_PUB, groupIdHex]), DB_KEY);
	assert.equal(aliceRow.desynced, true, "предусловие: уже desynced");

	await asBob(groupIdHex, bobSerializedState, async () => {
		const publishCapture = [];
		await sendMessage(BOB_PUB, BOB_PRIV, DB_KEY, ALICE_PUB, "живой ответ", 9, async (e) => {
			publishCapture.push(e);
			return { ok: true };
		});
		await receiveGroupMessageEvent(ALICE_PUB, ALICE_PRIV, DB_KEY, publishCapture.find((e) => e.kind === 445), async () => ({ ok: true }));
	});

	aliceRow = fromEncryptedRow(await db.table("mlsGroups").get([ALICE_PUB, groupIdHex]), DB_KEY);
	assert.equal(aliceRow.consecutiveDecryptFailures, 0);
	assert.equal(aliceRow.desynced, false, "успешный приём обязан снять пометку desynced");
});

test("sendMessage: НЕ сбрасывает consecutiveDecryptFailures/desynced (отправка не доказывает, что приём работает)", async () => {
	const { groupId } = await establishAliceToBob();
	const groupIdHex = toHex(groupId);
	await recordGroupDecryptFailure(ALICE_PUB, groupIdHex, DB_KEY);
	await recordGroupDecryptFailure(ALICE_PUB, groupIdHex, DB_KEY);
	await recordGroupDecryptFailure(ALICE_PUB, groupIdHex, DB_KEY);

	await sendMessage(ALICE_PUB, ALICE_PRIV, DB_KEY, BOB_PUB, "исходящее несмотря на desync", 10, async () => ({ ok: true }));

	const row = fromEncryptedRow(await db.table("mlsGroups").get([ALICE_PUB, groupIdHex]), DB_KEY);
	assert.equal(row.consecutiveDecryptFailures, 3, "отправка не должна тихо занулять накопленный счётчик");
	assert.equal(row.desynced, true, "и не должна тихо снимать пометку desynced");
});

test("listDesyncedChats: возвращает только desynced-группы этого owner, с contactPubkey и счётчиком", async () => {
	const { groupId } = await establishAliceToBob();
	const groupIdHex = toHex(groupId);
	assert.deepEqual(await listDesyncedChats(ALICE_PUB, DB_KEY), [], "до порога — пусто");

	await recordGroupDecryptFailure(ALICE_PUB, groupIdHex, DB_KEY);
	await recordGroupDecryptFailure(ALICE_PUB, groupIdHex, DB_KEY);
	await recordGroupDecryptFailure(ALICE_PUB, groupIdHex, DB_KEY);

	const list = await listDesyncedChats(ALICE_PUB, DB_KEY);
	assert.equal(list.length, 1);
	assert.equal(list[0].contactPubkey, BOB_PUB);
	assert.equal(list[0].consecutiveDecryptFailures, 3);
});

// Этап 5 (MESSAGE-DELIVERY-TZ.md, З5.7) — правка контракта: recreateChatConversation
// раньше ТОЛЬКО забывала локальное состояние (сигнатура (owner, contact, dbKey)) и
// ничего не отправляла — "починка провода" была ленивой (при следующей ручной
// отправке) и, как выяснилось, вообще не срабатывала (см. следующий тест). Новая
// сигнатура немедленно пересоздаёт группу и шлёт generation-меченый Welcome.
test("recreateChatConversation: немедленно создаёт НОВУЮ группу (другое состояние) и шлёт generation-меченый Welcome", async () => {
	const { groupId } = await establishAliceToBob();
	const groupIdHex = toHex(groupId);
	const rawBefore = await db.table("mlsGroups").get([ALICE_PUB, groupIdHex]);
	const stateBefore = fromEncryptedRow(rawBefore, DB_KEY).state;

	const bobKeyPackage2 = await createOwnKeyPackage(BOB_PUB, "bob-device");
	const fetchDeviceKeyPackages = async () => new Map([["bob-device", { wireBytes: bobKeyPackage2.wireBytes, createdAt: 2000 }]]);
	const published = [];
	const publish = async (e) => {
		published.push(e);
		return { ok: true };
	};
	let refreshCalled = 0;
	const refreshGroupMessageSubscription = async () => {
		refreshCalled++;
	};

	await recreateChatConversation(ALICE_PUB, ALICE_PRIV, BOB_PUB, DB_KEY, publish, fetchDeviceKeyPackages, refreshGroupMessageSubscription);

	const rawAfter = await db.table("mlsGroups").get([ALICE_PUB, groupIdHex]);
	assert.ok(rawAfter, "новая группа обязана появиться немедленно, не только при следующей ручной отправке");
	const rowAfter = fromEncryptedRow(rawAfter, DB_KEY);
	assert.notDeepEqual(rowAfter.state, stateBefore, "это ДРУГАЯ, независимая группа — не восстановление старой");
	assert.equal(rowAfter.generation, 1, "первое пересоздание — generation 1 (было 0 по умолчанию)");
	assert.equal(refreshCalled, 1, "подписка на групповые сообщения обязана обновиться — появился новый (пересозданный) groupId");

	const welcomeGiftWrap = published.find((e) => e.kind === 1059);
	assert.ok(welcomeGiftWrap, "обязан немедленно отправить новый Welcome, не ждать следующего сообщения пользователя");
	const rumor = nip59Unwrap(welcomeGiftWrap, BOB_PRIV);
	assert.equal(rumor.kind, 444);
	assert.deepEqual(rumor.tags, [["gen", "1"]], "Welcome обязан нести generation, иначе acceptWelcome не отличит его от повторной доставки старого");
});

// Этап 5 (З5.7) — регрессионный тест на САМУ дыру из ТЗ ("кнопка «пересоздать» —
// способ окончательно разойтись"): без generation-проверки в acceptWelcome
// получатель с УЖЕ существующей (устаревшей) группой молча игнорирует новый
// Welcome ("уже установлено") и продолжает расшифровывать новые 445 старым,
// несовместимым ключом — необратимое расхождение. С фиксом — новый Welcome
// (generation строго больше) заменяет старую группу, переписка возобновляется.
test("recreateChatConversation + acceptWelcome: собеседник со СТАРОЙ группой заменяет её по новому Welcome и снова расшифровывает сообщения (regression: было permanent divergence)", async () => {
	const { groupId, bobSerializedState: staleBobState } = await establishAliceToBob();
	const groupIdHex = toHex(groupId);

	// Боб публикует свой (реальный, ПЕРСИСТИРОВАННЫЙ) KeyPackage — acceptWelcome
	// ниже читает его из db.table("ownKeyPackage"), как в реальности (joinFromWelcome
	// нуждается в privatePackage), в отличие от establishAliceToBob (та ради теста
	// подставляет bobState напрямую, минуя эту таблицу).
	await ensureOwnKeyPackagePublished(BOB_PUB, BOB_PRIV, DB_KEY, async () => ({ ok: true }));
	const bobOwnKeyPackageRow = fromEncryptedRow(await db.table("ownKeyPackage").get(BOB_PUB), DB_KEY);
	const fetchDeviceKeyPackages = async () => new Map([["bob-device", { wireBytes: bobOwnKeyPackageRow.wireBytes, createdAt: 2000 }]]);
	const published = [];
	const publish = async (e) => {
		published.push(e);
		return { ok: true };
	};
	await recreateChatConversation(ALICE_PUB, ALICE_PRIV, BOB_PUB, DB_KEY, publish, fetchDeviceKeyPackages, async () => {});

	const welcomeGiftWrap = published.find((e) => e.kind === 1059);
	const rumor = nip59Unwrap(welcomeGiftWrap, BOB_PRIV);
	const newWelcomeWireBytes = Uint8Array.from(atob(rumor.content), (c) => c.charCodeAt(0));
	const genTag = rumor.tags.find((t) => t[0] === "gen");
	const incomingGeneration = Number(genTag[1]);

	// Боб — как будто ещё не видел recreate: у него в базе всё ещё СТАРАЯ группа.
	await asBob(groupIdHex, staleBobState, async () => {
		await acceptWelcome(BOB_PUB, DB_KEY, ALICE_PUB, newWelcomeWireBytes, incomingGeneration);
	});

	const bobRowAfterAccept = fromEncryptedRow(await db.table("mlsGroups").get([BOB_PUB, groupIdHex]), DB_KEY);
	assert.equal(bobRowAfterAccept.generation, incomingGeneration, "группа Боба обязана обновиться до нового generation, а не остаться на старом (0)");

	// Сквозная проверка: Алиса шлёт сообщение НОВЫМ (пересозданным) состоянием,
	// Боб успешно расшифровывает его СВОИМ ТОЛЬКО ЧТО ЗАМЕНЁННЫМ состоянием —
	// до фикса это было бы decrypt failure (несовместимые ключи).
	const alicePublished = [];
	await sendMessage(ALICE_PUB, ALICE_PRIV, DB_KEY, BOB_PUB, "после пересоздания", 1, async (e) => {
		alicePublished.push(e);
		return { ok: true };
	});
	const liveEvent = alicePublished.find((e) => e.kind === 445);

	const { result: received } = await asBob(groupIdHex, bobRowAfterAccept.state, () =>
		receiveGroupMessageEvent(BOB_PUB, BOB_PRIV, DB_KEY, liveEvent, async () => ({ ok: true })),
	);
	assert.equal(received.text, "после пересоздания", "Боб обязан успешно расшифровать — переписка реально восстановлена, а не только метаданные обновлены");
});

test("acceptWelcome: повторная доставка ТОГО ЖЕ generation (redelivery/EOSE-повтор) остаётся идемпотентным no-op", async () => {
	const { groupId, bobSerializedState } = await establishAliceToBob();
	const groupIdHex = toHex(groupId);

	// Тот же Welcome, что establishAliceToBob уже применил (generation по умолчанию 0),
	// доставлен ПОВТОРНО (та же причина, что и раньше вызывала "уже установлено" —
	// EOSE-повтор) — заведомо мусорные welcomeWireBytes: если бы код попытался их
	// распарсить (не сработал ранний return), тест упал бы с ошибкой декодирования,
	// а не молча прошёл — это и есть доказательство, что no-op сработал ДО парсинга.
	const { result, updatedBobSerializedState } = await asBob(groupIdHex, bobSerializedState, async () => {
		await acceptWelcome(BOB_PUB, DB_KEY, ALICE_PUB, new Uint8Array([1, 2, 3]), 0);
		return "no-op-completed";
	});
	assert.equal(result, "no-op-completed", "не должен был бросить на мусорных байтах — ранний return сработал раньше joinFromWelcome");
	assert.deepEqual(updatedBobSerializedState, bobSerializedState, "состояние группы не должно было измениться");
});

// Этап 74 — T3 (CONTRACTS.md/DESIGN.md "Этап 74", RC-2): строки, испорченные RC-1
// (неверный senderPubkey), "прилипли" через first-writer-wins дедуп в upsertMessage —
// зеркало (source:"mirror") авторитетно чинит ТОЛЬКО поле senderPubkey, живой путь
// (source:"live", значение по умолчанию) историю не переписывает.

test("upsertMessage: приход зеркала (source:'mirror') с верным senderPubkey исправляет ТОЛЬКО это поле, остальные нетронуты", async () => {
	await upsertMessage({
		ownerPubkey: ALICE_PUB,
		chatId: BOB_PUB,
		lamportTs: 1,
		senderPubkey: BOB_PUB, // испорчено RC-1 — на самом деле это было своё (sibling) сообщение
		id: "live-event-1",
		text: "привет",
		status: "sent",
		msgId: "t3-msg-1",
		sentAt: 1000,
	}, DB_KEY);

	await upsertMessage({
		ownerPubkey: ALICE_PUB,
		chatId: BOB_PUB,
		lamportTs: 1,
		senderPubkey: ALICE_PUB, // зеркало несёт ПРАВИЛЬНУЮ атрибуцию
		id: "mirror-event-1",
		text: "привет",
		status: "sent",
		msgId: "t3-msg-1",
		sentAt: 1000,
	}, DB_KEY, "mirror");

	const rows = await getChatHistory(ALICE_PUB, BOB_PUB, DB_KEY);
	const row = rows.find((r) => r.msgId === "t3-msg-1");
	assert.equal(row.senderPubkey, ALICE_PUB, "senderPubkey обязан быть исправлен зеркалом");
	// Остальные поля — от ПЕРВОЙ (живой) записи, не от зеркала: коррекция
	// затрагивает ТОЛЬКО senderPubkey, не весь объект.
	assert.equal(row.id, "live-event-1", "id остаётся от исходной живой записи, не заменяется id зеркала");
	assert.equal(row.text, "привет");
	assert.equal(row.status, "sent");
	assert.equal(row.sentAt, 1000);
});

test("upsertMessage: повторный приход того же зеркала — no-op (уже исправлено)", async () => {
	await upsertMessage({
		ownerPubkey: ALICE_PUB,
		chatId: BOB_PUB,
		lamportTs: 1,
		senderPubkey: BOB_PUB,
		id: "live-event-2",
		text: "текст",
		status: "sent",
		msgId: "t3-msg-2",
	}, DB_KEY);
	await upsertMessage({
		ownerPubkey: ALICE_PUB,
		chatId: BOB_PUB,
		lamportTs: 1,
		senderPubkey: ALICE_PUB,
		id: "mirror-event-2",
		text: "текст",
		status: "sent",
		msgId: "t3-msg-2",
	}, DB_KEY, "mirror");

	// Тот же мирроринг повторно (resubscribe-редоставка, тот же класс, что уже
	// задокументирован для kind:446 в других подписчиках проекта).
	await upsertMessage({
		ownerPubkey: ALICE_PUB,
		chatId: BOB_PUB,
		lamportTs: 1,
		senderPubkey: ALICE_PUB,
		id: "mirror-event-2",
		text: "текст",
		status: "sent",
		msgId: "t3-msg-2",
	}, DB_KEY, "mirror");

	const rows = await getChatHistory(ALICE_PUB, BOB_PUB, DB_KEY);
	const matching = rows.filter((r) => r.msgId === "t3-msg-2");
	assert.equal(matching.length, 1, "не должно быть дублей строк");
	assert.equal(matching[0].senderPubkey, ALICE_PUB);
});

test("upsertMessage: live-дубликат (source по умолчанию) НЕ меняет существующую строку, даже с другим senderPubkey", async () => {
	await upsertMessage({
		ownerPubkey: ALICE_PUB,
		chatId: BOB_PUB,
		lamportTs: 1,
		senderPubkey: BOB_PUB,
		id: "live-event-3",
		text: "оригинал",
		status: "sent",
		msgId: "t3-msg-3",
	}, DB_KEY);

	// Форджибл-payload (см. L-1, DESIGN.md "Этап 74") пытается переписать историю
	// через живой путь — обязан остаться no-op, иначе контакт мог бы задним числом
	// подменить атрибуцию чужого сообщения.
	await upsertMessage({
		ownerPubkey: ALICE_PUB,
		chatId: BOB_PUB,
		lamportTs: 1,
		senderPubkey: ALICE_PUB,
		id: "live-event-3-forged",
		text: "оригинал",
		status: "sent",
		msgId: "t3-msg-3",
	}, DB_KEY);

	const rows = await getChatHistory(ALICE_PUB, BOB_PUB, DB_KEY);
	const row = rows.find((r) => r.msgId === "t3-msg-3");
	assert.equal(row.senderPubkey, BOB_PUB, "живой путь не корректирует существующую строку");
	assert.equal(row.id, "live-event-3", "id остаётся от первой записи");
});

// ===== Этап 5 (MESSAGE-DELIVERY-TZ.md, З5.5) — подтверждение доставки =====

test("пиггибэк: ackUpTo едет в обычном исходящем сообщении Боба и переводит исходное сообщение Алисы sent -> read", async () => {
	const { groupId, bobSerializedState } = await establishAliceToBob();
	const groupIdHex = toHex(groupId);

	const alicePublished = [];
	const { eventId: event1Id } = await sendMessage(ALICE_PUB, ALICE_PRIV, DB_KEY, BOB_PUB, "первое от Алисы", 1, async (e) => {
		alicePublished.push(e);
		return { ok: true };
	});
	const event1 = alicePublished.find((e) => e.kind === 445);

	let bobState = bobSerializedState;
	let step = await asBob(groupIdHex, bobState, () => receiveGroupMessageEvent(BOB_PUB, BOB_PRIV, DB_KEY, event1, async () => ({ ok: true })));
	bobState = step.updatedBobSerializedState;
	assert.equal(step.result.text, "первое от Алисы", "предусловие: Боб реально получил первое сообщение");

	// Алиса ещё не получила ничего от Боба — её статус остаётся "sent", не "read".
	let aliceMsg1 = await db.table("messages").where("id").equals(event1Id).first();
	assert.equal(aliceMsg1.status, "sent", "предусловие: до ответа Боба статус ещё не read");

	const bobPublished = [];
	step = await asBob(groupIdHex, bobState, () =>
		sendMessage(BOB_PUB, BOB_PRIV, DB_KEY, ALICE_PUB, "ответ Боба", 2, async (e) => {
			bobPublished.push(e);
			return { ok: true };
		}),
	);
	bobState = step.updatedBobSerializedState;
	const event2 = bobPublished.find((e) => e.kind === 445);
	assert.ok(event2, "Боб обязан опубликовать живое kind 445 в ответ");

	await receiveGroupMessageEvent(ALICE_PUB, ALICE_PRIV, DB_KEY, event2, async () => ({ ok: true }));

	aliceMsg1 = await db.table("messages").where("id").equals(event1Id).first();
	assert.equal(aliceMsg1.status, "sent", "статус строки остаётся sent — доставка живёт в курсоре, не в status=read");
	const cursor = await getPeerCursor(ALICE_PUB, BOB_PUB);
	assert.ok(cursor.deliveredUpTo >= 1, "ответ Боба нёс d/ackUpTo>=1 пиггибэком — курсор Алисы обязан вырасти");
});

test("ackOnly-пакет (sendExplicitAck): переводит sent -> read, но НЕ создаёт видимую строку сообщения у получателя", async () => {
	const { groupId, bobSerializedState } = await establishAliceToBob();
	const groupIdHex = toHex(groupId);

	const alicePublished = [];
	const { eventId: event1Id } = await sendMessage(ALICE_PUB, ALICE_PRIV, DB_KEY, BOB_PUB, "сообщение Алисы", 1, async (e) => {
		alicePublished.push(e);
		return { ok: true };
	});
	const event1 = alicePublished.find((e) => e.kind === 445);

	let bobState = bobSerializedState;
	let step = await asBob(groupIdHex, bobState, () => receiveGroupMessageEvent(BOB_PUB, BOB_PRIV, DB_KEY, event1, async () => ({ ok: true })));
	bobState = step.updatedBobSerializedState;

	const ackPublished = [];
	step = await asBob(groupIdHex, bobState, () =>
		sendExplicitAck(BOB_PUB, BOB_PRIV, DB_KEY, ALICE_PUB, async (e) => {
			ackPublished.push(e);
			return { ok: true };
		}),
	);
	bobState = step.updatedBobSerializedState;
	const ackEvent = ackPublished.find((e) => e.kind === 445);
	assert.ok(ackEvent, "sendExplicitAck обязан опубликовать отдельное kind 445");

	const countBefore = await db.table("messages").where("[ownerPubkey+chatId]").equals([ALICE_PUB, BOB_PUB]).count();
	const received = await receiveGroupMessageEvent(ALICE_PUB, ALICE_PRIV, DB_KEY, ackEvent, async () => ({ ok: true }));
	assert.equal(received, null, "ackOnly-пакет не порождает результат для UI (не сообщение)");
	const countAfter = await db.table("messages").where("[ownerPubkey+chatId]").equals([ALICE_PUB, BOB_PUB]).count();
	assert.equal(countAfter, countBefore, "ackOnly-пакет не должен создавать новую строку в messages");

	const aliceMsg1 = await db.table("messages").where("id").equals(event1Id).first();
	assert.equal(aliceMsg1.status, "sent");
	const cursor = await getPeerCursor(ALICE_PUB, BOB_PUB);
	assert.ok(cursor.deliveredUpTo >= 1, "явный ACK обязан поднять delivered-курсор так же, как пиггибэк");
});

test("sendExplicitAck: нечего подтверждать (контакт ещё ничего не присылал) -> no-op, publish не вызывается", async () => {
	await establishAliceToBob();
	let publishCalled = false;
	await sendExplicitAck(ALICE_PUB, ALICE_PRIV, DB_KEY, BOB_PUB, async () => {
		publishCalled = true;
		return { ok: true };
	});
	assert.equal(publishCalled, false);
});

test("sweepPendingAcks: недавно полученное сообщение (< порога простоя) -> явный ACK НЕ отправляется", async () => {
	const { groupId, bobSerializedState } = await establishAliceToBob();
	const groupIdHex = toHex(groupId);

	const alicePublished = [];
	await sendMessage(ALICE_PUB, ALICE_PRIV, DB_KEY, BOB_PUB, "свежее", 1, async (e) => {
		alicePublished.push(e);
		return { ok: true };
	});
	const event1 = alicePublished.find((e) => e.kind === 445);
	const { updatedBobSerializedState: bobState } = await asBob(groupIdHex, bobSerializedState, () =>
		receiveGroupMessageEvent(BOB_PUB, BOB_PRIV, DB_KEY, event1, async () => ({ ok: true })),
	);

	const sweepPublished = [];
	await asBob(groupIdHex, bobState, () =>
		sweepPendingAcks(BOB_PUB, BOB_PRIV, DB_KEY, async (e) => {
			sweepPublished.push(e);
			return { ok: true };
		}),
	);
	assert.equal(sweepPublished.length, 0, "сообщение получено только что — не пора подтверждать явно");
});

test("sweepPendingAcks: старое (> порога простоя) неподтверждённое сообщение -> явный ACK отправляется", async () => {
	const { groupId, bobSerializedState } = await establishAliceToBob();
	const groupIdHex = toHex(groupId);

	const oldSentAt = Math.floor(Date.now() / 1000) - 400; // > EXPLICIT_ACK_IDLE_MS (5 мин)
	const alicePublished = [];
	await sendMessage(ALICE_PUB, ALICE_PRIV, DB_KEY, BOB_PUB, "старое", 1, async (e) => {
		alicePublished.push(e);
		return { ok: true };
	}, undefined, undefined, oldSentAt);
	const event1 = alicePublished.find((e) => e.kind === 445);
	const { updatedBobSerializedState: bobState } = await asBob(groupIdHex, bobSerializedState, () =>
		receiveGroupMessageEvent(BOB_PUB, BOB_PRIV, DB_KEY, event1, async () => ({ ok: true })),
	);

	const sweepPublished = [];
	await asBob(groupIdHex, bobState, () =>
		sweepPendingAcks(BOB_PUB, BOB_PRIV, DB_KEY, async (e) => {
			sweepPublished.push(e);
			return { ok: true };
		}),
	);
	assert.equal(sweepPublished.filter((e) => e.kind === 445).length, 1, "давно получено и ни разу не отвечено — явный ACK обязан уйти");
});

test("sweepPendingAcks: старое сообщение, но УЖЕ подтверждено пиггибэком собственного ответа -> явный ACK не дублируется", async () => {
	const { groupId, bobSerializedState } = await establishAliceToBob();
	const groupIdHex = toHex(groupId);

	const oldSentAt = Math.floor(Date.now() / 1000) - 400;
	const alicePublished = [];
	await sendMessage(ALICE_PUB, ALICE_PRIV, DB_KEY, BOB_PUB, "старое", 1, async (e) => {
		alicePublished.push(e);
		return { ok: true };
	}, undefined, undefined, oldSentAt);
	const event1 = alicePublished.find((e) => e.kind === 445);
	let bobState;
	({ updatedBobSerializedState: bobState } = await asBob(groupIdHex, bobSerializedState, () =>
		receiveGroupMessageEvent(BOB_PUB, BOB_PRIV, DB_KEY, event1, async () => ({ ok: true })),
	));

	// Боб уже успел ответить сам (свежим сообщением) — его payload уже нёс ackUpTo>=1.
	({ updatedBobSerializedState: bobState } = await asBob(groupIdHex, bobState, () =>
		sendMessage(BOB_PUB, BOB_PRIV, DB_KEY, ALICE_PUB, "ответ Боба", 2, async () => ({ ok: true })),
	));

	const sweepPublished = [];
	await asBob(groupIdHex, bobState, () =>
		sweepPendingAcks(BOB_PUB, BOB_PRIV, DB_KEY, async (e) => {
			sweepPublished.push(e);
			return { ok: true };
		}),
	);
	assert.equal(sweepPublished.length, 0, "уже подтверждено пиггибэком собственного ответа — явный ACK был бы избыточен");
});
