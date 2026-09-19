// AUDIT-EGOROD J1. Одноразовая зачистка следов старого формата: события 30070
// (прочитано), 30071 (черновик), 30074 (прочитано в канале) и 30065 (группы
// видимости канала) раньше несли pubkey собеседника / id канала ОТКРЫТЫМ
// текстом в d-теге и остаются на relay навсегда (replaceable-события с другим d
// новым форматом не заменяются). Порядок важен: сначала публикуется текущее
// состояние под непрозрачными тегами, и только потом старые события удаляются
// (NIP-09, адресное удаление) — окна, в котором состояние есть только локально,
// нет. Любой сбой публикации — флаг не ставится, попытка повторится при
// следующем подключении; повтор идемпотентен.
import { db } from "../../core/store/database.js";
import { fromEncryptedRow } from "../../core/store/encrypted-table.js";
import { buildAddressableDeletionEvent } from "../events/handlers.js";
import { READ_STATUS_KIND, parseReadStatusEvent, buildReadStatusEvent } from "./read-status.js";
import { DRAFT_KIND, parseDraftEvent, buildDraftEvent } from "./drafts.js";
import { CHANNEL_READ_STATUS_KIND, parseChannelReadStatusEvent, buildChannelReadStatusEvent } from "../content/channel-read-status.js";
import { CHANNEL_VISIBILITY_SYNC_KIND, parseChannelVisibilitySyncEvent, publishChannelVisibilitySync } from "../content/channel-visibility.js";

const SCRUB_FLAG = "metadataScrubV1";

const PARSERS = {
	[READ_STATUS_KIND]: (e, k) => ({ id: parseReadStatusEvent(e, k).chatId, legacy: parseReadStatusEvent(e, k).legacy }),
	[DRAFT_KIND]: (e, k) => ({ id: parseDraftEvent(e, k).chatId, legacy: parseDraftEvent(e, k).legacy }),
	[CHANNEL_READ_STATUS_KIND]: (e, k) => ({ id: parseChannelReadStatusEvent(e, k).channelId, legacy: parseChannelReadStatusEvent(e, k).legacy }),
	// у 30065 признак старого формата — отсутствие channelId в шифртексте
	[CHANNEL_VISIBILITY_SYNC_KIND]: (e, k) => {
		const p = parseChannelVisibilitySyncEvent(e, k);
		return { id: p.channelId, legacy: p.legacy };
	},
};

async function publishOk(publish, event) {
	const result = await publish(event);
	return result?.ok === true;
}

// Возвращает { scrubbed: boolean, deleted: number }. Не бросает.
export async function scrubLegacyMetadata(ownerPubkey, privKey, dbKey, publish) {
	try {
		const record = await db.table("keystore").get(ownerPubkey);
		if (record?.[SCRUB_FLAG]) return { scrubbed: false, deleted: 0, skipped: true };

		// 1. Найти старые события в локальном журнале.
		const legacy = new Map(); // `${kind}\0${dTag}` -> { kind, dTag, id }
		const localRows = [];
		for (const kind of Object.keys(PARSERS).map(Number)) {
			const events = await db.table("events").where("[pubkey+kind]").equals([ownerPubkey, kind]).toArray();
			for (const ev of events) {
				let parsed;
				try {
					parsed = PARSERS[kind](ev, privKey);
				} catch {
					continue;
				}
				if (!parsed.legacy) continue;
				const dTag = ev.tags.find((t) => t[0] === "d")?.[1];
				if (!dTag) continue;
				legacy.set(`${kind}\0${dTag}`, { kind, dTag, id: parsed.id });
				localRows.push(ev.seq);
			}
		}
		if (legacy.size === 0) {
			await db.table("keystore").update(ownerPubkey, { [SCRUB_FLAG]: true });
			return { scrubbed: true, deleted: 0 };
		}

		// 2. Опубликовать текущее состояние под непрозрачными тегами.
		for (const { kind, id } of legacy.values()) {
			let event = null;
			if (kind === READ_STATUS_KIND) {
				const row = await db.table("chatSyncState").get([ownerPubkey, id]);
				if (row?.lastReadLamportTs > 0) event = buildReadStatusEvent(privKey, { chatId: id, lastReadLamportTs: row.lastReadLamportTs });
			} else if (kind === DRAFT_KIND) {
				const row = await db.table("chatSyncState").get([ownerPubkey, id]);
				const draftText = row ? fromEncryptedRow(row, dbKey).draftText : "";
				if (draftText) event = buildDraftEvent(privKey, { chatId: id, text: draftText });
			} else if (kind === CHANNEL_READ_STATUS_KIND) {
				const row = await db.table("channelSyncState").get([ownerPubkey, id]);
				if (row?.lastReadAt > 0) event = buildChannelReadStatusEvent(privKey, { channelId: id, lastReadAt: row.lastReadAt });
			} else if (kind === CHANNEL_VISIBILITY_SYNC_KIND) {
				await publishChannelVisibilitySync(ownerPubkey, privKey, dbKey, id, publish);
			}
			if (event && !(await publishOk(publish, event))) return { scrubbed: false, deleted: 0 };
		}

		// 3. Удалить старые события на relay.
		let deleted = 0;
		for (const { kind, dTag } of legacy.values()) {
			if (!(await publishOk(publish, buildAddressableDeletionEvent(privKey, kind, dTag)))) return { scrubbed: false, deleted };
			deleted++;
		}

		// 4. Убрать старые строки из локального журнала событий и поставить флаг.
		await db.table("events").bulkDelete(localRows);
		await db.table("keystore").update(ownerPubkey, { [SCRUB_FLAG]: true });
		return { scrubbed: true, deleted };
	} catch (e) {
		console.warn("scrubLegacyMetadata: не удалось, повтор при следующем подключении", e);
		return { scrubbed: false, deleted: 0 };
	}
}
