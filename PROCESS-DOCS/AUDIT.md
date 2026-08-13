# Архитектурный аудит: события, транспорт, гапы M2/M5/M6, каналы

Дата: 2026-08-13. Снимок кодовой базы: коммит `5153bd9` (main), после закрытия
этапа 74 целиком (M3-класс для контента каналов, self-sync видимости,
retroactive-грант, republish постов, уведомление о недоступной истории,
гейт уведомлений по роли, сериализация retry).

Методология: исследование, не изменение кода. Блоки 1-3 собраны тремя
параллельными агентами (Explore, каждый в изолированном `git worktree`);
там, где worktree-снимок разошёлся с текущим HEAD (версии Dexie 23-24,
`channelVisibilityGroups`-rebuild, kind:3009 — всё добавлено в этой же
сессии до запуска агентов), факты перепроверены лично и исправлены на
актуальные. Блок 4 написан напрямую, без агента — весь материал уже был
в рабочем контексте этой сессии.

---

## Блок 1 — необратимость: реестр kind-событий и схема IndexedDB

### 1.1. Регулярные события (regular, вне диапазонов replaceable/addressable)

| Kind | Теги | Файл:строка (builder) | Назначение |
|---|---|---|---|
| 3001 | нет | `domain/contacts/requests.js:1-5` | Заявка в контакты (rumor через kind:1059) |
| 3002 | `channel_id` | `domain/content/channel-access.js:13,23-25` | Заявка на подписку канала (rumor) |
| 3003 | `channel_id`,`target`,`content_type`,`content_id`,`reason` | `domain/content/moderation.js:22,32-45` | Жалоба на контент/игнор (rumor) |
| 3004 | нет | `domain/contacts/requests.js:16-20` | Заявка в контакты принята (rumor) |
| 3005 | нет | `domain/contacts/requests.js:25-29` | Заявка в контакты отозвана (rumor) |
| 3006 | нет | `domain/contacts/requests.js:35-39` | Заявка в контакты отклонена (rumor) |
| 3007 | нет | `domain/files/sync.js:14,16-20` | Файлы: журнал операций (self, NIP-44) |
| 3007 | нет | `domain/content/channel-access.js:23` | **Численная коллизия с предыдущей строкой** — `CHANNEL_UNVIEW_KIND`, уведомление об отзыве VIEW (rumor) |
| 3008 | `h` (rootId доли) | `domain/files/share.js:21,73-78` | Файлы: журнал операций внутри расшаренной доли |
| 3009 | нет | `domain/content/channel-access.js:35` | **Этап 74** — уведомление о недоступности старой истории комментариев (rumor) |
| 443 | `device` | `domain/messaging/chat.js:105-114` | MLS: анонс KeyPackage устройства |
| 444 | `contact` (опц.) | `chat.js:190-195`, `devices.js:80-85,129` | MLS: Welcome (rumor через kind:1059) |
| 445 | `h` (groupId) | `chat.js:273-276`, `devices.js:69-73,123-127` | MLS: application message/commit, подписан эфемерным ключом |
| 446 | `h` (groupId) | `messaging/mirror.js:4,29-36` | Зеркало истории (multi-device), отдельный статический mirrorKey, не MLS-ратчет |
| 5 | `a`=`{kind}:{pubkey}:{dTag}` + extraTags | `domain/events/handlers.js:70-74` | NIP-09 адресуемое удаление (постов/каналов/групп) |
| 22242 | `relay`,`challenge` | `core/transport/relay-auth.js:5-18` | NIP-42 relay AUTH — формально ephemeral (20000-29999) |
| 24242 | `t`,`x`,`expiration` | `core/transport/blossom-client.js:7-15,25` | Blossom HTTP-авторизация — НЕ публикуется на relay, кодируется в HTTP-заголовок |
| 5051 | `d`=opaque HMAC (`subject:resource`) | `domain/events/handlers.js:14-22` | Права доступа (permission record) — **см. 1.7, несоответствие NIP-01** |

**Найдена реальная численная коллизия kind:3007** между `domain/files/sync.js` (журнал файловых операций) и `domain/content/channel-access.js` (`CHANNEL_UNVIEW_KIND`, добавлен на этапе 74 части сессии, ДО того как я выбирал номер 3009 для нового rumor'а). Оба — приватные gift-wrap rumor'ы, диспетчер (`giftWrapSubscriber`, `transport.js:412-538`) различает их по `rumor.kind ===`-ветвлению, так что на практике конфликта нет (разные ветки switch/if), но при добавлении новых приватных kind'ов номер стоит выбирать по централизованному реестру, а не локально в доменном файле — сегодня такого реестра нет (см. 1.7 и рекомендацию в конце блока).

### 1.2. Replaceable (kind 0, 3, 10000-19999)

| Kind | Теги | Файл:строка | Назначение |
|---|---|---|---|
| 0 | нет | `identity/profile.js:14-22` | Профиль |
| 3 | `p`×N | `contacts/contacts.js:3-11` | Публичный контакт-лист |
| 10000 | `p`×N | `contacts/contacts.js:32-40` | Мьют-лист |
| 10002 | `r` (url[,marker]) | `identity/relay-list.js:13-21` | Relay-список (NIP-65) |
| 10050 | `relay`×N | `identity/dm-relay-list.js:7-15` | DM relay list (упрощённый NIP-17-подобный "куда мне слать") |
| 10051 | — | `domain/events/kinds.js:4` | **Объявлена, не публикуется нигде** — мёртвая константа (`KIND_MLS_KEY_PACKAGE_RELAYS`) |

### 1.3. Ephemeral (20000-29999)

| Kind | Теги | Файл:строка | Назначение |
|---|---|---|---|
| 20075 | `p` (peerPubkey) | `domain/calls/signaling-adapter.js:8,13-18` | Сигналинг звонков (offer/answer/ice/hangup внутри NIP-44 content) |
| 22242 | см. 1.1 | `relay-auth.js` | NIP-42 AUTH |
| 24242 | см. 1.1 | `blossom-client.js` | Blossom auth (не на relay) |

### 1.4. Addressable / parameterized-replaceable (30000-39999)

| Kind | Теги | Файл:строка | Назначение |
|---|---|---|---|
| 30050 | `d`=groupId | `contacts/groups.js:6-12` | Группа контактов (self) |
| 30053 | `d`=opaque HMAC, `p`=readerPubkey | `content/channel-access.js:45-54` | VIEW-грант канала |
| 30054 | `d`=opaque HMAC, `h`=channelTopic | `core/crypto/comment-allowlist.js:10-25` | Allowlist комментаторов |
| 30060 | `d`=channelId, `h`=channelTopic | `content/channel.js:40-55` (create), `:248-259` (edit) | Метаданные канала |
| 30061 | `d`=`{channelId}:{postId}`, `h` | `content/post.js:74-85`, `:222-244` (republish при ротации, этап 74) | Пост |
| 30062 | `d`=`{postId}:{commentId}`, `h` | `content/comments.js:30-41` | Комментарий |
| 30063 | `d`=`{channelId}:{messageId}`, `h` | `content/channel-chat.js:29-40` | Общий чат канала |
| 30064 | `d`=`{channelId}:ban:{target}`, `h` | `content/moderation.js:18,128-140` | Бан (шифруется v_OLD ключом) |
| 30065 | `d`=channelId | `content/channel-visibility.js:46` | **Этап 74** — self-sync видимости канала (полный набор groupIds) |
| 30070 | `d`=chatId | `messaging/read-status.js:12-18` | Read-статус 1:1-чата |
| 30071 | `d`=chatId | `messaging/drafts.js:10-16` | Черновик 1:1-чата |
| 30072 | `d`="settings" | `settings/ui-settings.js:19,110-114` | UI-настройки (self) |
| 30073 | `d`="discovery" | `discovery/discovery.js:5,7-14` | Настройки "Обзора" (публичный plaintext) |
| 30074 | `d`=channelId | `content/channel-read-status.js:10,12-18` | Read-статус канала |
| 30075 | `d`=opaque HMAC, `p`=readerPubkey | `files/share.js:17,88-97` | Грант доступа к доле файлов |

### 1.5. Gift-wrap (kind:1059) — приватные rumor'ы

Обёртка — `core/crypto/nip59.js:1-9` (тонкая обёртка над `nostr-tools/nip59`'s `wrapEvent`). Внутренние rumor-kind'ы: 3001, 3002, 3003, 3004, 3005, 3006, 3007 (unview), 3009, 444. Диспетчеризация входящих — `transport.js:412-538` (`giftWrapSubscriber`), подписка `{"#p":[pubkeyHex], kinds:[1059]}`.

### 1.6. Синтетические/бенчмарк kind (НЕ production)

`domain/events/synthetic-fixtures.js` — kind 0, rumor 14 (нигде больше не используется), kind 30051 ("permission-proxy", НЕ совпадает с реальным 5051), kind 30061 (фиктивный d-tag). Артефакты P-SPIKE бенчмарка, не реальный протокол.

### 1.7. kind 5051 — несоответствие NIP-01

`buildPermissionEvent` (`events/handlers.js:14-22`) использует `d`-тег как parameterized-replaceable семантику ("новое событие с тем же d заменяет предыдущее"), но 5051 численно попадает в диапазон **regular** (1000-9999), не addressable (30000-39999). Relay формально не обязан схлопывать его по d-тегу. Код это компенсирует сам: `rebuildEffectivePermissions` (`handlers.js:31-48`) хранит полную историю всех 5051-событий и вручную LWW-фолдит через `createPermissionRecord`/`rebuildCache`, не полагаясь на relay-side дедупликацию — рабочее, но нестандартное решение.

### 1.8. Версионирование формата события

**Отрицательный факт: ни один production-kind не содержит поля версии JSON-схемы (`version`/`v`) внутри `content`.** Профиль (`{name,about,picture}`), группы (`{name,memberPubkeys}`), метаданные канала, посты/комментарии/чат — только доменные поля, без версии схемы. Эволюция формата на практике решается:
- **Опциональностью полей** — MLS application message (`chat.js:243-244`): `attachment` добавляется условно, `sentAt` — feature-detection по `!== undefined` (комментарий `chat.js:398-401` прямо это объясняет: старые сообщения этих полей не несут).
- **Мёрджем с дефолтами** — `ui-settings.js`'s `mergeWithDefaults` (`:93-108`) глубоко мёрджит прочитанные настройки с `DEFAULT_SETTINGS`, старые записи без новых полей дополняются дефолтами при чтении.

**Не путать с версией КЛЮЧА канала** (`channelKeyVersion`) — реальный, отдельный механизм: `encryptChannelContent(plaintext, channelKeyHex, version)` кодирует номер версии ключа как 4 байта в начале base64-blob (`comment-allowlist.js:45-48`, `readVersionForDecrypt`). Относится ТОЛЬКО к тому, каким симметричным ключом шифровать/расшифровывать, никак не отражает версию JSON-схемы полезной нагрузки. Тот же принцип у `files/share.js` (subtreeKey version).

**Вывод:** в проекте есть версионирование КЛЮЧА (канал, файловая доля), но нет версионирования ФОРМАТА данных внутри content. При будущей смене схемы полей внутри уже существующего kind придётся полагаться на опциональность полей или писать миграцию на лету при чтении, не на явный version-переключатель.

### 1.9. Версии схемы IndexedDB (Dexie) и миграции

`src/core/store/database.js`, 24 вызова `db.version(N).stores({...})`:

| V | Строка | Добавлено/изменено | Комментарий (начало) |
|---|---|---|---|
| 1 | `:4-30` | Базовые таблицы (events, contacts, groups, channelKeys, messages, channels, posts, comments, mlsGroups и др.) | — |
| 2 | `:35-38` | +ownKeyPackage, +contactRequests | "Этап 24 — аддитивно" |
| 3 | `:48-54` | +deviceIdentity, +knownDevices; messages переопределена (composite unique key) | "Этап 25 — multi-device" |
| 4 | `:70-76` | Owner-scoping ownKeyPackage/mlsGroups/messages/chatSyncState | "критический пробел этапов 13/24/25/26" |
| 5 | `:87-93` | Owner-scoping channels/channelKeys/channelKeyMeta/commentAllowlists; channelTopics удалена | "Этап 30" |
| 6 | `:99-102` | Owner-scoping posts/comments | "Этап 31" |
| 7 | `:106-108` | +channelMessages | "Этап 32 — общий чат канала" |
| 8 | `:115-120` | +channelReaders,+channelReports,+channelIgnores,+bannedMembers | "Этап 33 — модерация" |
| 9 | `:125-127` | +uiSettings | "Этап 34" |
| 10 | `:133-135` | +channelVisibilityGroups | "Этап 36 — отзыв VIEW" |
| 11 | `:148-150` | clock owner-scoped | "мультиаккаунт в разных вкладках" |
| 12 | `:154-156` | attachments переопределена | "Этап 43" |
| 13 | `:165-169` | +discoverySettings,+discoveryProfiles,+outgoingAcquaintanceRequests | "Этап 46 — Обзор" |
| 14 | `:176-178` | channelSyncState owner-scoped | "Этап 47 — гибкие уведомления" |
| 15 | `:185-187` | +contactRelationships (единая FSM-таблица) | "Этап 49" |
| 16 | `:194-196` | +journalEntries | "Этап 50 — Журнал" |
| 17 | `:210-216` | +files_nodes,+files_mounts,+files_manifests,+files_blobs,+files_thumbs | "Этап 53 — Файлы" |
| 18 | `:228-230` | +files_keys | "миниатюры, этап 53 И3 3.8" |
| 19 | `:253-259` | +files_shares,+files_shareKeys,+files_shareGrantees,+files_mountKeys,+files_mount_nodes | "Этап 53 И6 — шаринг" |
| 20 | `:270-272` | +files_mount_file_meta | "Этап 53 И6, 6.6b" |
| 21 | `:279-281` | +knownContactDevices | "Этап 72" |
| 22 | `:288-290` | +pendingOutgoingMessages | "Этап 73.3 — И3" |
| 23 | `:298-300` | +processedGroupEvents | "Этап 74 — T2.3 (RC-3) — межвкладочная дедупликация kind:445" |
| 24 | `:307-309` | +contactProfiles | "Этап 74 — Часть B, T5.2 — персист профилей контактов" |

`resetLocalDatabase()` — полное удаление БД (`db.delete()`).

### 1.10. Перестраиваемые vs неперестраиваемые сторы

**Явные `rebuild*`-функции (state полностью восстанавливается replay'ем `db.table('events')`):**

| Функция | Восстанавливает | Источник (kind) |
|---|---|---|
| `rebuildGroups` (`events/handlers.js:81-110`) | groups, groupMembers | 30050 + kind:5 удаления |
| `rebuildEffectivePermissions` (`events/handlers.js:31-48`) | effectivePerms | 5051 |
| `rebuildUiSettings` (`settings/ui-settings.js:170-175`) | uiSettings | 30072 |
| `rebuildReadStatus` (`messaging/read-status.js:66-79`) | chatSyncState.lastReadLamportTs | 30070 |
| `rebuildChannelReadStatus` (`content/channel-read-status.js:79-92`) | channelSyncState | 30074 |
| `rebuildChannelVisibilityGroups` (`content/channel-visibility.js:76`, **этап 74**) | channelVisibilityGroups | 30065 |
| `rebuildFilesLog` (`ui/signals/files.js:171-`) | Дерево файлов (in-memory) | 3007 (файловый), ленивый — только если экран "Файлы" уже открывался |
| `reconcileContactsFromEventLog` (`ui/signals/contacts.js:123-135`) | contactRelationships | kind 3 и 10000 |

Все (кроме ленивого `rebuildFilesLog`) вызываются из `transport.js` при `connect()`.

**Найденная недособранность:** `foldDraft` (`messaging/drafts.js:32-38`) вызывается ТОЛЬКО из `saveDraft` (то же устройство) — нет вызова из bootstrap/connect. Черновики 1:1-чата (kind 30071) публикуются на relay, но `chatSyncState.draftText` не синхронизируется на другие устройства.

**Перестраиваемы относительно** (через живую resubscribe без `since`, receive*-обработчики в transport.js, не через `db.table('events')`-rebuild): `channels`, `channelKeys`, `channelKeyMeta`, `commentAllowlists`, `posts`, `comments`, `channelMessages`, `bannedMembers` (частично).

**НЕ перестраиваемые (единственный источник истины — сама таблица):**

| Таблица | Почему |
|---|---|
| `channelReaders` | Локальная бухгалтерия владельца ("кому я выдал VIEW"), пишется только при локальной публикации гранта (грант шифруется ПОД читателя, не под owner) — нет receive-пути |
| `channelIgnores`, `channelReports` | Из gift-wrap kind 3003 — rumor'ы не хранятся в `events`-таблице (giftWrapSubscriber диспетчеризирует на лету, без `db.table("events").add`) |
| `mlsGroups` | Forward secrecy — состояние ратчета невосстановимо replay'ем, приватный KeyPackage не публикуется |
| `ownKeyPackage` | Приватная половина никогда не публикуется |
| `pendingOutgoingMessages` | Чисто client-side буфер, не публикуется как событие |
| входящие заявки (contact/channel) | Только через gift-wrap kind:1059, тот же класс, что channelIgnores выше |
| `journalEntries` | Локальный аудит-журнал "что реально показано", не прямое отражение одного kind |
| `chatSyncState.draftText` | См. `foldDraft`-пробел выше |

`channelVisibilityGroups` — **больше не в списке неперестраиваемых**: этап 74 (текущая сессия) добавил `rebuildChannelVisibilityGroups`/kind:30065 self-sync — таблица перестала быть неперестраиваемой.

---

## Блок 2 — транспорт: выбор relay

**Главный вывод**: проект уже не на стадии "жёстко один relay". За этапы 58-61 реализована существенная часть per-recipient маршрутизации — но **только для публикации (write)**, и только для событий с тегом `#p`. Сторона чтения (subscribe) остаётся полностью привязанной к собственному пулу relay.

### 2.1. Где принимается решение "куда публиковать / откуда читать"

**Создание/выбор WS-соединения:**
- `core/transport/relay-pool.js:36` — `createRelayConnection(url, options)` — FSM-обёртка над одним `new WebSocket(url)`.
- `relay-pool.js:138` — `createRelayPool(entries, options)` — пул из нескольких `createRelayConnection` (по одному на `{url,read,write}`), реализует тот же интерфейс, что одиночное соединение — остальной код "не отличает пул от одного соединения" (осознанный инвариант).
- `relay-pool.js:273` — `publishToRelay(url, event)` — эфемерное одноразовое соединение на конкретный url. Это и есть механизм "отправить именно на relay получателя".
- `relay-pool.js:322` — `fetchFromRelay(url, filters)` — симметричный одноразовый REQ+EOSE на конкретный url.
- Главное постоянное соединение сессии: `ui/signals/transport.js:290` — `connection = createRelayPool(relayEntries,{...})` внутри `connect()`. Module-level `connection` (`:89`) — синглтон на вкладку/сессию.
- Второй, независимый потребитель `createRelayConnection`: `ui/screens/diagnostics.jsx:569` — своё отдельное одноразовое соединение (самопроверка), не к основному пулу.

**`publish(event)` — куда уходит:**
- `publish(event)` (`transport.js:724-732`) — пишет на ВСЕ write-relay своего пула. Если есть тег `#p` (`:729`), дополнительно fire-and-forget вызывает `deliverToInboxRelays(recipientTag[1], event)` (`:730`) — тянет kind:10050 получателя через `fetchInboxRelays` (`:672-699`, REQ к СВОЕМУ пулу) и публикует туда через `publishToRelay` (`:711`).
- `publishToContact(event, contactPubkeyHex)` (`transport.js:738-745`) — то же для событий без `#p` (kind:445, адресация по `#h`), используется в `chat.jsx:263`.

Личные сообщения, gift-wrap rumors, channel-гранты (kind:30053, несёт `#p`) уже публикуются per-recipient — на relay получателя, в дополнение к своим. Ограничения: best-effort/fire-and-forget (результат не влияет на статус); определение "куда получателя" только через kind:10050 (упрощённый inbox-list, не полноценный NIP-65 outbox по write-relay из чужого kind:10002); кэш `inboxRelayCache` (TTL 5 мин, `:186`).

**REQ-подписки — всегда с одного соединения:** все 18 вызовов `createSubscriber(...)` (16 в `transport.js` + 2 в `core/sync/{bootstrap,incremental-sync}.js`) передают один и тот же module-level `connection`. Даже `fetchInboxRelays` (узнаёт relay получателя) сама делает REQ на СВОЙ пул (`:682`) — топология "один shared relay" пока это скрывает.

### 2.2. Откуда список relay

Три источника (`connect()`, `transport.js:250-300`):
1. Dexie `uiSettings.relayUrls: {url,read,write}[]` — первичный источник для существующего аккаунта.
2. Bootstrap-обнаружение через kind:10002 с bootstrap-relay — только если локальной записи ещё нет.
3. Build-time дефолт: `DEFAULT_RELAYS[0] ?? "ws://127.0.0.1:7777"` — из `src/config.js`, подставляется `vite.config.js` из `process.env.BUILD_DEFAULT_RELAYS`/`BUILD_BOOTSTRAP_RELAYS` (свой define-механизм, не `VITE_`/`import.meta.env`).

UI для смены relay-списка есть: `ui/screens/profile.jsx`, `RelayListEditor` — add/remove/toggle read-write. Публикует kind:10002 И kind:10050 при изменении, требует ручного `reconnectWithNewSettings`.

Итого: relay-URL не хардкод в одном месте — уже множественный список с UI-редактированием. "Один relay" сегодня — типичное содержимое списка, не архитектурное ограничение структуры данных.

### 2.3. kind:10002

Реализовано (публикация и парсинг): `identity/relay-list.js:13-21`/`:23-27` (build/parse, NIP-65-совместимые теги `['r',url]`/`['r',url,'read']`/`['r',url,'write']`). Публикуется при изменении списка и как backfill при каждом входе (`transport.js:340`, best-effort). **Читается/парсится ТОЛЬКО для собственного pubkey** (bootstrap) — нет ни одного места, где kind:10002 ЧУЖОГО pubkey читался бы для маршрутизации. Полноценного NIP-65 outbox-алгоритма нет; ближайший аналог — kind:10050 (упрощённый inbox-list).

### 2.4. Self-hosted server pairing

`domain/selfhost/pairing.js` + `ui-settings.js:275-294` — HTTPS admin-API отдельного сервера (TOFU-пейринг по fingerprint), используется для статуса стека и TURN-кредов звонков. НЕ relay, никак не связан с `relay-pool.js` — третий независимый канал.

### 2.5. Оценка объёма перехода на per-recipient маршрутизацию

**Уже есть**: write-путь частично готов; модель данных `relayUrls[]` уже множественная; kind:10002/10050 build/parse уже есть.

**Публикация**: ~35 вызовов `publish(...)` в ~24 файлах — но все идут через одну точку входа (`publish`/`publishToContact`), вызывающие места менять не придётся. Доработка сконцентрирована в ~3 функциях одного файла (`transport.js:672-745`).

**Подписки**: 18 вызовов `createSubscriber`, из них 7 именованных `refresh*Subscription` (профили, гранты каналов, контент каналов, файловые доли×2, групповые сообщения, зеркало) + giftWrap/callSignal/deviceAnnounce + 3 одноразовых REQ. Все 18 читают с одного module-level `connection` — per-recipient чтение не реализовано вообще, в отличие от write.

**Архитектурные допущения, зашитые глубоко (не точечные правки):**
1. Единственный module-level `connection` (`transport.js:89`) — от него зависят publish/publishToContact/все 16 createSubscriber/teardown/drainOutboxSafely.
2. `relay-pool.js`'s send() различает роли только "read/write своих relay", нет понятия "relay ЭТОГО получателя" в модели `entries[]`.
3. `publish()` определяет получателя эвристикой "один `#p`-тег = один получатель" — уже показала предел (kind:445 потребовал отдельного явного пути `publishToContact`).
4. Подписки не имеют понятия "прочитать с relay ДРУГОГО X" — переход на per-recipient READ требует нового функционального слоя (кэш "чьи events с какого relay читать", подмешивание REQ в дедупликацию, сегодня жёстко привязанную к одному пулу), не рефакторинга 18 мест.
5. `teardown()`/`reconnectWithNewSettings` пересоздают ВСЁ состояние разом при смене СВОЕГО relay-списка — модель "всё или ничего", не рассчитана на гранулярное управление per-peer соединениями.

**Итог**: write-сторона — небольшой инкремент поверх готового прототипа (1 файл, несколько функций). Read-сторона — заметно больше: 18 мест физически завязаны на единственный connection, и целого слоя "какой relay читать для X" не существует вообще — по объёму сопоставимо с уже сделанным на этапах 58-61 для write, но сложнее (постоянные подписки, не one-shot).

---

## Блок 3 — уточнение трёх гапов

### 3.1. М6 — что происходит после пометки "desynced"

**Где ставится флаг.** Порог `DESYNC_THRESHOLD = 3` (`chat.js:452`). `recordGroupDecryptFailure` (`chat.js:458-477`) инкрементирует `consecutiveDecryptFailures`, ставит `desynced: count >= 3`. Вызывается ТОЛЬКО из `retryBufferedGroupMessages` (`transport.js:1414`), когда буферная запись М3 окончательно истекла по TTL, ни разу не расшифровавшись — не на каждый единичный провал (тот — нормальная буферизация). Сброс — любой успешно расшифрованный kind:445 группы обнуляет счётчик (`chat.js:384-393`); успешная ОТПРАВКА сознательно не сбрасывает (не доказывает работоспособность приёма).

**Кто читает.** `listDesyncedChats` (`chat.js:479-482`) → `diagnostics.jsx:626-655` (`useDesyncedChats`) → раздел "Переписки" (`:836-862`), штатный пункт навигации, не скрытый dev-инструмент.

**Есть ли путь восстановления — да, не только индикация.** `recreateChatConversation` (`chat.js:489-493`) удаляет `mlsGroups`-запись и `knownContactDevices` для пары, вызывается по клику "Пересоздать" (`diagnostics.jsx:849-857`). Это НЕ автоматика и не полноценный re-handshake сама по себе — собственный комментарий кода (`chat.js:484-488`) это признаёт: "не решает, кто коммиттер — следующий `ensureChatEstablished` либо реактивный sibling-Welcome отработают тем же путём".

**Существенный практический нюанс (выведен логически, не прямая цитата):** `groupIdHex` детерминирован парой identity, не меняется при пересоздании. Если пересоздаёт только одна сторона, а вторая свою (desynced) запись не трогала — `acceptWelcome`'s `if (existing) return` (`chat.js:201-206`) молча проигнорирует новый Welcome от пересоздавшей стороны. Вероятно, реальное восстановление требует действия ОБЕИХ сторон — не проверено ни одним харнесс-тестом (`recreateChatConversation` тестами не покрыта).

### 3.2. М2 — харнесс и inter-identity гонка

**Харнесс уже достаточно общий.** `spawnDevice()`/`init({privKeyHex,relayUrl})` (`tests/harness/scenario.js:7-39`, `device.js:24-34`) identity-агностичны — любой процесс = изолированная "вкладка" с любым ключом и своей fake-indexeddb. `m1-repro.test.js` уже использует ТРИ процесса: Bob (одна identity) + AliceA1/AliceA2 (два устройства другой identity) — каркас "две разные identity" уже есть, M1-тест просто моделирует multi-device race одной из сторон поверх него.

**Чего не хватает:** формально новой инфраструктуры не требуется. Хелперы контролируемой задержки доставки (`pumpAll`/`pumpAllExcept`/`identifyNewConnId`) есть, но локальны `m1-repro.test.js`, не вынесены в `scenario.js` как переиспользуемые — стоило бы вынести для будущего `m2-repro.test.js`, не строгая необходимость.

**Найдена точная дыра в защите.** `ensureChatEstablished` (`chat.js:130-196`): И4-гейт (`hasAnyMessagesFor`, `:145-147`) не срабатывает при истинно первой переписке (0 сообщений у обоих). И3 committer-гейт (`isCommitter`, `:157-159`) применяется, только если `isKnownContact` — и это **прямо прокомментированное в коде намеренное исключение** (`chat.js:149-156`): "холодное обращение к незнакомцу (isKnownContact false) остаётся БЕЗ ГЕЙТА, старое поведение". `isKnownContact` (`inbox-requests.js:13-16`) проверяет `contactRelationships.state === "CONTACT"`. Если это состояние ещё не "CONTACT" локально хотя бы у одной стороны в момент одновременной первой отправки — ни И3, ни И4 не срабатывают, обе стороны независимо доходят до `createGroup`+publish Welcome — тот же класс бага, что M1, но между двумя разными людьми. `handleDeviceAnnounce`'s `isCommitter`-проверка (`devices.js:201`) тут не защищает — работает только когда `mlsGroups`-запись УЖЕ существует (`:204-205`), то есть уже после гонки на создание.

Отдельно, не проверено за отведённое время: разрешает ли UI (`chat.jsx`/`chats.js:39-65`) вообще отправку сообщения контакту, чей статус ещё не "CONTACT".

### 3.3. М5 — объём изменений для отзыва устройства

**kind:443 — точно REGULAR**, не addressable, не replaceable. Публикация (`chat.js:105-114`) — тегов `d` нет вообще. Прямое подтверждение в существующем комментарии (`transport.js:1288`): "kind 443 не replaceable — у контакта с 2+ устройствами их несколько на relay одновременно, это штатно". Функциональное подтверждение: `fetchDeviceKeyPackages` (`transport.js:1296-1333`) сама делает клиентский dedup по тегу `device`+`created_at` — если бы relay схлопывал события сам, этот код был бы не нужен.

**Вывод:** единственный протокольный путь для отзыва — НОВЫЙ отдельный kind-анонс ("это устройство больше не валидно"). Republish под тем же d-tag невозможен (нет d-tag), NIP-09 kind:5 в проекте нигде не публикуется/не обрабатывается для kind:443, и relay не гарантированно исполняет удаление regular-события.

**Затронутые Dexie-таблицы:** `ownKeyPackage` (`database.js:36,71`), `knownDevices` (`:50`, свои сиблинги), `knownContactDevices` (`:280`, устройства контакта), `mlsGroups` (`:29,72`, членство закодировано внутри MLS-состояния, не отдельным списком), `deviceIdentity` (`:49`). Ни у одной нет поля `revoked`/`active`.

**5 точек чтения списка устройств при построении группы (ни одна не проверяет "отозвано ли"):**
1. `fetchDeviceKeyPackages` (`transport.js:1296-1333`) — REQ `{authors:[pubkeyHex], kinds:[443]}`, используется `ensureChatEstablished` при первом создании группы.
2. `fetchOwnKeyPackageAnnounces` (`transport.js:1517+`).
3. `syncDeviceMembership` (`devices.js:222-255`) — батчевый проход, читает/создаёт `knownDevices`.
4. `handleDeviceAnnounce` (`devices.js:159-220`) — live-обработчик, ветки "мой сиблинг"/"устройство контакта".
5. `addSiblingToGroup`/`addContactDeviceToGroup` (`devices.js:31-92`, `101-134`) — вызывают MLS `addMember` без проверки статуса устройства.

Реализация revoke потребовала бы: новый kind-анонс отзыва + поле статуса в `knownDevices`/`knownContactDevices` (или отдельная таблица revoked-set) + правку всех 5 точек чтения на фильтрацию по этому статусу.

---

## Блок 4 — каналы и статьи

### 4.1. Публикуемые kind

См. таблицу 1.4 (addressable) для 30060/30053/30054/30061/30062/30063/30064/30065/30074, плюс приватные rumor'ы 3002 (заявка на подписку)/3003 (жалоба)/3007 (unview)/3009 (недоступная история, этап 74) и kind:5 (удаление канала/поста, через `buildAddressableDeletionEvent`).

### 4.2. Где хранится черновик поста

НЕ отдельная таблица — хранится в ТОЙ ЖЕ Dexie-таблице `posts` (`database.js:100`, `[ownerPubkey+id], [ownerPubkey+channelId+createdAt], deleted`) со статусом `status:"draft"` (`post.js:33`, `createDraftPost`). Черновик никогда не публикуется на relay — ни одно kind:30061-событие не создаётся, пока пользователь не вызовет `publishPost` (FSM-переход draft→published, `post-machine.js`). Редактирование черновика (`updateDraftPost`) — чисто локальная мутация.

### 4.3. Этап 74 — что закрыто

1. M3-класс throw+буфер+retry для 5 функций приёма контента канала (`ChannelContentNotReadyError`) — версия ключа "ещё не готова" стала ретраебельной вместо permanent silent loss.
2. Гонка `flush()` в общем транспортном слое (`subscriber.js`) — сериализация per-subId, влияет на все подписки приложения.
3. `channelVisibilityGroups` self-sync между sibling-устройствами владельца (kind:30065).
4. `grantIfNewlyVisible` — retroactive-грант участнику, добавленному в уже привязанную к каналу группу после включения видимости.
5. "Неизвестный канал" во всех 5 receive*-функциях — тоже throw+buffer (было silent no-op) — закрывает гонку unview-rumor vs republish-метаданных.
6. `republishAllPostsUnderCurrentKey` — посты переиздаются под новой версией ключа при каждой ротации.
7. Уведомление о недоступности старых комментариев (kind:3009) — комментарии физически невозможно переиздать (подписаны автором, не владельцем).
8. Гейт push-уведомлений по `role !== "available"`.
9. Сериализация `retryBufferedChannelContentEvents` per-`channelTopicHex` — устранён шторм дублирующихся уведомлений.

### 4.4. Что осталось / известные ограничения

- **Комментарии не восстанавливаются после revoke/re-add** — криптографическое ограничение модели, не пробел реализации. Митигировано уведомлением, не устранено.
- **`receiveComment`/`receiveChannelMessage` не идемпотентны** к повторной обработке того же `event.id` (в отличие от `receivePost`, у которой есть LWW-гейт). Сериализация retry устранила подтверждённую гонку, но не сам структурный пробел.
- **Live-обновление открытой формы настроек канала** (`ChannelSettingsForm`) — читает список групп видимости в `useEffect` на mount, не signal-based.
- **Owner-side `commentAllowlists` sync между сиблингами владельца** — не расследовано, зафиксировано ещё в Части C этапа 74.
- **C-6 (`syncMirroredHistory`/пагинация backlog)** — отложено, зависит от реального поведения relay.
- **Zen-браузер аномалия** — пользователь считает багом окружения, не расследовано.

---

## Сквозные наблюдения (не входили явно ни в один блок, но всплыли по ходу)

- **Нет централизованного реестра kind-констант.** Каждый домен объявляет свои `_KIND`-константы локально (`channel-access.js`, `moderation.js`, `files/sync.js`, `events/kinds.js` и т.д.) — отсюда коллизия 3007 (п. 1.1). При добавлении новых kind стоит явно сверяться с полным списком из этого документа, а не только с соседним файлом.
- **Версионирование формата (1.8) отсутствует системно** — при любой будущей смене JSON-схемы полей внутри уже существующего kind (не только каналов) единственная стратегия — опциональность новых полей, без явного переключателя версии. Стоит иметь это в виду как осознанный, не случайный выбор.
- **М2 и М5 — оба сводятся к одному и тому же классу пробела**, что и M1 изначально: код полагается на состояние, которое ещё не гарантированно синхронизировано (`contactRelationships.state`/список известных устройств), в момент, когда решение уже нужно принимать. И3/И4-гейты закрыли самый частый случай (established contact, multi-device одной identity), но не периметр целиком.
