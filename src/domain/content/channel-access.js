import { db } from "../../core/store/database.js";
import { sign } from "../../core/crypto/sign.js";
import { wrap as nip59Wrap } from "../../core/crypto/nip59.js";
import { encryptChannelKeyGrant } from "../../core/crypto/channel-key.js";
import { buildAllowlistEvent } from "../../core/crypto/comment-allowlist.js";
import { deriveMasterSecret, opaqueDTag } from "../../core/crypto/derivation.js";
import { toEncryptedRow, fromEncryptedRow } from "../../core/store/encrypted-table.js";
import { COMMENT_ALLOWLISTS_PLAINTEXT_FIELDS } from "../../core/store/table-fields.js";

// Новый rumor kind (gift-wrap, kind 1059) — по прямому прецеденту CONTACT_REQUEST_KIND
// (3001, contacts/requests.js): не публичный, владелец узнаёт запросившего через unwrap.
export const CHANNEL_SUBSCRIBE_REQUEST_KIND = 3002;

async function requirePublishOk(publish, event) {
	const result = await publish(event);
	if (!result.ok) {
		throw new Error(result.reason || "relay отклонил публикацию");
	}
}

export function buildSubscribeRequestRumor(channelId) {
	return { kind: CHANNEL_SUBSCRIBE_REQUEST_KIND, content: "", tags: [["channel_id", channelId]], created_at: Math.floor(Date.now() / 1000) };
}

export async function sendSubscribeRequest(requesterPrivKey, ownerPubkey, channelId, publish) {
	const giftWrap = nip59Wrap(buildSubscribeRequestRumor(channelId), requesterPrivKey, ownerPubkey);
	await requirePublishOk(publish, giftWrap);
}

// channel: {channelId, channelTopic (hex), channelKey (hex)}. F-CH-04 — kind 30053,
// тег #p для маршрутизации к конкретному читателю.
//
// НАЙДЕНО ЖИВЫМ E2E (этап 32, не домысел): исходная реализация (этап 30) публиковала
// kind 30053 БЕЗ d-тега вовсе — NIP-01 трактует отсутствующий d как d="" для
// parameterized-replaceable кинда (30000-39999). Раздача VIEW ВТОРОМУ читателю того
// же канала (тот же kind+pubkey+d="") заменяла на relay грант ПЕРВОГО читателя —
// он навсегда терял VIEW при следующей выборке по `#p`. TECH.md §4.8 буквально
// специфицирует d-tag = HMAC(masterSecret, "30053:" + channelId + readerPubkey +
// keyVersion) — контракт этапа 30 (CONTRACTS.md) этот d-tag просто не перенёс в
// реализацию, комментарий там ошибочно называл это "идемпотентностью" ("повторная
// публикация того же гранта безвредна"), не заметив, что РАЗНЫЕ читатели с ПУСТЫМ
// d-tag коллизируют друг с другом на relay, а не только сами с собой.
export async function sendViewGrant(ownerPubkey, ownerPrivKey, channel, readerPubkey, keyVersion, publish) {
	const content = encryptChannelKeyGrant(channel.channelId, channel.channelTopic, channel.channelKey, keyVersion, ownerPrivKey, readerPubkey);
	const masterSecret = deriveMasterSecret(ownerPrivKey);
	const dTag = opaqueDTag(masterSecret, 30053, `${channel.channelId}:${readerPubkey}:${keyVersion}`);
	const event = sign(
		{ kind: 30053, content, tags: [["d", dTag], ["p", readerPubkey]], created_at: Math.floor(Date.now() / 1000) },
		ownerPrivKey,
	);
	await requirePublishOk(publish, event);
}

// Владелец обрабатывает входящий запрос на подписку (VIEW уже есть у requesterPubkey —
// group-видимость была решением при создании канала; здесь только выдача COMMENT).
// F-CH-05: НЕ ротирует channelKey (та же версия) — только новый allowlist той же эпохи.
// Идемпотентно: requesterPubkey уже в списке -> no-op, не публикует лишний kind 30054.
export async function handleIncomingSubscribeRequest(ownerPubkey, ownerPrivKey, dbKey, channelId, requesterPubkey, publish) {
	const channelRow = await db.table("channels").get([ownerPubkey, channelId]);
	if (!channelRow) return; // не наш канал — defensive, не должно происходить в норме

	const meta = await db.table("channelKeyMeta").get([ownerPubkey, channelId]);
	const version = meta.currentVersion;
	const keyRow = fromEncryptedRow(await db.table("channelKeys").get([ownerPubkey, channelId, version]), dbKey);
	const allowlistRowRaw = await db.table("commentAllowlists").get([ownerPubkey, channelId, version]);
	const allowlistRow = fromEncryptedRow(allowlistRowRaw, dbKey);
	const currentAuthors = allowlistRow ? allowlistRow.allowedAuthors : [];
	if (currentAuthors.includes(requesterPubkey)) return;

	const newAuthors = [...currentAuthors, requesterPubkey];
	const masterSecret = deriveMasterSecret(ownerPrivKey);
	const event = buildAllowlistEvent(channelId, channelRow.channelTopic, version, newAuthors, keyRow.channelKey, ownerPrivKey, masterSecret);
	await requirePublishOk(publish, event);
	await db.table("commentAllowlists").put(
		toEncryptedRow({ ownerPubkey, channelId, keyVersion: version, allowedAuthors: newAuthors }, COMMENT_ALLOWLISTS_PLAINTEXT_FIELDS, dbKey),
	);
}
