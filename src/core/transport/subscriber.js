const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_BATCH_WINDOW_MS = 200;

export function createSubscriber(connection, options) {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const batchWindowMs = options.batchWindowMs ?? DEFAULT_BATCH_WINDOW_MS;
  const verifyBatch = options.verifyBatch;
  const onBatch = options.onBatch;
  const onEose = options.onEose;

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

  // Этап 74 — найдено живой проверкой (не домысел): flush() и её вызывающий код
  // (handleMessage/scheduleFlush ниже) НЕ awaits друг друга — новое событие,
  // прилетевшее ПОКА один flush() ещё внутри await verifyBatch/onBatch, планирует
  // СВОЙ независимый flush() (q.timer уже сброшен в начале текущего). Два вызова
  // onBatch того же subId могли выполняться конкурентно — потребители вроде
  // rebuildGroups (transport.js) делают "прочитать снимок -> пересчитать -> точно
  // записать", и "устаревший" вызов мог физически завершить запись ПОСЛЕ
  // "свежего", откатив состояние (живой баг: добавление участника в группу
  // терялось). Серилизуем per-subId, тот же приём, что withGroupLock's fallback
  // in-process mutex (mls-lock.js) — здесь без Web Locks: чисто внутрипроцессная
  // гонка внутри одной вкладки, межвкладочная гарантия не нужна.
  const flushChains = new Map(); // subId -> promise (хвост цепочки)

  function serializedPerSubId(subId, fn) {
    const previous = flushChains.get(subId) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    // Цепочка продолжается независимо от исхода — ошибка одного flush не должна
    // дедлочить очередь следующих (тот же принцип, что mls-lock.js).
    flushChains.set(
      subId,
      next.then(
        () => {},
        () => {},
      ),
    );
    return next;
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

    await serializedPerSubId(subId, async () => {
      const verified = await verifyBatch(batch);
      const validEvents = batch.filter((_, i) => verified[i]);
      if (validEvents.length > 0) {
        await onBatch(validEvents, subId);
      }
    });
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
      // onEose обязан сработать ПОСЛЕ того, как последний батч уже обработан
      // onBatch — иначе вызывающий код (bootstrap.js, этап 19) мог бы решить,
      // что данные готовы, пока последний батч ещё асинхронно летит.
      Promise.resolve(flush(subId)).then(() => onEose?.(subId));
      return true;
    }

    return false;
  }

  return { subscribe, unsubscribe, handleMessage };
}
