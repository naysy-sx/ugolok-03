import { db } from "../../core/store/database.js";
import { sign } from "../../core/crypto/sign.js";
import { encryptChannelContent, decryptChannelContent } from "../../core/crypto/channel-key.js";
import { canAuthorComment } from "../../core/crypto/comment-allowlist.js";
import { toEncryptedRow, fromEncryptedRow } from "../../core/store/encrypted-table.js";
import { CHANNEL_MESSAGES_PLAINTEXT_FIELDS } from "../../core/store/table-fields.js";
import { ChannelContentNotReadyError } from "./channel-content-errors.js";
import { DomainError } from "../errors.js";

async function requirePublishOk(publish, event) {
	const result = await publish(event);
	if (!result.ok) {
		if (result.reason) throw new Error(result.reason);
		throw new DomainError("relay отклонил публикацию", "errors.relayRejected");
	}
}

// Общий чат канала — тот же контур, что comments.js (CONTRACTS.md, этап 32): право
// писать в чат = COMMENT-allowlist (PLAN.md буквально), отдельного allowlist для чата
// не заводим. kind 30063 (следующий свободный в 30060-30069, parameterized-replaceable,
// как посты/комментарии — сообщение не редактируется в этом этапе, d-tag просто уникален).
export async function sendChannelMessage(ownerPubkey, ownerPrivKey, dbKey, channelId, text, attachments, publish) {
	const channelRow = await db.table("channels").get([ownerPubkey, channelId]);
	if (!channelRow) throw new DomainError("канал не найден", "errors.channelNotFound");
	const meta = fromEncryptedRow(await db.table("channelKeyMeta").get([ownerPubkey, channelId]), dbKey);
	const keyRow = fromEncryptedRow(await db.table("channelKeys").get([ownerPubkey, channelId, meta.currentVersion]), dbKey);

	const messageId = crypto.randomUUID();
	const content = encryptChannelContent(JSON.stringify({ text, attachments }), keyRow.channelKey, meta.currentVersion);
	const event = sign(
		{
			kind: 30063,
			content,
			tags: [
				["d", `${channelId}:${messageId}`],
				["h", channelRow.channelTopic],
			],
			created_at: Math.floor(Date.now() / 1000),
		},
		ownerPrivKey,
	);
	await requirePublishOk(publish, event);

	await db.table("channelMessages").put(
		toEncryptedRow(
			{
				ownerPubkey,
				id: messageId,
				channelId,
				authorPubkey: ownerPubkey,
				text,
				attachments,
				keyVersion: meta.currentVersion,
				createdAt: event.created_at,
			},
			CHANNEL_MESSAGES_PLAINTEXT_FIELDS,
			dbKey,
		),
	);
	return { messageId };
}

// CONTRACTS.md, этап 32 — авторизация тем же путём, что receiveComment (F-EV-06,
// владелец имплицитно разрешён). Отличие: !channelRow.allowChatAttachments не отбрасывает
// сообщение целиком — обрезает вложение (UX/политика владельца, не auth-нарушение: у
// автора и так есть channelKey+COMMENT, вложение в обход настройки не даёт ему ничего
// нового, чего он не мог бы сделать иначе).
export async function receiveChannelMessage(ownerPubkey, dbKey, event) {
	const hTag = event.tags.find((t) => t[0] === "h");
	if (!hTag) return false;
	const channelRow = await db
		.table("channels")
		.where("channelTopic")
		.equals(hTag[1])
		.and((r) => r.ownerPubkey === ownerPubkey)
		.first();
	// Этап 74 — найдено живой проверкой (revoke/re-grant race, тот же класс, что
	// receiveChannelMetadata, channel.js): "неизвестный канал" может быть
	// транзитным (unview ещё не сменился повторным грантом) — throw делает
	// событие ретраебельным вместо permanent silent loss.
	if (!channelRow) throw new ChannelContentNotReadyError();

	// Этап 74 — найдено живой проверкой (CONTRACTS.md/DESIGN.md "Этап 74"): throw,
	// не silent no-op — тот же приём, что receiveChannelMetadata (М3-класс для каналов).
	const meta = fromEncryptedRow(await db.table("channelKeyMeta").get([ownerPubkey, channelRow.id]), dbKey);
	if (!meta) throw new ChannelContentNotReadyError();
	const keyRowRaw = await db.table("channelKeys").get([ownerPubkey, channelRow.id, meta.currentVersion]);
	if (!keyRowRaw) throw new ChannelContentNotReadyError();
	const keyRow = fromEncryptedRow(keyRowRaw, dbKey);

	const plaintext = decryptChannelContent(event.content, { [meta.currentVersion]: keyRow.channelKey });
	if (plaintext === null) throw new ChannelContentNotReadyError();

	if (event.pubkey !== channelRow.creatorPubkey) {
		const allowlistRow = fromEncryptedRow(await db.table("commentAllowlists").get([ownerPubkey, channelRow.id, meta.currentVersion]), dbKey);
		const verifiedAllowlist = allowlistRow ? { allowedAuthors: allowlistRow.allowedAuthors } : null;
		if (!canAuthorComment(event.pubkey, verifiedAllowlist)) return false;
	}

	const parsed = JSON.parse(plaintext);
	const dTag = event.tags.find((t) => t[0] === "d");
	if (!dTag) return false;
	const messageId = dTag[1].slice(dTag[1].indexOf(":") + 1);
	const attachments = channelRow.allowChatAttachments ? parsed.attachments : [];

	await db.table("channelMessages").put(
		toEncryptedRow(
			{
				ownerPubkey,
				id: messageId,
				channelId: channelRow.id,
				authorPubkey: event.pubkey,
				text: parsed.text,
				attachments,
				keyVersion: meta.currentVersion,
				createdAt: event.created_at,
			},
			CHANNEL_MESSAGES_PLAINTEXT_FIELDS,
			dbKey,
		),
	);
	return true;
}
