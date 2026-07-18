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
      onMessage?.(JSON.parse(evt.data));
    };
  }

  function send(msgArray) {
    if (state !== "connected" && state !== "subscribed") {
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
