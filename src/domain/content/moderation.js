import { db } from "../../core/store/database.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { sign } from "../../core/crypto/sign.js";
import { wrap as nip59Wrap } from "../../core/crypto/nip59.js";
import { generateChannelKey, encryptChannelContent, decryptChannelContent } from "../../core/crypto/channel-key.js";
import { buildAllowlistEvent } from "../../core/crypto/comment-allowlist.js";
import { deriveMasterSecret } from "../../core/crypto/derivation.js";
import { sendViewGrant } from "./channel-access.js";

// DESIGN.md, этап 33 — следующий свободный parameterized-replaceable kind после
// общего чата (30063). Контент шифруется channelKey[v_OLD] (не v_new!) — единственный
// способ, которым сам забаненный тоже прочитает объявление о собственном бане (у него
// уже нет v_new, но v_old ещё есть, как и у всех оставшихся — историчные эпохи не
// удаляются, § 4.7.3 TECH.md).
export const CHANNEL_BAN_KIND = 30064;

// DESIGN.md, этап 33 — по прямому прецеденту CHANNEL_SUBSCRIBE_REQUEST_KIND (3002):
// gift-wrap, приватно владельцу, тег reason различает явную жалобу от авто-репорта игнора.
export const CHANNEL_REPORT_KIND = 3003;

async function requirePublishOk(publish, event) {
	const result = await publish(event);
	if (!result.ok) {
		throw new Error(result.reason || "relay отклонил публикацию");
	}
}

export function buildReportRumor({ channelId, targetPubkey, contentType, contentId, contentText, reason }) {
	return {
		kind: CHANNEL_REPORT_KIND,
		content: contentText,
		tags: [
			["channel_id", channelId],
			["target", targetPubkey],
			["content_type", contentType],
			["content_id", contentId],
			["reason", reason],
		],
		created_at: Math.floor(Date.now() / 1000),
	};
}

export async function reportContent(reporterPrivKey, channelOwnerPubkey, params, publish) {
	const giftWrap = nip59Wrap(buildReportRumor(params), reporterPrivKey, channelOwnerPubkey);
	await requirePublishOk(publish, giftWrap);
}

// Конвенция диспетчера (transport.js, giftWrapSubscriber) — unwrap делает ТОЛЬКО
// transport.js, домен получает уже распакованные примитивы (тот же принцип, что
// CONTACT_REQUEST_KIND/CHANNEL_SUBSCRIBE_REQUEST_KIND). reporterPubkey — аутентичный
// отправитель из unwrap (rumor.pubkey), НЕ из тега (тег легко подделать, unwrap — нет).
export async function receiveReport(ownerPubkey, { reporterPubkey, channelId, targetPubkey, contentType, contentId, contentText, reason, createdAt }) {
	await db.table("channelReports").put({
		ownerPubkey,
		id: crypto.randomUUID(),
		channelId,
		reporterPubkey,
		targetPubkey,
		contentType,
		contentId,
		contentText,
		reason,
		viewed: false,
		createdAt,
	});
	return true;
}

// DESIGN.md, "Игнор" — чисто локальное, необратимое в этом этапе отношение (снять
// может только владелец в ТЗ, но это нереализуемо в модели без сетевого механизма —
// см. явное сужение скоупа). Идемпотентно (put по составному PK).
export async function ignoreMember(viewerPubkey, viewerPrivKey, channelOwnerPubkey, params, publish) {
	await db.table("channelIgnores").put({ ownerPubkey: viewerPubkey, channelId: params.channelId, ignoredPubkey: params.targetPubkey });
	await reportContent(viewerPrivKey, channelOwnerPubkey, { ...params, reason: "ignore" }, publish);
}

export async function getIgnoredSet(viewerPubkey, channelId) {
	const rows = await db.table("channelIgnores").where("[ownerPubkey+channelId]").equals([viewerPubkey, channelId]).toArray();
	return new Set(rows.map((r) => r.ignoredPubkey));
}

// DESIGN.md, "Этап 33", формализация 1 — шаги 1-6 буквально. Не бросает, если
// targetPubkey не был в readers/allowlist (VIEW-only без COMMENT — валидный бан-кейс,
// ротация и уведомление всё равно применяются).
export async function banMember(ownerPubkey, ownerPrivKey, channelId, targetPubkey, publish) {
	const channelRow = await db.table("channels").get([ownerPubkey, channelId]);
	if (!channelRow) throw new Error("канал не найден");
	const meta = await db.table("channelKeyMeta").get([ownerPubkey, channelId]);
	const oldKeyRow = await db.table("channelKeys").get([ownerPubkey, channelId, meta.currentVersion]);
	const vOld = meta.currentVersion;
	const vNew = vOld + 1;

	const newKeyHex = bytesToHex(generateChannelKey());
	await db.table("channelKeys").put({ ownerPubkey, channelId, keyVersion: vNew, channelKey: newKeyHex });
	await db.table("channelKeyMeta").update([ownerPubkey, channelId], { currentVersion: vNew });

	const readers = await db.table("channelReaders").where("[ownerPubkey+channelId]").equals([ownerPubkey, channelId]).toArray();
	const remaining = readers.filter((r) => r.readerPubkey !== targetPubkey);
	const newChannel = { channelId, channelTopic: channelRow.channelTopic, channelKey: newKeyHex };
	for (const r of remaining) {
		await sendViewGrant(ownerPubkey, ownerPrivKey, newChannel, r.readerPubkey, vNew, publish);
	}

	const oldAllowlistRow = await db.table("commentAllowlists").get([ownerPubkey, channelId, vOld]);
	if (oldAllowlistRow) {
		const newAuthors = oldAllowlistRow.allowedAuthors.filter((p) => p !== targetPubkey);
		const masterSecret = deriveMasterSecret(ownerPrivKey);
		const allowlistEvent = buildAllowlistEvent(channelId, channelRow.channelTopic, vNew, newAuthors, newKeyHex, ownerPrivKey, masterSecret);
		await requirePublishOk(publish, allowlistEvent);
		await db.table("commentAllowlists").put({ ownerPubkey, channelId, keyVersion: vNew, allowedAuthors: newAuthors });
	}

	const banContent = encryptChannelContent(JSON.stringify({ targetPubkey }), oldKeyRow.channelKey, vOld);
	const banEvent = sign(
		{
			kind: CHANNEL_BAN_KIND,
			content: banContent,
			tags: [
				["d", `${channelId}:ban:${targetPubkey}`],
				["h", channelRow.channelTopic],
			],
			created_at: Math.floor(Date.now() / 1000),
		},
		ownerPrivKey,
	);
	await requirePublishOk(publish, banEvent);

	await db.table("bannedMembers").put({ ownerPubkey, channelId, pubkey: targetPubkey, bannedAt: banEvent.created_at });
	await db.table("channelReaders").delete([ownerPubkey, channelId, targetPubkey]);
}

async function deleteChannelLocally(ownerPubkey, channelId) {
	await db.table("channels").delete([ownerPubkey, channelId]);
	await db.table("channelKeyMeta").delete([ownerPubkey, channelId]);
	await db.table("channelKeys").where("[ownerPubkey+channelId]").equals([ownerPubkey, channelId]).delete();
	await db.table("commentAllowlists").where("[ownerPubkey+channelId]").equals([ownerPubkey, channelId]).delete();
	await db.table("channelReaders").where("[ownerPubkey+channelId]").equals([ownerPubkey, channelId]).delete();
	await db.table("channelIgnores").where("[ownerPubkey+channelId]").equals([ownerPubkey, channelId]).delete();
	await db.table("bannedMembers").where("[ownerPubkey+channelId]").equals([ownerPubkey, channelId]).delete();
	await db.table("channelReports").where("[ownerPubkey+channelId]").equals([ownerPubkey, channelId]).delete();

	const posts = await db.table("posts").where("ownerPubkey").equals(ownerPubkey).toArray();
	await db.table("posts").bulkDelete(posts.filter((p) => p.channelId === channelId).map((p) => [ownerPubkey, p.id]));
	const comments = await db.table("comments").where("ownerPubkey").equals(ownerPubkey).toArray();
	await db.table("comments").bulkDelete(comments.filter((c) => c.channelId === channelId).map((c) => [ownerPubkey, c.id]));
	const messages = await db.table("channelMessages").where("ownerPubkey").equals(ownerPubkey).toArray();
	await db.table("channelMessages").bulkDelete(messages.filter((m) => m.channelId === channelId).map((m) => [ownerPubkey, m.id]));
}

// DESIGN.md, "Приём kind 30064" — шаги 1-5 буквально.
export async function receiveBanAnnouncement(ownerPubkey, event) {
	const hTag = event.tags.find((t) => t[0] === "h");
	if (!hTag) return false;
	const channelRow = await db
		.table("channels")
		.where("channelTopic")
		.equals(hTag[1])
		.and((r) => r.ownerPubkey === ownerPubkey)
		.first();
	if (!channelRow) return false;

	// Единственное место в этом этапе, где нужны ВСЕ исторические ключи (не только
	// current) — объявление шифруется v_old, который у текущих читателей уже НЕ current.
	const keyRows = await db.table("channelKeys").where("[ownerPubkey+channelId]").equals([ownerPubkey, channelRow.id]).toArray();
	const versionsMap = Object.fromEntries(keyRows.map((k) => [k.keyVersion, k.channelKey]));
	const plaintext = decryptChannelContent(event.content, versionsMap);
	if (plaintext === null) return false;

	if (event.pubkey !== channelRow.creatorPubkey) return false; // F-EV-07-класс: не владелец не может банить

	const { targetPubkey } = JSON.parse(plaintext);

	if (targetPubkey === ownerPubkey) {
		await deleteChannelLocally(ownerPubkey, channelRow.id);
		return true;
	}

	await db.table("bannedMembers").put({ ownerPubkey, channelId: channelRow.id, pubkey: targetPubkey, bannedAt: event.created_at });

	const comments = await db.table("comments").where("ownerPubkey").equals(ownerPubkey).toArray();
	for (const c of comments) {
		if (c.channelId === channelRow.id && c.authorPubkey === targetPubkey && !c.deleted) {
			await db.table("comments").update([ownerPubkey, c.id], { deleted: true });
		}
	}
	const messages = await db.table("channelMessages").where("ownerPubkey").equals(ownerPubkey).toArray();
	for (const m of messages) {
		if (m.channelId === channelRow.id && m.authorPubkey === targetPubkey && !m.deleted) {
			await db.table("channelMessages").update([ownerPubkey, m.id], { deleted: true });
		}
	}
	return true;
}

export async function listReports(ownerPubkey, channelId) {
	const rows = await db.table("channelReports").where("[ownerPubkey+channelId]").equals([ownerPubkey, channelId]).toArray();
	return rows.sort((a, b) => b.createdAt - a.createdAt);
}

export async function markReportViewed(ownerPubkey, reportId) {
	await db.table("channelReports").update([ownerPubkey, reportId], { viewed: true });
}

export async function markAllReportsViewed(ownerPubkey, channelId) {
	const rows = await db.table("channelReports").where("[ownerPubkey+channelId]").equals([ownerPubkey, channelId]).toArray();
	for (const r of rows) {
		if (!r.viewed) await db.table("channelReports").update([ownerPubkey, r.id], { viewed: true });
	}
}

// ТЗ: "статистика: общее количество отчётов, количество непросмотренных, топ-заигноренных
// пользователей". topIgnored считает РАЗНЫХ жалующихся (reporterPubkey) на каждого
// targetPubkey среди reason==="ignore" — повторный игнор тем же человеком не накручивает счётчик.
export async function getModerationStats(ownerPubkey, channelId) {
	const rows = await listReports(ownerPubkey, channelId);
	const total = rows.length;
	const unviewed = rows.filter((r) => !r.viewed).length;

	const reportersByTarget = new Map();
	for (const r of rows) {
		if (r.reason !== "ignore") continue;
		if (!reportersByTarget.has(r.targetPubkey)) reportersByTarget.set(r.targetPubkey, new Set());
		reportersByTarget.get(r.targetPubkey).add(r.reporterPubkey);
	}
	const topIgnored = [...reportersByTarget.entries()]
		.map(([pubkey, reporters]) => ({ pubkey, count: reporters.size }))
		.sort((a, b) => b.count - a.count)
		.slice(0, 5);

	return { total, unviewed, topIgnored };
}

export async function listBannedMembers(ownerPubkey, channelId) {
	const rows = await db.table("bannedMembers").where("[ownerPubkey+channelId]").equals([ownerPubkey, channelId]).toArray();
	return rows.map((r) => r.pubkey);
}
