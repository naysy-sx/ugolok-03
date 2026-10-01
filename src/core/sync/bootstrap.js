import { db } from "../store/database.js";
import { createSubscriber } from "../transport/subscriber.js";
import { withDeadline } from "../transport/deadline.js";
import { logWarn } from "../diag/boot-log.js";
import { mergeEvents } from "./g-set.js";
import { computeInitialLamportValue, persistLamportValue } from "./lamport.js";

export async function getSyncState(relayUrl) {
  const row = await db.table("syncState").get(relayUrl);
  return row?.lastSeen;
}

export async function setSyncState(relayUrl, lastSeen) {
  await db.table("syncState").put({ relay: relayUrl, lastSeen });
}

// Найдено живой проверкой (native/Android, чек-лист §6 ТЗ-NATIVE-APPS, Ворота
// Э4): EOSE от relay на этот REQ иногда не приходит вовсе — экран "Загрузка
// истории с сервера…" висел 20+ секунд без ответа, полностью блокируя вход
// (весь connect() в transport.js — контакты/permissions/settings — ждёт эту
// функцию). Тот же класс бага, что deadline.js уже закрыл для publisher.publish()/
// fetchDeviceKeyPackages (MESSAGE-DELIVERY-TZ.md, Этап 2, H2/H3) — здесь
// пропущен, потому что runBootstrap не переиспользует oneShotRequest (нужен
// incremental onBatch/mergeEvents, не просто накопление в массив). Таймаут —
// НЕ бросает наружу: партиальные addedCount (то, что успело прийти до среза)
// всё равно полезны и не должны обрушивать весь вход в аккаунт (та же логика,
// что outbox.drain() — один сбой не должен блокировать всё остальное).
const BOOTSTRAP_EOSE_TIMEOUT_MS = 20000;

// Скоуп этого этапа — TECH.md §12.2 шаги 1-4/10-11 только (одно соединение,
// не "все relay"; без расшифровки приватных kind/channel-key/allowlist —
// эти домены ещё не существуют). Обоснование сужения — DESIGN.md, этап 19.
export async function runBootstrap(connection, pubkey, options = {}) {
  const subId = options.subId ?? "bootstrap";
  let addedCount = 0;
  let subscriber;

  const inner = new Promise((resolve) => {
    subscriber = createSubscriber(connection, {
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

  try {
    await withDeadline(inner, options.timeoutMs ?? BOOTSTRAP_EOSE_TIMEOUT_MS);
  } catch {
    logWarn(`bootstrap: нет EOSE за ${options.timeoutMs ?? BOOTSTRAP_EOSE_TIMEOUT_MS}мс — продолжаю с ${addedCount} уже полученными событиями`);
  } finally {
    connection.removeMessageHandler?.(subscriber.handleMessage);
    try {
      subscriber.unsubscribe(subId);
    } catch {
      // соединение уже недоступно — нечего закрывать
    }
  }

  const lamportValue = await computeInitialLamportValue(pubkey);
  await persistLamportValue(pubkey, lamportValue);
  await setSyncState(connection.getUrl(), Math.floor(Date.now() / 1000));

  return { addedCount, lamportValue };
}
