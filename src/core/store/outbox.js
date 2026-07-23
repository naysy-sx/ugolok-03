import { db } from "./database.js";
import { toEncryptedRow, fromEncryptedRow } from "./encrypted-table.js";
import { OUTBOX_PLAINTEXT_FIELDS } from "./table-fields.js";

// dbKey (этап 45, Tier 4) — event целиком уходит в шифр; eventId/status/retryCount
// остаются plaintext (индексируемые, читаются partial-update'ами markSent/markFailed
// ниже — они НЕ трогают event, поэтому decrypt-merge-encrypt для них не нужен).
export async function enqueue(event, dbKey) {
  return db.outbox.add(toEncryptedRow({ eventId: event.id, event, status: "pending", retryCount: 0 }, OUTBOX_PLAINTEXT_FIELDS, dbKey));
}

export async function listPending(dbKey) {
  const rows = await db.outbox.where("status").equals("pending").sortBy("seq");
  return rows.map((row) => fromEncryptedRow(row, dbKey));
}

export async function markSent(seq) {
  await db.outbox.update(seq, { status: "sent" });
}

export async function markFailed(seq) {
  const record = await db.outbox.get(seq);
  if (record) {
    await db.outbox.update(seq, { status: "failed", retryCount: record.retryCount + 1 });
  }
}

export async function drain(publishFn, dbKey) {
  let records = await listPending(dbKey);
  let sentCount = 0;
  let failedCount = 0;

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
      await markFailed(record.seq);
      failedCount++;
    }
  }

  return { sentCount, failedCount };
}
