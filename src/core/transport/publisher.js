const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_BATCH_WINDOW_MS = 200;
// Этап 2 (MESSAGE-DELIVERY-TZ.md, З2.2) — H2 (MESSAGE-DELIVERY-AUDIT-BRIEFING.md,
// tests/harness/h2-publish-hang-repro.mjs): EVENT физически уходит на relay
// (WebSocket.send() не бросает — ровно то, что происходит на «зомби»-сокете,
// который ОС ещё не объявила мёртвым), а "OK" не приходит никогда — раньше
// promise висел бесконечно, никакого срока не было вообще. 8с — меньше
// CONNECT_TIMEOUT 15с, чтобы ретрай сигналинга успел внутри бюджета установки
// (QUICK-CONNECT-TZ / ревью 2026-09-19).
const DEFAULT_PUBLISH_TIMEOUT_MS = 8000;

// Не DomainError/i18n — publisher.js самый нижний слой транспорта (core/),
// причина классифицируется полем .code, читается вызывающим кодом/трассировкой
// (delivery-trace.js), не показывается пользователю напрямую нигде в проекте
// на сегодня (chat.js's doSendMessage ловит любой reject публикации одинаково —
// AC-09 outbox-путь, ему важен только факт неуспеха, не текст).
function publisherError(code, message) {
  const err = new Error(message);
  err.name = "PublisherError";
  err.code = code;
  return err;
}

export function createPublisher(connection, options = {}) {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const batchWindowMs = options.batchWindowMs ?? DEFAULT_BATCH_WINDOW_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_PUBLISH_TIMEOUT_MS;

  let queue = [];
  let timer = null;
  const pending = new Map(); // eventId -> {resolve, reject, deadline}

  function clearPending(eventId) {
    const p = pending.get(eventId);
    if (!p) return null;
    pending.delete(eventId);
    clearTimeout(p.deadline);
    return p;
  }

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
        const p = clearPending(event.id);
        if (p) p.reject(publisherError("disconnected", String(err?.message ?? err)));
      }
    }
  }

  function scheduleFlush() {
    if (timer) return;
    timer = setTimeout(flush, batchWindowMs);
  }

  function publish(event) {
    return new Promise((resolve, reject) => {
      // Этап 2 (З2.2) — срок на КАЖДЫЙ publish(), независимо от состояния
      // соединения в момент вызова: "connected" по мнению relay-pool.js не
      // значит "живой на TCP-уровне" (H2 — сокет технически ещё открыт,
      // "OK" просто никогда не придёт).
      const deadline = setTimeout(() => {
        pending.delete(event.id);
        reject(publisherError("timeout", `publisher: таймаут ожидания OK (${timeoutMs}мс), eventId=${event.id}`));
      }, timeoutMs);
      if (typeof deadline?.unref === "function") deadline.unref();
      pending.set(event.id, { resolve, reject, deadline });
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
    const p = clearPending(eventId);
    p.resolve({ ok, reason });
    return true;
  }

  // Этап 2 (З2.2) — вызывается снаружи (transport.js) при переходе соединения
  // в "disconnected": все ЕЩЁ НЕЗАВЕРШЁННЫЕ publish() отклоняются немедленно,
  // а не ждут собственные 15с — соединение уже точно мертво, ждать смысла нет
  // (тот же принцип DI, что onTrace/onStateChange в relay-pool.js — publisher.js
  // сам не подписывается на жизненный цикл соединения). Map гарантированно
  // очищается — утечек pending быть не должно (З2.2, последний пункт).
  function rejectAll(code = "disconnected", message = "relay-соединение потеряно") {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    queue = [];
    for (const [, p] of pending) {
      clearTimeout(p.deadline);
      p.reject(publisherError(code, message));
    }
    pending.clear();
  }

  return { publish, flush, handleMessage, rejectAll };
}
