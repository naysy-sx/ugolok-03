import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { sign } from '../../core/crypto/sign.js';
import { db } from '../../core/store/database.js';
import { pickLatest } from '../../core/sync/lww.js';
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
  await updateProfile(ownerPubkey, { bio: parsed.about || current.bio || '', avatarUrl: parsed.picture || current.avatarUrl || '' });
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
    const current = await getProfile(ownerPubkey);
    const event = buildProfileEvent(privKey, { name: login, about: current.bio || undefined, picture: current.avatarUrl || undefined });
    await publish(event);
  } catch (e) {
    console.warn('ensureProfilePublished: не удалось опубликовать профиль', e);
  }
}
