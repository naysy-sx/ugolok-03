const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_BATCH_WINDOW_MS = 200;

export function createPublisher(connection, options = {}) {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const batchWindowMs = options.batchWindowMs ?? DEFAULT_BATCH_WINDOW_MS;

  let queue = [];
  let timer = null;
  const pending = new Map(); // eventId -> {resolve, reject}

  // Найдено живой проверкой (Rooms, этап 3): close() соединения между publish()
  // и срабатыванием отложенного flush() (batchWindowMs) — connection.send()
  // бросает синхронно ("недоступен в состоянии disconnected"), а поскольку flush
  // вызывается ИЗ setTimeout-колбэка, это необработанное исключение роняло вкладку
  // целиком, а не просто эту публикацию. Ошибка теперь адресована ожидающему
  // publish()'у как reject (тот же контракт, что уже есть для OK:false от relay) —
  // остальные события батча всё равно пытаются уйти, одна неудача не блокирует другие.
  function flush() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    const batch = queue;
    queue = [];
    for (const event of batch) {
      try {
        connection.send(["EVENT", event]);
      } catch (err) {
        const p = pending.get(event.id);
        if (p) {
          pending.delete(event.id);
          p.reject(err);
        }
      }
    }
  }

  function scheduleFlush() {
    if (timer) return;
    timer = setTimeout(flush, batchWindowMs);
  }

  function publish(event) {
    return new Promise((resolve, reject) => {
      pending.set(event.id, { resolve, reject });
      queue.push(event);
      if (queue.length >= batchSize) {
        flush();
      } else {
        scheduleFlush();
      }
    });
  }

  function handleMessage(msg) {
    const [type, eventId, ok, reason] = msg;
    if (type !== "OK" || !pending.has(eventId)) return false;
    const { resolve } = pending.get(eventId);
    pending.delete(eventId);
    resolve({ ok, reason });
    return true;
  }

  return { publish, flush, handleMessage };
}
