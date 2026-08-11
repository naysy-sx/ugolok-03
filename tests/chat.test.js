import "fake-indexeddb/auto";
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { db } from "../src/core/store/database.js";
import { getPublicKey } from "../src/core/crypto/keys.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { decrypt as nip44Decrypt } from "../src/core/crypto/nip44.js";
import { unwrap as nip59Unwrap } from "../src/core/crypto/nip59.js";
import { joinFromWelcome, createOwnKeyPackage, deserializeState, serializeState } from "../src/core/crypto/mls-session.js";
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
	hasAnyMessagesFor,
	enqueuePendingOutgoingMessage,
	drainPendingOutgoingMessages,
	recordGroupDecryptFailure,
	listDesyncedChats,
	recreateChatConversation,
} from "../src/domain/messaging/chat.js";

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

test("enqueuePendingOutgoingMessage/drainPendingOutgoingMessages: очередь копится, drain отправляет по порядку lamportTs и опустошает очередь", async () => {
	await enqueuePendingOutgoingMessage(BOB_PUB, DB_KEY, { contactPubkey: ALICE_PUB, text: "второе", lamportTs: 2 });
	await enqueuePendingOutgoingMessage(BOB_PUB, DB_KEY, { contactPubkey: ALICE_PUB, text: "первое", lamportTs: 1 });

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
	assert.equal(received.attachment, undefined, "без вложения — поле отсутствует, не undefined-значение");
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

test("AC-09: sendMessage — publish возвращает {ok:false} — НЕ бросает, ставит event в outbox целиком, сохраняет сообщение локально со статусом 'failed', возвращает {eventId, queued:true}", async () => {
	await establishAliceToBob();
	const publish = async () => ({ ok: false, reason: "relay недоступен" });

	const result = await sendMessage(ALICE_PUB, ALICE_PRIV, DB_KEY, BOB_PUB, "не долетит", 7, publish);
	assert.equal(result.queued, true);
	assert.equal(typeof result.eventId, "string");

	const outboxRows = (await db.table("outbox").where("eventId").equals(result.eventId).toArray()).map((r) => fromEncryptedRow(r, DB_KEY));
	assert.equal(outboxRows.length, 1, "событие должно быть поставлено в outbox");
	assert.equal(outboxRows[0].status, "pending");
	assert.equal(outboxRows[0].event.kind, 445, "в outbox должен лежать ВЕСЬ подписанный event (МЛС-ратчет уже продвинут — регенерировать нельзя), не только id");
	assert.equal(outboxRows[0].event.id, result.eventId);

	const messageRows = (await db.table("messages").where("id").equals(result.eventId).toArray()).map((r) => fromEncryptedRow(r, DB_KEY));
	assert.equal(messageRows.length, 1, "сообщение должно остаться в локальной истории, не потеряно молча");
	assert.equal(messageRows[0].status, "failed");
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
	assert.equal(row.attachment, undefined, "без вложения — поле отсутствует");
});

test("этап 29: sendMessage(attachment) — вложение попадает в локальную строку и доходит до собеседника", async () => {
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
	const publish = async () => ({ ok: true });
	const { eventId } = await sendMessage(ALICE_PUB, ALICE_PRIV, DB_KEY, BOB_PUB, "смотри", 1, publish, attachment);

	const aliceRow = fromEncryptedRow(await db.table("messages").where("id").equals(eventId).first(), DB_KEY);
	assert.deepEqual(aliceRow.attachment, attachment, "своя копия сразу содержит вложение (оптимистично, как text)");

	const sentEvents = [];
	const publishCapture = async (event) => {
		sentEvents.push(event);
		return { ok: true };
	};
	await sendMessage(ALICE_PUB, ALICE_PRIV, DB_KEY, BOB_PUB, "ещё одна с вложением", 2, publishCapture, attachment);
	const sentEvent = sentEvents.find((e) => e.kind === 445);

	const { result: received } = await asBob(groupIdHex, bobSerializedState, () =>
		receiveGroupMessageEvent(BOB_PUB, BOB_PRIV, DB_KEY, sentEvent, async () => ({ ok: true })),
	);
	assert.deepEqual(received.attachment, attachment, "вложение доходит до собеседника без искажений");

	const bobRow = fromEncryptedRow(await db.table("messages").where("id").equals(sentEvent.id).first(), DB_KEY);
	assert.deepEqual(bobRow.attachment, attachment, "и попадает в его локальную строку тоже");
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

test("recreateChatConversation: удаляет локальную mlsGroups-запись и knownContactDevices для этого контакта", async () => {
	const bobDevice2 = await createOwnKeyPackage(BOB_PUB, "bob-device-2");
	const fetchDeviceKeyPackages = async () =>
		new Map([
			["bob-device", { wireBytes: (await createOwnKeyPackage(BOB_PUB, "bob-device")).wireBytes, createdAt: 1000 }],
			["bob-device-2", { wireBytes: bobDevice2.wireBytes, createdAt: 1000 }],
		]);
	await ensureChatEstablished(ALICE_PUB, ALICE_PRIV, DB_KEY, BOB_PUB, async () => ({ ok: true }), fetchDeviceKeyPackages);
	const groupIdHex = toHex(computeGroupId(ALICE_PUB, BOB_PUB));
	assert.ok(await db.table("mlsGroups").get([ALICE_PUB, groupIdHex]), "предусловие: группа существует");
	assert.ok((await db.table("knownContactDevices").where("[ownerPubkey+contactPubkey]").equals([ALICE_PUB, BOB_PUB]).count()) > 0, "предусловие: известные устройства есть");

	await recreateChatConversation(ALICE_PUB, BOB_PUB, DB_KEY);

	assert.equal(await db.table("mlsGroups").get([ALICE_PUB, groupIdHex]), undefined);
	assert.equal(await db.table("knownContactDevices").where("[ownerPubkey+contactPubkey]").equals([ALICE_PUB, BOB_PUB]).count(), 0);
});
