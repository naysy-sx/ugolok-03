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
import { OWN_KEY_PACKAGE_PLAINTEXT_FIELDS, MLS_GROUPS_PLAINTEXT_FIELDS, MESSAGES_PLAINTEXT_FIELDS } from "../../core/store/table-fields.js";

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

async function requirePublishOk(publish, event) {
	const result = await publish(event);
	if (!result.ok) {
		throw new Error(result.reason || "relay отклонил публикацию");
	}
}

// upsertMessage — идемпотентная вставка (DESIGN.md, этап 25, раздел 3): одно и то же
// логическое сообщение может прийти ДВУМЯ путями (живой MLS kind 445 и зеркало kind 446),
// в любом порядке, любое число раз. Дедупликация по unique-индексу [ownerPubkey+chatId+msgId]
// (db.version(4), owner-scoping — найдено реальным использованием, см. database.js) — НЕ по
// (chatId, lamportTs, senderPubkey): два РАЗНЫХ сообщения могут легитимно иметь одинаковый
// lamportTs при multi-device (найдено адверсарным прогоном уже принятого теста
// getChatHistory tiebreak-by-id). row обязан содержать ownerPubkey — вызывающий код.
export async function upsertMessage(row, dbKey) {
	try {
		await db.table("messages").add(toEncryptedRow(row, MESSAGES_PLAINTEXT_FIELDS, dbKey));
	} catch (e) {
		if (e.name !== "ConstraintError") throw e;
		// уже есть строка с тем же (chatId, msgId) — тихий no-op, не дубль
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
export async function ensureChatEstablished(ownerPubkey, privKey, dbKey, contactPubkey, publish, fetchKeyPackage) {
	const groupId = computeGroupId(ownerPubkey, contactPubkey);
	const groupIdHex = bytesToHex(groupId);

	const existing = await db.table("mlsGroups").get([ownerPubkey, groupIdHex]);
	if (existing) return;

	const theirWireBytes = await fetchKeyPackage(contactPubkey);

	// Свежий KeyPackage — для СОЗДАНИЯ именно этой группы, не переиспользует
	// опубликованный "приглашающий" ownKeyPackage (тот — для входящих Welcome от других).
	const deviceId = await getOrCreateDeviceId();
	const ownKeyPackage = await createOwnKeyPackage(ownerPubkey, deviceId);
	const state = await createGroup(ownerPubkey, ownKeyPackage, groupId);
	const { newSessionState, welcomeWireBytes } = await addMember(state, theirWireBytes);
	// commitWireBytes сознательно отброшен — некому его слать (DESIGN.md п.3.4):
	// у новой 2-местной группы нет других существующих участников кроме нового,
	// который узнаёт состояние из Welcome, не из коммита.

	// contactPubkey хранится РЯДОМ с состоянием (не отдельной таблицей-маппингом) —
	// нужен для обратного поиска "чьё это kind 445" по groupId из h-тега: groupId —
	// однонаправленный хэш (DESIGN.md п.2), pubkey из него не восстановить назад.
	// ownerPubkey — часть составного ключа (db.version(4), owner-scoping — см. database.js).
	// Этап 39 — contactPubkey/state теперь sensitive (шифруются dbKey), ownerPubkey/groupId
	// остаются plaintext (составной PK, нужен для .get([ownerPubkey, groupIdHex])).
	await db.table("mlsGroups").put(
		toEncryptedRow({ ownerPubkey, groupId: groupIdHex, contactPubkey, state: serializeState(newSessionState) }, MLS_GROUPS_PLAINTEXT_FIELDS, dbKey),
	);

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
}

// Этап 29 — правка контракта (skill п.12: только Claude, полная регрессия сразу
// после). attachment — необязательный 7-й параметр (undefined по умолчанию, старые
// вызовы без изменений). sentAt (wall-clock, секунды) генерируется ВСЕГДА — обе
// стороны видят ОДИНАКОВОЕ время отправки (не время получения); lamportTs (логические
// часы, порядок сортировки) не трогается — назначение разное, смешивать нельзя.
export async function sendMessage(ownerPubkey, privKey, dbKey, contactPubkey, text, lamportTs, publish, attachment) {
	const groupId = computeGroupId(ownerPubkey, contactPubkey);
	const groupIdHex = bytesToHex(groupId);
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
	const messagePayload = { text, lamportTs, msgId, sentAt };
	if (attachment !== undefined) messagePayload.attachment = attachment;
	const plaintextBytes = utf8ToBytes(JSON.stringify(messagePayload));
	const { newSessionState, wireBytes } = await encryptApplicationMessage(state, plaintextBytes);

	await db.table("mlsGroups").put(
		toEncryptedRow({ ownerPubkey, groupId: groupIdHex, contactPubkey: row.contactPubkey, state: serializeState(newSessionState) }, MLS_GROUPS_PLAINTEXT_FIELDS, dbKey),
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
		await enqueue(event);
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
			...(attachment !== undefined ? { attachment } : {}),
		}, dbKey);
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
		...(attachment !== undefined ? { attachment } : {}),
	}, dbKey);

	await mirrorBestEffort(
		privKey,
		publish,
		{ text, lamportTs, senderPubkey: ownerPubkey, contactPubkey, msgId, sentAt, ...(attachment !== undefined ? { attachment } : {}) },
		groupIdHex,
	);

	return { eventId: event.id };
}

// privKey/publish (правка контракта этапа 25, было (ownerPubkey, event)) — нужны для
// зеркала best-effort (DESIGN.md, "Этап 25", раздел 2): устройство, ПРИНЯВШЕЕ сообщение
// живым MLS-путём, обязано распространить его на ОСТАЛЬНЫЕ устройства той же identity,
// иначе они не MLS-участники именно этого сообщения и никогда его не увидят.
export async function receiveGroupMessageEvent(ownerPubkey, privKey, dbKey, event, publish) {
	const hTag = event.tags.find((t) => t[0] === "h");
	if (!hTag) return null;
	const groupIdHex = hTag[1];

	const raw = await db.table("mlsGroups").get([ownerPubkey, groupIdHex]);
	if (!raw) return null; // чужая/неизвестная группа — не наш разговор
	const row = fromEncryptedRow(raw, dbKey);
	const contactPubkey = row.contactPubkey;

	const state = deserializeState(row.state);
	const { privateKey, publicKey } = await deriveNostrEnvelopeKeys(state);
	const wireBytes = decodeBase64(nip44Decrypt(event.content, privateKey, bytesToHex(publicKey)));

	const result = await decryptApplicationMessage(state, wireBytes);
	await db.table("mlsGroups").put(
		toEncryptedRow({ ownerPubkey, groupId: groupIdHex, contactPubkey, state: serializeState(result.newSessionState) }, MLS_GROUPS_PLAINTEXT_FIELDS, dbKey),
	);

	if (result.kind === "control") return null;

	const parsed = JSON.parse(new TextDecoder().decode(result.message));
	// Этап 29 — sentAt/attachment ОТСУТСТВУЮТ у сообщений старого формата (до этого
	// этапа) — включаются в строку/результат, только если РЕАЛЬНО пришли в payload,
	// не как undefined-значения (иначе deepEqual-тесты на старый формат, devices.test.js,
	// увидели бы лишние ключи и сломались бы).
	const extra = {};
	if (parsed.sentAt !== undefined) extra.sentAt = parsed.sentAt;
	if (parsed.attachment !== undefined) extra.attachment = parsed.attachment;

	await upsertMessage({
		ownerPubkey,
		chatId: contactPubkey,
		lamportTs: parsed.lamportTs,
		senderPubkey: contactPubkey,
		id: event.id,
		text: parsed.text,
		status: "sent",
		msgId: parsed.msgId,
		...extra,
	}, dbKey);

	await mirrorBestEffort(
		privKey,
		publish,
		{ text: parsed.text, lamportTs: parsed.lamportTs, senderPubkey: contactPubkey, contactPubkey, msgId: parsed.msgId, ...extra },
		groupIdHex,
	);

	// contactPubkey — аддитивное поле (этап 34): нужно вызывающему коду (transport.js)
	// для уведомлений "новое сообщение от X", ничего не ломает (существующие вызовы
	// проверяют отдельные поля через assert.equal, не строгий deepEqual на весь объект).
	return { text: parsed.text, lamportTs: parsed.lamportTs, contactPubkey, ...extra };
}

export async function getChatHistory(ownerPubkey, contactPubkey, dbKey) {
	const raw = await db.table("messages").where("[ownerPubkey+chatId]").equals([ownerPubkey, contactPubkey]).toArray();
	const rows = raw.map((r) => fromEncryptedRow(r, dbKey));
	rows.sort((a, b) => {
		if (a.lamportTs !== b.lamportTs) return a.lamportTs - b.lamportTs;
		if (a.senderPubkey !== b.senderPubkey) return a.senderPubkey < b.senderPubkey ? -1 : 1;
		return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
	});
	return rows;
}
