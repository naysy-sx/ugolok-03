import { signal } from "@preact/signals";
import { deriveMasterSecret, deriveDbKey } from "../../core/crypto/derivation.js";
import { clearMemoryCache } from "../attachment-memory-cache.js";
import { closeMedia } from "./media.js";

export const currentUser = signal(null);
export const privKeySig = signal(null);
export const masterSecretSig = signal(null);
export const dbKeySig = signal(null);

let lastActivity = Date.now();

export function login(id, loginName, privKeyBytes, now = Date.now()) {
  currentUser.value = { id, login: loginName };
  privKeySig.value = privKeyBytes;
  masterSecretSig.value = deriveMasterSecret(privKeyBytes);
  dbKeySig.value = deriveDbKey(masterSecretSig.value);
  touch(now);
}

export function lock() {
  closeMedia(); // SPEC §3.5 — ДО очистки кэшей: плейлист держит ключи файлов в памяти
  clearMemoryCache();
  currentUser.value = null;
  privKeySig.value = null;
  masterSecretSig.value = null;
  dbKeySig.value = null;
}

export function touch(now = Date.now()) {
  lastActivity = now;
}

const IDLE_THRESHOLD_MS = 24 * 60 * 60 * 1000;

export function isIdle(now = Date.now()) {
  return now - lastActivity > IDLE_THRESHOLD_MS;
}

const LAST_ACCOUNT_KEY = "ugolok:lastAccountId";

export function setRememberedAccountId(id) {
  localStorage.setItem(LAST_ACCOUNT_KEY, id);
}

export function getRememberedAccountId() {
  return localStorage.getItem(LAST_ACCOUNT_KEY);
}

export function startIdleWatcher() {
  const interval = setInterval(() => {
    if (isIdle()) lock();
  }, 60000);
  const onActivity = () => touch();
  window.addEventListener("click", onActivity);
  window.addEventListener("keydown", onActivity);
  return () => {
    clearInterval(interval);
    window.removeEventListener("click", onActivity);
    window.removeEventListener("keydown", onActivity);
  };
}
