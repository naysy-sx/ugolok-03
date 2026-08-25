import Dexie from "dexie";
import { logInfo } from "../diag/boot-log.js";

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

// Этап 49 — единая таблица состояний контакта/заявки (CONTACTS-FSM.md §3),
// заменяет structurally contacts/contactRequests/blockedContacts/
// outgoingAcquaintanceRequests (те остаются в схеме нетронутыми до
// переноса — миграция отложена до unlock, см. contact-runtime.js,
// contactRequests зашифрована и нечитаема без dbKey в момент upgrade).
db.version(15).stores({
  contactRelationships: "[owner+peer], [owner+state]"
});

// Этап 50 — фича "Журнал" (персистентный лог уведомлений, CONTACTS-FSM.md
// §7). `id` — глобально уникальный uuid, отдельный owner-составной ключ не
// нужен; `owner` и `[owner+createdAt]` — индексы под "список для владельца"
// и "сортировка по времени" (read — plaintext-флаг, фильтр по нему в памяти,
// объём таблицы для персонального мессенджера невелик).
db.version(16).stores({
  journalEntries: "id, owner, [owner+createdAt]"
});

// Этап 53 — раздел "Файлы" (CONTRACTS.md, §4.4 TASK.md). Owner-scoped
// составные ключи — тот же принцип, что contacts/groups/attachments:
// несколько локальных аккаунтов в одной вкладке не должны видеть чужие
// узлы/манифесты/миниатюры даже при совпадении digest. files_nodes хранит
// LWW-регистры РАЗВЁРНУТО по столбцам (par*/name*/origin* отдельно), не
// вложенным JSON — тот же стиль, что уже принят для похожих плоских
// табличных состояний в проекте (permissions/effectivePerms). Поля пока НЕ
// проходят через AC-16 Tier-классификацию (шифрование по полям) — по
// прямому прецеденту проекта: похожие таблицы (permissions, mlsGroups)
// тоже добавлялись сначала плейнтекстом, Tier-шифрование — отдельный
// последующий этап (см. этапы 39-42 в log.md), не смешивается с этой
// работой.
db.version(17).stores({
  files_nodes: "[ownerPubkey+id], ownerPubkey",
  files_mounts: "[ownerPubkey+nodeId], ownerPubkey",
  files_manifests: "[ownerPubkey+digest], ownerPubkey",
  files_blobs: "[ownerPubkey+digest+chunkIndex], ownerPubkey, digest",
  files_thumbs: "[ownerPubkey+digest], ownerPubkey"
});

// Найдено при реализации миниатюр (этап 53, И3 3.8): content.putStream
// возвращает fileKey ОТДЕЛЬНЫМ полем (CONTRACTS.md — "персистентность вне
// ответственности content.js"), но ничто до сих пор не сохраняло его —
// после перезагрузки страницы файл стал бы НЕРАСШИФРОВЫВАЕМ НАВСЕГДА
// (ключ нигде, кроме памяти на момент putStream). files_keys закрывает
// именно это — ключ владельца на своё же содержимое (не путать с share.js/
// И6: там обёртки ключа ДЛЯ КОНТАКТОВ, здесь — обычный доступ владельца).
// Шифруется dbKey перед записью (тот же приём, что domain/attachments/
// cache.js) — это симметричный ключ РАСШИФРОВКИ файла, самая чувствительная
// вещь во всём модуле, хранить в открытом виде в IndexedDB недопустимо.
db.version(18).stores({
  files_keys: "[ownerPubkey+digest], ownerPubkey"
});

// Этап 53 И6 (CONTRACTS.md/DESIGN.md) — шаринг и монтирование, по прямому
// образцу channelKeys/channelKeyMeta/channelReaders (этапы 30/33).
// files_shares/files_shareKeys — ownerPubkey ЗДЕСЬ означает "владелец
// ДОЛИ" (тот, кто расшарил); зашифрованы dbKey, тот же приём, что
// files_keys (subtreeKey — чувствительный симметричный ключ).
// files_shareGrantees — список текущих читателей доли, НЕ шифруется
// (тот же прецедент, что channelReaders — "голые" pubkey-списки, не
// Tier-чувствительны).
//
// Сторона ПОЛУЧАТЕЛЯ (mount.js) — ownerPubkey в таблицах ниже означает
// ПОЛУЧАТЕЛЯ, не владельца доли. files_mounts (уже объявлена, version(17))
// хранит саму запись Mount (owner/rootId/currentVersion). files_mountKeys —
// СВОЯ копия ключей по версиям (получатель может накопить НЕСКОЛЬКО версий:
// revoke ДРУГОГО читателя той же доли ротирует ключ и переиздаёт ЭТОМУ
// получателю тоже — та же форма, что files_shareKeys на стороне владельца).
// files_mount_nodes — СОБСТВЕННОЕ CRDT-состояние смонтированной доли
// (nodeId — узел-ссылка в ЕГО дереве, id — узел ВНУТРИ Mount.state),
// по прямому образцу files_nodes (та же форма строки, тот же
// nodeToRow/rowToNode) — НЕ смешивается с files_nodes того же владельца
// (ALGO.MD §4.3: "исчезает как класс" открытая задача частичной видимости
// именно потому, что состояния разделены).
db.version(19).stores({
  files_shares: "[ownerPubkey+nodeId], ownerPubkey",
  files_shareKeys: "[ownerPubkey+nodeId+version], [ownerPubkey+nodeId]",
  files_shareGrantees: "[ownerPubkey+nodeId+granteePubkey], [ownerPubkey+nodeId]",
  files_mountKeys: "[ownerPubkey+nodeId+version], [ownerPubkey+nodeId]",
  files_mount_nodes: "[ownerPubkey+mountId+id], [ownerPubkey+mountId]"
});

// Этап 53 И6, задача 6.6b (CONTRACTS.md) — сайдкар для деривации fileKey
// файлов ВНУТРИ доли. plaintextDigest едет ТРАНЗИТНО в create-опе
// (encryptSubtreeOp, уже зашифрованный канал) — tree.js's Node-тип его не
// хранит (applyOp/mkNode его не читают, контракт И1 не меняется), поэтому
// получателю нужно ОТДЕЛЬНОЕ место, иначе deriveShareFileKey нечем будет
// вызвать при следующем открытии приложения. НЕ шифруется — тот же
// прецедент, что files_mount_nodes (version(19) выше): структурные
// метаданные дерева доли в этой сессии не шифруются целиком, plaintextDigest
// без subtreeKey доступа к содержимому не даёт.
db.version(20).stores({
  files_mount_file_meta: "[ownerPubkey+mountId+id], [ownerPubkey+mountId]"
});

// Этап 72 — учёт уже добавленных в MLS-группу устройств КОНТАКТА (не своих
// собственных — для тех уже есть knownDevices, version(3)), чтобы реактивная
// досинхронизация (devices.js) не пыталась добавить одно и то же устройство
// контакта повторно. Не шифруется — тот же прецедент, что knownDevices:
// KeyPackage и так публичен на relay, локальную копию нечем защищать.
db.version(21).stores({
  knownContactDevices: "[ownerPubkey+contactPubkey+deviceId], [ownerPubkey+contactPubkey]"
});

// Этап 73.3 — И3 (единственный коммиттер): исходящие, накопленные
// проигравшей стороной, пока коммиттер не создал группу (DESIGN.md,
// "Этап 73"). Шифруется через toEncryptedRow/PENDING_OUTGOING_MESSAGES_
// PLAINTEXT_FIELDS — только ownerPubkey/contactPubkey/lamportTs plaintext
// (составной индекс).
db.version(22).stores({
  pendingOutgoingMessages: "[ownerPubkey+contactPubkey+lamportTs], [ownerPubkey+contactPubkey]"
});

// Этап 74 — T2.3 (RC-3, CONTRACTS.md/DESIGN.md "Этап 74"): межвкладочная
// дедупликация обработки kind:445 — withGroupLock делает конкурентную
// обработку БЕЗОПАСНОЙ, но без этого журнала второй processMessage того же
// wire-события упал бы на replay-защите MLS и засчитался бы decrypt failure.
// eventId уже публичен на relay — не Tier-чувствителен, но toEncryptedRow
// применяется по прецеденту всех остальных таблиц (единообразие).
db.version(23).stores({
  processedGroupEvents: "[ownerPubkey+eventId], [ownerPubkey+firstSeenAt]"
});

// Этап 74 — Часть B, T5.2 (CONTRACTS.md/DESIGN.md "Этап 74"): персист
// профилей контактов (P-2 — раньше жили только в памяти, holodный старт
// офлайн показывал инициалы). Составной индекс — единственные plaintext-
// поля (нужны для .get([owner,contact])/.where("ownerPubkey")-гидратации
// при старте); name/about/picture/createdAt/id — содержательные, шифруются.
db.version(24).stores({
  contactProfiles: "[ownerPubkey+contactPubkey], ownerPubkey"
});

// Редизайн интерфейса, этап 1 (CONTRACTS.md) — признаки записи (dueAt/done/
// title/linkUrl, dueAt/done открыты). posts переопределена целиком (Dexie
// требует полный список индексов таблицы при изменении хотя бы одного) —
// добавлен [ownerPubkey+dueAt] для этапа 4 ("Сегодня": выборка по сроку без
// полного перебора). Индекс по done не заводится — записей со сроком мало,
// фильтрация done !== true в памяти.
db.version(25).stores({
  posts: "[ownerPubkey+id], [ownerPubkey+channelId+createdAt], deleted, [ownerPubkey+dueAt]"
});

// Редизайн интерфейса, этап 5 (CONTRACTS.md) — chatActivity: одна строка на
// [ownerPubkey+chatId], только ПОСЛЕДНЕЕ событие переписки (не история) —
// свежесть для сортировки боковой панели (этап 10). Индекс "ownerPubkey" —
// гидратация списка переписок аккаунта, сортировка по lastAt в памяти (тот
// же приём, что listChatPartners: объём — число переписок, не сообщений).
db.version(26).stores({
  chatActivity: "[ownerPubkey+chatId], ownerPubkey"
});

// Редизайн интерфейса, этап 6 (CONTRACTS.md) — закреплённое (каналы+люди),
// одна строка на аккаунт, тот же принцип, что uiSettings/discoverySettings.
db.version(27).stores({
  pinned: "ownerPubkey"
});

db.on("ready", () => {
  logInfo(`база данных открыта, схема ${db.verno}`);
});

export async function resetLocalDatabase() {
  await db.delete();
}
