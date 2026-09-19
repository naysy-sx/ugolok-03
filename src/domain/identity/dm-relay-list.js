import { sign } from '../../core/crypto/sign.js';

// Этап 60 — NIP-17 "DM Relay List" (kind:10050, номер сверен по спеке, не
// угадан). Тег 'relay' (НЕ 'r', как у relay-list.js's kind:10002 — разные
// NIP). Без read/write маркеров: сам смысл события — "сюда мне присылайте",
// read-сторона получателя, роли различать нечего.
export function buildDmRelayListEvent(privKey, relayUrls) {
  const eventTemplate = {
    kind: 10050,
    created_at: Math.floor(Date.now() / 1000),
    tags: relayUrls.map(url => ['relay', url]),
    content: ''
  };
  return sign(eventTemplate, privKey);
}

export function parseDmRelayListEvent(event) {
  return event.tags.filter(tag => tag[0] === 'relay').map(tag => tag[1]);
}

// AUDIT-EGOROD (соседняя находка J1). kind:10050 принадлежит ПОЛУЧАТЕЛЮ — любой
// pubkey, которому пишут (контакт, а для запросов знакомства и незнакомец), сам
// выбирает, какие адреса там лежат. Клиент открывал к ним прямые WebSocket, то
// есть получатель мог держать «inbox-relay» у себя и узнавать IP каждого, кто ему
// пишет, а заодно заставлять браузер стучаться по произвольным адресам. Это же
// противоречит модели «клиент ходит только в свой инстанс» (GATEWAY-TZ-1).
//
// Теперь по умолчанию чужие relay не используются вовсе: событие и так
// публикуется на СВОИ relay пользователя (publisher), между инстансами доставка —
// задача шлюза на стороне сервера. Оператор мульти-инстансного развёртывания без
// шлюза может включить доставку явно (config.json → allowForeignInboxRelays), и
// даже тогда: только wss, не более max адресов, без localhost/частных сетей/
// IP-литералов (защита от использования браузера как сканера локальной сети).
const PRIVATE_V4 = /^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.)/;

function isSafeForeignHost(hostname) {
  const h = hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".lan")) return false;
  if (h.startsWith("[") || h.includes(":")) return false; // IPv6-литерал
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) return false; // IPv4-литерал (в т.ч. частный) — только имена
  if (PRIVATE_V4.test(h)) return false;
  return h.includes(".");
}

function originOfRelay(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== "ws:" && u.protocol !== "wss:") return null;
    return { origin: u.origin, protocol: u.protocol, hostname: u.hostname };
  } catch {
    return null;
  }
}

export function selectInboxRelays(candidates, { ownRelayUrls = [], allowForeign = false, max = 3 } = {}) {
  if (!allowForeign) return [];
  const own = new Set(ownRelayUrls.map((u) => originOfRelay(u)?.origin).filter(Boolean));
  const out = [];
  const seen = new Set();
  for (const url of candidates ?? []) {
    if (typeof url !== "string" || url.length > 512) continue;
    const parsed = originOfRelay(url);
    if (!parsed || seen.has(parsed.origin)) continue;
    seen.add(parsed.origin);
    if (own.has(parsed.origin)) continue; // уже получил событие через собственный пул
    if (parsed.protocol !== "wss:" || !isSafeForeignHost(parsed.hostname)) continue;
    out.push(url);
    if (out.length >= max) break;
  }
  return out;
}
