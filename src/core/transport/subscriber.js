const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_BATCH_WINDOW_MS = 200;

export function createSubscriber(connection, options) {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const batchWindowMs = options.batchWindowMs ?? DEFAULT_BATCH_WINDOW_MS;
  const verifyBatch = options.verifyBatch;
  const onBatch = options.onBatch;

  // per-subId состояние очереди — подписки не должны смешивать батчи
  const queues = new Map(); // subId -> { events: [], timer }

  function getQueue(subId) {
    let q = queues.get(subId);
    if (!q) {
      q = { events: [], timer: null };
      queues.set(subId, q);
    }
    return q;
  }

  async function flush(subId) {
    const q = queues.get(subId);
    if (!q || q.events.length === 0) return;
    if (q.timer) {
      clearTimeout(q.timer);
      q.timer = null;
    }
    const batch = q.events;
    q.events = [];

    const verified = await verifyBatch(batch);
    const validEvents = batch.filter((_, i) => verified[i]);
    if (validEvents.length > 0) {
      await onBatch(validEvents, subId);
    }
  }

  function scheduleFlush(subId) {
    const q = getQueue(subId);
    if (q.timer) return;
    q.timer = setTimeout(() => flush(subId), batchWindowMs);
  }

  function subscribe(subId, filters) {
    queues.set(subId, { events: [], timer: null });
    connection.send(["REQ", subId, ...filters]);
  }

  function unsubscribe(subId) {
    const q = queues.get(subId);
    if (q?.timer) clearTimeout(q.timer);
    queues.delete(subId);
    connection.send(["CLOSE", subId]);
  }

  function handleMessage(msg) {
    const [type, subId] = msg;

    if (type === "EVENT" && queues.has(subId)) {
      const [, , event] = msg;
      const q = getQueue(subId);
      q.events.push(event);
      if (q.events.length >= batchSize) {
        flush(subId);
      } else {
        scheduleFlush(subId);
      }
      return true;
    }

    if (type === "EOSE" && queues.has(subId)) {
      flush(subId);
      return true;
    }

    return false;
  }

  return { subscribe, unsubscribe, handleMessage };
}
