// ТЗ-03 — журнал загрузок: локальное хранение, пачки, публикация, догрузка.
//
// Принципы:
//  * запись в журнал НИКОГДА не ломает заливку (все входные функции глотают ошибки);
//  * без bindJournal() всё — no-op (домен и тесты не зависят от UI);
//  * журнал не участвует в стартовой синхронизации: пачки подписаны производным
//    ключом-автором (derivation.js) и читаются только pullJournal() — по требованию.
import { db } from "../../core/store/database.js";
import { toEncryptedRow, fromEncryptedRow } from "../../core/store/encrypted-table.js";
import { UPLOADS_PLAINTEXT_FIELDS, UPLOAD_BATCHES_PLAINTEXT_FIELDS } from "../../core/store/table-fields.js";
import { publishDurably } from "../../core/store/outbox.js";
import { makeAdd, makeTarget, makeDel, applyOp, foldOps, newGroupId } from "./records.js";
import { appendOps, devShort, buildBatchEvent, parseBatchEvent, journalPubkey, JOURNAL_KIND } from "./batches.js";

const FLUSH_DELAY_MS = 15_000;

let ctx = null;
let lock = Promise.resolve();
let flushTimer = null;

// ctx: { ownerPubkey, dbKey, journalKey, journalSigner, deviceId, publish, now?, flushDelayMs? }
export function bindJournal(c) {
	unbindJournal();
	ctx = {
		...c,
		dev: devShort(c.deviceId),
		journalPub: journalPubkey(c.journalSigner),
		now: c.now ?? (() => Date.now()),
	};
	// Если с прошлого сеанса остались неопубликованные пачки — отправить.
	withLock(async () => {
		const dirty = (await loadBatches()).some((b) => b.dirty && b.dev === ctx?.dev);
		if (dirty) scheduleFlush();
	}).catch(() => {});
}

export function unbindJournal() {
	if (flushTimer) clearTimeout(flushTimer);
	flushTimer = null;
	ctx = null;
}

export function isJournalBound() {
	return ctx !== null;
}

export function journalAuthor() {
	return ctx?.journalPub ?? null;
}

// Последовательное выполнение: несколько заливок одновременно не должны перетирать
// друг другу пачки.
function withLock(fn) {
	const run = lock.then(fn, fn);
	lock = run.then(
		() => undefined,
		() => undefined,
	);
	return run;
}

function batchToRow(b) {
	const { ops, ...rest } = b;
	return toEncryptedRow({ ownerPubkey: ctx.ownerPubkey, ...rest, ops }, UPLOAD_BATCHES_PLAINTEXT_FIELDS, ctx.dbKey);
}

function rowToBatch(row) {
	const { ownerPubkey: _o, ...b } = fromEncryptedRow(row, ctx.dbKey);
	return b;
}

async function loadBatches() {
	const rows = await db.table("uploadBatches").where("ownerPubkey").equals(ctx.ownerPubkey).toArray();
	return rows.map(rowToBatch);
}

async function saveBatches(list) {
	if (list.length === 0) return;
	await db.table("uploadBatches").bulkPut(list.map(batchToRow));
}

function uploadToRow(r) {
	return toEncryptedRow({ ownerPubkey: ctx.ownerPubkey, ...r }, UPLOADS_PLAINTEXT_FIELDS, ctx.dbKey);
}

function rowToUpload(row) {
	const { ownerPubkey: _o, nonce: _n, ciphertext: _c, ...r } = fromEncryptedRow(row, ctx.dbKey);
	return r;
}

// Полная пересборка материализованной таблицы из всех пачек.
async function rebuildUploads(batches) {
	const rows = foldOps(batches.flatMap((b) => b.ops));
	await db.transaction("rw", db.table("uploads"), async () => {
		await db.table("uploads").where("ownerPubkey").equals(ctx.ownerPubkey).delete();
		const out = [...rows.values()].map(uploadToRow);
		if (out.length) await db.table("uploads").bulkPut(out);
	});
}

// Инкрементально: применить операции к таблице uploads (локальные операции идут по
// возрастанию времени, семантика та же, что у свёртки).
async function applyToUploads(ops) {
	for (const op of ops) {
		const key = [ctx.ownerPubkey, op.hash];
		const existing = await db.table("uploads").get(key);
		const rows = new Map();
		if (existing) rows.set(op.hash, rowToUpload(existing));
		applyOp(rows, op);
		const next = rows.get(op.hash);
		if (next) await db.table("uploads").put(uploadToRow(next));
		else await db.table("uploads").delete(key);
	}
}

async function commitOps(ops) {
	if (ops.length === 0) return;
	const batches = await loadBatches();
	const before = new Map(batches.map((b) => [b.d, b]));
	const touched = appendOps(batches, ops, { dev: ctx.dev, now: ctx.now() });
	const changed = batches.filter((b) => touched.has(b.d) || !before.has(b.d));
	await saveBatches(changed);
	await applyToUploads(ops);
	scheduleFlush();
}

// --- входные функции (не бросают) -------------------------------------------------

// entries: [{hash,size,role,purpose,target,group,name,server,sourceDigest,at?}]
export async function recordUploads(entries) {
	if (!ctx) return;
	try {
		await withLock(async () => {
			const now = ctx.now();
			const ops = entries.map((e) => makeAdd({ ...e, at: e.at ?? now }, now)).filter(Boolean);
			await commitOps(ops);
		});
	} catch {
		// журнал — вспомогательная бухгалтерия, заливку он ломать не вправе
	}
}

// Удобная обёртка над recordUploads для результата putStream/putFileStreaming
// (`blobs`: [{role, hash, size}]). meta: {purpose, target, name, server, group?, roles?, sourceDigest?}.
// roles — переименование ролей (превью: {content:"preview", manifest:"previewManifest"}).
export async function recordBlobs(blobs, meta) {
	if (!ctx || !Array.isArray(blobs) || !meta?.purpose) return;
	const group = meta.group ?? newGroupId();
	await recordUploads(
		blobs.map((b) => ({
			hash: b.hash,
			size: b.size,
			role: meta.roles?.[b.role] ?? b.role,
			purpose: meta.purpose,
			target: meta.target,
			group,
			name: meta.name,
			server: meta.server,
			sourceDigest: meta.sourceDigest,
		})),
	);
	return group;
}

// Тот же блоб отправлен ещё куда-то: цель добавляется ВСЕЙ группе вложения
// (иначе счётчик «сколько мест использует файл» знал бы только про манифест).
export async function addTargetToGroupOf(hash, target) {
	if (!ctx || !target) return;
	try {
		await withLock(async () => {
			const row = await db.table("uploads").get([ctx.ownerPubkey, hash]);
			if (!row) return;
			const group = rowToUpload(row).group;
			const members = (await db.table("uploads").where("[ownerPubkey+group]").equals([ctx.ownerPubkey, group]).toArray()).map(rowToUpload);
			const now = ctx.now();
			const ops = members.filter((m) => !m.targets.includes(target)).map((m) => makeTarget(m.hash, target, now)).filter(Boolean);
			await commitOps(ops);
		});
	} catch {
		// см. recordUploads
	}
}

// Удаляет записи (после освобождения места на сервере). Единственный случай, когда
// ЗАКРЫТАЯ пачка переписывается: операции удалённых блобов вычищаются из своих
// пачек (иначе имена удалённых файлов вечно лежали бы на relay). Если операции
// живут в пачке другого устройства — переписать её нельзя без гонки, вместо этого в
// свою пачку кладётся надгробие.
export async function removeUploads(hashes) {
	if (!ctx || hashes.length === 0) return { ok: true };
	try {
		return await withLock(async () => {
			const set = new Set(hashes);
			const batches = await loadBatches();
			const now = ctx.now();
			const changed = [];
			const foreign = new Set();
			for (const b of batches) {
				const kept = b.ops.filter((o) => !set.has(o.hash));
				if (b.dev === ctx.dev) {
					if (kept.length !== b.ops.length) {
						b.ops = kept;
						b.dirty = true;
						b.updatedAt = now;
						changed.push(b);
					}
				} else {
					for (const o of b.ops) if (set.has(o.hash)) foreign.add(o.hash);
				}
			}
			await saveBatches(changed);
			const tombstones = [...foreign].map((h) => makeDel(h, now)).filter(Boolean);
			if (tombstones.length) {
				const all = await loadBatches();
				const touched = appendOps(all, tombstones, { dev: ctx.dev, now });
				await saveBatches(all.filter((b) => touched.has(b.d)));
			}
			await rebuildUploads(await loadBatches());
			scheduleFlush();
			return { ok: true };
		});
	} catch (e) {
		return { ok: false, error: e };
	}
}

// --- чтение ---------------------------------------------------------------------

export async function listUploads() {
	if (!ctx) return [];
	const rows = await db.table("uploads").where("ownerPubkey").equals(ctx.ownerPubkey).toArray();
	return rows.map(rowToUpload);
}

export async function findBySourceDigest(sourceDigest) {
	if (!ctx || !sourceDigest) return null;
	return (await listUploads()).find((r) => r.sourceDigest === sourceDigest) ?? null;
}

// Все записи группы вложения, к которой относится блоб (по любому из четырёх хешей).
export async function getGroupOfHash(hash) {
	if (!ctx || !hash) return null;
	const row = await db.table("uploads").get([ctx.ownerPubkey, hash]);
	if (!row) return null;
	const { group } = rowToUpload(row);
	const rows = (await db.table("uploads").where("[ownerPubkey+group]").equals([ctx.ownerPubkey, group]).toArray()).map(rowToUpload);
	return { group, rows };
}

export async function hasUpload(hash) {
	if (!ctx) return false;
	return (await db.table("uploads").get([ctx.ownerPubkey, hash])) !== undefined;
}

// --- публикация -----------------------------------------------------------------

export function scheduleFlush() {
	if (!ctx || flushTimer) return;
	const delay = ctx.flushDelayMs ?? FLUSH_DELAY_MS;
	const t = setTimeout(() => {
		flushTimer = null;
		flushJournal().catch(() => {});
	}, delay);
	if (typeof t?.unref === "function") t.unref();
	flushTimer = t;
}

// Публикует пачки СВОЕГО устройства с несохранёнными изменениями. Возвращает число
// опубликованных.
export async function flushJournal() {
	if (!ctx) return 0;
	const c = ctx;
	if (flushTimer) {
		clearTimeout(flushTimer);
		flushTimer = null;
	}
	return withLock(async () => {
		if (ctx !== c) return 0;
		const batches = await loadBatches();
		let sent = 0;
		let failed = 0;
		for (const b of batches) {
			if (b.dev !== c.dev || !b.dirty) continue;
			const createdAt = Math.max(Math.floor(c.now() / 1000), (b.remoteAt ?? 0) + 1);
			const event = buildBatchEvent(b, c.journalKey, c.journalSigner, createdAt);
			const result = await publishDurably(event, c.publish, c.dbKey);
			if (result?.ok) {
				b.dirty = false;
				b.remoteAt = createdAt;
				await saveBatches([b]);
				sent += 1;
			} else {
				failed += 1;
			}
		}
		// Нет сети / relay отказал: пачка осталась «грязной», повторяем позже сами —
		// иначе журнал уехал бы на relay только при следующей заливке.
		if (failed > 0 && ctx === c) {
			if (flushTimer) clearTimeout(flushTimer);
			const t = setTimeout(() => {
				flushTimer = null;
				flushJournal().catch(() => {});
			}, c.flushRetryMs ?? 60_000);
			if (typeof t?.unref === "function") t.unref();
			flushTimer = t;
		}
		return sent;
	});
}

// --- догрузка с relay (только по требованию) --------------------------------------

async function loadSync() {
	return (await db.table("uploadSync").get(ctx.ownerPubkey)) ?? { ownerPubkey: ctx.ownerPubkey, newest: 0, oldest: null, exhausted: false };
}

export async function getJournalSync() {
	if (!ctx) return null;
	return loadSync();
}

async function mergeRemote(events) {
	const batches = await loadBatches();
	const byD = new Map(batches.map((b) => [b.d, b]));
	const changed = [];
	let merged = 0;
	for (const ev of events) {
		const parsed = parseBatchEvent(ev, ctx.journalKey, ctx.journalPub);
		if (!parsed) continue;
		const local = byD.get(parsed.d);
		if (local) {
			if (local.dirty) continue; // свои неопубликованные правки новее
			if ((local.remoteAt ?? 0) >= parsed.createdAt) continue; // эту версию уже применяли
		}
		const b = { d: parsed.d, day: parsed.day, dev: parsed.dev, seq: parsed.seq, ops: parsed.ops, closed: parsed.closed, dirty: false, updatedAt: parsed.createdAt * 1000, remoteAt: parsed.createdAt };
		byD.set(b.d, b);
		changed.push(b);
		merged += 1;
	}
	if (changed.length) {
		await saveBatches(changed);
		await rebuildUploads([...byD.values()]);
	}
	return merged;
}

// fetchEvents(filter) -> Promise<event[]> — одноразовый запрос к relay (transport.js).
// Идёт от новых к старым постранично; уже дочитанное повторно не качает. Возвращает
// {exhausted, merged, pages}. Бросает при сетевой ошибке (то, что успели, сохранено).
export async function pullJournal({ fetchEvents, pageSize = 20, maxPages = 5, onProgress } = {}) {
	if (!ctx) return { exhausted: false, merged: 0, pages: 0 };
	const c = ctx;
	let merged = 0;
	let pages = 0;
	const sync = await loadSync();
	const base = { authors: [c.journalPub], kinds: [JOURNAL_KIND] };

	// 1. новое с прошлого раза (в т.ч. обновлённые чужие пачки)
	if (sync.newest) {
		const events = await fetchEvents({ ...base, since: sync.newest });
		merged += await withLock(() => mergeRemote(events));
		for (const e of events) sync.newest = Math.max(sync.newest, e.created_at);
		await db.table("uploadSync").put(sync);
		onProgress?.({ merged, exhausted: sync.exhausted, pages });
	}

	// 2. старое, постранично
	while (!sync.exhausted && pages < maxPages) {
		const filter = { ...base, limit: pageSize };
		if (sync.oldest) filter.until = sync.oldest - 1;
		const events = await fetchEvents(filter);
		pages += 1;
		merged += await withLock(() => mergeRemote(events));
		if (events.length === 0) {
			sync.exhausted = true;
		} else {
			for (const e of events) {
				sync.newest = Math.max(sync.newest, e.created_at);
				sync.oldest = sync.oldest ? Math.min(sync.oldest, e.created_at) : e.created_at;
			}
			if (events.length < pageSize) sync.exhausted = true;
		}
		await db.table("uploadSync").put(sync);
		onProgress?.({ merged, exhausted: sync.exhausted, pages });
	}
	return { exhausted: sync.exhausted, merged, pages };
}

export { newGroupId };
