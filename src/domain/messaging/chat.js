import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { generateSecretKey } from "nostr-tools/pure";
import { sign } from "../../core/crypto/sign.js";
import { encrypt as nip44Encrypt, decrypt as nip44Decrypt, MAX_PLAINTEXT_BYTES } from "../../core/crypto/nip44.js";
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
import { enqueue, markSent, markFailed } from "../../core/store/outbox.js";
import { toEncryptedRow, fromEncryptedRow } from "../../core/store/encrypted-table.js";
import { OWN_KEY_PACKAGE_PLAINTEXT_FIELDS, MLS_GROUPS_PLAINTEXT_FIELDS, MESSAGES_PLAINTEXT_FIELDS, PENDING_OUTGOING_MESSAGES_PLAINTEXT_FIELDS, PROCESSED_GROUP_EVENTS_PLAINTEXT_FIELDS, UNDELIVERABLE_PLAINTEXT_FIELDS } from "../../core/store/table-fields.js";
import { DomainError } from "../errors.js";
import { isKnownContact } from "./inbox-requests.js";
import { withGroupLock } from "../../core/store/mls-lock.js";
import { touchChatActivity } from "./chat-activity.js";
import { notePeerActivity } from "./peer-presence.js";
import {
	applyPeerCursor,
	extractCursorFromPayload,
	parseCursorText,
	buildCursorText,
	markCursorSent,
	cursorGrewSinceLastSend,
	bindCursorFlush,
	scheduleCursorFlush,
	rearmAfterMinInterval,
} from "./peer-cursors.js";
import { loadUiSettings } from "../settings/ui-settings.js";
import { record as traceDelivery } from "../../core/diag/delivery-trace.js";
import { transitionMessage } from "./machine.js";

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
	const sorted = [String(pubkeyHexA).toLowerCase(), String(pubkeyHexB).toLowerCase()].sort();
	return sha256(utf8ToBytes(sorted.join(":")));
}

// Этап 73.3 — И3: для пары (A,B) ровно одна сторона вправе впервые создать
// G(A,B) — тот же приём, что glare resolution в call-FSM (FEATURE-SPECS/VOICE.md).
export function isCommitter(pubkeyHexA, pubkeyHexB) {
	return String(pubkeyHexA).toLowerCase() < String(pubkeyHexB).toLowerCase();
}

// Этап 5 (MESSAGE-DELIVERY-TZ.md, З5.2) — strfry (server/strfry/strfry.conf,
// rejectEventsNewerThanSeconds=900/rejectEventsOlderThanSeconds) отвергает
// событие с сильно расходящимся created_at сообщением "invalid: created_at
// too late"/"invalid: created_at too early" (проверено чтением исходника
// relay, server/strfry/strfry-src/src/{events,apps/relay/RelayIngester}.cpp —
// не домысел). Раньше это всплывало как сырой английский текст от relay —
// теперь явная, переведённая причина.
const CLOCK_SKEW_REASON_PATTERN = /created_at too (late|early)/;

export async function requirePublishOk(publish, event) {
	const result = await publish(event);
	if (!result.ok) {
		if (result.reason && CLOCK_SKEW_REASON_PATTERN.test(result.reason)) {
			const tooLate = result.reason.includes("too late");
			throw new DomainError(
				tooLate ? "часы устройства спешат — сообщение не принято реле" : "часы устройства отстают — сообщение не принято реле",
				tooLate ? "errors.clockAhead" : "errors.clockBehind",
			);
		}
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
	traceDelivery("establish.enter", { groupIdHex, contactPubkey, isCommitter: isCommitter(ownerPubkey, contactPubkey) });
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
	//
	// Этап 5 (З5.7) — этот гейт СОЗНАТЕЛЬНО обходится recreateChatConversation
	// (вызывает createGroupAndSendWelcome напрямую, минуя doEnsureChatEstablished):
	// после осознанного "пересоздать" СТАРЫЕ messages этого же контакта неизбежно
	// есть (сама переписка, которую только что признали desynced) — здесь это
	// было бы ложным срабатыванием И4 (гейт создан для ДРУГОГО случая — sibling-
	// устройство той же identity, не "я сам только что решил начать заново").
	if (await hasAnyMessagesFor(ownerPubkey, contactPubkey)) {
		traceDelivery("establish.throw", { groupIdHex, key: "errors.awaitingSiblingSync" });
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
		traceDelivery("establish.throw", { groupIdHex, key: "errors.awaitingCommitter" });
		throw new DomainError("ожидание установления переписки — коммиттер этой пары не я", "errors.awaitingCommitter", { contactPubkey });
	}

	await createGroupAndSendWelcome(ownerPubkey, privKey, dbKey, contactPubkey, publish, fetchDeviceKeyPackages, groupId, groupIdHex);
}

// Этап 5 (MESSAGE-DELIVERY-TZ.md, З5.7) — вынесено из doEnsureChatEstablished
// (та часть, что идёт ПОСЛЕ гейтов И3/И4): recreateChatConversation вызывает
// это НАПРЯМУЮ, под тем же локом, обходя гейты (см. комментарий у И4 выше) —
// единственное отличие от обычного establish-пути в том, ЧТО именно вызвало
// эту функцию, не в том, что она делает.
async function createGroupAndSendWelcome(ownerPubkey, privKey, dbKey, contactPubkey, publish, fetchDeviceKeyPackages, groupId, groupIdHex) {
	traceDelivery("keypackages.req", { peer: contactPubkey });
	const t0 = Date.now();
	const theirDevices = await fetchDeviceKeyPackages(contactPubkey);
	traceDelivery("keypackages.eose", { count: theirDevices.size, elapsed: Date.now() - t0 });

	// Свежий KeyPackage — для СОЗДАНИЯ именно этой группы, не переиспользует
	// опубликованный "приглашающий" ownKeyPackage (тот — для входящих Welcome от других).
	const myDeviceId = await getOrCreateDeviceId();
	const ownKeyPackage = await createOwnKeyPackage(ownerPubkey, myDeviceId);
	const state = await createGroup(ownerPubkey, ownKeyPackage, groupId);
	const { newSessionState, welcomeWireBytes } = await addMembers(state, Array.from(theirDevices.values(), (d) => d.wireBytes));
	// commitWireBytes сознательно отброшен — некому его слать (DESIGN.md п.3.4):
	// у новой группы нет других СУЩЕСТВУЮЩИХ участников кроме новых, которые
	// узнают состояние из Welcome, не из коммита.

	// Этап 5 (MESSAGE-DELIVERY-TZ.md, З5.3) — ДО db.table("mlsGroups").put() ниже:
	// эта группа ещё нигде не персистирована — если welcomeWireBytes заведомо не
	// поместится в конверт (два слоя NIP-59: seal+wrap, оба поверх NIP-44 v2 с
	// лимитом 65535 байт на СВОЙ plaintext — вложенный JSON накапливает накладные
	// расходы обоих слоёв), лучше не создавать локальную группу вовсе, чем
	// создать её и никогда не суметь доставить Welcome контакту (тот молча
	// копит 445 в буфере до TTL, см. Этап 3, undeliverable). Порог —
	// консервативная ОЦЕНКА (не точный расчёт компаундирующихся накладных
	// расходов двух слоёв NIP-44 + JSON-обёртки события), намеренно с запасом.
	const MAX_SAFE_WELCOME_WIRE_BYTES = 20000;
	if (welcomeWireBytes.length > MAX_SAFE_WELCOME_WIRE_BYTES) {
		throw new DomainError(
			`слишком много устройств у контакта (${theirDevices.size}) для одного приглашения — попробуйте ещё раз позже`,
			"errors.welcomeTooLargeForDeviceCount",
			{ deviceCount: theirDevices.size },
		);
	}

	// Этап 5 (З5.7) — "поколение" этой пары: bumpChatGeneration (вызывается
	// recreateChatConversation ДО удаления старой группы) переживает удаление
	// mlsGroups-строки — обычный establish (не после recreate) видит 0 всегда.
	// Едет В ОТКРЫТУЮ в теге Welcome (не секрет, не аутентифицирован NIP-44 —
	// целостность обеспечивает сам NIP-59 wrap/seal, подделать тег отдельно от
	// содержимого нельзя, не расширяя поверхность атаки) — приёмная сторона
	// (acceptWelcome) сверяет его с уже сохранённым, чтобы отличить "новый
	// Welcome взамен мёртвой группы" от "повторная доставка ТОГО ЖЕ Welcome".
	const generation = await getChatGeneration(ownerPubkey, contactPubkey);

	// contactPubkey хранится РЯДОМ с состоянием (не отдельной таблицей-маппингом) —
	// нужен для обратного поиска "чьё это kind 445" по groupId из h-тега: groupId —
	// однонаправленный хэш (DESIGN.md п.2), pubkey из него не восстановить назад.
	// ownerPubkey — часть составного ключа (db.version(4), owner-scoping — см. database.js).
	// Этап 39 — contactPubkey/state теперь sensitive (шифруются dbKey), ownerPubkey/groupId
	// остаются plaintext (составной PK, нужен для .get([ownerPubkey, groupIdHex])).
	await db.table("mlsGroups").put(
		toEncryptedRow({ ownerPubkey, groupId: groupIdHex, contactPubkey, state: serializeState(newSessionState), generation }, MLS_GROUPS_PLAINTEXT_FIELDS, dbKey),
	);

	// Бухгалтерия для реактивной досинхронизации (devices.js, handleDeviceAnnounce) —
	// эти устройства контакта УЖЕ добавлены сейчас, повторно добавлять не нужно.
	// Не шифруется (тот же прецедент, что knownDevices) — публичный KeyPackage.
	for (const [theirDeviceId, device] of theirDevices) {
		await db.table("knownContactDevices").put({ ownerPubkey, contactPubkey, deviceId: theirDeviceId, wireBytes: device.wireBytes });
	}

	const welcomeEvent = nip59Wrap(
		{ kind: 444, content: encodeBase64(welcomeWireBytes), tags: [["gen", String(generation)]] },
		privKey,
		contactPubkey,
	);
	await requirePublishOk(publish, welcomeEvent);
}

// Вызывается диспетчером входящих gift wrap (transport.js) на rumor.kind===444.
// welcomeSenderPubkey = rumor.pubkey (уже проверен nip59.unwrap — F-EV-05) — это и есть
// контакт, с которым устанавливается разговор с ПОЛУЧАЮЩЕЙ стороны.
// incomingGeneration (Этап 5, З5.7) — из тега ["gen", N] rumor'а Welcome
// (createGroupAndSendWelcome кладёт его туда); 0 по умолчанию для старых
// вызовов без этого параметра (тесты, обратная совместимость).
export async function acceptWelcome(ownerPubkey, dbKey, welcomeSenderPubkey, welcomeWireBytes, incomingGeneration = 0) {
	const groupId = computeGroupId(ownerPubkey, welcomeSenderPubkey);
	const groupIdHex = bytesToHex(groupId);
	traceDelivery("recv.welcome", { contact: welcomeSenderPubkey, groupIdHex, incomingGeneration });

	// Этап 74 — T2.2 (RC-3): гонка "две вкладки одновременно принимают один
	// Welcome" — существует (DESIGN.md "Этап 74"), лок ЦЕЛИКОМ вокруг get→put.
	return withGroupLock(ownerPubkey, groupIdHex, async () => {
		const existingRaw = await db.table("mlsGroups").get([ownerPubkey, groupIdHex]);
		if (existingRaw) {
			// Этап 5 (З5.7) — раньше ЛЮБОЙ Welcome при уже существующей локальной
			// группе молча игнорировался ("уже установлено") — это верно для
			// повторной доставки ТОГО ЖЕ Welcome (EOSE-повтор и т.п.), но означало
			// permanent-divergence дыру для recreateChatConversation: собеседник
			// пересоздал группу локально и шлёт НОВЫЙ Welcome, а мы, всё ещё думая,
			// что старая группа рабочая, тихо выбрасываем его и продолжаем
			// расшифровывать его будущие 445 СТАРЫМ (несовместимым) ключом —
			// desync без пути назад. incomingGeneration СТРОГО больше уже
			// сохранённого — однозначный сигнал "замени", не "дубль".
			const existing = fromEncryptedRow(existingRaw, dbKey);
			if (incomingGeneration <= (existing.generation ?? 0)) return;
			traceDelivery("recv.welcome.replace", { contact: welcomeSenderPubkey, groupIdHex, fromGeneration: existing.generation ?? 0, toGeneration: incomingGeneration });
		}

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
			toEncryptedRow(
				{ ownerPubkey, groupId: groupIdHex, contactPubkey: welcomeSenderPubkey, state: serializeState(state), generation: incomingGeneration },
				MLS_GROUPS_PLAINTEXT_FIELDS,
				dbKey,
			),
		);
	});
}

// Этап 29 — правка контракта (skill п.12: только Claude, полная регрессия сразу
// после). attachments — необязательный 7-й параметр, МАССИВ (этап B, MEDIA-SPEC.md
// §3.7 — было единственное вложение attachment, undefined по умолчанию, старые
// вызовы без изменений). sentAt (wall-clock, секунды) генерируется ВСЕГДА — обе
// стороны видят ОДИНАКОВОЕ время отправки (не время получения); lamportTs (логические
// часы, порядок сортировки) не трогается — назначение разное, смешивать нельзя.
// msgId/sentAt (Этап 1 — MESSAGE-DELIVERY-TZ.md, З1.1) — необязательные
// аддитивные параметры. sendChatMessageAction/drainPendingOutgoingMessages
// генерируют их ОДИН РАЗ в момент клика (до сети — строка уже в ленте со
// статусом "queued"/"sending", см. chats.js) и передают сюда, чтобы doSendMessage
// не создавала ВТОРОЙ msgId для строки, которая уже существует. Старые прямые
// вызовы sendMessage() (тесты, АДВЕРСАРНЫЕ вызовы в обход sendChatMessageAction)
// не передают их — поведение как раньше, генерируются здесь.
// Этап 3 (MESSAGE-DELIVERY-TZ.md, З3.1) — publish() ушёл ИЗ-ПОД лока: раньше
// withGroupLock оборачивала ВЕСЬ doSendMessage, включая сетевой publish() —
// зависшая публикация (H2, ту же группу лочит receiveGroupMessageEvent)
// блокировала приём/отправку для ЭТОЙ ЖЕ пары на другой вкладке/устройстве
// на всё время висящего сетевого ожидания (H6, MESSAGE-DELIVERY-AUDIT-
// BRIEFING.md §5.7). Крипто-критичная часть (deserialize→encrypt→persist
// state→sign→outbox.enqueue) остаётся ПОД локом целиком (единственный
// писатель MLS-состояния, DESIGN.md "Этап 74") — publish() выполняется уже
// СНАРУЖИ, когда лок отпущен.
export async function sendMessage(ownerPubkey, privKey, dbKey, contactPubkey, text, lamportTs, publish, attachments, msgId, sentAt) {
	const groupId = computeGroupId(ownerPubkey, contactPubkey);
	const groupIdHex = bytesToHex(groupId);
	const prepared = await withGroupLock(ownerPubkey, groupIdHex, () =>
		prepareOutgoingMessage(ownerPubkey, privKey, dbKey, contactPubkey, text, lamportTs, attachments, groupIdHex, msgId, sentAt),
	);
	return finishOutgoingMessage(ownerPubkey, privKey, dbKey, contactPubkey, text, lamportTs, publish, attachments, groupIdHex, prepared);
}

async function prepareOutgoingMessage(ownerPubkey, privKey, dbKey, contactPubkey, text, lamportTs, attachments, groupIdHex, msgIdParam, sentAtParam) {
	const raw = await db.table("mlsGroups").get([ownerPubkey, groupIdHex]);
	if (!raw) {
		throw new Error("чат не установлен — вызовите ensureChatEstablished() перед sendMessage()");
	}
	const row = fromEncryptedRow(raw, dbKey);

	const state = deserializeState(row.state);
	// msgId (этап 25) — единственный идентификатор, тождественный между живым MLS-путём
	// и зеркалом одного и того же логического сообщения (DESIGN.md, "Этап 25", раздел 3).
	const msgId = msgIdParam ?? bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
	const sentAt = sentAtParam ?? Math.floor(Date.now() / 1000);
	// Этап 74 — T1.1 (RC-1): отправитель едет ВНУТРИ MLS-payload (не видно на
	// проводе — см. CONTRACTS.md/DESIGN.md "Этап 74"). С этапа 72 все устройства
	// ОБЕИХ identity состоят в группе — без этого поля приёмник не может отличить
	// живое 445 от sibling-устройства владельца от живого 445 от контакта.
	const messagePayload = { text, lamportTs, msgId, sentAt, senderPubkey: ownerPubkey };
	// Этап 5 (MESSAGE-DELIVERY-TZ.md, З5.5) — пиггибэк-подтверждение (вариант
	// "дёшево" из ТЗ): "везём" вместе с обычным сообщением наивысший lamportTs,
	// который мы реально видели ОТ этого контакта — ничего не стоит на проводе
	// сверх нескольких байт JSON. undefined (контакт нам ещё ничего не писал) —
	// поле не добавляем вовсе, "работает только при взаимной переписке" (ТЗ).
	const receipts = await getOutgoingReceipts(ownerPubkey, contactPubkey, dbKey);
	if (receipts.d !== undefined) {
		messagePayload.d = receipts.d;
		messagePayload.ackUpTo = receipts.d;
	}
	if (receipts.r !== undefined) messagePayload.r = receipts.r;
	if (attachments !== undefined && attachments.length > 0) messagePayload.attachments = attachments;
	const plaintextBytes = utf8ToBytes(JSON.stringify(messagePayload));
	// Этап 5 (MESSAGE-DELIVERY-TZ.md, З5.3) — проверка ДО encryptApplicationMessage,
	// не после: та продвигает MLS-ратчет НЕОБРАТИМО (тот же принцип, что
	// AC-09/З3.1 — событие, для которого ратчет уже сдвинут, нельзя просто
	// перегенерировать). Раньше nip44.js бросала СВОЙ предел (65535 байт на
	// base64(wireBytes)) уже ПОСЛЕ шифрования — ратчет успевал сдвинуться
	// впустую, сообщение терялось бы безвозвратно (та же дыра, что была у
	// outbox.enqueue "только в catch" до Этапа 3). Порог здесь — консервативная
	// оценка СВЕРХУ по входному plaintext (запас на служебные накладные
	// расходы MLS-шифрования + base64: 4/3 расширение), не точный расчёт —
	// пропускает погранично малые случаи в штатный путь (там всё ещё есть
	// финальная проверка nip44.js как страховка), но отсекает заведомо
	// слишком большие ДО того, как ратчет пострадает.
	const SAFE_PLAINTEXT_MARGIN_BYTES = 4096; // накладные расходы MLS-framing + AEAD-тег + запас
	const maxSafePayloadBytes = Math.floor((MAX_PLAINTEXT_BYTES * 3) / 4) - SAFE_PLAINTEXT_MARGIN_BYTES;
	if (plaintextBytes.length > maxSafePayloadBytes) {
		throw new DomainError(
			`сообщение слишком большое для отправки одним событием (${plaintextBytes.length} байт) — обычно причина в количестве вложений; попробуйте отправить их по отдельности`,
			"errors.messageTooLargeForEvent",
			{ bytes: plaintextBytes.length },
		);
	}
	const { newSessionState, wireBytes } = await encryptApplicationMessage(state, plaintextBytes);
	traceDelivery("encrypt.done", { msgId, groupIdHex, epoch: newSessionState.groupContext?.epoch?.toString?.() });

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
	traceDelivery("state.persisted", { msgId, groupIdHex });

	const { privateKey, publicKey } = await deriveNostrEnvelopeKeys(newSessionState);
	const content = nip44Encrypt(encodeBase64(wireBytes), privateKey, bytesToHex(publicKey));

	// НОВЫЙ эфемерный Nostr-ключ на КАЖДОЕ kind 445 (NIP-EE) — обфускация состава
	// группы теряет смысл при переиспользовании, см. DESIGN.md/CONTRACTS.md этапа 24.
	const ephemeralPriv = generateSecretKey();
	const event = sign(
		{ kind: 445, tags: [["h", groupIdHex]], content, created_at: Math.floor(Date.now() / 1000) },
		ephemeralPriv,
	);
	traceDelivery("event.signed", { msgId, eventId: event.id, groupIdHex });

	// Этап 1 (MESSAGE-DELIVERY-TZ.md, З1.1/З1.3/З1.2) — строка УЖЕ существует в
	// messages со статусом "queued" (написана sendChatMessageAction ДО сети, до
	// того как MLS-группа вообще была установлена, см. chats.js) для ОБОИХ путей:
	// немедленная отправка коммиттера и отложенная отправка через drain. Прямые
	// вызовы sendMessage() в обход sendChatMessageAction (старые тесты) строки не
	// создают — тогда вставляем её здесь заново, сразу в "sending" (нечего
	// транзишенить, это первая запись). transitionMessage — единственный
	// источник истины для допустимости перехода (machine.js), недопустимый бросает.
	const existingRow = await db.table("messages").where("[ownerPubkey+chatId+msgId]").equals([ownerPubkey, contactPubkey, msgId]).first();
	if (existingRow) {
		await db
			.table("messages")
			.where("[ownerPubkey+chatId+msgId]")
			.equals([ownerPubkey, contactPubkey, msgId])
			.modify({ status: transitionMessage(existingRow.status, "ESTABLISHED"), id: event.id });
	} else {
		await upsertMessage({
			ownerPubkey,
			chatId: contactPubkey,
			lamportTs,
			senderPubkey: ownerPubkey,
			id: event.id,
			text,
			status: "sending",
			msgId,
			sentAt,
			...(attachments !== undefined && attachments.length > 0 ? { attachments } : {}),
		}, dbKey);
	}
	traceDelivery("message.upsert", { msgId, status: "sending" });

	// Этап 3 (З3.1) — outbox.enqueue() ДО попытки публикации, не только в catch
	// после сбоя: если вкладку закрыли между этой строкой и ответом relay,
	// событие уже лежит в durable-очереди — drainOutboxSafely довезёт его на
	// следующем подключении. Раньше enqueue происходил ТОЛЬКО из catch — окно
	// "вкладка закрыта посреди зависшей публикации" теряло событие навсегда,
	// хотя MLS-ратчет уже был необратимо продвинут (см. AUDIT-BRIEFING §4.2).
	// ok:true ниже (finishOutgoingMessage) чистит эту запись через markSent —
	// то, что каждое сообщение теперь проходит через outbox, а не только
	// провалившиеся, обменивает одну лишнюю запись в Dexie на устранение
	// потери — тот же компромисс, что sourced из ТЗ, не самостоятельное решение.
	const seq = await enqueue(event, dbKey);
	traceDelivery("outbox.enqueued", { msgId, eventId: event.id });

	return { event, seq, msgId, sentAt, receipts };
}

// Этап 3 (З3.1) — вне лока: зависшая публикация (H2, или просто медленная
// сеть) для ЭТОЙ группы больше не блокирует receiveGroupMessageEvent/другую
// вкладку, желающую отправить в ТУ ЖЕ группу (withGroupLock уже отпущена к
// этому моменту). "reject → ничего не удаляем: событие уже в очереди, статус
// остаётся 'sending'" — по коду ТЗ буквально: локальный статус НЕ становится
// "failed" здесь, drainOutboxSafely доведёт его до "sent" при следующей
// удачной попытке или до "failed" только когда outbox исчерпает MAX_ATTEMPTS
// (З3.2) — тогда же кнопка "повторить" в UI.
async function finishOutgoingMessage(ownerPubkey, privKey, dbKey, contactPubkey, text, lamportTs, publish, attachments, groupIdHex, prepared) {
	const { event, seq, msgId, sentAt, receipts } = prepared;
	const publishStartedAt = Date.now();
	let result;
	try {
		result = await requirePublishOk(publish, event);
		traceDelivery("publish.ok", { msgId, eventId: event.id, elapsed: Date.now() - publishStartedAt });
	} catch (e) {
		traceDelivery("publish.reject", { msgId, eventId: event.id, reason: String(e?.message ?? e), elapsed: Date.now() - publishStartedAt });
		// AC-09: событие уже в outbox (prepareOutgoingMessage, ПОД локом, ДО
		// этой попытки) — ничего дополнительно ставить в очередь не нужно.
		// Эта немедленная попытка ЗАСЧИТЫВАЕТСЯ как одна из MAX_ATTEMPTS
		// (markFailed) — тот же счётчик, что drainOutboxSafely двигает при
		// последующих попытках, единая бухгалтерия, не два независимых счёта.
		// Локальный статус ОСТАЁТСЯ "sending", если MAX_ATTEMPTS ещё не
		// исчерпан — становится "failed" только когда finalFailure (крайне
		// маловероятно на первой же попытке, но возможно при MAX_ATTEMPTS=1
		// в тестовой конфигурации) — не здесь безусловно, не после первого же
		// провала (это и была исходная дыра, AUDIT-BRIEFING §4.6: "одна
		// неудача = конец").
		const { finalFailure } = await markFailed(seq);
		// Этап 5 (З5.2) — расхождение часов не самовосстанавливается молчаливым
		// повтором так же надёжно, как обычный сетевой сбой: событие остаётся в
		// outbox (не теряется — вдруг часы поправятся сами, тогда ЭТА ЖЕ
		// попытка от drainOutboxSafely пройдёт), но пользователю нужно увидеть
		// ПРИЧИНУ сразу, не только после исчерпания MAX_ATTEMPTS (~сутки).
		if (e?.key === "errors.clockAhead" || e?.key === "errors.clockBehind") {
			await touchChatActivity(ownerPubkey, dbKey, contactPubkey, ownerPubkey, sentAt);
			throw e;
		}
		if (finalFailure) {
			await db
				.table("messages")
				.where("[ownerPubkey+chatId+msgId]")
				.equals([ownerPubkey, contactPubkey, msgId])
				.modify({ status: transitionMessage("sending", "FAIL") });
			traceDelivery("message.upsert", { msgId, status: "failed" });
		}
		await touchChatActivity(ownerPubkey, dbKey, contactPubkey, ownerPubkey, sentAt);
		return { eventId: event.id, queued: true };
	}

	await markSent(seq);
	if (receipts) markCursorSent(ownerPubkey, contactPubkey, receipts.d, receipts.r);
	await db
		.table("messages")
		.where("[ownerPubkey+chatId+msgId]")
		.equals([ownerPubkey, contactPubkey, msgId])
		.modify({ status: transitionMessage("sending", "ACK") });
	traceDelivery("message.upsert", { msgId, status: "sent" });
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
// Этап 1 (MESSAGE-DELIVERY-TZ.md, З1.3, вариант A) — text/attachments БОЛЬШЕ НЕ
// параметры: строка со статусом "queued" уже лежит в messages (написана
// вызывающим, sendChatMessageAction, ДО этого вызова) — drain читает содержимое
// оттуда по msgId, один источник текста, не два.
export async function enqueuePendingOutgoingMessage(ownerPubkey, dbKey, { contactPubkey, lamportTs, msgId }) {
	await db.table("pendingOutgoingMessages").put(toEncryptedRow({ ownerPubkey, contactPubkey, lamportTs, msgId }, PENDING_OUTGOING_MESSAGES_PLAINTEXT_FIELDS, dbKey));
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
		traceDelivery("drain.start", { contactPubkey, count: raw.length });
		for (const encryptedRow of raw) {
			const row = fromEncryptedRow(encryptedRow, dbKey);
			// Этап 1 (З1.3, вариант A) — новый формат несёт только msgId, содержимое
			// (text/attachments/sentAt) читается из messages (строка "queued" уже
			// там с момента клика). Старый формат (row.text напрямую, msgId
			// отсутствует) — совместимость с записями, накопленными ДО этого этапа
			// (живой деплой, очередь могла пережить обновление кода): используем как
			// раньше, без похода в messages.
			if (row.msgId !== undefined) {
				const messageRow = await db.table("messages").where("[ownerPubkey+chatId+msgId]").equals([ownerPubkey, contactPubkey, row.msgId]).first();
				const decoded = messageRow ? fromEncryptedRow(messageRow, dbKey) : null;
				await sendMessage(ownerPubkey, privKey, dbKey, contactPubkey, decoded?.text ?? "", row.lamportTs, publish, decoded?.attachments, row.msgId, decoded?.sentAt);
			} else {
				await sendMessage(ownerPubkey, privKey, dbKey, contactPubkey, row.text, row.lamportTs, publish, row.attachments);
			}
			await db.table("pendingOutgoingMessages").delete([ownerPubkey, contactPubkey, row.lamportTs]);
		}
		traceDelivery("drain.done", { contactPubkey, count: raw.length });
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
	traceDelivery("recv.445", { eventId: event.id, groupIdHex, createdAt: event.created_at });
	// Этап 74 — T2.3: журнал обработанных событий — лок делает конкурентную
	// обработку БЕЗОПАСНОЙ, но без этого гейта второй processMessage того же
	// wire-события упал бы на replay-защите MLS и засчитался бы decrypt failure
	// (DESIGN.md "Этап 74"). Проверка ВНУТРИ лока — иначе тот же TOCTOU, что
	// лок вообще призван устранить.
	const alreadyProcessed = await db.table("processedGroupEvents").get([ownerPubkey, event.id]);
	if (alreadyProcessed) return null;

	const raw = await db.table("mlsGroups").get([ownerPubkey, groupIdHex]);
	if (!raw) {
		traceDelivery("recv.445.nogroup", { eventId: event.id, groupIdHex });
		return null; // чужая/неизвестная группа — не наш разговор
	}
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

	const incomingCursor = extractCursorFromPayload(parsed);
	if (incomingCursor) {
		await applyPeerCursor(ownerPubkey, contactPubkey, incomingCursor);
	}

	const isCursorOnly = parsed.ackOnly === true || parseCursorText(parsed.text) !== null;
	if (isCursorOnly) {
		await notePeerActivity(ownerPubkey, contactPubkey, event.created_at);
		traceDelivery("recv.445.ackonly", { eventId: event.id, groupIdHex, ackUpTo: incomingCursor?.d });
		return null;
	}

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
	if (senderPubkey === contactPubkey) {
		await notePeerActivity(ownerPubkey, contactPubkey, event.created_at);
	}

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

export function armPeerCursorAck(ownerPubkey, privKey, dbKey, contactPubkey, publish) {
	ensureCursorFlushBound(ownerPubkey, privKey, dbKey, contactPubkey, publish);
	scheduleCursorFlush(ownerPubkey, contactPubkey);
}

// Этап 73.3 — И4 (chat.js, ensureChatEstablished): существование, не данные —
// count() дешевле toArray() для гейта "была ли переписка вообще".
// Этап 1 (MESSAGE-DELIVERY-TZ.md, З1.1/З1.3) — исключаем status:"queued":
// с этого этапа sendChatMessageAction пишет строку в messages ДО вызова
// ensureChatEstablished (лента видна сразу, до сети) — без этого исключения
// СВОЙ ЖЕ только что созданный placeholder ложно засчитывался бы как
// "другое моё устройство уже разговаривало с этим контактом" (И4) на КАЖДОЙ
// первой отправке новому контакту, отправляя её в вечную очередь вместо
// установления чата. "queued" ничего не доказывает — сообщение ещё не
// покидало это устройство.
export async function hasAnyMessagesFor(ownerPubkey, contactPubkey) {
	return (
		(await db
			.table("messages")
			.where("[ownerPubkey+chatId]")
			.equals([ownerPubkey, contactPubkey])
			.filter((r) => r.status !== "queued")
			.count()) > 0
	);
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

// Этап 5 (MESSAGE-DELIVERY-TZ.md, З5.5) — наивысший lamportTs среди сообщений,
// реально пришедших ОТ contactPubkey в этом чате. lamportTs/senderPubkey —
// plaintext-поля (MESSAGES_PLAINTEXT_FIELDS) — читаем сырые строки без
// расшифровки, по прецеденту hasAnyMessagesFor выше.
async function lastReceivedLamportTs(ownerPubkey, contactPubkey) {
	const rows = await db
		.table("messages")
		.where("[ownerPubkey+chatId]")
		.equals([ownerPubkey, contactPubkey])
		.filter((r) => r.senderPubkey === contactPubkey)
		.toArray();
	if (rows.length === 0) return undefined;
	return Math.max(...rows.map((r) => r.lamportTs));
}

async function lastReadIncomingLamport(ownerPubkey, contactPubkey) {
	const sync = await db.table("chatSyncState").get([ownerPubkey, contactPubkey]);
	const lastRead = sync?.lastReadLamportTs ?? 0;
	if (!lastRead) return undefined;
	const rows = await db
		.table("messages")
		.where("[ownerPubkey+chatId]")
		.equals([ownerPubkey, contactPubkey])
		.filter((r) => r.senderPubkey === contactPubkey && r.lamportTs <= lastRead)
		.toArray();
	if (rows.length === 0) return undefined;
	return Math.max(...rows.map((r) => r.lamportTs));
}

async function getOutgoingReceipts(ownerPubkey, contactPubkey, dbKey) {
	const d = await lastReceivedLamportTs(ownerPubkey, contactPubkey);
	const settings = await loadUiSettings(ownerPubkey, dbKey);
	const r = settings.sendReadReceipts === false ? undefined : await lastReadIncomingLamport(ownerPubkey, contactPubkey);
	return { d, r };
}

function ensureCursorFlushBound(ownerPubkey, privKey, dbKey, contactPubkey, publish) {
	bindCursorFlush(ownerPubkey, contactPubkey, () => sendExplicitAck(ownerPubkey, privKey, dbKey, contactPubkey, publish));
}

// Этап 5 (З5.5) — та же выборка, но с sentAt (шифрованное поле — нужна
// расшифровка) отправителя, для sweepPendingAcks (нужен момент получения,
// не только lamportTs, чтобы решить "давно ли это было").
async function lastReceivedMessageMeta(ownerPubkey, dbKey, contactPubkey) {
	const rows = await db
		.table("messages")
		.where("[ownerPubkey+chatId]")
		.equals([ownerPubkey, contactPubkey])
		.filter((r) => r.senderPubkey === contactPubkey)
		.toArray();
	if (rows.length === 0) return undefined;
	const maxRow = rows.reduce((a, b) => (b.lamportTs > a.lamportTs ? b : a));
	const { sentAt } = fromEncryptedRow(maxRow, dbKey);
	return { lamportTs: maxRow.lamportTs, sentAt };
}

// Этап 5 (З5.5) — "собеседник уже узнал бы ackUpTo=lamportTs(receivedSentAt)
// через пиггибэк сам собой" — верно, если у нас есть ХОТЯ БЫ ОДНО собственное
// сообщение со статусом sent/read, отправленное ПОСЛЕ получения этого: его
// payload нёс бы ackUpTo >= этого lamportTs (prepareOutgoingMessage считает
// его заново при КАЖДОЙ отправке, см. выше) — отдельный ACK был бы избыточен.
async function alreadyAckedViaPiggyback(ownerPubkey, dbKey, contactPubkey, receivedSentAt) {
	if (typeof receivedSentAt !== "number") return false;
	const rows = await db
		.table("messages")
		.where("[ownerPubkey+chatId]")
		.equals([ownerPubkey, contactPubkey])
		.filter((r) => r.senderPubkey === ownerPubkey && (r.status === "sent" || r.status === "read"))
		.toArray();
	for (const raw of rows) {
		const { sentAt } = fromEncryptedRow(raw, dbKey);
		if (typeof sentAt === "number" && sentAt >= receivedSentAt) return true;
	}
	return false;
}

// Этап 5 (MESSAGE-DELIVERY-TZ.md, З5.5) — явный ACK ("дорого" из ТЗ): отдельный
// kind:445 без text/msgId, только { ackOnly: true, ackUpTo }. Продвигает MLS-
// ратчет как любое applicationMessage — вызывать РЕДКО (см. sweepPendingAcks),
// не на каждое взаимодействие. Best-effort, НЕ через outbox: если публикация
// не удалась сейчас, условие "давно не подтверждали" на следующем тике
// sweepPendingAcks всё ещё истинно — отдельный durable-путь не нужен.
export async function sendExplicitAck(ownerPubkey, privKey, dbKey, contactPubkey, publish) {
	const groupId = computeGroupId(ownerPubkey, contactPubkey);
	const groupIdHex = bytesToHex(groupId);
	const receipts = await getOutgoingReceipts(ownerPubkey, contactPubkey, dbKey);
	if (receipts.d === undefined) return;
	if (!cursorGrewSinceLastSend(ownerPubkey, contactPubkey, receipts.d, receipts.r)) return;
	if (rearmAfterMinInterval(ownerPubkey, contactPubkey)) return;

	const event = await withGroupLock(ownerPubkey, groupIdHex, async () => {
		const raw = await db.table("mlsGroups").get([ownerPubkey, groupIdHex]);
		if (!raw) return null; // чат не установлен — нечего подтверждать
		const row = fromEncryptedRow(raw, dbKey);
		const state = deserializeState(row.state);
		const payload = {
			ackOnly: true,
			ackUpTo: receipts.d,
			d: receipts.d,
			text: buildCursorText({ d: receipts.d, ...(receipts.r !== undefined ? { r: receipts.r } : {}) }),
		};
		if (receipts.r !== undefined) payload.r = receipts.r;
		const plaintextBytes = utf8ToBytes(JSON.stringify(payload));
		const { newSessionState, wireBytes } = await encryptApplicationMessage(state, plaintextBytes);
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
		const ephemeralPriv = generateSecretKey();
		return sign({ kind: 445, tags: [["h", groupIdHex]], content, created_at: Math.floor(Date.now() / 1000) }, ephemeralPriv);
	});
	if (!event) return;

	try {
		await requirePublishOk(publish, event);
		markCursorSent(ownerPubkey, contactPubkey, receipts.d, receipts.r);
		traceDelivery("ack.sent", { groupIdHex, ackUpTo: receipts.d });
	} catch (e) {
		traceDelivery("ack.publish.reject", { groupIdHex, ackUpTo: receipts.d, reason: String(e?.message ?? e) });
	}
}

const EXPLICIT_ACK_IDLE_MS = 5 * 60 * 1000; // ТЗ З5.5: "если от собеседника ничего не приходило дольше N минут"

// Этап 5 (З5.5) — периодический sweep (вызывающий код — transport.js, по
// прецеденту sweepBufferedGroupMessages, таймер ~30-60с): для каждого
// установленного чата этого owner проверяет "получено давно, ни разу не
// ответили — пиггибэк не мог доехать сам собой" и явно подтверждает такие.
export async function sweepPendingAcks(ownerPubkey, privKey, dbKey, publish) {
	const groups = await db.table("mlsGroups").where("ownerPubkey").equals(ownerPubkey).toArray();
	const now = Date.now();
	for (const raw of groups) {
		const { contactPubkey } = fromEncryptedRow(raw, dbKey);
		const lastReceived = await lastReceivedMessageMeta(ownerPubkey, dbKey, contactPubkey);
		if (!lastReceived || typeof lastReceived.sentAt !== "number") continue;
		if (now - lastReceived.sentAt * 1000 < EXPLICIT_ACK_IDLE_MS) continue;
		if (await alreadyAckedViaPiggyback(ownerPubkey, dbKey, contactPubkey, lastReceived.sentAt)) continue;
		try {
			await sendExplicitAck(ownerPubkey, privKey, dbKey, contactPubkey, publish);
		} catch (e) {
			console.warn("sweepPendingAcks: sendExplicitAck упал, попробуем на следующем тике", e);
		}
	}
}

// Этап 3 (MESSAGE-DELIVERY-TZ.md, З3.6) — "буфер не должен молча дропать":
// вызывается ТОЛЬКО из retryBufferedGroupMessages (transport.js) в момент
// окончательного (TTL истёк) отказа от буферной записи — та же точка, что уже
// вызывает recordGroupDecryptFailure (М6) рядом. Видимая, персистентная
// запись подтверждённой потери — не только console.warn.
export async function recordUndeliverableEvent(ownerPubkey, eventId, groupIdHex, reason, firstSeenAt, dbKey) {
	await db.table("undeliverable").put(
		toEncryptedRow({ ownerPubkey, eventId, groupIdHex, reason, firstSeenAt, droppedAt: Date.now() }, UNDELIVERABLE_PLAINTEXT_FIELDS, dbKey),
	);
}

export async function listUndeliverable(ownerPubkey, dbKey) {
	const rows = await db.table("undeliverable").where("ownerPubkey").equals(ownerPubkey).toArray();
	return rows.map((r) => fromEncryptedRow(r, dbKey)).sort((a, b) => b.droppedAt - a.droppedAt);
}

// Этап 5 (MESSAGE-DELIVERY-TZ.md, З5.7) — "поколение" разговора для пары
// (ownerPubkey, contactPubkey): переживает удаление mlsGroups-строки
// (recreateChatConversation стирает её), поэтому не может жить ВНУТРИ этой
// строки — отдельная маленькая таблица. Не шифруется (голый счётчик, не
// секрет — тот же прецедент, что knownContactDevices).
async function getChatGeneration(ownerPubkey, contactPubkey) {
	const row = await db.table("chatGeneration").get([ownerPubkey, contactPubkey]);
	return row?.generation ?? 0;
}

async function bumpChatGeneration(ownerPubkey, contactPubkey) {
	const next = (await getChatGeneration(ownerPubkey, contactPubkey)) + 1;
	await db.table("chatGeneration").put({ ownerPubkey, contactPubkey, generation: next });
	return next;
}

// Этап 5 (MESSAGE-DELIVERY-TZ.md, З5.7) — раньше эта функция ТОЛЬКО забывала
// локальное состояние и полагалась на то, что следующая исходящая отправка
// (ручная — от пользователя, когда бы она ни случилась) реактивирует И3/И4 —
// два независимых пробела: (1) "починка провода" ленивая, а не немедленная —
// собеседник ничего не узнаёт, пока владелец САМ не напишет что-то новое;
// (2) даже когда Welcome в итоге уходил, acceptWelcome видел "у меня уже есть
// группа с этим groupId" и молча его игнорировал — обе стороны навсегда
// расходятся в несовместимых MLS-состояниях под одним и тем же groupId
// (permanent divergence, ровно то, о чём предупреждает ТЗ: "кнопка
// «пересоздать» — способ окончательно разойтись").
//
// Теперь: генерация бьётся СРАЗУ (до удаления — переживает его), затем НОВАЯ
// группа создаётся и Welcome публикуется НЕМЕДЛЕННО (createGroupAndSendWelcome
// напрямую, в обход И3/И4 — см. комментарий у И4 в doEnsureChatEstablished),
// а не отложенно при следующей отправке. Новый Welcome несёт generation
// СТРОГО больше предыдущего — acceptWelcome (получающая сторона, тот же
// код, что обрабатывает и обычные первые Welcome) обязан распознать это как
// "замени мёртвую группу", а не как повторную доставку старого приглашения.
export async function recreateChatConversation(ownerPubkey, privKey, contactPubkey, dbKey, publish, fetchDeviceKeyPackages, refreshGroupMessageSubscription) {
	const groupId = computeGroupId(ownerPubkey, contactPubkey);
	const groupIdHex = bytesToHex(groupId);
	await bumpChatGeneration(ownerPubkey, contactPubkey);
	await db.table("mlsGroups").delete([ownerPubkey, groupIdHex]);
	await db.table("knownContactDevices").where("[ownerPubkey+contactPubkey]").equals([ownerPubkey, contactPubkey]).delete();
	await withGroupLock(ownerPubkey, groupIdHex, () =>
		createGroupAndSendWelcome(ownerPubkey, privKey, dbKey, contactPubkey, publish, fetchDeviceKeyPackages, groupId, groupIdHex),
	);
	// Этап 73.3, тот же принцип, что sendChatMessageAction (chats.js) после
	// ensureChatEstablished — набор groupId'ов, за которыми следит live-подписка,
	// только что изменился (новая группа под тем же groupIdHex, но она только
	// что создана заново — подписка могла быть настроена ДО этого момента).
	// Параметр НЕ импортируется напрямую (transport.js уже импортирует ИЗ
	// chat.js — обратный импорт был бы циклическим), передаётся вызывающим
	// UI-кодом, как и во всех остальных подобных местах этого файла.
	if (typeof refreshGroupMessageSubscription === "function") {
		await refreshGroupMessageSubscription(ownerPubkey, privKey, dbKey, publish);
	}
}
