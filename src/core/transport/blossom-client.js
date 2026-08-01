import { sign } from '../crypto/sign.js';

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
  const response = await fetchImpl(stripTrailingSlash(serverUrl) + '/upload', { method: 'PUT', headers: { Authorization: encodeAuthHeader(authEvent) }, body: encryptedBytes, signal: options.signal });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error('Blossom upload failed: ' + response.status + ' ' + text);
  }
  return await response.json();
}

export async function checkBlossomReachable(serverUrl, options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  try {
    await fetchImpl(stripTrailingSlash(serverUrl) + '/', { method: 'HEAD' });
    return true;
  } catch {
    return false;
  }
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
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  try {
    const authEvent = sign(buildAuthEvent('upload', sha256Hex), privateKey);
    const response = await fetchImpl(stripTrailingSlash(serverUrl) + '/upload', { method: 'HEAD', headers: { Authorization: encodeAuthHeader(authEvent), 'X-SHA-256': sha256Hex, 'X-Content-Type': mime, 'X-Content-Length': String(size) }, signal: options.signal });
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
