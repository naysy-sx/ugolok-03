import { db } from "./database.js";
import { toEncryptedRow, fromEncryptedRow } from "./encrypted-table.js";
import { OUTBOX_PLAINTEXT_FIELDS } from "./table-fields.js";

// Этап 3 (MESSAGE-DELIVERY-TZ.md, З3.2) — раньше ОДНА неудача выводила
// запись из listPending НАВСЕГДА (markFailed ставила status:"failed" сразу
// на первый провал; tests/outbox.test.js фиксировал это КАК КОНТРАКТ, хотя
// ТЗ прямо называет его кодирующим баг). Теперь: неудача -> retryCount++,
// статус ОСТАЁТСЯ "pending" с экспоненциально растущим nextAttemptAt — до
// MAX_ATTEMPTS. Значения — буквально из ТЗ (backoff = 2000*1.8^n, потолок
// 5 минут, ±30% джиттер; MAX_ATTEMPTS=8 — "примерно сутки" накопленного
// времени ожидания между попытками).
export const MAX_ATTEMPTS = 8;
const BACKOFF_BASE_MS = 2000;
const BACKOFF_MULTIPLIER = 1.8;
const BACKOFF_MAX_MS = 300000;
const BACKOFF_JITTER = 0.3;

export function computeOutboxBackoff(retryCount) {
  const raw = Math.min(BACKOFF_BASE_MS * BACKOFF_MULTIPLIER ** retryCount, BACKOFF_MAX_MS);
  const spread = raw * BACKOFF_JITTER;
  return raw - spread + Math.random() * spread * 2;
}

// dbKey (этап 45, Tier 4) — event целиком уходит в шифр; eventId/status/retryCount/
// nextAttemptAt остаются plaintext (индексируемые/читаются partial-update'ами
// markSent/markFailed ниже — они НЕ трогают event, поэтому decrypt-merge-encrypt
// для них не нужен).
export async function enqueue(event, dbKey) {
  return db.outbox.add(toEncryptedRow({ eventId: event.id, event, status: "pending", retryCount: 0, nextAttemptAt: 0 }, OUTBOX_PLAINTEXT_FIELDS, dbKey));
}

// Этап 3 (З3.2) — фильтр по nextAttemptAt <= now: запись, ещё не "созревшая"
// для повторной попытки (backoff), не должна пытаться публиковаться на
// КАЖДЫЙ drain (каждое подключение/каждые 30с, см. transport.js) — иначе
// экспоненциальный backoff не имел бы смысла, drain бил бы по ней так же
// часто, как по свежим записям.
export async function listPending(dbKey) {
  const now = Date.now();
  const rows = await db.outbox.where("status").equals("pending").sortBy("seq");
  return rows.map((row) => fromEncryptedRow(row, dbKey)).filter((r) => (r.nextAttemptAt ?? 0) <= now);
}

export async function markSent(seq) {
  await db.outbox.update(seq, { status: "sent" });
}

// Возвращает { finalFailure, eventId } — finalFailure=true ТОЛЬКО когда
// MAX_ATTEMPTS исчерпан ЭТИМ провалом (вызывающий код, drainOutboxSafely,
// именно тогда переводит messages.status в "failed" и включает кнопку
// "повторить" — не на каждый отдельный провал, см. AUDIT-BRIEFING §4.6).
export async function markFailed(seq) {
  const record = await db.outbox.get(seq);
  if (!record) return { finalFailure: false };
  const retryCount = record.retryCount + 1;
  if (retryCount >= MAX_ATTEMPTS) {
    await db.outbox.update(seq, { status: "failed", retryCount });
    return { finalFailure: true, eventId: record.eventId };
  }
  await db.outbox.update(seq, { status: "pending", retryCount, nextAttemptAt: Date.now() + computeOutboxBackoff(retryCount) });
  return { finalFailure: false, eventId: record.eventId };
}

export async function drain(publishFn, dbKey) {
  let records = await listPending(dbKey);
  let sentCount = 0;
  let failedCount = 0; // ОКОНЧАТЕЛЬНЫЕ провалы (MAX_ATTEMPTS исчерпан) в этом проходе — не единичные неудачи
  const finallyFailedEventIds = [];

  for (let record of records) {
    // publishFn может бросить (сетевой сбой посреди batch), не только
    // вернуть {ok:false} — drain не должен останавливаться из-за одной
    // упавшей записи, иначе все записи ПОСЛЕ неё зависнут в pending навсегда.
    let ok = false;
    try {
      ok = (await publishFn(record)).ok;
    } catch {
      ok = false;
    }
    if (ok) {
      await markSent(record.seq);
      sentCount++;
    } else {
      const { finalFailure, eventId } = await markFailed(record.seq);
      if (finalFailure) {
        failedCount++;
        finallyFailedEventIds.push(eventId);
      }
    }
  }

  return { sentCount, failedCount, finallyFailedEventIds };
}
