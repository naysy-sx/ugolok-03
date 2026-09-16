// Часть B (READ-STATUS-AND-LAST-SEEN-TZ.md) — производная «последняя активность».
// Никакого маячка: lastSeenAt = max(created_at) по событиям, авторство которых
// доказано контактом. chatActivity — свежесть переписки для сортировки сайдбара,
// сюда не смешиваем (профиль/443 не должны поднимать диалог в списке).

import { db } from "../../core/store/database.js";

export const LAST_SEEN_CLOCK_SKEW_SEC = 900;

export async function notePeerActivity(ownerPubkey, contactPubkey, createdAtSec, nowSec = Math.floor(Date.now() / 1000)) {
	if (!ownerPubkey || !contactPubkey || ownerPubkey === contactPubkey) return;
	if (typeof createdAtSec !== "number" || !Number.isFinite(createdAtSec)) return;
	if (createdAtSec > nowSec + LAST_SEEN_CLOCK_SKEW_SEC) return;
	const existing = await db.table("peerPresence").get([ownerPubkey, contactPubkey]);
	const lastSeenAt = Math.max(existing?.lastSeenAt ?? 0, createdAtSec);
	if (existing && lastSeenAt === existing.lastSeenAt) return;
	await db.table("peerPresence").put({ ownerPubkey, contactPubkey, lastSeenAt, updatedAt: nowSec });
}

export async function getPeerLastSeenAt(ownerPubkey, contactPubkey) {
	const row = await db.table("peerPresence").get([ownerPubkey, contactPubkey]);
	return row?.lastSeenAt;
}

export function clampLastSeenAt(lastSeenAt, nowSec = Math.floor(Date.now() / 1000)) {
	if (typeof lastSeenAt !== "number" || lastSeenAt <= 0) return null;
	return Math.min(lastSeenAt, nowSec);
}
