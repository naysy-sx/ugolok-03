import { DomainError } from "../../domain/errors.js";
import { createSubscriber } from "./subscriber.js";

// Этап 2 (MESSAGE-DELIVERY-TZ.md, З2.1) — общий примитив: НИ ОДНО сетевое
// ожидание в проекте не должно висеть без срока (H2/H3, MESSAGE-DELIVERY-
// AUDIT-BRIEFING.md — publisher.publish() и fetchDeviceKeyPackages оба
// доказанно висели бесконечно без ответа relay, tests/harness/h2-publish-
// hang-repro.mjs и h3-keypackage-hang-repro.mjs). key — необязательный (без
// него errorMessage() в ui/signals/i18n.js покажет message как есть, тот же
// принцип, что остальные keyless DomainError в проекте) — задаётся только
// там, где ошибка реально всплывает в UI и нужен переведённый текст
// (fetchDeviceKeyPackages — "errors.keyPackageTimeout").
export function withDeadline(promise, ms, { onTimeout, key, message } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        onTimeout?.();
      } catch {
        // сбой колбэка очистки не должен маскировать сам факт таймаута
      }
      reject(new DomainError(message ?? `таймаут ожидания (${ms}мс)`, key));
    }, ms);
    // Node/тесты без .unref — таймер не должен держать процесс живым дольше,
    // чем нужно самому промису (тот же приём, что boot-log.js/call-trace.js).
    if (typeof timer?.unref === "function") timer.unref();
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

// Этап 2, З2.1/З2.3/З2.4 — единственная точка одноразового REQ→EVENT*→EOSE
// в проекте: срок ожидания EOSE + гарантированная очистка (removeMessageHandler
// + CLOSE) на ЛЮБОМ исходе (успех/таймаут/сбой send()), не только на EOSE —
// до этого этапа fetchDeviceKeyPackages/fetchProfiles/fetchInboxRelays/
// fetchOwnKeyPackageAnnounces/syncMirroredHistory/fetchDiscoveryProfiles
// оставляли обработчик в цепочке НАВСЕГДА (relay-pool.js не имел
// removeMessageHandler вовсе — гипотеза З2.4 подтвердилась чтением кода) и
// не имели срока (не наш домысел — доказано tests/harness/h3-keypackage-
// hang-repro.mjs на РЕАЛЬНОМ fetchDeviceKeyPackages).
//
// verifyBatch прокидывается КАК ЕСТЬ (crypto.worker подпись) — это не сырой
// REQ мимо проверки подписи, а тот же createSubscriber/verifyBatch путь,
// что был у всех шести функций раньше; только батчинг/добавление в массив
// теперь общие, а не скопированы шесть раз.
export function oneShotRequest(connection, filters, { timeoutMs = 10000, maxEvents = Infinity, verifyBatch, key, message } = {}) {
  const subId = "oneshot-" + Math.random().toString(36).slice(2);
  const collected = [];
  let subscriber;
  let cleaned = false;

  function cleanup() {
    if (cleaned) return;
    cleaned = true;
    if (subscriber) connection.removeMessageHandler?.(subscriber.handleMessage);
    try {
      subscriber?.unsubscribe(subId);
    } catch {
      // соединение уже недоступно — нечего закрывать
    }
  }

  const inner = new Promise((resolve, reject) => {
    subscriber = createSubscriber(connection, {
      verifyBatch,
      onBatch: (events) => {
        collected.push(...events);
        if (collected.length >= maxEvents) resolve(collected);
      },
      onEose: () => resolve(collected),
    });
    connection.addMessageHandler(subscriber.handleMessage);
    try {
      subscriber.subscribe(subId, filters);
    } catch (e) {
      reject(e);
    }
  });

  return withDeadline(inner, timeoutMs, { onTimeout: cleanup, key, message: message ?? `oneShotRequest: таймаут ожидания EOSE (${timeoutMs}мс)` }).then(
    (value) => {
      cleanup();
      return value;
    },
    (err) => {
      cleanup();
      throw err;
    },
  );
}
