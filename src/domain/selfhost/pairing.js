import { DomainError } from '../errors.js';

export function decodePairingCode(code) {
  if (typeof code !== 'string' || !code) throw new DomainError('некорректный пейринг-код', 'errors.pairingInvalidCode');
  let decoded = code.replace(/-/g, '+').replace(/_/g, '/');
  while (decoded.length % 4) decoded += '=';

  let jsonStr;
  try {
    jsonStr = atob(decoded);
  } catch {
    throw new DomainError('не удалось декодировать пейринг-код: невалидный base64', 'errors.pairingInvalidBase64');
  }

  let parsed;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    throw new DomainError('не удалось разобрать пейринг-код: повреждённый JSON', 'errors.pairingCorruptedJson');
  }

  const { host, port, token, fingerprint } = parsed;
  if (!host || !token || !fingerprint || typeof port !== 'number') {
    throw new DomainError('пейринг-код не содержит host/port/token/fingerprint', 'errors.pairingMissingFields');
  }
  return { host, port, token, fingerprint };
}

export async function fetchAgentStatus(pairing, options = {}) {
  const { host, port, token } = pairing;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  try {
    const response = await fetchImpl(`https://${host}:${port}/status`, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) throw new DomainError('сервер отклонил запрос: ' + response.status, 'errors.pairingServerRejected', { status: response.status });
    return await response.json();
  } catch (err) {
    if (err instanceof Error) throw new DomainError(`не удалось связаться с сервером: ${err.message}`, 'errors.pairingCannotReach', { message: err.message });
    throw err;
  }
}

export async function fetchTurnCredentials(pairing, options = {}) {
  const { host, port, token } = pairing;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  try {
    const response = await fetchImpl(`https://${host}:${port}/turn-credentials`, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) throw new DomainError('сервер отклонил запрос: ' + response.status, 'errors.pairingServerRejected', { status: response.status });
    return await response.json();
  } catch (err) {
    if (err instanceof Error) throw new DomainError(`не удалось связаться с сервером: ${err.message}`, 'errors.pairingCannotReach', { message: err.message });
    throw err;
  }
}
