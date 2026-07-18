import { sign } from '../crypto/sign.js';

// Найдено адверсарной фазой (не гипотеза): serverUrl с завершающим "/" (пользователь
// вставит с ним или без — этап 32, F-AT-09, список серверов вводится вручную) давал
// "//upload" — некоторые Blossom-серверы трактуют это как ДРУГОЙ путь, не "/upload".
function stripTrailingSlash(url) {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

function buildAuthEvent(action, sha256Hex) {
  const now = Math.floor(Date.now() / 1000);
  return {
    kind: 24242,
    created_at: now,
    content: action + ' blob',
    tags: [['t', action], ['x', sha256Hex], ['expiration', String(now + 300)]],
  };
}

function encodeAuthHeader(event) {
  const json = JSON.stringify(event);
  const base64 = typeof btoa === 'undefined' ? Buffer.from(json, 'utf8').toString('base64') : btoa(json);
  return 'Nostr ' + base64;
}

export async function uploadBlob(serverUrl, encryptedBytes, sha256Hex, privateKey, options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const authEvent = sign(buildAuthEvent('upload', sha256Hex), privateKey);
  const response = await fetchImpl(stripTrailingSlash(serverUrl) + '/upload', { method: 'PUT', headers: { Authorization: encodeAuthHeader(authEvent) }, body: encryptedBytes });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error('Blossom upload failed: ' + response.status + ' ' + text);
  }
  return await response.json();
}

export async function downloadBlob(serverUrl, sha256Hex, options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const response = await fetchImpl(stripTrailingSlash(serverUrl) + '/' + sha256Hex);
  if (!response.ok) {
    throw new Error('Blossom download failed: ' + response.status);
  }
  const arrayBuffer = await response.arrayBuffer();
  return new Uint8Array(arrayBuffer);
}
