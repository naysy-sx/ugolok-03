import { sign } from "../crypto/sign.js";

const DEFAULT_TIMEOUT_MS = 10000;

export function buildAuthEvent(challenge, relayUrl, privKey) {
  return sign(
    {
      kind: 22242,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ["relay", relayUrl],
        ["challenge", challenge],
      ],
      content: "",
    },
    privKey,
  );
}

export function createAuthHandler(connection, relayUrl, privKey, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let pendingAuthEventId = null;
  let timer = null;

  function clearPending() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    pendingAuthEventId = null;
  }

  return function handleMessage(msg) {
    const [type] = msg;

    if (type === "AUTH") {
      const [, challenge] = msg;
      // Новый challenge заменяет ожидание предыдущего (спецификация NIP-42:
      // "The challenge is valid ... until another challenge is sent").
      clearPending();
      connection.reportAuthChallenge();
      const authEvent = buildAuthEvent(challenge, relayUrl, privKey);
      pendingAuthEventId = authEvent.id;
      connection.send(["AUTH", authEvent]);
      timer = setTimeout(() => {
        timer = null;
        pendingAuthEventId = null;
        connection.reportAuthTimeout();
      }, timeoutMs);
      return true;
    }

    if (type === "OK") {
      const [, eventId, ok] = msg;
      if (eventId !== pendingAuthEventId) return false;
      clearPending();
      if (ok) connection.reportAuthOk();
      else connection.reportAuthFail();
      return true;
    }

    return false;
  };
}
