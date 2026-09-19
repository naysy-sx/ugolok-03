import { transition } from "../fsm/machine.js";
import { createPublisher } from "./publisher.js";
import { createAuthHandler } from "./relay-auth.js";

const TRANSITIONS = {
  disconnected: { CONNECT: "connecting" },
  connecting: { OPEN: "connected", TIMEOUT: "disconnected" },
  connected: {
    AUTH_CHALLENGE: "authenticating",
    SUBSCRIBE_OK: "subscribed",
  },
  authenticating: {
    AUTH_CHALLENGE: "authenticating",
    AUTH_OK: "connected",
    AUTH_FAIL: "connected",
    TIMEOUT: "connected",
  },
  subscribed: {
    AUTH_CHALLENGE: "authenticating",
    ERROR: "connected",
  },
  "*": {
    CLOSE: "disconnected",
    ERROR: "disconnected",
  },
};

// TZ-recovery-policy.md §5 — множитель 1.7 (был 2) и разброс ±30% (был 0.2):
// найдено в 10-LIVE-INCIDENT-2026-09-07.md §11.5 живьём — 11 циклов
// "подключение-отключение" за 14с, потому что onopen (даже для соединения,
// прожившего доли секунды) сбрасывал reconnectAttempt в 0 и следующая
// попытка снова стартовала с baseMs — экспонента фактически не росла ни
// разу. RECONNECT_STABLE_MS (§5) — сброс происходит ТОЛЬКО после того, как
// соединение продержалось успешным дольше этого времени.
const DEFAULT_BACKOFF = { baseMs: 1000, maxMs: 30000, multiplier: 1.7, jitter: 0.3 };
const RECONNECT_STABLE_MS = 5000;

export function computeBackoffDelay(attempt, config = DEFAULT_BACKOFF) {
  const raw = Math.min(config.baseMs * config.multiplier ** attempt, config.maxMs);
  if (!config.jitter) return raw;
  const spread = raw * config.jitter;
  return raw - spread + Math.random() * spread * 2;
}

export function createRelayConnection(url, options = {}) {
  const WebSocketImpl = options.WebSocketImpl ?? globalThis.WebSocket;
  const backoff = { ...DEFAULT_BACKOFF, ...options.backoff };
  const autoReconnect = options.autoReconnect ?? true;
  const onMessage = options.onMessage;
  const onStateChange = options.onStateChange;
  // TZ-diag-trace.md §2.5/§0.3 — необязательный, DI (не импорт трассировщика
  // сюда: relay-pool.js обслуживает и звонки, и весь остальной трафик
  // аккаунта, и не должен ничего знать про диагностический экран). Не меняет
  // ни backoff, ни порядок операций ниже — только добавляет запись рядом.
  const onTrace = options.onTrace;
  function trace(ev, payload) {
    if (!onTrace) return;
    try {
      onTrace(ev, { url, ...payload });
    } catch {
      // сбой трассировки не должен ронять транспорт
    }
  }

  let state = "disconnected";
  let ws = null;
  let intentionalClose = false;
  let reconnectAttempt = 0;
  let reconnectTimer = null;
  let stableTimer = null; // TZ-recovery-policy.md §5 — см. RECONNECT_STABLE_MS выше
  // NIP-42/strfry: REQ с gift-wrap (kind 1059 и др. restricted) до AUTH
  // закрывается CLOSED auth-required. Повторяем активные REQ после AUTH_OK.
  const activeReqs = new Map();
  // TZ-recovery-policy.md §5 — "после восстановления подписки возобновлять
  // от метки времени последнего полученного события, а не с начала". Ключ —
  // subId (тот же, что activeReqs), значение — created_at последнего EVENT,
  // виденного по этой подписке НА ЭТОМ соединении.
  const lastEventCreatedAtBySubId = new Map();
  // Этап 3 (MESSAGE-DELIVERY-TZ.md, З3.5) — водяной знак ОБРАБОТКИ, отдельно
  // от водяного знака "видел" выше. lastEventCreatedAtBySubId растёт на КАЖДЫЙ
  // EVENT независимо от исхода (нужен по историческим причинам — TZ-recovery-
  // policy.md §5 — как безопасный дефолт "не пересылать уже виденное" для
  // подписчиков, которым конкретно ЭТА гарантия не нужна). Для подписок,
  // которым важно "не потерять необработанное" (kind:445 — 445 может прийти,
  // провалиться на no-group/decrypt fail и уйти в буфер, см. transport.js) —
  // reportProcessed() ниже даёt МЕНЬШИЙ, безопасный водяной знак, который
  // withResumedSince предпочитает, если он есть для этого subId.
  const processedWatermarkBySubId = new Map();
  let lastDisconnectAtMs = null;

  const messageHandlers = [];

  function addMessageHandler(handler) {
    messageHandlers.push(handler);
  }

  // Этап 2 (MESSAGE-DELIVERY-TZ.md, З2.4) — подтверждённая гипотеза: метода
  // не было вовсе. Одноразовые запросы (oneShotRequest, core/transport/
  // deadline.js) регистрируют обработчик на каждый вызов и без этого метода
  // не могли его снять — навсегда оставался в цепочке до конца сессии
  // (дёшево по CPU на сообщение, но растёт без ограничения за долгую сессию).
  function removeMessageHandler(handler) {
    const idx = messageHandlers.indexOf(handler);
    if (idx !== -1) messageHandlers.splice(idx, 1);
  }

  function setState(next) {
    const prev = state;
    state = next;
    if (prev !== next) onStateChange?.(next, prev);
  }

  function apply(event) {
    setState(transition(TRANSITIONS, state, event));
  }

  function scheduleReconnect() {
    if (!autoReconnect || intentionalClose) return;
    const delay = computeBackoffDelay(reconnectAttempt, backoff);
    reconnectAttempt += 1;
    trace("reconnect-scheduled", { attempt: reconnectAttempt, delayMs: Math.round(delay) });
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function connect() {
    intentionalClose = false;
    trace("connect-attempt", {});
    apply("CONNECT");
    ws = new WebSocketImpl(url);
    ws.onopen = () => {
      trace("open", {});
      // TZ-recovery-policy.md §5 — НЕ сбрасываем reconnectAttempt сразу здесь
      // (это и была причина 11 циклов за 14с в 10-LIVE-INCIDENT §11.5: onopen
      // срабатывал даже для соединения, прожившего доли секунды, экспонента
      // ни разу не успевала вырасти). Сброс — только после RECONNECT_STABLE_MS
      // непрерывной жизни; onclose ниже эту отложенную задачу отменяет.
      stableTimer = setTimeout(() => {
        stableTimer = null;
        reconnectAttempt = 0;
      }, RECONNECT_STABLE_MS);
      // Node (тесты, которые не доводят соединение до close()) — не держать
      // процесс живым диагностическим/бухгалтерским таймером; в браузере
      // setTimeout возвращает число без .unref, ветка просто не выполняется
      // (тот же приём, что уже применён в src/core/diag/call-trace.js).
      if (typeof stableTimer?.unref === "function") stableTimer.unref();
      // Снимок ДО apply("OPEN"): сам переход синхронно уведомляет подписчика
      // (onStateChange -> send(REQ)), и он уже кладёт новый REQ в activeReqs.
      // Реплеим только то, что было активно ДО этого коннекта (переподключение
      // после обрыва/AUTH), иначе только что отправленный REQ уходит дважды.
      const reqsBeforeOpen = new Map(activeReqs);
      apply("OPEN");
      replayActiveReqs(reqsBeforeOpen);
      if (onTrace && reqsBeforeOpen.size > 0) trace("resubscribe", { subIds: [...reqsBeforeOpen.keys()] });
    };
    ws.onclose = (evt) => {
      lastDisconnectAtMs = Date.now();
      trace("close", { code: evt?.code, reason: evt?.reason });
      if (stableTimer) {
        clearTimeout(stableTimer);
        stableTimer = null;
      }
      apply("CLOSE");
      scheduleReconnect();
    };
    ws.onerror = (evt) => {
      trace("error", { message: evt?.message });
      apply("ERROR");
    };
    ws.onmessage = (evt) => {
      let msg;
      try {
        msg = JSON.parse(evt.data);
      } catch {
        return;
      }
      // TZ-recovery-policy.md §5 — запоминаем created_at последнего EVENT по
      // каждой подписке, ДО раздачи обработчикам: нужно только для
      // replayActiveReqs() после следующего реконнекта этого же соединения.
      if (msg[0] === "EVENT" && typeof msg[2]?.created_at === "number") {
        const prev = lastEventCreatedAtBySubId.get(msg[1]);
        if (prev === undefined || msg[2].created_at > prev) lastEventCreatedAtBySubId.set(msg[1], msg[2].created_at);
      }
      onMessage?.(msg);
      for (const handler of messageHandlers) {
        if (handler(msg)) break;
      }
    };
  }

  function send(msgArray) {
    if (state !== "connected" && state !== "subscribed" && state !== "authenticating") {
      throw new Error(`relay-pool: send() недоступен в состоянии "${state}"`);
    }
    if (msgArray[0] === "REQ") activeReqs.set(msgArray[1], msgArray);
    else if (msgArray[0] === "CLOSE") activeReqs.delete(msgArray[1]);
    ws.send(JSON.stringify(msgArray));
  }

  // TZ-recovery-policy.md §5 — возобновлять от метки последнего события.
  // since включительно (не lastSeen+1): offer и первые ICE часто уходят в
  // ту же секунду, +1 терял бы пачку. Повтор безвреден (restart-флаг, ICE).
  function withResumedSince(req) {
    const subId = req[1];
    // Этап 3 (З3.5) — предпочитаем явно подтверждённый водяной знак ОБРАБОТКИ
    // (reportProcessed), если вызывающий код его вообще репортит для этого
    // subId; иначе — прежнее поведение (водяной знак "видел", без изменений
    // для всех подписчиков, которые reportProcessed не зовут).
    const lastSeen = processedWatermarkBySubId.get(subId) ?? lastEventCreatedAtBySubId.get(subId);
    let resumeSince;
    if (lastSeen !== undefined) {
      resumeSince = lastSeen;
    } else if (lastDisconnectAtMs !== null) {
      resumeSince = Math.floor((lastDisconnectAtMs - 10000) / 1000);
    } else {
      return req;
    }
    const [type, id, ...filters] = req;
    const patchedFilters = filters.map((f) => (typeof f?.since === "number" && f.since >= resumeSince ? f : { ...f, since: resumeSince }));
    return [type, id, ...patchedFilters];
  }

  function replayActiveReqs(snapshot = activeReqs) {
    for (const req of snapshot.values()) {
      ws.send(JSON.stringify(withResumedSince(req)));
    }
  }

  // Этап 3 (З3.5) — вызывающий код (transport.js) репортит created_at
  // события, которое он ДЕЙСТВИТЕЛЬНО обработал (успех, дедуп по
  // processedGroupEvents — не "прочитал из сокета"). Монотонно: меньший/
  // равный уже известному watermark'у не откатывает его назад (defensive —
  // redelivery/переупорядоченный батч не должен двигать знак в прошлое).
  function reportProcessed(subId, createdAt) {
    if (typeof createdAt !== "number") return;
    const prev = processedWatermarkBySubId.get(subId);
    if (prev === undefined || createdAt > prev) processedWatermarkBySubId.set(subId, createdAt);
  }

  function close() {
    intentionalClose = true;
    activeReqs.clear();
    lastEventCreatedAtBySubId.clear();
    processedWatermarkBySubId.clear();
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (stableTimer) {
      clearTimeout(stableTimer);
      stableTimer = null;
    }
    ws?.close();
  }

  const api = {
    getState: () => state,
    getUrl: () => url,
    addMessageHandler,
    removeMessageHandler,
    connect,
    send,
    reportProcessed,
    reportAuthChallenge: () => apply("AUTH_CHALLENGE"),
    reportAuthOk: () => {
      apply("AUTH_OK");
      replayActiveReqs();
    },
    // Этап 2 (З2.5) — раньше AUTH_FAIL переводил в "connected" БЕЗ повтора
    // активных подписок: REQ, закрытый relay'ем как auth-required ДО AUTH,
    // так и оставался закрытым навсегда — ensureChatEstablished/fetchProfiles
    // и т.п. висели бы до собственного таймаута (oneShotRequest), не получив
    // ни одного EVENT. AUTH_OK уже реплеил — тот же приём здесь, независимо
    // от исхода AUTH: реле, скорее всего, всё равно готово обслуживать
    // НЕ-restricted подписки, отказ AUTH не должен молчаливо хоронить их все.
    reportAuthFail: () => {
      apply("AUTH_FAIL");
      replayActiveReqs();
      trace("auth-fail-replay", {});
    },
    reportAuthTimeout: () => apply("TIMEOUT"),
    reportSubscribed: () => apply("SUBSCRIBE_OK"),
    close,
  };
  if (options.privKey) {
    addMessageHandler(createAuthHandler(api, url, options.privKey));
  }
  return api;
}

// createRelayPool — DESIGN.md, раздел "Этап 58". Реализует РОВНО ТОТ ЖЕ
// интерфейс, что createRelayConnection (getState/getUrl/addMessageHandler/
// connect/send/close) — publisher.js/subscriber.js и весь signals/transport.js
// не отличают пул от одного соединения (инвариант "fake-connection", см.
// DESIGN.md). entries[i] и connections[i] — параллельные массивы, индекс
// связывает роль (read/write) с конкретным createRelayConnection.
const STATE_RANK = ["disconnected", "connecting", "authenticating", "connected", "subscribed"];

export function createRelayPool(entries, options = {}) {
  if (entries.length === 0) {
    throw new Error("relay-pool: createRelayPool требует непустой список entries");
  }

  const WebSocketImpl = options.WebSocketImpl ?? globalThis.WebSocket;
  const backoff = { ...DEFAULT_BACKOFF, ...options.backoff };
  const autoReconnect = options.autoReconnect ?? true;
  const onStateChange = options.onStateChange;

  // Инвариант П1 (DESIGN.md) — состояние пула ВСЕГДА пересчитывается заново
  // как max по STATE_RANK среди ЖИВЫХ состояний членов, не защёлкивается.
  function aggregateState() {
    let best = "disconnected";
    for (const connection of connections) {
      if (STATE_RANK.indexOf(connection.getState()) > STATE_RANK.indexOf(best)) {
        best = connection.getState();
      }
    }
    return best;
  }

  let lastReportedState = "disconnected";
  function handleMemberStateChange() {
    const next = aggregateState();
    if (next !== lastReportedState) {
      const prev = lastReportedState;
      lastReportedState = next;
      onStateChange?.(next, prev);
    }
  }

  const connections = entries.map((entry) =>
    createRelayConnection(entry.url, {
      WebSocketImpl,
      backoff,
      autoReconnect,
      privKey: options.privKey,
      onStateChange: handleMemberStateChange,
      onTrace: options.onTrace,
    }),
  );

  // Инвариант П3/П4 (DESIGN.md) — дедуп EVENT по (subId,id), EOSE "первый —
  // финальный". Общее для ВСЕХ зарегистрированных через addMessageHandler
  // обработчиков пула (не per-registration — иначе вторая регистрация видела
  // бы событие как "уже поглощённое" первой, ломая first-match-wins).
  const seenEventIds = new Map(); // subId -> Set<eventId>
  const seenEose = new Set(); // subId, для которых EOSE уже проброшен наверх

  const poolHandlers = [];
  function addMessageHandler(handler) {
    poolHandlers.push(handler);
  }

  // Этап 2 (З2.4) — симметрично addMessageHandler, тот же приём, что
  // createRelayConnection выше. publisher.js/subscriber.js/oneShotRequest не
  // отличают пул от одного соединения (инвариант "fake-connection", DESIGN.md).
  function removeMessageHandler(handler) {
    const idx = poolHandlers.indexOf(handler);
    if (idx !== -1) poolHandlers.splice(idx, 1);
  }

  function dispatchToPoolHandlers(msg) {
    for (const handler of poolHandlers) {
      if (handler(msg)) break;
    }
  }

  function onMemberMessage(msg) {
    const type = msg[0];
    if (type === "EVENT") {
      const subId = msg[1];
      const event = msg[2];
      let seen = seenEventIds.get(subId);
      if (!seen) {
        seen = new Set();
        seenEventIds.set(subId, seen);
      }
      if (seen.has(event.id)) return true; // поглощено — не давать остальным обработчикам ЭТОГО соединения увидеть тоже
      seen.add(event.id);
      dispatchToPoolHandlers(msg);
      return true;
    }
    if (type === "EOSE") {
      const subId = msg[1];
      if (seenEose.has(subId)) return true;
      seenEose.add(subId);
      dispatchToPoolHandlers(msg);
      return true;
    }
    dispatchToPoolHandlers(msg);
    return true;
  }

  for (const connection of connections) {
    connection.addMessageHandler(onMemberMessage);
  }

  function send(msgArray) {
    const role = msgArray[0] === "REQ" || msgArray[0] === "CLOSE" ? "read" : "write";
    let sentToAny = false;
    for (let i = 0; i < entries.length; i++) {
      if (!entries[i][role]) continue;
      try {
        connections[i].send(msgArray);
        sentToAny = true;
      } catch {
        // это конкретное соединение не готово — не наша забота, пробуем остальные (DESIGN.md П2)
      }
    }
    if (!sentToAny) {
      throw new Error(`relay-pool: нет готового ${role}-соединения`);
    }
  }

  function connect() {
    for (const connection of connections) connection.connect();
  }

  function close() {
    for (const connection of connections) connection.close();
  }

  // Этап 3 (З3.5) — водяной знак ОБРАБОТКИ per-subId, разослать всем членам
  // пула: событие этого subId могло прийти через ЛЮБОЕ read-соединение, каждое
  // ведёт свой независимый lastEventCreatedAtBySubId/processedWatermarkBySubId
  // (per-connection, как и раньше — П-инварианты relay-pool.js не про это).
  function reportProcessed(subId, createdAt) {
    for (const connection of connections) connection.reportProcessed(subId, createdAt);
  }

  function getUrl() {
    return entries
      .filter((e) => e.write)
      .map((e) => e.url)
      .join(",");
  }

  return {
    getState: aggregateState,
    getUrl,
    // Диагностика: агрегат getState() отвечает "хоть что-то живо?", а
    // человеку на экране нужно "какое именно реле молчит". Отдаём копию
    // (map по connections), а не сами connection-объекты — снаружи пул
    // доступен только на чтение.
    getMembers: () =>
      entries.map((entry, i) => ({
        url: entry.url,
        read: !!entry.read,
        write: !!entry.write,
        state: connections[i].getState(),
      })),
    addMessageHandler,
    removeMessageHandler,
    connect,
    send,
    reportProcessed,
    close,
  };
}

// Этап 60 — доставка на relay ПОЛУЧАТЕЛЯ (не входящий в собственный пул,
// этап 58): эфемерное one-shot соединение, не постоянное. connect() ->
// дождаться "connected" реактивно (через onStateChange, БЕЗ поллинга) ->
// publish(event) -> close() сразу после ответа, успешного или нет.
export function publishToRelay(url, event, options = {}) {
  const timeoutMs = options.timeoutMs ?? 8000;

  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;

    const connection = createRelayConnection(url, {
      WebSocketImpl: options.WebSocketImpl,
      autoReconnect: false,
      onStateChange: (state) => {
        if (settled || state !== "connected") return;
        settled = true;
        clearTimeout(timer);
        // batchSize:1 — НАЙДЕНО ПРИ НАПИСАНИИ ТЕСТА: publisher.js's дефолтный
        // batchWindowMs (200мс) означал бы, что одиночное событие ждёт таймер,
        // а не отправляется сразу же после connected. Здесь батчить нечего —
        // ровно одно событие на эфемерное соединение, которое сразу закрывается.
        const publisher = createPublisher(connection, { batchSize: 1 });
        connection.addMessageHandler(publisher.handleMessage);
        publisher.publish(event).then(
          (result) => {
            connection.close();
            resolve(result);
          },
          (err) => {
            connection.close();
            reject(err);
          },
        );
      },
    });

    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      connection.close();
      reject(new Error(`publishToRelay: таймаут подключения к ${url}`));
    }, timeoutMs);

    connection.connect();
  });
}

// Этап 61 — симметрично publishToRelay: эфемерное one-shot соединение, но
// для ЧТЕНИЯ (bootstrap-обнаружение relay-списка при первом входе на
// устройстве). REQ со случайным subId -> собрать EVENT до EOSE -> close().
// Пустой массив — валидный исход ("ничего не нашлось"), отличим от таймаута
// подключения (reject) — вызывающая сторона обязана различать эти два случая.
export function fetchFromRelay(url, filters, options = {}) {
  const timeoutMs = options.timeoutMs ?? 8000;

  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const events = [];

    const connection = createRelayConnection(url, {
      WebSocketImpl: options.WebSocketImpl,
      autoReconnect: false,
      onStateChange: (state) => {
        if (settled || state !== "connected") return;
        const subId = "fetch-" + Math.random().toString(36).slice(2);
        connection.addMessageHandler((msg) => {
          if (msg[0] === "EVENT" && msg[1] === subId) {
            events.push(msg[2]);
            return true;
          }
          if (msg[0] === "EOSE" && msg[1] === subId) {
            if (settled) return true;
            settled = true;
            clearTimeout(timer);
            connection.close();
            resolve(events);
            return true;
          }
          return false;
        });
        connection.send(["REQ", subId, ...filters]);
      },
    });

    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      connection.close();
      reject(new Error(`fetchFromRelay: таймаут подключения к ${url}`));
    }, timeoutMs);

    connection.connect();
  });
}
