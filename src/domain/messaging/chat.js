import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { generateSecretKey } from "nostr-tools/pure";
import { sign } from "../../core/crypto/sign.js";
import { encrypt as nip44Encrypt, decrypt as nip44Decrypt } from "../../core/crypto/nip44.js";
import { wrap as nip59Wrap } from "../../core/crypto/nip59.js";
import {
	createOwnKeyPackage,
	createGroup,
	addMember,
	addMembers,
	joinFromWelcome,
	encryptApplicationMessage,
	decryptApplicationMessage,
	deriveNostrEnvelopeKeys,
	serializeState,
	deserializeState,
} from "../../core/crypto/mls-session.js";
import { deriveMasterSecret, deriveMirrorKey } from "../../core/crypto/derivation.js";
import { buildMirrorEvent } from "./mirror.js";
import { db } from "../../core/store/database.js";
import { getOrCreateDeviceId } from "../identity/device.js";
import { enqueue } from "../../core/store/outbox.js";
import { toEncryptedRow, fromEncryptedRow } from "../../core/store/encrypted-table.js";
import { OWN_KEY_PACKAGE_PLAINTEXT_FIELDS, MLS_GROUPS_PLAINTEXT_FIELDS, MESSAGES_PLAINTEXT_FIELDS, PENDING_OUTGOING_MESSAGES_PLAINTEXT_FIELDS, PROCESSED_GROUP_EVENTS_PLAINTEXT_FIELDS } from "../../core/store/table-fields.js";
import { DomainError } from "../errors.js";
import { isKnownContact } from "./inbox-requests.js";
import { withGroupLock } from "../../core/store/mls-lock.js";
import { touchChatActivity } from "./chat-activity.js";

// Этап 74 — T2.3 (CONTRACTS.md/DESIGN.md "Этап 74"): по прецеденту
// pendingUndecryptedByGroup/UNDECRYPTED_RETRY_TTL_MS (transport.js) — 5 минут,
// sweep при каждой записи, не scheduled-таймер.
const PROCESSED_EVENT_TTL_MS = 5 * 60 * 1000;

async function markEventProcessed(ownerPubkey, eventId, dbKey) {
	const now = Date.now();
	await db.table("processedGroupEvents").put(
		toEncryptedRow({ ownerPubkey, eventId, firstSeenAt: now }, PROCESSED_GROUP_EVENTS_PLAINTEXT_FIELDS, dbKey),
	);
	const stale = await db
		.table("processedGroupEvents")
		.where("[ownerPubkey+firstSeenAt]")
		.between([ownerPubkey, 0], [ownerPubkey, now - PROCESSED_EVENT_TTL_MS])
		.primaryKeys();
	if (stale.length > 0) await db.table("processedGroupEvents").bulkDelete(stale);
}

function encodeBase64(bytes) {
	return btoa(String.fromCharCode.apply(null, bytes));
}

function decodeBase64(str) {
	return Uint8Array.from(atob(str), (c) => c.charCodeAt(0));
}

// DESIGN.md, этап 24, п.2: детерминирован для ОБЕИХ сторон — не хранится
// отдельно как "chatId -> groupId" маппинг, пересчитывается на лету.
export function computeGroupId(pubkeyHexA, pubkeyHexB) {
	const sorted = [pubkeyHexA, pubkeyHexB].sort();
	return sha256(utf8ToBytes(sorted.join(":")));
}

// Этап 73.3 — И3: для пары (A,B) ровно одна сторона вправе впервые создать
// G(A,B) — тот же приём, что glare resolution в call-FSM (FEATURE-SPECS/VOICE.md).
export function isCommitter(pubkeyHexA, pubkeyHexB) {
	return pubkeyHexA < pubkeyHexB;
}

export async function requirePublishOk(publish, event) {
	const result = await publish(event);
	if (!result.ok) {
		if (result.reason) throw new Error(result.reason);
		throw new DomainError("relay отклонил публикацию", "errors.relayRejected");
	}
}

// upsertMessage — идемпотентная вставка (DESIGN.md, этап 25, раздел 3): одно и то же
// логическое сообщение может прийти ДВУМЯ путями (живой MLS kind 445 и зеркало kind 446),
// в любом порядке, любое число раз. Дедупликация по unique-индексу [ownerPubkey+chatId+msgId]
// (db.version(4), owner-scoping — найдено реальным использованием, см. database.js) — НЕ по
// (chatId, lamportTs, senderPubkey): два РАЗНЫХ сообщения могут легитимно иметь одинаковый
// lamportTs при multi-device (найдено адверсарным прогоном уже принятого теста
// getChatHistory tiebreak-by-id). row обязан содержать ownerPubkey — вызывающий код.
// Этап 74 — T3 (RC-2, CONTRACTS.md/DESIGN.md "Этап 74"): source — аддитивный
// параметр, старые вызовы (без него) сохраняют прежнее поведение ("live").
// Живой путь существующие строки НЕ корректирует (форджибл-payload из T1 не
// получил бы права переписывать историю чужим senderPubkey, см. L-1); зеркало
// (source:"mirror") авторитетно чинит ТОЛЬКО поле senderPubkey — его пишет
// само устройство-отправитель под ключом, выводимым из privKey владельца.
export async function upsertMessage(row, dbKey, source = "live") {
	try {
		await db.table("messages").add(toEncryptedRow(row, MESSAGES_PLAINTEXT_FIELDS, dbKey));
	} catch (e) {
		if (e.name !== "ConstraintError") throw e;
		if (source !== "mirror") return; // живой дубликат — тихий no-op, не дубль, история не переписывается
		const existing = await db
			.table("messages")
			.where("[ownerPubkey+chatId+msgId]")
			.equals([row.ownerPubkey, row.chatId, row.msgId])
			.first();
		if (existing && existing.senderPubkey !== row.senderPubkey) {
			// senderPubkey — plaintext-поле (MESSAGES_PLAINTEXT_FIELDS) — точечное
			// исправление без расшифровки/перешифровки остальной строки.
			await db
				.table("messages")
				.where("[ownerPubkey+chatId+msgId]")
				.equals([row.ownerPubkey, row.chatId, row.msgId])
				.modify({ senderPubkey: row.senderPubkey });
		}
	}
}

// Зеркало best-effort (DESIGN.md, этап 25, раздел 2): сбой публикации НЕ блокирует и не
// откатывает основной MLS-путь, только предупреждение — по прецеденту profile.jsx (этап 23-довесок).
async function mirrorBestEffort(privKey, publish, payload, groupIdHex) {
	try {
		const mirrorKey = deriveMirrorKey(deriveMasterSecret(privKey));
		const event = sign(buildMirrorEvent(payload, mirrorKey, groupIdHex, Math.floor(Date.now() / 1000)), privKey);
		await requirePublishOk(publish, event);
	} catch (e) {
		console.warn("mirrorBestEffort: не удалось зеркалировать сообщение", e);
	}
}

export async function ensureOwnKeyPackagePublished(ownerPubkey, privKey, dbKey, publish) {
	const existing = await db.table("ownKeyPackage").get(ownerPubkey);
	if (existing) return;

	const deviceId = await getOrCreateDeviceId();
	const ownKeyPackage = await createOwnKeyPackage(ownerPubkey, deviceId);
	await db.table("ownKeyPackage").put(
		toEncryptedRow(
			{
				ownerPubkey,
				publicPackage: ownKeyPackage.publicPackage,
				privatePackage: ownKeyPackage.privatePackage,
				wireBytes: ownKeyPackage.wireBytes,
			},
			OWN_KEY_PACKAGE_PLAINTEXT_FIELDS,
			dbKey,
		),
	);

	const event = sign(
		{
			kind: 443,
			tags: [["device", deviceId]],
			content: encodeBase64(ownKeyPackage.wireBytes),
			created_at: Math.floor(Date.now() / 1000),
		},
		privKey,
	);
	await requirePublishOk(publish, event);
}

// DESIGN.md, этап 24, п.3 — установление 1:1-разговора. Своя (не из NIP-EE
// напрямую) последовательность: KeyPackage адресата -> createGroup+addMember
// -> персист ДО отправки (SM-1/SM-2, этап 13) -> Welcome как gift wrap.
//
// Этап 72 — было: addMember() с ОДНИМ произвольно выбранным устройством
// контакта (недетерминированный выбор в fetchKeyPackage) приводило к
// split-brain — разные инициаторы могли выбрать разное устройство контакта,
// получая ДВЕ независимые MLS-группы под одним и тем же #h-тегом
// (computeGroupId зависит только от пары identity, не от устройства).
// Теперь fetchDeviceKeyPackages возвращает ВСЕ известные устройства контакта
// разом — addMembers добавляет их ОДНИМ commit'ом/welcome (см. DESIGN.md
// "Этап 72" — Welcome в MLS штатно несёт секреты для нескольких новых
// участников одновременно, каждое устройство извлекает свои независимо).
export async function ensureChatEstablished(ownerPubkey, privKey, dbKey, contactPubkey, publish, fetchDeviceKeyPackages) {
	const groupId = computeGroupId(ownerPubkey, contactPubkey);
	const groupIdHex = bytesToHex(groupId);

	// Этап 74 — T2.2 (RC-3): гонка "две вкладки одновременно создают ОДНУ группу
	// первый раз" — лок ЦЕЛИКОМ вокруг get→создание→put (DESIGN.md "Этап 74").
	return withGroupLock(ownerPubkey, groupIdHex, () => doEnsureChatEstablished(ownerPubkey, privKey, dbKey, contactPubkey, publish, fetchDeviceKeyPackages, groupId, groupIdHex));
}

async function doEnsureChatEstablished(ownerPubkey, privKey, dbKey, contactPubkey, publish, fetchDeviceKeyPackages, groupId, groupIdHex) {
	const existing = await db.table("mlsGroups").get([ownerPubkey, groupIdHex]);
	if (existing) return;

	// Этап 73.3 — И4 (device-level, ПЕРЕД И3 — сигнал сильнее и безусловен):
	// единственный способ иметь строки в messages БЕЗ локальной mlsGroups-записи —
	// зеркало (kind:446, этап 25) от ДРУГОГО устройства ТОЙ ЖЕ identity (см.
	// DESIGN.md "И4" — verified, не домысел). Найдено харнессом: identity-pair
	// гейт (И3 ниже) САМ ПО СЕБЕ не закрывал М1 — оба устройства ОДНОЙ Алисы
	// получают ОДИНАКОВЫЙ ответ isCommitter(). Восстановление — БЕЗ нового
	// кода: существующий sibling-sync (devices.js, ветка announcerPubkey===
	// ownerPubkey) уже добавляет новое устройство в СУЩЕСТВУЮЩУЮ группу.
	if (await hasAnyMessagesFor(ownerPubkey, contactPubkey)) {
		throw new DomainError("другое моё устройство уже разговаривало с этим контактом — жду синхронизации", "errors.awaitingSiblingSync", { contactPubkey });
	}

	// Этап 73.3 — И3: гейт применяется, ТОЛЬКО если contact УЖЕ подтверждённый
	// контакт этого owner — холодное обращение к незнакомцу (isKnownContact
	// false) остаётся БЕЗ ГЕЙТА, старое поведение (найдено проверкой против
	// реальных тестов inbox-signals.test.js/inbox-requests.test.js, где
	// проигравшая по лексикографике сторона пишет незнакомцу впервые — без
	// этого условия сообщение зависло бы навсегда: реактивный канал
	// восстановления, ветка Г devices.js, существует ТОЛЬКО для подтверждённых
	// контактов, см. CONTRACTS.md/DESIGN.md "Этап 73.3").
	if ((await isKnownContact(ownerPubkey, contactPubkey)) && !isCommitter(ownerPubkey, contactPubkey)) {
		throw new DomainError("ожидание установления переписки — коммиттер этой пары не я", "errors.awaitingCommitter", { contactPubkey });
	}

	const theirDevices = await fetchDeviceKeyPackages(contactPubkey);

	// Свежий KeyPackage — для СОЗДАНИЯ именно этой группы, не переиспользует
	// опубликованный "приглашающий" ownKeyPackage (тот — для входящих Welcome от других).
	const myDeviceId = await getOrCreateDeviceId();
	const ownKeyPackage = await createOwnKeyPackage(ownerPubkey, myDeviceId);
	const state = await createGroup(ownerPubkey, ownKeyPackage, groupId);
	const { newSessionState, welcomeWireBytes } = await addMembers(state, Array.from(theirDevices.values(), (d) => d.wireBytes));
	// commitWireBytes сознательно отброшен — некому его слать (DESIGN.md п.3.4):
	// у новой группы нет других СУЩЕСТВУЮЩИХ участников кроме новых, которые
	// узнают состояние из Welcome, не из коммита.

	// contactPubkey хранится РЯДОМ с состоянием (не отдельной таблицей-маппингом) —
	// нужен для обратного поиска "чьё это kind 445" по groupId из h-тега: groupId —
	// однонаправленный хэш (DESIGN.md п.2), pubkey из него не восстановить назад.
	// ownerPubkey — часть составного ключа (db.version(4), owner-scoping — см. database.js).
	// Этап 39 — contactPubkey/state теперь sensitive (шифруются dbKey), ownerPubkey/groupId
	// остаются plaintext (составной PK, нужен для .get([ownerPubkey, groupIdHex])).
	await db.table("mlsGroups").put(
		toEncryptedRow({ ownerPubkey, groupId: groupIdHex, contactPubkey, state: serializeState(newSessionState) }, MLS_GROUPS_PLAINTEXT_FIELDS, dbKey),
	);

	// Бухгалтерия для реактивной досинхронизации (devices.js, handleDeviceAnnounce) —
	// эти устройства контакта УЖЕ добавлены сейчас, повторно добавлять не нужно.
	// Не шифруется (тот же прецедент, что knownDevices) — публичный KeyPackage.
	for (const [theirDeviceId, device] of theirDevices) {
		await db.table("knownContactDevices").put({ ownerPubkey, contactPubkey, deviceId: theirDeviceId, wireBytes: device.wireBytes });
	}

	const welcomeEvent = nip59Wrap(
		{ kind: 444, content: encodeBase64(welcomeWireBytes), tags: [] },
		privKey,
		contactPubkey,
	);
	await requirePublishOk(publish, welcomeEvent);
}

// Вызывается диспетчером входящих gift wrap (transport.js) на rumor.kind===444.
// welcomeSenderPubkey = rumor.pubkey (уже проверен nip59.unwrap — F-EV-05) — это и есть
// контакт, с которым устанавливается разговор с ПОЛУЧАЮЩЕЙ стороны.
export async function acceptWelcome(ownerPubkey, dbKey, welcomeSenderPubkey, welcomeWireBytes) {
	const groupId = computeGroupId(ownerPubkey, welcomeSenderPubkey);
	const groupIdHex = bytesToHex(groupId);

	// Этап 74 — T2.2 (RC-3): гонка "две вкладки одновременно принимают один
	// Welcome" — существует (DESIGN.md "Этап 74"), лок ЦЕЛИКОМ вокруг get→put.
	return withGroupLock(ownerPubkey, groupIdHex, async () => {
		const existing = await db.table("mlsGroups").get([ownerPubkey, groupIdHex]);
		if (existing) return; // уже установлено (повторная доставка того же Welcome, EOSE-повтор и т.п.)

		const ownKeyPackageRaw = await db.table("ownKeyPackage").get(ownerPubkey);
		if (!ownKeyPackageRaw) {
			throw new Error("нет собственного KeyPackage — вызовите ensureOwnKeyPackagePublished() раньше");
		}
		const ownKeyPackageRow = fromEncryptedRow(ownKeyPackageRaw, dbKey);
		const ownKeyPackage = {
			publicPackage: ownKeyPackageRow.publicPackage,
			privatePackage: ownKeyPackageRow.privatePackage,
		};

		const state = await joinFromWelcome(ownKeyPackage, welcomeWireBytes);
		await db.table("mlsGroups").put(
			toEncryptedRow({ ownerPubkey, groupId: groupIdHex, contactPubkey: welcomeSenderPubkey, state: serializeState(state) }, MLS_GROUPS_PLAINTEXT_FIELDS, dbKey),
		);
	});
}

// Этап 29 — правка контракта (skill п.12: только Claude, полная регрессия сразу
// после). attachments — необязательный 7-й параметр, МАССИВ (этап B, MEDIA-SPEC.md
// §3.7 — было единственное вложение attachment, undefined по умолчанию, старые
// вызовы без изменений). sentAt (wall-clock, секунды) генерируется ВСЕГДА — обе
// стороны видят ОДИНАКОВОЕ время отправки (не время получения); lamportTs (логические
// часы, порядок сортировки) не трогается — назначение разное, смешивать нельзя.
export async function sendMessage(ownerPubkey, privKey, dbKey, contactPubkey, text, lamportTs, publish, attachments) {
	const groupId = computeGroupId(ownerPubkey, contactPubkey);
	const groupIdHex = bytesToHex(groupId);
	// Этап 74 — T2.2 (RC-3): единственный писатель на (ownerPubkey, groupIdHex) —
	// лок ЦЕЛИКОМ, get→крипто→put (DESIGN.md "Этап 74"). drainPendingOutgoingMessages
	// вызывает sendMessage — лочится только этот, внутренний уровень (правило
	// нереентерабельности, DESIGN.md).
	return withGroupLock(ownerPubkey, groupIdHex, () => doSendMessage(ownerPubkey, privKey, dbKey, contactPubkey, text, lamportTs, publish, attachments, groupIdHex));
}

async function doSendMessage(ownerPubkey, privKey, dbKey, contactPubkey, text, lamportTs, publish, attachments, groupIdHex) {
	const raw = await db.table("mlsGroups").get([ownerPubkey, groupIdHex]);
	if (!raw) {
		throw new Error("чат не установлен — вызовите ensureChatEstablished() перед sendMessage()");
	}
	const row = fromEncryptedRow(raw, dbKey);

	const state = deserializeState(row.state);
	// msgId (этап 25) — единственный идентификатор, тождественный между живым MLS-путём
	// и зеркалом одного и того же логического сообщения (DESIGN.md, "Этап 25", раздел 3).
	const msgId = bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
	const sentAt = Math.floor(Date.now() / 1000);
	// Этап 74 — T1.1 (RC-1): отправитель едет ВНУТРИ MLS-payload (не видно на
	// проводе — см. CONTRACTS.md/DESIGN.md "Этап 74"). С этапа 72 все устройства
	// ОБЕИХ identity состоят в группе — без этого поля приёмник не может отличить
	// живое 445 от sibling-устройства владельца от живого 445 от контакта.
	const messagePayload = { text, lamportTs, msgId, sentAt, senderPubkey: ownerPubkey };
	if (attachments !== undefined && attachments.length > 0) messagePayload.attachments = attachments;
	const plaintextBytes = utf8ToBytes(JSON.stringify(messagePayload));
	const { newSessionState, wireBytes } = await encryptApplicationMessage(state, plaintextBytes);

	// Этап 73.5 — М6: переносим (НЕ сбрасываем) consecutiveDecryptFailures/desynced —
	// успешная ОТПРАВКА не доказывает, что ПРИЁМ работает (в M1/M2-сценарии
	// отправка от "своей" ветки продолжает работать бесконечно, именно то, что
	// маскирует проблему от пользователя, если тут тихо занулять счётчик).
	await db.table("mlsGroups").put(
		toEncryptedRow(
			{
				ownerPubkey,
				groupId: groupIdHex,
				contactPubkey: row.contactPubkey,
				state: serializeState(newSessionState),
				consecutiveDecryptFailures: row.consecutiveDecryptFailures ?? 0,
				desynced: row.desynced ?? false,
			},
			MLS_GROUPS_PLAINTEXT_FIELDS,
			dbKey,
		),
	);

	const { privateKey, publicKey } = await deriveNostrEnvelopeKeys(newSessionState);
	const content = nip44Encrypt(encodeBase64(wireBytes), privateKey, bytesToHex(publicKey));

	// НОВЫЙ эфемерный Nostr-ключ на КАЖДОЕ kind 445 (NIP-EE) — обфускация состава
	// группы теряет смысл при переиспользовании, см. DESIGN.md/CONTRACTS.md этапа 24.
	const ephemeralPriv = generateSecretKey();
	const event = sign(
		{ kind: 445, tags: [["h", groupIdHex]], content, created_at: Math.floor(Date.now() / 1000) },
		ephemeralPriv,
	);
	try {
		await requirePublishOk(publish, event);
	} catch (e) {
		// AC-09: сбой publish — event уже подписан (MLS-ратчет уже продвинут
		// строкой выше, эфемерный ключ уже одноразово использован), поэтому
		// нельзя просто повторно вызвать sendMessage с тем же текстом позже —
		// это создало бы ВТОРОЙ, другой шифртекст. Кладём в outbox буквально
		// ТОТ ЖЕ event для повторной попытки, не бросаем исключение — сообщение
		// остаётся видимым локально со статусом "failed", не теряется молча.
		await enqueue(event, dbKey);
		await upsertMessage({
			ownerPubkey,
			chatId: contactPubkey,
			lamportTs,
			senderPubkey: ownerPubkey,
			id: event.id,
			text,
			status: "failed",
			msgId,
			sentAt,
			...(attachments !== undefined && attachments.length > 0 ? { attachments } : {}),
		}, dbKey);
		// Редизайн интерфейса, этап 5 (CONTRACTS.md) — даже неотправленное
		// сообщение — реальное локальное действие пользователя в ЭТОМ чате
		// прямо сейчас, поднимает переписку по свежести, не оставляет её
		// "протухшей" до успешной доставки.
		await touchChatActivity(ownerPubkey, dbKey, contactPubkey, ownerPubkey, sentAt);
		return { eventId: event.id, queued: true };
	}

	await upsertMessage({
		ownerPubkey,
		chatId: contactPubkey,
		lamportTs,
		senderPubkey: ownerPubkey,
		id: event.id,
		text,
		status: "sent",
		msgId,
		sentAt,
		...(attachments !== undefined && attachments.length > 0 ? { attachments } : {}),
	}, dbKey);
	// Редизайн интерфейса, этап 5 (CONTRACTS.md) — свежесть переписки.
	await touchChatActivity(ownerPubkey, dbKey, contactPubkey, ownerPubkey, sentAt);

	await mirrorBestEffort(
		privKey,
		publish,
		{ text, lamportTs, senderPubkey: ownerPubkey, contactPubkey, msgId, sentAt, ...(attachments !== undefined && attachments.length > 0 ? { attachments } : {}) },
		groupIdHex,
	);

	return { eventId: event.id };
}

// Этап 73.3 — И3: проигравшая сторона (не коммиттер) копит исходящие здесь,
// пока коммиттер не создаст группу — см. DESIGN.md/CONTRACTS.md "Этап 73.3".
export async function enqueuePendingOutgoingMessage(ownerPubkey, dbKey, { contactPubkey, text, lamportTs, attachments }) {
	await db.table("pendingOutgoingMessages").put(
		toEncryptedRow({ ownerPubkey, contactPubkey, lamportTs, text, ...(attachments !== undefined && attachments.length > 0 ? { attachments } : {}) }, PENDING_OUTGOING_MESSAGES_PLAINTEXT_FIELDS, dbKey),
	);
}

// НАЙДЕНО ХАРНЕССОМ (m1-repro.test.js, не домысел): Welcome может прийти
// ПОВТОРНО (resubscribe-редоставка giftwrap-подписки — тот же класс, что
// уже задокументирован для kind:445/kind:443 в других подписчиках этого
// проекта) — acceptWelcome сама идемпотентна (`if (existing) return`), но
// БЕЗ коалесцирования drain всё равно вызывался бы дважды на два прихода
// ОДНОГО Welcome, отправляя одно и то же сообщение повторно. Тот же приём,
// что handleDeviceAnnounceInFlight (devices.js, этап 72) — второй вызов
// просто ждёт результата первого, не гоняет свою копию.
const drainInFlight = new Map();

// Вызывается, как только группа появляется — оба пути: (а) я сам стал
// коммиттером реактивно (devices.js's handleDeviceAnnounce), (б) я принял
// Welcome от коммиттера (transport.js, giftwrap-диспетчер, после acceptWelcome).
// Группа ОБЯЗАНА уже существовать к этому моменту — drain её не создаёт.
export async function drainPendingOutgoingMessages(ownerPubkey, privKey, dbKey, contactPubkey, publish) {
	const key = `${ownerPubkey}:${contactPubkey}`;
	const inFlight = drainInFlight.get(key);
	if (inFlight) return inFlight;

	const promise = (async () => {
		const raw = await db.table("pendingOutgoingMessages").where("[ownerPubkey+contactPubkey]").equals([ownerPubkey, contactPubkey]).sortBy("lamportTs");
		for (const encryptedRow of raw) {
			const row = fromEncryptedRow(encryptedRow, dbKey);
			await sendMessage(ownerPubkey, privKey, dbKey, contactPubkey, row.text, row.lamportTs, publish, row.attachments);
			await db.table("pendingOutgoingMessages").delete([ownerPubkey, contactPubkey, row.lamportTs]);
		}
	})().finally(() => drainInFlight.delete(key));

	drainInFlight.set(key, promise);
	return promise;
}

// privKey/publish (правка контракта этапа 25, было (ownerPubkey, event)) — нужны для
// зеркала best-effort (DESIGN.md, "Этап 25", раздел 2): устройство, ПРИНЯВШЕЕ сообщение
// живым MLS-путём, обязано распространить его на ОСТАЛЬНЫЕ устройства той же identity,
// иначе они не MLS-участники именно этого сообщения и никогда его не увидят.
export async function receiveGroupMessageEvent(ownerPubkey, privKey, dbKey, event, publish) {
	const hTag = event.tags.find((t) => t[0] === "h");
	if (!hTag) return null;
	const groupIdHex = hTag[1];

	// Этап 74 — T2.2/T2.3 (RC-3, DESIGN.md "Этап 74"): единственный писатель на
	// (ownerPubkey, groupIdHex) — лок ЦЕЛИКОМ, от get() до put() включительно
	// (дедуп-гейт T2.3 — внутри того же лока, до крипто).
	return withGroupLock(ownerPubkey, groupIdHex, () => doReceiveGroupMessageEvent(ownerPubkey, privKey, dbKey, event, publish, groupIdHex));
}

async function doReceiveGroupMessageEvent(ownerPubkey, privKey, dbKey, event, publish, groupIdHex) {
	// Этап 74 — T2.3: журнал обработанных событий — лок делает конкурентную
	// обработку БЕЗОПАСНОЙ, но без этого гейта второй processMessage того же
	// wire-события упал бы на replay-защите MLS и засчитался бы decrypt failure
	// (DESIGN.md "Этап 74"). Проверка ВНУТРИ лока — иначе тот же TOCTOU, что
	// лок вообще призван устранить.
	const alreadyProcessed = await db.table("processedGroupEvents").get([ownerPubkey, event.id]);
	if (alreadyProcessed) return null;

	const raw = await db.table("mlsGroups").get([ownerPubkey, groupIdHex]);
	if (!raw) return null; // чужая/неизвестная группа — не наш разговор
	const row = fromEncryptedRow(raw, dbKey);
	const contactPubkey = row.contactPubkey;

	const state = deserializeState(row.state);
	const { privateKey, publicKey } = await deriveNostrEnvelopeKeys(state);
	const wireBytes = decodeBase64(nip44Decrypt(event.content, privateKey, bytesToHex(publicKey)));

	const result = await decryptApplicationMessage(state, wireBytes);
	// Этап 73.5 — М6: единственная точка сброса — успешный приём ЛЮБОГО kind:445
	// этой группы (control-commit или обычное сообщение) прямое доказательство
	// "группа сейчас в порядке", даже если раньше были единичные потери.
	await db.table("mlsGroups").put(
		toEncryptedRow(
			{ ownerPubkey, groupId: groupIdHex, contactPubkey, state: serializeState(result.newSessionState), consecutiveDecryptFailures: 0, desynced: false },
			MLS_GROUPS_PLAINTEXT_FIELDS,
			dbKey,
		),
	);
	// Этап 74 — T2.3: запись ПОСЛЕ успешной обработки, тем же локом.
	await markEventProcessed(ownerPubkey, event.id, dbKey);

	if (result.kind === "control") return null;

	const parsed = JSON.parse(new TextDecoder().decode(result.message));
	// Этап 29 — sentAt ОТСУТСТВУЕТ у сообщений старого формата (до этого этапа) —
	// включается в строку/результат, только если РЕАЛЬНО пришёл в payload, не как
	// undefined-значение (иначе deepEqual-тесты на старый формат, devices.test.js,
	// увидели бы лишний ключ и сломались бы).
	// Этап B (MEDIA-SPEC.md §3.7) — attachments (массив) заменил attachment
	// (единственное число). Нормализация ЗДЕСЬ, единственном месте: старый формат
	// (payload.attachment — сообщения ДО этого этапа, локальная база разработки их
	// содержит) приводится к attachments-массиву; дальше по коду везде уже extra.attachments.
	const extra = {};
	if (parsed.sentAt !== undefined) extra.sentAt = parsed.sentAt;
	const normalizedAttachments = parsed.attachments ?? (parsed.attachment ? [parsed.attachment] : undefined);
	if (normalizedAttachments !== undefined) extra.attachments = normalizedAttachments;

	// Этап 74 — T1.2 (RC-1): нормализация к ОДНОМУ из двух легальных значений —
	// в 1:1-группе других identity нет, третье значение в payload — мусор/спуфинг
	// (см. L-1, DESIGN.md "Этап 74"), сводится к contactPubkey. Payload старого
	// формата (без senderPubkey, исторические sibling-сообщения при catch-up) —
	// parsed.senderPubkey===ownerPubkey ложно для undefined, ветка отрабатывает
	// сама (обратная совместимость, L-2).
	const senderPubkey = parsed.senderPubkey === ownerPubkey ? ownerPubkey : contactPubkey;

	await upsertMessage({
		ownerPubkey,
		chatId: contactPubkey,
		lamportTs: parsed.lamportTs,
		senderPubkey,
		id: event.id,
		text: parsed.text,
		status: "sent",
		msgId: parsed.msgId,
		...extra,
	}, dbKey);
	// Редизайн интерфейса, этап 5 (CONTRACTS.md) — свежесть переписки для
	// ПОЛУЧАТЕЛЯ. lastFrom — уже вычисленный senderPubkey (T1.2, тот же
	// принцип, что upsertMessage выше). extra.sentAt отсутствует у старого
	// формата (до этапа 29) — момент ПОЛУЧЕНИЯ не хуже приближение, чем
	// полное отсутствие записи активности.
	await touchChatActivity(ownerPubkey, dbKey, contactPubkey, senderPubkey, extra.sentAt ?? Math.floor(Date.now() / 1000));

	// Этап 74 — T1.3: то же вычисленное значение — иначе зеркало несёт ВТОРОЙ
	// экземпляр той же жёсткой ошибки RC-1.
	await mirrorBestEffort(
		privKey,
		publish,
		{ text: parsed.text, lamportTs: parsed.lamportTs, senderPubkey, contactPubkey, msgId: parsed.msgId, ...extra },
		groupIdHex,
	);

	// contactPubkey — аддитивное поле (этап 34): нужно вызывающему коду (transport.js)
	// для уведомлений "новое сообщение от X", ничего не ломает (существующие вызовы
	// проверяют отдельные поля через assert.equal, не строгий deepEqual на весь объект).
	return { text: parsed.text, lamportTs: parsed.lamportTs, contactPubkey, ...extra };
}

// Этап 73.3 — И4 (chat.js, ensureChatEstablished): существование, не данные —
// count() дешевле toArray() для гейта "была ли переписка вообще".
export async function hasAnyMessagesFor(ownerPubkey, contactPubkey) {
	return (await db.table("messages").where("[ownerPubkey+chatId]").equals([ownerPubkey, contactPubkey]).count()) > 0;
}

// Этап B медиа-подсистемы (MEDIA-SPEC.md §3.7) — та же нормализация, что уже
// применяется на живом/зеркальном приёме (doReceiveGroupMessageEvent/
// buildMirroredMessageRow), но здесь — для строк, УЖЕ лежащих в IndexedDB с
// момента ДО этого этапа (attachment, единственное число). Без неё старые
// сообщения с вложением молча перестают его показывать при чтении истории.
export function normalizeMessageAttachments(row) {
	if (row.attachments !== undefined || row.attachment === undefined) return row;
	return { ...row, attachments: [row.attachment] };
}

export async function getChatHistory(ownerPubkey, contactPubkey, dbKey) {
	const raw = await db.table("messages").where("[ownerPubkey+chatId]").equals([ownerPubkey, contactPubkey]).toArray();
	const rows = raw.map((r) => normalizeMessageAttachments(fromEncryptedRow(r, dbKey)));
	rows.sort((a, b) => {
		if (a.lamportTs !== b.lamportTs) return a.lamportTs - b.lamportTs;
		if (a.senderPubkey !== b.senderPubkey) return a.senderPubkey < b.senderPubkey ? -1 : 1;
		return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
	});
	return rows;
}

// Этап 73.5 — М6 (детект расхождения). Порог — 3 ПОДРЯД без единого успешного
// приёма между ними (не 1 — редкая единичная потеря, уже принятый остаточный
// риск И2/И4, не должна немедленно объявлять переписку сломанной; см.
// DESIGN.md "Реализация (73.5)"). Произвольная, но консервативная константа.
const DESYNC_THRESHOLD = 3;

// Вызывается ТОЛЬКО из retryBufferedGroupMessages (transport.js) в момент
// окончательного (TTL истёк) отказа от буферной записи — НЕ на каждый
// провал расшифровки (это была бы нормальная, ожидаемая буферизация М3,
// не признак расхождения).
export async function recordGroupDecryptFailure(ownerPubkey, groupIdHex, dbKey) {
	// Этап 74 — T2.2 (RC-3): тот же get→put на mlsGroups, тот же лок (DESIGN.md "Этап 74").
	return withGroupLock(ownerPubkey, groupIdHex, async () => {
		const raw = await db.table("mlsGroups").get([ownerPubkey, groupIdHex]);
		if (!raw) return;
		const row = fromEncryptedRow(raw, dbKey);
		const consecutiveDecryptFailures = (row.consecutiveDecryptFailures ?? 0) + 1;
		await db.table("mlsGroups").put(
			toEncryptedRow(
				{
					ownerPubkey,
					groupId: groupIdHex,
					contactPubkey: row.contactPubkey,
					state: row.state,
					consecutiveDecryptFailures,
					desynced: consecutiveDecryptFailures >= DESYNC_THRESHOLD,
				},
				MLS_GROUPS_PLAINTEXT_FIELDS,
				dbKey,
			),
		);
	});
}

export async function listDesyncedChats(ownerPubkey, dbKey) {
	const rows = (await db.table("mlsGroups").where("ownerPubkey").equals(ownerPubkey).toArray()).map((r) => fromEncryptedRow(r, dbKey));
	return rows.filter((r) => r.desynced).map((r) => ({ contactPubkey: r.contactPubkey, groupId: r.groupId, consecutiveDecryptFailures: r.consecutiveDecryptFailures }));
}

// Забывает ЛОКАЛЬНОЕ состояние (группу + бухгалтерию известных устройств
// контакта) — НЕ решает, кто в паре коммиттер: следующий ensureChatEstablished
// (ручная отправка) либо реактивный sibling-Welcome отработают ТЕМ ЖЕ путём,
// что уже реализуют И3/И4 (DESIGN.md "Реализация (73.5)") — не отдельный
// протокольный механизм.
export async function recreateChatConversation(ownerPubkey, contactPubkey, dbKey) {
	const groupIdHex = bytesToHex(computeGroupId(ownerPubkey, contactPubkey));
	await db.table("mlsGroups").delete([ownerPubkey, groupIdHex]);
	await db.table("knownContactDevices").where("[ownerPubkey+contactPubkey]").equals([ownerPubkey, contactPubkey]).delete();
}
