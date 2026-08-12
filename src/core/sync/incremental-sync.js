import { createSubscriber } from "../transport/subscriber.js";
import { mergeEvents } from "./g-set.js";
import { getSyncState, setSyncState } from "./bootstrap.js";

const CLOCK_SKEW_THRESHOLD_SECONDS = 30;

// Скоуп этого этапа — TECH.md §12.5, только подпункты (a) validate→G-Set merge→
// store и обёртка syncState/clock-skew. Расшифровка приватных kind, rebuildCache
// permissions/contacts/groups, lamport.receive для открытых чатов, обновление
// channel allowlist — правка контракта на этапах 21/22/24/30 (см. DESIGN.md).
export async function startIncrementalSync(connection, pubkey, options = {}) {
  const subId = options.subId ?? "incremental-sync";
  const since = (await getSyncState(connection.getUrl())) ?? 0;

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
    onEose: () => {
      options.onCaughtUp?.();
    },
  });

  connection.addMessageHandler(subscriber.handleMessage);
  subscriber.subscribe(subId, [{ authors: [pubkey], since }]);

  return {
    stop: () => subscriber.unsubscribe(subId),
  };
}
