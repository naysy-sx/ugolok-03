import { transition } from "../fsm/machine.js";
import { createPublisher } from "./publisher.js";

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

const DEFAULT_BACKOFF = { baseMs: 1000, maxMs: 30000, multiplier: 2, jitter: 0.2 };

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

  let state = "disconnected";
  let ws = null;
  let intentionalClose = false;
  let reconnectAttempt = 0;
  let reconnectTimer = null;

  const messageHandlers = [];

  function addMessageHandler(handler) {
    messageHandlers.push(handler);
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
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function connect() {
    intentionalClose = false;
    apply("CONNECT");
    ws = new WebSocketImpl(url);
    ws.onopen = () => {
      reconnectAttempt = 0;
      apply("OPEN");
    };
    ws.onclose = () => {
      apply("CLOSE");
      scheduleReconnect();
    };
    ws.onerror = () => {
      apply("ERROR");
    };
    ws.onmessage = (evt) => {
      const msg = JSON.parse(evt.data);
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
    ws.send(JSON.stringify(msgArray));
  }

  function close() {
    intentionalClose = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    ws?.close();
  }

  return {
    getState: () => state,
    getUrl: () => url,
    addMessageHandler,
    connect,
    send,
    reportAuthChallenge: () => apply("AUTH_CHALLENGE"),
    reportAuthOk: () => apply("AUTH_OK"),
    reportAuthFail: () => apply("AUTH_FAIL"),
    reportAuthTimeout: () => apply("TIMEOUT"),
    reportSubscribed: () => apply("SUBSCRIBE_OK"),
    close,
  };
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
      onStateChange: handleMemberStateChange,
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

  function getUrl() {
    return entries
      .filter((e) => e.write)
      .map((e) => e.url)
      .join(",");
  }

  return {
    getState: aggregateState,
    getUrl,
    addMessageHandler,
    connect,
    send,
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
