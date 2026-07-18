import { transition } from "../fsm/machine.js";

// Автомат соединения — правка контракта TECH.md §9.3, обоснование в DESIGN.md
// ("Этап 16"): connecting+OPEN ведёт сразу в connected (не authenticating),
// AUTH_CHALLENGE входит в authenticating реактивно из connected/subscribed,
// все три исхода authenticating (OK/FAIL/TIMEOUT) возвращают в connected.
const TRANSITIONS = {
  disconnected: { CONNECT: "connecting" },
  connecting: { OPEN: "connected", TIMEOUT: "disconnected" },
  connected: {
    AUTH_CHALLENGE: "authenticating",
    SUBSCRIBE_OK: "subscribed",
  },
  authenticating: {
    // Повторный challenge поверх уже идущей аутентификации — самопереход
    // (сохранено из исходного автомата TECH.md §9.3). NIP-42 прямо допускает
    // новый challenge в любой момент; relay-auth.js обязан отправить ответ
    // именно на ПОСЛЕДНИЙ — старый теряет силу (см. DESIGN.md/тесты этапа 17).
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

  // Композиция message-interceptor'ов (relay-auth.js/publisher.js/subscriber.js,
  // этапы 17-18) — правка контракта, этап 19. `onMessage` из options — сырой
  // наблюдатель (видит ВСЁ, ни на что не влияет); handleMessage-функции
  // регистрируются здесь и пробуются по очереди до первой, вернувшей true
  // ("сообщение моё, обработано") — тот же паттерн first-match-wins, что уже
  // используют сами interceptor'ы.
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
    // "authenticating" тоже допустим: именно в этом состоянии relay-auth.js
    // (этап 17) обязан отправить AUTH-ответ на challenge — WS реально открыт
    // во всех трёх состояниях, различие только в том, что приложение считает
    // уместным делать сейчас.
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
