import { createSubscriber } from "../transport/subscriber.js";
import { logWarn } from "../diag/boot-log.js";
import { mergeEvents } from "./g-set.js";
import { getSyncState, setSyncState } from "./bootstrap.js";

const CLOCK_SKEW_THRESHOLD_SECONDS = 30;

// Найдено живой проверкой (native/Android, чек-лист §6 ТЗ-NATIVE-APPS, Ворота
// Э4) — тот же класс бага, что уже закрыт в bootstrap.js's runBootstrap: EOSE
// на этот REQ тоже иногда не приходит, и т.к. onCaughtUp (который выставляет
// synced.value = true в transport.js) вызывается ТОЛЬКО из onEose — баннер
// "Подключение к серверу…"/SyncProgressBar (sync-progress-bar.jsx, держится
// на !synced.value) висел НАВСЕГДА, даже когда остальной connect() уже давно
// отработал и приложение полностью функционально. В отличие от bootstrap.js
// эта подписка НЕ одноразовая (живая, до stop()) — таймаут здесь не завершает
// подписку, только гарантирует, что onCaughtUp сработает хотя бы раз (best-effort,
// та же терпимость к частичному сбою, что у bootstrap.js/outbox.drain()).
const INCREMENTAL_SYNC_EOSE_TIMEOUT_MS = 20000;

// Скоуп этого этапа — TECH.md §12.5, только подпункты (a) validate→G-Set merge→
// store и обёртка syncState/clock-skew. Расшифровка приватных kind, rebuildCache
// permissions/contacts/groups, lamport.receive для открытых чатов, обновление
// channel allowlist — правка контракта на этапах 21/22/24/30 (см. DESIGN.md).
export async function startIncrementalSync(connection, pubkey, options = {}) {
  const subId = options.subId ?? "incremental-sync";
  const since = (await getSyncState(connection.getUrl())) ?? 0;
  let caughtUp = false;
  let timer;

  function markCaughtUp() {
    if (caughtUp) return;
    caughtUp = true;
    clearTimeout(timer);
    options.onCaughtUp?.();
  }

  const subscriber = createSubscriber(connection, {
    verifyBatch: options.verifyBatch,
    onBatch: async (events) => {
      for (const event of events) {
        const skew = Math.abs(Math.floor(Date.now() / 1000) - event.created_at);
        if (skew > CLOCK_SKEW_THRESHOLD_SECONDS) {
          options.onClockSkew?.(skew);
        }
      }

      const { addedIds } = await mergeEvents(events);
      await setSyncState(connection.getUrl(), Math.floor(Date.now() / 1000));
      // Этап 74 — найдено живой проверкой: без await onBatch резолвился ДО того,
      // как onEvent (transport.js — rebuildGroups и др.) реально дописывал Dexie.
      // Следующий flush() того же subId (см. subscriber.js — теперь тоже
      // сериализован per-subId) мог начать СВОЙ onEvent раньше, чем этот
      // завершится — два независимых rebuildGroups гонялись за одной и той же
      // строкой, "устаревший" мог записаться последним и откатить состояние.
      await options.onEvent?.(addedIds.length);
    },
    onEose: markCaughtUp,
  });

  connection.addMessageHandler(subscriber.handleMessage);
  subscriber.subscribe(subId, [{ authors: [pubkey], since }]);

  timer = setTimeout(() => {
    logWarn(`incremental-sync: нет EOSE за ${options.caughtUpTimeoutMs ?? INCREMENTAL_SYNC_EOSE_TIMEOUT_MS}мс — считаю синхронизацию догнанной`);
    markCaughtUp();
  }, options.caughtUpTimeoutMs ?? INCREMENTAL_SYNC_EOSE_TIMEOUT_MS);
  if (typeof timer?.unref === "function") timer.unref();

  return {
    stop: () => {
      clearTimeout(timer);
      subscriber.unsubscribe(subId);
    },
  };
}
