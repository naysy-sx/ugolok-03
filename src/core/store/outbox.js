import { db } from "./database.js";

export async function enqueue(event) {
  return db.outbox.add({ eventId: event.id, event, status: "pending", retryCount: 0 });
}

export async function listPending() {
  return db.outbox.where("status").equals("pending").sortBy("seq");
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

export async function drain(publishFn) {
  let records = await listPending();
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
