import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { sign } from '../../core/crypto/sign.js';
import { db } from '../../core/store/database.js';
import { pickLatest, isNewerVersion } from '../../core/sync/lww.js';
import { hasEvent, appendEvent } from '../../core/store/event-log.js';
import { getProfile, updateProfile } from '../../core/crypto/keystore.js';
import { uploadBlob, checkUploadRequirements } from '../files/blob.js';
import { validateAttachment } from '../files/attachment-validation.js';
import { DomainError } from '../errors.js';

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

// Перенесено из domain/attachments/upload.js (этап 53 И7, задача 7.4 — снятие
// фасада attachments). Логика НЕ меняется: параллель uploadMessageAttachment,
// БЕЗ шифрования (публичный профиль — шифровать нечего и незачем), переиспользует
// uploadBlob (files/blob.js, тот же, что чанкованная загрузка content.js —
// сам по себе агностичен к тому, зашифрованы байты или нет) и validateAttachment.
// Возвращает СТРОКУ (публичный URL), не дескриптор — avatar идёт через обычный
// <img src>, не через downloadMessageAttachment's manifest-проверку.
export async function uploadAvatarBlob(serverUrl, fileBytes, mime, privateKey, options = {}) {
  validateAttachment({ mime, size: fileBytes.length });
  const sha256Hex = bytesToHex(sha256(fileBytes));
  const requirements = await checkUploadRequirements(serverUrl, { sha256Hex, mime, size: fileBytes.length }, privateKey, options);
  if (!requirements.ok) {
    const detail = requirements.status ? ' (' + requirements.status + (requirements.reason ? ': ' + requirements.reason : '') + ')' : '';
    throw new DomainError('Blossom-сервер отклонил файл' + detail, 'errors.blossomRejectedFile', { detail });
  }
  const response = await uploadBlob(serverUrl, fileBytes, sha256Hex, privateKey, options);
  return response.url ?? (serverUrl.replace(/\/$/, '') + '/' + sha256Hex);
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
// Этап 57 (найдено собственной тестовой методологией сессии — повторные
// "чистые устройства" стирали keystore.profileAutoPublished, из-за чего
// ensureProfilePublished переиздавал ГОЛЫЙ {name} поверх содержательного
// kind 0 — replaceable-семантика NIP-01 схлопывала старую версию с био/
// аватаром): пустое ВХОДЯЩЕЕ поле больше не побеждает уже непустое локальное —
// иначе ЛЮБОЙ такой инцидент (не только тестовый — гонка между устройствами
// или сбой публикации тоже могли бы дать пустой "самый свежий по created_at")
// безусловно стирал бы уже хорошие локальные данные при каждом connect().
// Настоящее обновление (непустое входящее значение) по-прежнему побеждает.
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
  const current = await getProfile(ownerPubkey);
  const newAvatarUrl = parsed.picture || current.avatarUrl || '';
  const patch = { bio: parsed.about || current.bio || '', avatarUrl: newAvatarUrl };
  // Этап 74 — Часть B, T6.1 (P-3, CONTRACTS.md/DESIGN.md "Этап 74"): avatar —
  // ЛОКАЛЬНЫЙ data-url кэш этого устройства, avatarUrl — публичный Blossom URL
  // из kind:0. Если входящий picture НЕПУСТОЙ и реально ОТЛИЧАЕТСЯ от уже
  // хранимого avatarUrl (устройство сменило картинку) — локальный кэш устарел,
  // инвалидируем вместе с avatarUrl. Пустой picture локальные поля не трогает
  // (правило этапа 57 выше — без изменений).
  if (parsed.picture && parsed.picture !== current.avatarUrl) {
    patch.avatar = '';
  }
  await updateProfile(ownerPubkey, patch);
  return true;
}

// Этап 74 — Часть B, T5.1 (within-batch, CONTRACTS.md/DESIGN.md "Этап 74",
// P-1): fetchProfiles (transport.js) копит несколько версий ОДНОГО pubkey за
// ОДИН REQ+EOSE (multi-relay pool) — без гейта здесь последнее ПРИБЫВШЕЕ
// (не обязательно самое новое по created_at) необратимо побеждает ДО того,
// как внешний LWW-гейт (contacts.js's applyProfileUpdates) вообще получит
// шанс сравнить. results — Map<pubkey, {...,createdAt,id}>, мутируется на месте.
export function accumulateProfileVersions(results, event) {
  let parsed;
  try {
    parsed = parseProfileEvent(event);
  } catch {
    return; // повреждённый/не-JSON профиль чужого клиента — пропустить, не ронять батч
  }
  const incoming = { ...parsed, createdAt: event.created_at, id: event.id };
  const existing = results.get(event.pubkey);
  if (!existing || isNewerVersion(incoming, existing)) {
    results.set(event.pubkey, incoming);
  }
}

// Этап 74 — Часть B, T6.2 (P-4, CONTRACTS.md/DESIGN.md "Этап 74"): живая
// подписка на СВОЙ kind:0 (transport.js's refreshLiveProfileSubscription,
// ветка event.pubkey===ownerPubkey). Персистит сырое событие в db.events
// (идемпотентно — hasEvent-гейт, тот же приём, что bootstrap) и
// переиспользует hydrateOwnProfile — LWW-корректность НАСЛЕДУЕТСЯ от уже
// протестированного pickLatest над полной историей, вторая реализация
// сравнения версий не пишется (T7). Возвращает true, ТОЛЬКО если профиль
// РЕАЛЬНО изменился — эхо собственной публикации (relay возвращает только
// что изданный kind:0) обязано быть no-op, сравнение ДО/ПОСЛЕ, не внутри
// hydrateOwnProfile (её true/false-контракт "найден валидный kind:0" уже
// протестирован отдельно, profile.test.js, менять нельзя).
export async function applyLiveOwnProfileEvent(ownerPubkey, event) {
  if (!(await hasEvent(event.id))) {
    await appendEvent(event);
  }
  const before = await getProfile(ownerPubkey);
  await hydrateOwnProfile(ownerPubkey);
  const after = await getProfile(ownerPubkey);
  return before.bio !== after.bio || before.avatarUrl !== after.avatarUrl || before.avatar !== after.avatar;
}

// CHANNEL-V2 часть A1 (ТЗ, PROCESS-DOCS/REDESIGN/CHANNEL-2/CHANNEL-V2-TASK.md) —
// решение отменено: было "флаг вперёд, ретраев нет" (тот же идиом, что chat.js's
// ensureOwnKeyPackagePublished, этап 25). Цена: единственный неудачный первый
// connect навсегда оставлял пользователя без kind:0 — на релее просто нет
// события, из которого чужой клиент возьмёт имя (все видят npub). Флаг теперь
// ставится ТОЛЬКО после подтверждения релея (publish → {ok:true}); publish
// по-прежнему обёрнут в try/catch — имя в профиле косметическое, сбой сети не
// должен ронять connect()/блокировать вход (в отличие от MLS KeyPackage).
// Цена ретрая — одно kind:0 на connect, пока публикация не пройдёт; дешевле,
// чем безымянный аккаунт навсегда.
export async function ensureProfilePublished(ownerPubkey, login, privKey, publish) {
  const record = await db.table('keystore').get(ownerPubkey);
  if (record?.profileAutoPublished) return;
  try {
    const current = await getProfile(ownerPubkey);
    const event = buildProfileEvent(privKey, { name: login, about: current.bio || undefined, picture: current.avatarUrl || undefined });
    const result = await publish(event);
    if (result?.ok) {
      await db.table('keystore').update(ownerPubkey, { profileAutoPublished: true });
    }
  } catch (e) {
    console.warn('ensureProfilePublished: не удалось опубликовать профиль', e);
  }
}
