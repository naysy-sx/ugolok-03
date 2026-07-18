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
  // Правка находки: version(1)'s inboxRequests (bare "id") не был owner-scoped — тот же
  // класс пробела, что contactRequests УЖЕ исправил в этапе 24 (мультиаккаунт на одном
  // устройстве иначе схлопывает pending-запросы разных владельцев в одну строку). Таблица
  // не использовалась нигде до этого этапа (мёртвая с этапа 3) — переопределение безопасно,
  // данных к миграции нет. createdAt (camelCase) — для единообразия с contactRequests,
  // было created_at (единственное расхождение стиля во всей схеме).
  inboxRequests: "[owner+senderPubkey], owner, senderPubkey, createdAt"
});
