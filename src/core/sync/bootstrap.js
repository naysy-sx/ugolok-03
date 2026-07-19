import { db } from "../store/database.js";
import { createSubscriber } from "../transport/subscriber.js";
import { mergeEvents } from "./g-set.js";
import { computeInitialLamportValue, persistLamportValue } from "./lamport.js";

export async function getSyncState(relayUrl) {
  const row = await db.table("syncState").get(relayUrl);
  return row?.lastSeen;
}

export async function setSyncState(relayUrl, lastSeen) {
  await db.table("syncState").put({ relay: relayUrl, lastSeen });
}

// Скоуп этого этапа — TECH.md §12.2 шаги 1-4/10-11 только (одно соединение,
// не "все relay"; без расшифровки приватных kind/channel-key/allowlist —
// эти домены ещё не существуют). Обоснование сужения — DESIGN.md, этап 19.
export async function runBootstrap(connection, pubkey, options = {}) {
  const subId = options.subId ?? "bootstrap";
  let addedCount = 0;

  await new Promise((resolve) => {
    const subscriber = createSubscriber(connection, {
      verifyBatch: options.verifyBatch,
      onBatch: async (events) => {
        const { addedIds } = await mergeEvents(events);
        addedCount += addedIds.length;
      },
      onEose: () => resolve(),
    });

    connection.addMessageHandler(subscriber.handleMessage);
    subscriber.subscribe(subId, [{ authors: [pubkey] }, { "#p": [pubkey], kinds: [30053] }]);
  });

  const lamportValue = await computeInitialLamportValue(pubkey);
  await persistLamportValue(pubkey, lamportValue);
  await setSyncState(connection.getUrl(), Math.floor(Date.now() / 1000));

  return { addedCount, lamportValue };
}
