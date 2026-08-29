import { db } from "../../core/store/database.js";
import { wrap as nip59Wrap } from "../../core/crypto/nip59.js";
import { toEncryptedRow } from "../../core/store/encrypted-table.js";
import { DISCOVERY_REPORTS_PLAINTEXT_FIELDS } from "../../core/store/table-fields.js";
import { requirePublishOk } from "../messaging/chat.js";

// CONTRACTS.md §DISCOVERY, T9 — 1-в-1 копия паттерна content/moderation.js's
// CHANNEL_REPORT_KIND: gift-wrap, адресат — admin (не владелец канала, тут
// канала нет), reporterPubkey у приёмника — из rumor.pubkey (unwrap), не из
// тега (см. transport.js's giftWrapSubscriber). 3001-3009 заняты, 3010 —
// следующий свободный (проверено grep'ом по домену).
export const DISCOVERY_REPORT_KIND = 3010;

export function buildDiscoveryReportRumor({ targetPubkey, reason, snapshot }) {
	return {
		kind: DISCOVERY_REPORT_KIND,
		content: JSON.stringify(snapshot),
		tags: [
			["target", targetPubkey],
			["reason", reason],
		],
		created_at: Math.floor(Date.now() / 1000),
	};
}

export async function reportDiscoveryProfile(reporterPrivKey, adminPubkey, params, publish) {
	const giftWrap = nip59Wrap(buildDiscoveryReportRumor(params), reporterPrivKey, adminPubkey);
	await requirePublishOk(publish, giftWrap);
}

// Чисто локальная запись, БЕЗ сетевого параметра — работает независимо от
// того, ушла ли жалоба (ТЗ: "немедленно и навсегда, независимо от сети").
export async function hideDiscoveryProfileLocally(ownerPubkey, targetPubkey) {
	await db.table("discoveryHidden").put({ ownerPubkey, targetPubkey });
}

export async function listHiddenDiscoveryPubkeys(ownerPubkey) {
	const rows = await db.table("discoveryHidden").where("ownerPubkey").equals(ownerPubkey).toArray();
	return rows.map((r) => r.targetPubkey);
}

// Конвенция диспетчера (transport.js, giftWrapSubscriber) — unwrap делает
// ТОЛЬКО transport.js, домен получает уже распакованные примитивы (тот же
// принцип, что receiveReport в moderation.js).
export async function receiveDiscoveryReport(ownerPubkey, dbKey, { reporterPubkey, targetPubkey, reason, snapshot, createdAt }) {
	await db.table("discoveryReports").put(
		toEncryptedRow(
			{ ownerPubkey, id: crypto.randomUUID(), reporterPubkey, targetPubkey, reason, snapshot, createdAt },
			DISCOVERY_REPORTS_PLAINTEXT_FIELDS,
			dbKey,
		),
	);
}
