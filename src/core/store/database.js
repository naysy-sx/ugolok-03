import Dexie from "dexie";

export const db = new Dexie("ugolok");
db.version(1).stores({
  events: "++seq, id, [pubkey+kind], created_at, *flatTags",
  contacts: "[owner+pubkey], owner",
  blockedContacts: "[owner+pubkey], owner",
  groups: "[owner+id], owner",
  groupMembers: "[groupId+pubkey], groupId",
  permissions: "[owner+subject+resource], owner, subject, resource",
  effectivePerms: "[owner+subject+resource], owner, subject, resource",
  channelKeys: "[channelId+keyVersion], channelId",
  channelKeyMeta: "channelId",
  channelTopics: "channelId",
  commentAllowlists: "[channelId+keyVersion], channelId",
  messages: "++seq, [chatId+lamportTs+senderPubkey+id], chatId, id, status, deleted",
  channels: "id, owner",
  posts: "id, [channelId+created_at], channelId, author, keyVersion, deleted",
  comments: "[authorPubkey+commentId], postId, parentId, keyVersion, deleted",
  attachments: "sha256, messageId, type, mime",
  keystore: "id",
  clock: "id",
  syncState: "relay",
  chatSyncState: "chatId",
  channelSyncState: "channelId",
  outbox: "++seq, eventId, status, retryCount",
  inboxRequests: "id, senderPubkey, created_at",
  deletions: "targetId, deleterPubkey, created_at",
  mlsGroups: "groupId"
});

// Этап 24 — аддитивно: две новые таблицы, остальные наследуются из version(1)
// без изменений (стандартная Dexie-семантика, миграция данных не нужна — проект
// ещё не в проде, только пустые локальные базы).
db.version(2).stores({
  ownKeyPackage: "id",
  contactRequests: "[owner+senderPubkey], owner"
});

// Этап 25 — аддитивно: две новые таблицы (multi-device) + messages переопределена
// целиком (Dexie требует полный список индексов таблицы при изменении хотя бы
// одного) — добавлен unique-индекс [chatId+msgId] для идемпотентного upsertMessage
// (DESIGN.md, "Этап 25", раздел 3). НЕ [chatId+lamportTs+senderPubkey] — легитимная
// коллизия при multi-device (два устройства одной identity тикают один и тот же
// lamport-момент), тайбрейк по id уже покрыт существующим тестом этапа 24. Старый
// неуникальный индекс [chatId+lamportTs+senderPubkey+id] остаётся для сортировки
// getChatHistory, данных к миграции нет (пустые локальные базы).
db.version(3).stores({
  deviceIdentity: "id",
  knownDevices: "[ownerPubkey+deviceId], ownerPubkey",
  messages:
    "++seq, &[chatId+msgId], [chatId+lamportTs+senderPubkey+id], chatId, id, status, deleted",
  inboxRequests: "[owner+senderPubkey], owner, senderPubkey, createdAt"
});

// НАЙДЕНО РЕАЛЬНЫМ ИСПОЛЬЗОВАНИЕМ (не адверсарным тестом) — критический пробел
// этапов 13/24/25/26: ownKeyPackage/mlsGroups/messages/chatSyncState НИКОГДА не были
// owner-scoped, в отличие от contacts/blockedContacts/groups/contactRequests/inboxRequests/
// knownDevices (owner-scoped с самого начала). Молчаливое допущение "одна identity = одно
// устройство = одна БД" не учитывало, что мультиаккаунт на одном устройстве (уже поддержан
// с этапа 11) означает НЕСКОЛЬКО identities, делящих ОДНУ IndexedDB (один origin). На практике:
// ownKeyPackage хранил ОДНУ запись "self" на всё устройство — второй локальный аккаунт молча
// получал MLS-credential ПЕРВОГО, что ts-mls закономерно отвергает как "участник уже в группе"
// (тот же класс конфликта, что этап 25 исправил для credential identity:deviceId, только
// теперь между РАЗНЫМИ identity на одном устройстве, не между устройствами одной identity).
// mlsGroups/messages/chatSyncState были голыми (без owner) — второй локальный аккаунт видел
// ЧУЖИЕ переписки. deviceIdentity НЕ owner-scoped НАМЕРЕННО и остаётся так — deviceId это
// метка ФИЗИЧЕСКОГО устройства, общая для всех identity на нём (credential = identity:deviceId
// уже различает identity через первую часть, коллизии deviceId сам по себе не создаёт).
db.version(4).stores({
  ownKeyPackage: "ownerPubkey",
  mlsGroups: "[ownerPubkey+groupId], ownerPubkey",
  messages:
    "++seq, &[ownerPubkey+chatId+msgId], [ownerPubkey+chatId+lamportTs+senderPubkey+id], [ownerPubkey+chatId], id, status, deleted",
  chatSyncState: "[ownerPubkey+chatId], ownerPubkey"
});

// Этап 30 — найдено рассуждением ДО кода (не постфактум), тот же класс пробела, что уже
// исправлен для messages/mlsGroups/ownKeyPackage/chatSyncState (этапы 25-27): channels/
// channelKeys/channelKeyMeta/commentAllowlists в version(1) были объявлены БЕЗ ownerPubkey
// в индексе — при мультиаккаунте на одном устройстве второй локальный аккаунт видел бы
// чужие каналы/ключи. Эти таблицы НИКОГДА не использовались кодом (объявлены с этапа 1,
// не заполнялись) — переопределение без риска миграции данных. channelTopics (была
// отдельной таблицей channelId→topic) сворачивается в поле channels.channelTopic —
// тот же список получаем через channels.where('ownerPubkey'), обратный запрос
// (topic→канал) — через индекс channelTopic той же таблицы, отдельная таблица не нужна.
db.version(5).stores({
  channels: "[ownerPubkey+id], ownerPubkey, channelTopic",
  channelKeys: "[ownerPubkey+channelId+keyVersion], [ownerPubkey+channelId]",
  channelKeyMeta: "[ownerPubkey+channelId]",
  commentAllowlists: "[ownerPubkey+channelId+keyVersion], [ownerPubkey+channelId]",
  channelTopics: null
});

// Этап 31 — тот же класс пробела, найденный рассуждением ДО кода (не постфактум), что
// этап 30 уже исправил для channels/channelKeys/...: posts/comments в version(1) были
// объявлены БЕЗ ownerPubkey. Никогда не использовались кодом — переопределение без
// риска миграции.
db.version(6).stores({
  posts: "[ownerPubkey+id], [ownerPubkey+channelId+createdAt], deleted",
  comments: "[ownerPubkey+id], [ownerPubkey+postId], deleted"
});

// Этап 32 — общий чат канала. Owner-scoped с рождения (паттерн из этапов 25-31
// уже усвоен — не откладываем правильную схему на потом).
db.version(7).stores({
  channelMessages: "[ownerPubkey+id], [ownerPubkey+channelId+createdAt]"
});

// Этап 33 — модерация. channelReaders: аддитивная правка контракта этапа 30
// (createChannel теперь персистит, кому realistically выдан VIEW — нужно banMember,
// чтобы переиздать ключ ВСЕМ оставшимся). channelMessages не меняет primary key
// (аддитивно) — получает поле deleted (не индексируется, фильтрация в памяти,
// тот же паттерн, что posts/comments).
db.version(8).stores({
  channelReaders: "[ownerPubkey+channelId+readerPubkey], [ownerPubkey+channelId]",
  channelReports: "[ownerPubkey+id], [ownerPubkey+channelId], viewed",
  channelIgnores: "[ownerPubkey+channelId+ignoredPubkey], [ownerPubkey+channelId]",
  bannedMembers: "[ownerPubkey+channelId+pubkey], [ownerPubkey+channelId]"
});

// Этап 34 — настройки (kind 30072, F-SY-03). Один blob на аккаунт, голый
// ownerPubkey — сам по себе owner-scoped (тот же приём, что deviceIdentity/
// ownKeyPackage), составной ключ не нужен, т.к. это не коллекция записей.
db.version(9).stores({
  uiSettings: "ownerPubkey"
});

// Этап 36 — отзыв VIEW при выходе из группы (DESIGN.md). Снимок "какие группы
// дали каналу видимость при создании" — без этого removeGroupMemberAction не
// может узнать, на какие каналы вообще влияет выход из группы. Обратный индекс
// [ownerPubkey+groupId] — findChannelIdsByVisibilityGroup без полного скана channels.
db.version(10).stores({
  channelVisibilityGroups: "[ownerPubkey+channelId+groupId], [ownerPubkey+channelId], [ownerPubkey+groupId]"
});

// НАЙДЕНО РЕАЛЬНЫМ ИСПОЛЬЗОВАНИЕМ (пользователь, мультиаккаунт в разных вкладках
// одного браузера/origin) — clock (Lamport-часы, этап 19) НИКОГДА не был owner-scoped,
// в отличие от messages/mlsGroups/ownKeyPackage/chatSyncState (db.version(4)) и
// channels/channelKeys/... (db.version(5)/(6)) — тот же класс пробела, пропущенный
// при том рефакторинге. Один глобальный {id:'lamport'} на ВСЁ устройство означал, что
// computeInitialLamportValue() (lamport.js) искала max(lamportTs) по messages ВСЕХ
// локальных аккаунтов разом, а persistLamportValue() писала в ОДНУ строку — второй
// локальный аккаунт (второй пользователь переписки, открытый в соседней вкладке)
// перетирал тики первого, путая сортировку истории чата (то же следствие, что
// найденный на этапе 19-25 баг "часы не синхронизировались", только через другой
// канал — общий персист вместо отсутствующего receive()).
db.version(11).stores({
  clock: "[ownerPubkey+id]"
});

// Этап 43 — переопределяет мёртвую attachments (объявлена с этапа 1, никогда не
// читалась/писалась) под owner-scoped кэш расшифрованных вложений (CONTRACTS.md/DESIGN.md).
db.version(12).stores({
  attachments: "[ownerPubkey+sha256], ownerPubkey, lastAccessedAt"
});

// Этап 46 — раздел "Обзор" (CONTRACTS.md/DESIGN.md). discoverySettings — локальное
// зеркало СВОЕГО выбора видимости (тот же бутстрап-принцип, что uiSettings — не ждать
// relay round-trip, чтобы открыть свой тумблер). discoveryProfiles — локальный кэш ЧУЖИХ
// discovery-broadcast'ов (kind 30073, публичный по определению — шифровать локальную
// копию публичного смысла нет). outgoingAcquaintanceRequests — присутствие строки САМО
// является состоянием "заявка ещё не отменена/не принята" (DESIGN.md, этап 46) —
// голые pubkey, тот же класс, что groupMembers/contacts на Tier 2, не шифруется.
db.version(13).stores({
  discoverySettings: "ownerPubkey",
  discoveryProfiles: "pubkey",
  outgoingAcquaintanceRequests: "[owner+targetPubkey], owner"
});

// Этап 47 — гибкие уведомления (CONTRACTS.md/DESIGN.md). channelSyncState объявлена
// с этапа 1, ни разу не использована (мёртвый код, класс находки — как attachments
// до этапа 43) и была БЕЗ owner-scoping (голый channelId — тот же класс пробела, что
// clock/messages до соответствующих правок). Оживлена под read-tracking каналов —
// ОДИН общий курсор на канал (posts+comments+chat вместе), не три отдельных.
db.version(14).stores({
  channelSyncState: "[ownerPubkey+channelId]"
});

export async function resetLocalDatabase() {
  await db.delete();
}
