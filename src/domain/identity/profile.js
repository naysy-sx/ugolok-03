import { sign } from '../../core/crypto/sign.js';
import { db } from '../../core/store/database.js';

// Этап 37 — правка контракта (было: picture сознательно не писалась, этап 26,
// "локальный stand-in до Blossom"). JSON.stringify сам опускает undefined-поля —
// если picture не передана, в content её вообще нет (не пустая строка).
export function buildProfileEvent(privKey, { name, about, picture } = {}) {
  const eventTemplate = {
    kind: 0,
    created_at: Math.floor(Date.now() / 1000),
    tags: [],
    content: JSON.stringify({ name, about, picture })
  };
  return sign(eventTemplate, privKey);
}

export function parseProfileEvent(event) {
  return JSON.parse(event.content);
}

// Тот же идиом, что chat.js's ensureOwnKeyPackagePublished (этап 25): локальный
// флаг персистится ДО попытки publish, повторных попыток при сбое сознательно
// нет. ОТЛИЧИЕ от прототипа: publish обёрнут в try/catch внутри самой функции —
// имя в профиле косметическое, сбой сети не должен ронять connect()/блокировать
// вход (в отличие от MLS KeyPackage, который функционально необходим).
export async function ensureProfilePublished(ownerPubkey, login, privKey, publish) {
  const record = await db.table('keystore').get(ownerPubkey);
  if (record?.profileAutoPublished) return;
  await db.table('keystore').update(ownerPubkey, { profileAutoPublished: true });
  try {
    const event = buildProfileEvent(privKey, { name: login });
    await publish(event);
  } catch (e) {
    console.warn('ensureProfilePublished: не удалось опубликовать профиль', e);
  }
}
