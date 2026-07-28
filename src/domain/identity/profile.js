import { sign } from '../../core/crypto/sign.js';
import { db } from '../../core/store/database.js';
import { pickLatest } from '../../core/sync/lww.js';
import { updateProfile } from '../../core/crypto/keystore.js';

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

// Найдено пользователем (живая проверка — вход в существующий аккаунт с
// чистого устройства по мнемонике): bootstrap (transport.js, authors:[я])
// тянет СВОЙ kind 0 в db.events, но до сих пор ничто не читало его обратно —
// avatar/bio оставались пустыми навсегда на новом устройстве, не временно
// (профиль читается ИСКЛЮЧИТЕЛЬНО из keystore, profile.jsx/sidebar-profile-
// card.jsx, а keystore заполняет только локальная форма редактирования).
// kind 0 — replaceable (NIP-01), в db.events может лежать несколько копий с
// разных relay/подписок — pickLatest (тот же приём, что rebuildGroups и
// остальные *-fold в handlers.js) берёт по (created_at, id).
// avatarUrl — публичный Blossom URL (этап 37, БЕЗ шифрования сознательно),
// не сам avatar (тот — локальный data-url кэш конкретно этого устройства,
// заполняется только загрузкой файла) — рендер аватара обязан сам решить
// показать avatarUrl, когда avatar пуст (profile.jsx/sidebar-profile-card.jsx).
export async function hydrateOwnProfile(ownerPubkey) {
  const events = await db.table('events').where('[pubkey+kind]').equals([ownerPubkey, 0]).toArray();
  if (events.length === 0) return false;
  const latest = pickLatest(events);
  let parsed;
  try {
    parsed = parseProfileEvent(latest);
  } catch {
    return false; // повреждённый/чужеродный content — не роняем bootstrap
  }
  await updateProfile(ownerPubkey, { bio: parsed.about ?? '', avatarUrl: parsed.picture ?? '' });
  return true;
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
