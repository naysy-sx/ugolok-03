import { db } from "./database.js";

export async function enqueue(eventId) {
  return db.outbox.add({ eventId, status: "pending", retryCount: 0 });
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
