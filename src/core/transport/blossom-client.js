import { sign } from '../crypto/sign.js';

function stripTrailingSlash(url) {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

// expirationSec — параметризован (FILES-FIX-SPEC.md §1/§7.2, TZ-FIX-FILES-
// MEDIA-STATIC.md решение №13): 300с жёстко было КОРОЧЕ, чем PUT крупного
// файла на медленном канале (10 МБ @ 30 КБ/с ≈ 5-6 мин). Дефолт 300 остаётся
// для delete/HEAD-предпроверки (тело маленькое/отсутствует).
function buildAuthEvent(action, sha256Hex, expirationSec = 300) {
  const now = Math.floor(Date.now() / 1000);
  return {
    kind: 24242,
    created_at: now,
    content: action + ' blob',
    tags: [['t', action], ['x', sha256Hex], ['expiration', String(now + expirationSec)]],
  };
}

function encodeAuthHeader(event) {
  const json = JSON.stringify(event);
  const base64 = typeof btoa === 'undefined' ? Buffer.from(json, 'utf8').toString('base64') : btoa(json);
  return 'Nostr ' + base64;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 0/502/503/504 — транзиентные, стоит повторить (прокси/апстрим временно не
// ответил); всё остальное (4xx, 500/501) — сервер осмысленно отказал,
// повторять бессмысленно (FILES-FIX-SPEC.md §7.1, TZ-FIX-FILES-MEDIA-STATIC.md
// 5.1: "повторять ТОЛЬКО сетевые отказы... не 4xx").
export function isRetryableStatus(status) {
  return status === 0 || status === 502 || status === 503 || status === 504;
}

// fetch() бросает TypeError на сетевой сбой (DNS/обрыв/CORS) — единственный
// класс исключения, который стоит повторить. AbortError (пользователь ИЛИ
// собственный timeoutMs) — намеренно НЕ входит сюда, повторять его нельзя
// никогда (см. combineSignals ниже и Приложение Б FILES-FIX-SPEC.md: слепой
// retry на уже перегруженном ресурсе удваивает нагрузку, а не помогает).
export function isNetworkError(err) {
  return err instanceof TypeError;
}

// Таймаут — СОБСТВЕННЫЙ AbortSignal, объединённый с внешним (пользовательская
// отмена) через AbortSignal.any, если доступно (Node 20+/современные браузеры);
// иначе ручная связка тем же контроллером. Оба даю ОДИНАКОВОЕ имя ошибки
// "AbortError" — вызывающая сторона (putWithRetry) не должна и не может их
// различать для решения "повторять или нет" (решение: не повторять НИ ОДИН).
export function combineSignals(signal, timeoutMs) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  if (!signal) return timeoutSignal;
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([signal, timeoutSignal]);
  const controller = new AbortController();
  const forward = (s) => {
    if (s.aborted) controller.abort(s.reason);
    else s.addEventListener('abort', () => controller.abort(s.reason), { once: true });
  };
  forward(signal);
  forward(timeoutSignal);
  return controller.signal;
}

function defaultIsRetryable(err) {
  return isNetworkError(err) || isRetryableStatus(err?.status);
}

// MEDIA-PERF-TZ-5.md §5 — общий помощник для чтения (downloadBlobRange/
// downloadBlob). PUT уже имеет putWithRetry ниже; дублировать цикл в blob.js
// нельзя — isRetryableStatus/backoff обязаны совпадать. retries=2 → 3 попытки
// всего (первая + два повтора). AbortError (пользователь и собственный
// таймаут) не повторяется никогда.
export async function withRetry(fn, { retries = 2, backoffMs = 500, isRetryable = defaultIsRetryable } = {}) {
  let attempt = 0;
  for (;;) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (err?.name === 'AbortError') throw err;
      if (attempt < retries && isRetryable(err)) {
        attempt += 1;
        await sleep(backoffMs * 2 ** (attempt - 1));
        continue;
      }
      throw err;
    }
  }
}

function byteLength(body) {
  if (typeof body?.size === 'number') return body.size;
  if (typeof body?.length === 'number') return body.length;
  return 0;
}

// Таймаут PUT. TZ-FIX 5.1 задавал max(120с, 8мс/КиБ) ≈ расчёт на ≥125 КБ/с.
// И0 2026-09-06: хост Blossom принимает 2 МиБ за ~50 мс (~40 МБ/с); живые
// 26–37 КБ/с — канал браузера, не сервер. 10 МБ @ 30 КБ/с ≈ 6 мин > 120 с —
// формула TZ оборвала бы загрузку, которая на бою сейчас доезжает.
// Пол 120 с, скорость запаса 8 КиБ/с (ниже измеренных 26 КБ/с), потолок час
// (FILES-FIX-SPEC.md §7.2). expirationSec по-прежнему max(300, timeout/1000+60).
export const UPLOAD_TIMEOUT_FLOOR_MS = 120_000;
export const UPLOAD_TIMEOUT_CEIL_MS = 3_600_000;
export const UPLOAD_TIMEOUT_BYTES_PER_SEC = 8192;

export function resolveUploadTimeoutMs(bytes) {
  const sized = Math.ceil(Math.max(0, bytes) / UPLOAD_TIMEOUT_BYTES_PER_SEC) * 1000;
  return Math.min(UPLOAD_TIMEOUT_CEIL_MS, Math.max(UPLOAD_TIMEOUT_FLOOR_MS, sized));
}

// XHR — единственный способ получить upload-прогресс в браузере (fetch с
// потоковым телом duplex:"half" — только Chromium, FILES-FIX-SPEC.md §5.1.2).
// Используется ТОЛЬКО когда: (а) вызывающая сторона не подставила свой
// fetchImpl (тесты/Node всегда его подставляют — не ломаем существующие
// моки), (б) есть глобальный XMLHttpRequest (браузер), (в) тело — Blob (File
// его расширяет) — putFileStreaming уже собирает Blob(parts).
function canUseXhrUpload(fetchImpl, body) {
  return !fetchImpl && typeof XMLHttpRequest !== 'undefined' && typeof Blob !== 'undefined' && body instanceof Blob;
}

function abortErrorFor(reason) {
  return reason instanceof Error ? reason : new DOMException('Загрузка отменена', 'AbortError');
}

function xhrPut(url, body, headers, { timeoutMs, signal, onUploadProgress } = {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url, true);
    for (const [key, value] of Object.entries(headers)) xhr.setRequestHeader(key, value);
    if (timeoutMs) xhr.timeout = timeoutMs;
    xhr.upload.onprogress = (e) => {
      onUploadProgress?.({ loaded: e.loaded, total: e.lengthComputable ? e.total : undefined });
    };
    xhr.onload = () => {
      resolve({
        ok: xhr.status >= 200 && xhr.status < 300,
        status: xhr.status,
        text: async () => xhr.responseText,
        json: async () => JSON.parse(xhr.responseText),
      });
    };
    xhr.onerror = () => reject(new TypeError('Blossom upload: сетевая ошибка XHR'));
    xhr.ontimeout = () => reject(new DOMException('Загрузка отменена', 'AbortError'));
    const onAbort = () => {
      xhr.abort();
      reject(abortErrorFor(signal?.reason));
    };
    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    xhr.send(body);
  });
}

// Общий retry+timeout цикл для PUT (uploadBlob) — HEAD-предпроверка
// (checkUploadRequirements) использует его же логику ретраев инлайн (тело
// пустое, XHR-прогресс не нужен). downloadBlob/deleteBlob НЕ получают retry
// (TZ-FIX-FILES-MEDIA-STATIC.md 5.1: "не обязаны").
async function putWithRetry(url, body, headers, { fetchImpl, signal, timeoutMs, retries, backoffMs, onUploadProgress }) {
  const useXhr = canUseXhrUpload(fetchImpl, body);
  let attempt = 0;
  for (;;) {
    try {
      let response;
      if (useXhr) {
        response = await xhrPut(url, body, headers, { timeoutMs, signal, onUploadProgress });
      } else {
        const doFetch = fetchImpl ?? globalThis.fetch;
        const combined = combineSignals(signal, timeoutMs);
        response = await doFetch(url, { method: 'PUT', headers, body, signal: combined });
        // fetchImpl подставлен (тесты/Node) или duplex-стриминг недоступен —
        // настоящего событийного прогресса нет, отдаём один финальный тик
        // (TZ-FIX-FILES-MEDIA-STATIC.md 5.1: "в Node-тестах... звать один раз").
        const total = byteLength(body);
        onUploadProgress?.({ loaded: total, total });
      }
      if (isRetryableStatus(response.status) && attempt < retries) {
        attempt += 1;
        await sleep(backoffMs * 2 ** (attempt - 1));
        continue;
      }
      return response;
    } catch (err) {
      if (err?.name === 'AbortError') throw err;
      if (isNetworkError(err) && attempt < retries) {
        attempt += 1;
        await sleep(backoffMs * 2 ** (attempt - 1));
        continue;
      }
      throw err;
    }
  }
}

export async function uploadBlob(serverUrl, encryptedBytes, sha256Hex, privateKey, options = {}) {
  const {
    fetchImpl,
    signal,
    timeoutMs = resolveUploadTimeoutMs(byteLength(encryptedBytes)),
    retries = 2,
    backoffMs = 1000,
    onUploadProgress,
    expirationSec = Math.max(300, Math.ceil(timeoutMs / 1000) + 60),
  } = options;
  const authEvent = sign(buildAuthEvent('upload', sha256Hex, expirationSec), privateKey);
  const response = await putWithRetry(
    stripTrailingSlash(serverUrl) + '/upload',
    encryptedBytes,
    { Authorization: encodeAuthHeader(authEvent) },
    { fetchImpl, signal, timeoutMs, retries, backoffMs, onUploadProgress },
  );
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error('Blossom upload failed: ' + response.status + ' ' + text);
  }
  return await response.json();
}

export async function checkBlossomReachable(serverUrl, options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  try {
    // /stats — BUD без auth, на нашем форке 200. HEAD / даёт 404 (пустой
    // корень): любой ответ всё равно = «жив», но опрос раз в 30с красил
    // Network красным и путался с отказом плеера (живой лог 2026-09-10).
    await fetchImpl(stripTrailingSlash(serverUrl) + '/stats', { method: 'HEAD' });
    return true;
  } catch {
    return false;
  }
}

export async function downloadBlob(serverUrl, sha256Hex, options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const response = await fetchImpl(stripTrailingSlash(serverUrl) + '/' + sha256Hex, { signal: options.signal });
  if (!response.ok) {
    const err = new Error('Blossom download failed: ' + response.status);
    err.status = response.status;
    throw err;
  }
  const arrayBuffer = await response.arrayBuffer();
  return new Uint8Array(arrayBuffer);
}

export async function deleteBlob(serverUrl, sha256Hex, privateKey, options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const authEvent = sign(buildAuthEvent('delete', sha256Hex), privateKey);
  const response = await fetchImpl(stripTrailingSlash(serverUrl) + '/' + sha256Hex, { method: 'DELETE', headers: { Authorization: encodeAuthHeader(authEvent) }, signal: options.signal });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error('Blossom delete failed: ' + response.status + ' ' + text);
  }
}

export async function checkUploadRequirements(serverUrl, { sha256Hex, mime, size }, privateKey, options = {}) {
  const {
    fetchImpl,
    signal,
    timeoutMs = 120_000,
    retries = 2,
    backoffMs = 1000,
    expirationSec = 300,
  } = options;
  try {
    const authEvent = sign(buildAuthEvent('upload', sha256Hex, expirationSec), privateKey);
    const doFetch = fetchImpl ?? globalThis.fetch;
    const headers = { Authorization: encodeAuthHeader(authEvent), 'X-SHA-256': sha256Hex, 'X-Content-Type': mime, 'X-Content-Length': String(size) };
    let attempt = 0;
    let response;
    for (;;) {
      try {
        const combined = combineSignals(signal, timeoutMs);
        response = await doFetch(stripTrailingSlash(serverUrl) + '/upload', { method: 'HEAD', headers, signal: combined });
        if (isRetryableStatus(response.status) && attempt < retries) {
          attempt += 1;
          await sleep(backoffMs * 2 ** (attempt - 1));
          continue;
        }
        break;
      } catch (err) {
        if (err?.name === 'AbortError') throw err;
        if (isNetworkError(err) && attempt < retries) {
          attempt += 1;
          await sleep(backoffMs * 2 ** (attempt - 1));
          continue;
        }
        throw err;
      }
    }
    if (response.status === 404 || response.status === 405) {
      return { ok: true, unknown: true };
    }
    if (response.ok) {
      return { ok: true };
    }
    return { ok: false, status: response.status, reason: response.headers.get('X-Reason') ?? null };
  } catch {
    return { ok: true, unknown: true };
  }
}
