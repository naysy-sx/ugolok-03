import { signal } from "@preact/signals";
import { deriveMasterSecret, deriveDbKey } from "../../core/crypto/derivation.js";
import { clearMemoryCache } from "../attachment-memory-cache.js";
import { closeMedia } from "./media.js";
import { clearManifestCache } from "../../domain/files/content.js";
import { clearPlaintextCache } from "../../domain/media/plaintext-cache.js";
import { clearPlayerCaches } from "../../domain/files/player-bridge.js";
import { setFilesBlobsOwner } from "../../domain/files/blob-cache.js";
import { logInfo } from "../../core/diag/boot-log.js";

export const currentUser = signal(null);
export const privKeySig = signal(null);
export const masterSecretSig = signal(null);
export const dbKeySig = signal(null);

let lastActivity = Date.now();

const lockHooks = new Set();

export function onLock(fn) {
  lockHooks.add(fn);
  return () => lockHooks.delete(fn);
}

export function login(id, loginName, privKeyBytes, now = Date.now()) {
  currentUser.value = { id, login: loginName };
  privKeySig.value = privKeyBytes;
  masterSecretSig.value = deriveMasterSecret(privKeyBytes);
  dbKeySig.value = deriveDbKey(masterSecretSig.value);
  setFilesBlobsOwner(id);
  logInfo("ключи расшифрованы");
  touch(now);
}

export function lock() {
  closeMedia(); // SPEC §3.5 — ДО очистки кэшей: плейлист держит ключи файлов в памяти
  clearPlayerCaches();
  clearMemoryCache();
  clearManifestCache();
  clearPlaintextCache();
  setFilesBlobsOwner(null);
  for (const fn of lockHooks) {
    try {
      fn();
    } catch {
      // хук не должен блокировать сброс сигналов
    }
  }
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
