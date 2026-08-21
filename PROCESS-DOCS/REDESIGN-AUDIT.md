# Разведка перед редизайном интерфейса — отчёт

Отчёт составлен по правилам `PROCESS-DOCS/REDESIGN-AUDIT-TASK.md`: только факты
с адресами (файл:строка), без предложений по улучшению. Работа выполнена
четырьмя параллельными обследованиями кода (разделы A/G/H, B/D, C/F, E) —
каждый прочёсывал свою часть кодовой базы независимо.

---

## A. Навигация и состояние «где я сейчас»

### A1. Все места, читающие/пишущие `activeId`, `activeChatPubkey`, `activeChannelId`

**`activeId`** (локальный `useState` внутри `MainShell`; в проекте нет
`src/ui/app.jsx` — компонент фактически лежит в `src/app.jsx`):

| Файл:строка | Операция |
|---|---|
| `src/app.jsx:77` | пишет (объявление `const [activeId, setActiveId] = useState(DEFAULT_ACTIVE)`) |
| `src/app.jsx:158` | пишет (`setActiveId("messages")`, эффект на `activeChatPubkey.value`) |
| `src/app.jsx:167` | пишет (`setActiveId("channels")`, эффект на `activeChannelId.value`) |
| `src/app.jsx:176` | пишет (`setActiveId(target.screen)`, эффект на `pendingNavTarget.value`) |
| `src/app.jsx:220` | пишет (внутри `selectNavItem`) |
| `src/app.jsx:292, 295` | читает (класс `is-active`, `aria-current`) |
| `src/app.jsx:336–354` | читает (условный рендер экранов + fallback `Placeholder`) |

**`activeChatPubkey`** (сигнал, `src/ui/signals/chat.js:6`):

| Файл:строка | Операция |
|---|---|
| `src/ui/signals/chat.js:6` | объявление сигнала |
| `src/ui/signals/chat.js:9` | пишет (внутри `openChat(pubkey)`) |
| `src/app.jsx:158–159` | читает (`useEffect` зависимость + `if`) |
| `src/app.jsx:218` | пишет (`activeChatPubkey.value = null` внутри `selectNavItem`) |
| `src/ui/screens/chat.jsx:969–970` | читает (переключение список чатов ↔ окно переписки) |
| `src/ui/signals/notification-nav.js:24` | пишет косвенно через `openChat(target.contactPubkey)` |

**`activeChannelId`** (сигнал, `src/ui/signals/channel-nav.js:6`):

| Файл:строка | Операция |
|---|---|
| `src/ui/signals/channel-nav.js:6` | объявление сигнала |
| `src/ui/signals/channel-nav.js:9` | пишет (внутри `openChannel(channelId)`) |
| `src/app.jsx:167–168` | читает (`useEffect` зависимость + `if`) |
| `src/app.jsx:219` | пишет (`activeChannelId.value = null` внутри `selectNavItem`) |
| `src/ui/screens/channels.jsx:378–379` | читает (переключение список каналов ↔ `ChannelDetail`) |
| `src/ui/signals/notification-nav.js:26` | пишет косвенно через `openChannel(target.channelId)` |
| `src/ui/screens/channel.jsx:824, 835, 847, 899` | пишет (`openChannel(null)` — «назад»/удаление) |

Смежный сигнал `channelPostTarget` (`src/ui/signals/channel-nav.js:16-20`) и
`setChannelPostTarget` — читается/пишется в `src/ui/screens/channel.jsx:805-810`
и `src/ui/signals/notification-nav.js:27`.

### A2. `pendingNavTarget` / `applyNavTarget`

Файл: `src/ui/signals/notification-nav.js`.

- `pendingNavTarget` — сигнал, объявлен `notification-nav.js:10`, читается/обнуляется
  в `src/app.jsx:174-179` (единственный читатель).
- Поле `screen` по факту встречается в двух буквальных значениях в комментарии файла
  (`"messages"`, `"channels"`), но реальный набор форм объекта шире — плюс
  `{ screen: "contacts" }` (`src/ui/signals/contacts.js:78`).

**Полный список форм объекта `target`, с адресами создания:**

| Форма объекта | Файл:строка |
|---|---|
| `{ screen: "messages", contactPubkey: peerPubkey }` | `src/ui/signals/call.js:33` (входящий звонок) |
| `{ screen: "contacts" }` | `src/ui/signals/contacts.js:78` |
| `{ screen: "messages" }` (без `contactPubkey`) | `src/ui/signals/transport.js:536-537` |
| `{ screen: "channels", channelId: hOldHistoryChannelId, subTab: "posts" }` | `src/ui/signals/transport.js:592` |
| `{ screen: "channels", channelId: reportChannelId, subTab: "moderation" }` | `src/ui/signals/transport.js:631-632` |
| `{ screen: "channels", channelId, postId, subTab: "posts" }` | `src/ui/signals/transport.js:1227` |
| `{ screen: "channels", channelId, postId: storedComment?.postId, commentId, subTab: "posts" }` | `src/ui/signals/transport.js:1273` |
| `{ screen: "channels", channelId, subTab: "chat" }` | `src/ui/signals/transport.js:1346` |
| `{ screen: "channels" }` (без прочих полей) | `src/ui/signals/transport.js:1384` |
| `{ screen: "channels", channelId, subTab: "moderation" }` | `src/ui/signals/transport.js:1404` |
| `{ screen: "messages", contactPubkey: receivedResult.contactPubkey }` | `src/ui/signals/transport.js:1656` |
| `entry.navTarget` (произвольная из вышеперечисленных форм, читаемая из записи журнала) | `src/ui/signals/journal.js:23` |

Комментарий в самом файле (`notification-nav.js:11-13`) документирует только 2
формы («messages»/«channels») — не полностью отражает реальный набор.

Функция `applyNavTarget` (`notification-nav.js:22-29`) обрабатывает только 2
случая: `screen === "messages" && contactPubkey` → `openChat`;
`screen === "channels" && channelId` → `openChannel` + `setChannelPostTarget`.
Для `screen === "contacts"` и «голых» `{screen:"messages"}`/`{screen:"channels"}`
(без id) `applyNavTarget` дополнительно ничего не делает — переключение вкладки
в `app.jsx:176` (`setActiveId(target.screen)`) отрабатывает независимо от неё.

### A3. Кто ещё переключает раздел/экран в обход `selectNavItem`

`selectNavItem` определена в `src/app.jsx:217-222`. Прямые вызыватели — только
внутри самого `app.jsx`: `src/app.jsx:275` (`SidebarProfileCard onEditProfile`)
и `src/app.jsx:294` (клик по пункту нава).

В обход `selectNavItem` активный раздел переключается ещё в трёх местах
`app.jsx`, напрямую через `setActiveId` (без побочного сброса
`activeChatPubkey`/`activeChannelId`):
- `src/app.jsx:158` — `setActiveId("messages")`
- `src/app.jsx:167` — `setActiveId("channels")`
- `src/app.jsx:176` — `setActiveId(target.screen)`

Файлов вне `app.jsx`, вызывающих `setActiveId`/`selectNavItem`, не найдено
(`grep -rn "setActiveId\|selectNavItem" src/` даёт только совпадения внутри
`app.jsx` и один комментарий в `notification-nav.js:20`).

Отдельно от `activeId` существует независимая верхнеуровневая ветка
`roomsScreenActive` (сигнал, `src/app.jsx:59`), которая переключает не
`activeId`, а целиком вид (`Quick` вместо `MainShell`) — читается/пишется в
`src/app.jsx:325, 367, 368`.

### A4. `tests/nav-items.test.js`

Проверяет:
1. Наличие обязательного минимума `id` в `NAV_ITEMS` (`REQUIRED_IDS =
   ["contacts","messages","channels","settings","profile","diagnostics","discovery","journal"]`)
   — строки 8-23.
2. Уникальность `id` и формат kebab-case (`^[a-z][a-z0-9-]*$`) — строки 26-32.
3. Что каждый `item.labelKey` резолвится в `ru.json` (не просто непустая
   строка, а реально существующий путь) — строки 37-42.
4. Что `DEFAULT_ACTIVE` указывает на существующий `id` — строки 44-47.
5. Что `DEFAULT_ACTIVE === "journal"` — строки 49-51.

Других тестов, завязанных на состав `NAV_ITEMS`/`DEFAULT_ACTIVE`, не найдено
(`grep -rln "NAV_ITEMS\|DEFAULT_ACTIVE" tests/` даёт только этот файл). Тесты,
ссылающиеся на имена экранов как строки, встречаются в других файлах
(`tests/chat.test.js`, `tests/channel.test.js`, `tests/journal.test.js`,
`tests/notifications-signals.test.js` и др.) — но это тесты доменной логики,
не состава нава как такового.

### A5. Персистентность активного раздела между запусками

Не найдено. `activeId` — обычный `useState(DEFAULT_ACTIVE)` в
`src/app.jsx:77`, без чтения/записи в `localStorage`/IndexedDB/настройки.
`DEFAULT_SETTINGS` (`src/domain/settings/ui-settings.js:39-51`) не содержит
поля вида `activeScreen`/`lastNavId`. `grep -rn "localStorage" src/` показывает
использование `localStorage` только для медиа-настроек
(`src/ui/signals/media.js:36,50`) и последнего аккаунта
(`src/ui/signals/auth.js:43,47`, ключ `LAST_ACCOUNT_KEY`) — ни то, ни другое
не хранит активный раздел нава. При каждом входе стартовый экран всегда
`DEFAULT_ACTIVE = "journal"` (`src/ui/nav-items.js:31`).

---

## B. Лента: личный чат и чат канала

Фактические файлы: личный чат — `src/ui/screens/chat.jsx`, окно переписки —
компонент `ChatWindow` (строка 264), сам экран называется `Chat` (default
export, строка 955) и переключает `ChatList`/`ComposeMessage`/`ChatWindow` по
состоянию. Чат канала — `src/ui/components/channel-chat.jsx`, компонент
`ChannelChat` (default export, строка 92).

### B1. Сравнение возможностей

| Возможность | Личный чат (`ChatWindow`, chat.jsx) | Чат канала (`ChannelChat`, channel-chat.jsx) | Комментарий |
|---|---|---|---|
| Загрузка окна сообщений | `chat.jsx:353-375` (эффект → `loadChatWindow`) | `channel-chat.jsx:99-119` (`refresh()` → `loadChannelChatWindow`) | Оба реагируют на `messagingActivity.value` |
| «Загрузить старые» | `chat.jsx:510-517` (`handleLoadMore`), кнопка `chat.jsx:802-806` | `channel-chat.jsx:128-133` (`handleLoadMore`), кнопка `channel-chat.jsx:152-156` | Личный чат ещё вызывает `markWindowLoaded` (`chat.jsx:516`) — в канале аналога нет |
| Прокрутка вниз | `chat.jsx:339-351` (`pendingScrollRef`/`bottomRef`) | `channel-chat.jsx:96-97, 103, 121-126` | Одинаковый паттерн |
| Отправка | `chat.jsx:540-588` (`handleSend` → `sendChatMessageAction`) | `channel-chat.jsx:35-56` (`handleSubmit` → `sendChannelMessage`), в подкомпоненте `ChatComposer` (`channel-chat.jsx:27-88`) | Разные экшены (см. B2/B3) |
| Вложения | `chat.jsx:307-309, 418-428` (`useAttachmentTray`) | `channel-chat.jsx:31, 76-79` (тот же хук) | Общий хук `use-attachment-tray.js` |
| Запись голоса | Есть: `chat.jsx:460-497`, UI `chat.jsx:712-731` | Не найдено | Не импортируется в `channel-chat.jsx` |
| Вставка файла из хранилища | Есть: `chat.jsx:430-458`, UI `chat.jsx:826` (`<FilePicker>`) | Не найдено | `FilePicker` не импортируется |
| Правка сообщения | Есть: `chat.jsx:661-679` (`handleEdit` → `editChatMessageAction`) | Не найдено | Нет `onEdit`/импорта |
| Удаление у себя | Есть: `chat.jsx:608-615` (`deleteMessageForMeAction`) | Не найдено | Аналога нет ни в UI, ни в домене |
| Удаление у всех | Есть: `chat.jsx:590-604` (`deleteChatMessageAction` → `domain/messaging/deletions.js:18`) | Не найдено | Своего «удалить» для сообщения нет |
| Очистка истории | Есть: `chat.jsx:651-659` (`clearChatHistoryAction` → `deletions.js:80-82`) | Не найдено | — |
| Модерация | Не найдено | Есть: `channel-chat.jsx:169-179` (`<ModerationActions compact>`) | В личном чате не импортируется |
| Отметка о прочтении | Есть: `chat.jsx:362-367` (`markChatReadAction`) + лейбл `message-bubble.jsx:53,99` | Есть, но только курсор: `channel-chat.jsx:105-110` (`markChannelAsRead`), без индикатора на уровне сообщения | Разные домены (`read-status.js` vs `channel-read-status.js`) |
| Открытие вложения в просмотрщике | Есть: `chat.jsx:643-649` (`openAttachment` → `openMedia`) | Есть: `channel-chat.jsx:137-143` (аналогично) | Оба используют `domain/media/scope.js` и `media-ref.js` |

Личный чат рендерит сообщения через `src/ui/components/message-bubble.jsx`
(`MessageBubble`, импорт `chat.jsx:50`); чат канала — инлайновой вёрсткой
`<li class="channel-message-row">` прямо в `channel-chat.jsx:161-189`,
`MessageBubble` не используется.

### B2. Функции загрузки

**Личный чат** — `loadChatWindow`, `src/core/sync/lazy-chat.js:8-35`:
```js
export async function loadChatWindow(ownerPubkey, contactPubkey, dbKey, { limit = 100, beforeSeq } = {})
```
Возвращает `{ messages, hasMore }`. Источник — Dexie `messages`, индекс
`[ownerPubkey+chatId]` (`lazy-chat.js:10`). Фильтрует служебные
маркеры удаления/правки (строка 17), сортирует по `(lamportTs, senderPubkey,
id)` (строки 19-23), курсор `beforeSeq` по авто-инкременту `seq`. Парная
`markWindowLoaded(ownerPubkey, dbKey, contactPubkey, oldestLoadedSeq)`
(строки 37-41), пишет в `chatSyncState`.

**Чат канала** — `loadChannelChatWindow`, `src/core/sync/lazy-channel.js:50-65`:
```js
export async function loadChannelChatWindow(ownerPubkey, dbKey, channelId, { limit = 15, beforeCreatedAt } = {})
```
Возвращает `{ messages, hasMore }`. Источник — Dexie `channelMessages`, индекс
`ownerPubkey` (строка 51), фильтрует `deleted` и авторов из `ignored`-списка
(строки 52-54). Сортировка по `createdAt` (строка 55), курсор
`beforeCreatedAt` — по времени, не по `seq`. Дефолтный лимит — 15 (у личного
чата — 100). Комментарий `lazy-channel.js:5-9` называет функцию «прямым
аналогом `loadChatWindow`, только курсор по `createdAt`». Нет аналога
`markWindowLoaded` — есть отдельная `markChannelAsRead`
(`domain/content/channel-read-status.js`), вызывается из
`channel-chat.jsx:107`, не из `lazy-channel.js`.

### B3. Шифрование и формат события

**Личный чат** (`src/domain/messaging/chat.js`):
- KeyPackage устройства — `kind: 443` (`chat.js:144-153`), контент — plaintext
  base64 (публичен по протоколу MLS).
- Welcome — `kind: 444` (`chat.js:235-239`), обёрнут NIP-59 gift wrap
  (`nip59Wrap`, вызов на той же строке).
- Сообщение — `kind: 445` (`chat.js:335-338`): MLS
  `encryptApplicationMessage` (`chat.js:308`) поверх ratchet-состояния
  группы, затем NIP-44 (`nip44Encrypt`, `chat.js:330`) ключами из
  `deriveNostrEnvelopeKeys` (`chat.js:329`), публикуется с одноразовым
  эфемерным ключом (`chat.js:334`) — двойной слой MLS + NIP-44.
- Зеркало на другие устройства владельца — `kind: 446`
  (`domain/messaging/mirror.js:4`), ChaCha20-Poly1305
  (`encryptMirrorPayload`, `mirror.js:14-19`), вызывается из
  `mirrorBestEffort` (`chat.js:115-123, 377-382`).
- Удаление/правка — не отдельный kind, а текстовые маркеры внутри обычного
  `kind: 445` (`deletions.js:7-16`, аналогично `edits.js`).

**Чат канала** (`src/domain/content/channel-chat.js`):
- Сообщение — `kind: 30063` (`channel-chat.js:32`; комментарий
  строк 20-21: «следующий свободный в 30060-30069, parameterized-replaceable»),
  теги `["d", "<channelId>:<messageId>"]` + `["h", channelTopic]`.
- Шифрование — прямой ChaCha20-Poly1305 общим `channelKey`:
  `encryptChannelContent` (`core/crypto/channel-key.js:59-64`), вызов
  `channel-chat.js:29`. Формат: `base64(uint32BE(version) ‖ nonce(12) ‖
  ChaCha20Poly1305(text))`. Ключ общий на всех читателей канала (VIEW-грант),
  не индивидуальный на пару.
- Нет gift-wrap (NIP-59) и нет отдельного KeyPackage-протокола — обычная
  `sign()` события приватным ключом владельца (`channel-chat.js:30-41`).

Итог: личный чат — MLS + NIP-44 + NIP-59 (для Welcome) + 4 разных kind
(443/444/445/446); чат канала — один kind (30063), один слой ChaCha20-Poly1305
на общем ключе канала.

### B4. Общее и раздельное между постами канала и чатами

`PostWithComments` — функция внутри `src/ui/screens/channel.jsx:550` (не
отдельный файл). `PostCard` — отдельный компонент
`src/ui/components/post-card.jsx` (default export, строка 26), импортируется в
`channel.jsx:30`, используется в `PostWithComments` (`channel.jsx:669`).

**Общее:**
- `src/ui/components/attachment-view.jsx` (`AttachmentView`) — `post-card.jsx:1`, `channel-chat.jsx:12`, а также через `MessageBubble`.
- `src/ui/components/message-bubble-attachments.js` (`splitBubbleAttachments`) — `post-card.jsx:2`, `channel-chat.jsx:13`, `message-bubble.jsx:5`.
- `src/ui/components/media/media-buttons.jsx` (`MediaButtons`) — `post-card.jsx:10`, `chat.jsx:59`, `channel.jsx:21`, `files.jsx:50` (`channel-chat.jsx` не использует).
- `src/ui/components/markdown-view.jsx` (`MarkdownView`) — `post-card.jsx:41`, `channel-chat.jsx:183`, `message-bubble.jsx:93`.
- `src/domain/media/scope.js` (`collectChatScope`/`collectPostScope`/`findRefPosition`) — `collectChatScope` в `chat.jsx:56` и `channel-chat.jsx:15`; `collectPostScope` отдельно, только в `channel.jsx:17`.
- `src/domain/media/media-ref.js` (`refFromAttachment`/`classOf`) — общий.
- `src/ui/components/moderation-actions.jsx` (`ModerationActions`) — общий для `channel-chat.jsx:169` и для комментариев в `channel.jsx` (`CommentNode`).
- `src/ui/hooks/use-attachment-tray.js` + `src/ui/components/media/attachment-tray.jsx` — общие для постов и обоих чатов.
- `formatDateTime` — определена в `post-card.jsx:12-14`, реэкспортирована (строка 76) и переиспользуется в `channel-chat.jsx:20`.
- `src/ui/components/contacts.jsx` (`ContactIdentity`) — `chat.jsx:28`, `channel-chat.jsx:18`.

**Раздельное:**
- `PostCard` — своё меню владельца (`ActionsMenu`, архив/снять с публикации/удалить, `post-card.jsx:62-70`) — аналога в чатах нет.
- Дерево комментариев (`comments.js`, `getCommentsTree`/`compareComments`) — древовидная модель, у обоих чатов — плоский список (комментарий `channel-chat.jsx:90-91`).
- `MessageBubble` (состояния `editing`/`confirming-delete`, `message-bubble.jsx:33-149`) — не переиспользуется в `ChannelChat` (там своя `<li>`-разметка, `channel-chat.jsx:161-189`).
- Отправка: `sendMessage`/`sendChatMessageAction` (`domain/messaging/chat.js`) и `sendChannelMessage` (`domain/content/channel-chat.js`) — раздельные модули, нет общего кода отправки.
- Загрузка окна: `loadChatWindow` vs `loadChannelChatWindow` — раздельные функции (см. B2).
- `post.js`/`post-machine.js` (FSM черновик/публикация/архив поста) — аналога в чатах нет вообще.

---

## C. Модель записи

### C1. Форма объекта поста канала и объекта сообщения

**Пост канала** (таблица `posts`, kind 30061). Создаётся `createDraftPost` —
`src/domain/content/post.js:22-43`. Поля (строки 26-37):

| Поле | Тип | Обязательность |
|---|---|---|
| `ownerPubkey` | string (hex pubkey), plaintext | обязательное |
| `id` | string (uuid) | обязательное |
| `channelId` | string | обязательное |
| `authorPubkey` | string (hex pubkey) | обязательное |
| `text` | string | обязательное |
| `attachments` | array (см. C2) | опциональное, по умолчанию `[]` |
| `status` | enum (FSM, `post-machine.js`) | обязательное |
| `keyVersion` | number\|null | обязательное поле, значение может быть `null` |
| `createdAt` | number (unix seconds) | обязательное |
| `deleted` | boolean | обязательное |
| `lastEventCreatedAt` | number | добавляется при публикации/приёме (post.js:93, 185) |
| `lastEventId` | string | добавляется при публикации/приёме (post.js:93, 186) |

Plaintext-подмножество — `POSTS_PLAINTEXT_FIELDS`,
`src/core/store/table-fields.js:40`: `["ownerPubkey", "id", "channelId",
"createdAt", "deleted", "status", "keyVersion", "lastEventCreatedAt",
"lastEventId"]`. Остальное (`text`, `attachments`, `authorPubkey`) —
зашифровано. Сериализуемый payload на relay (kind 30061) — только `{ text,
attachments, status }` (`post.js:71-75`, повтор `post.js:229`).

**Сообщение** (таблица `messages`, MLS kind 445 / зеркало kind 446). Форма
строится в `doSendMessage` — `src/domain/messaging/chat.js:349-360`
(неудача) и `364-375` (успех), приёмник `doReceiveGroupMessageEvent` —
`chat.js:498-508`.

| Поле | Тип | Обязательность |
|---|---|---|
| `ownerPubkey` | string | обязательное |
| `chatId` | string (=contactPubkey) | обязательное |
| `lamportTs` | number | обязательное |
| `senderPubkey` | string | обязательное |
| `id` | string (nostr event id) | обязательное |
| `text` | string | обязательное |
| `status` | enum `"sent"/"failed"` | обязательное |
| `msgId` | string (hex, 16 байт) | обязательное |
| `sentAt` | number (unix seconds) | опциональное — отсутствует у старых сообщений (chat.js:477-478, `normalizeMessageAttachments`, chat.js:536-539) |
| `attachments` | array (см. C2) | опциональное, добавляется только если `length > 0` (chat.js:306, 359, 374) |
| `deleted` | есть в схеме таблицы | — |

Plaintext-подмножество — `MESSAGES_PLAINTEXT_FIELDS`, `table-fields.js:33`:
`["seq", "ownerPubkey", "chatId", "msgId", "lamportTs", "senderPubkey", "id",
"status", "deleted"]`. `text`/`sentAt`/`attachments` — зашифрованы.

MLS-payload на проводе — `messagePayload`, `chat.js:305-306`: `{ text,
lamportTs, msgId, sentAt, senderPubkey, attachments? }`.

Отдельная форма для группового чата канала (таблица `channelMessages`,
`CHANNEL_MESSAGES_PLAINTEXT_FIELDS`, `table-fields.js:44`) — по составу полей
(`ownerPubkey, id, channelId, createdAt, deleted, authorPubkey`) аналогична
форме сообщения личного чата (файл `channel-chat.js` подробно не разбирался
на предмет литералов создания).

### C2. Дескриптор вложения (`attachments[i]`)

Определяется/используется в `src/domain/messaging/attachments.js`:
`uploadMessageAttachment` (36-40), `uploadMessageAttachmentStreaming`
(49-53), `referenceStoredFile` (61-70). Актуальная форма:

| Поле | Тип | Обязательность |
|---|---|---|
| `type` | enum (`"image"/"video"/"audio"/"file"`, из `classOf`, `media-ref.js`) | обязательное |
| `manifestDigest` | string (хэш content-addressed манифеста) | обязательное |
| `fileKey` | string (base64 ключа расшифровки) | обязательное |
| `mime` | string | обязательное |
| `size` | number | обязательное |
| `name` | string | обязательное |

Legacy-формат упомянут в комментарии `attachments.js:6-9`:
`{type, sha256, blossomUrl, encryptionKey, mime, size, name}` — заменён этим
модулем; нормализация старых сообщений (одиночное вложение → массив) —
`normalizeMessageAttachments` (`chat.js:536-539`) и внутри приёмника
(`chat.js:485-488`, приведение поля `attachment` к массиву `attachments`).

### C3. Поля под дедлайн/статус выполнения/URL/заголовок

Искал: `title`, `deadline`/`dueDate`/`due`, `completed`/`isDone`/`done`, `url`
— в `src/domain/content`, `src/domain/messaging`, `src/domain/events`.

- **`title`** — не найдено ни в форме поста, ни сообщения.
- **`deadline`/`dueDate`/`due`** — не найдено нигде в `src/domain`, `src/core`.
- **"выполнено"** — единственное совпадение `completed` — значение состояния
  FSM файловой загрузки (`transfer-machine.js:9`,
  `uploading: {UPLOADED: "completed", ...}`), не относится к постам/сообщениям.
- **`url`** — не найдено как поле нигде в `post.js`/`chat.js`/`attachments.js`
  (ссылка на содержимое вложения — `manifestDigest`+`fileKey`, не прямой URL).

Границы схемы, которые пришлось бы расширять:
- Пост: литерал строки — `post.js:26-37` (создание), `:173-188` (приём);
  список plaintext-полей — `table-fields.js:40`; сериализация в nostr-событие
  — `post.js:71-75`, `post.js:229`.
- Сообщение: литерал `messagePayload` — `chat.js:305-306`; список
  plaintext-полей — `table-fields.js:33`; запись в Dexie — `chat.js:349-360,
  364-375, 498-508`.

### C4. Хранение в Dexie

Файл: `src/core/store/database.js`. Актуальная (после всех `.version()`)
форма ключевых таблиц:

| Таблица | Индексы (актуальные) | Строки (версия) |
|---|---|---|
| `posts` | `[ownerPubkey+id]` (PK), `[ownerPubkey+channelId+createdAt]`, `deleted` | database.js:100 (v6) |
| `comments` | `[ownerPubkey+id]` (PK), `[ownerPubkey+postId]`, `deleted` | database.js:101 (v6) |
| `messages` | `++seq` (PK), unique `&[ownerPubkey+chatId+msgId]`, `[ownerPubkey+chatId+lamportTs+senderPubkey+id]`, `[ownerPubkey+chatId]`, `id`, `status`, `deleted` | database.js:73-74 (v4) |
| `channelMessages` | `[ownerPubkey+id]` (PK), `[ownerPubkey+channelId+createdAt]` | database.js:107 (v7) |
| `attachments` | `[ownerPubkey+sha256]` (PK), `ownerPubkey`, `lastAccessedAt` | database.js:155 (v12) — переопределена под кэш расшифрованных вложений; изначальная форма (`sha256, messageId, type, mime`, v1, строка 20) никогда не использовалась |
| `channels` | `[ownerPubkey+id]` (PK), `ownerPubkey`, `channelTopic` | database.js:88 (v5) |
| `events` (сырой event-log) | `++seq` (PK), `id`, `[pubkey+kind]`, `created_at`, `*flatTags` | database.js:5 (v1, не переопределялась) |
| `outbox` | `++seq` (PK), `eventId`, `status`, `retryCount` | database.js:26 (v1) |

Индекс "все каналы разом, по времени": для `posts` есть только составной
индекс `[ownerPubkey+channelId+createdAt]` (database.js:100) — сортировка по
времени возможна только внутри конкретного `channelId` (диапазонный запрос
требует префикс `channelId`). Одноколоночного индекса по `createdAt` (без
`channelId`) нет, составного `[ownerPubkey+createdAt]` тоже нет. То же самое
для `channelMessages` (database.js:107). Получение "постов из всех каналов
разом, по времени" требует full-scan таблицы с сортировкой в памяти — так и
делает `listChannelPosts` (post.js:196-199: читает все посты владельца,
фильтрует по `channelId` в памяти).

### C5. Механизм миграции схемы Dexie

Есть — стандартный Dexie `db.version(N).stores({...})`, каждая версия
аддитивна либо переопределяет таблицу целиком. Файл:
`src/core/store/database.js`. Всего **24 версии** (1..24), без явных
`.upgrade()`-функций (во всех комментариях указано, что перенос данных не
нужен — таблицы либо пустые, либо ещё не в проде). Кратко:

- v1 (5-30): базовый набор таблиц.
- v2 (35-38): `ownKeyPackage`, `contactRequests`.
- v3 (48-54): multi-device — `deviceIdentity`, `knownDevices`; `messages` получает `&[chatId+msgId]`.
- v4 (70-76): owner-scoping для `ownKeyPackage`/`mlsGroups`/`messages`/`chatSyncState`.
- v5 (87-93): owner-scoping для `channels`/`channelKeys`/`channelKeyMeta`/`commentAllowlists`; удалена `channelTopics`.
- v6 (99-102): owner-scoping для `posts`/`comments`.
- v7 (106-108): `channelMessages`.
- v8 (115-120): модерация — `channelReaders`, `channelReports`, `channelIgnores`, `bannedMembers`.
- v9 (125-127): `uiSettings`.
- v10 (133-135): `channelVisibilityGroups`.
- v11 (148-150): owner-scoping для `clock`.
- v12 (154-156): переопределение `attachments` под owner-scoped кэш.
- v13 (165-169): раздел "Обзор" — `discoverySettings`, `discoveryProfiles`, `outgoingAcquaintanceRequests`.
- v14 (176-178): owner-scoping `channelSyncState`.
- v15 (185-187): `contactRelationships` (единая FSM-таблица контактов).
- v16 (194-196): `journalEntries`.
- v17 (210-216): раздел "Файлы" — `files_nodes`, `files_mounts`, `files_manifests`, `files_blobs`, `files_thumbs`.
- v18 (228-230): `files_keys`.
- v19 (253-259): шаринг файлов — `files_shares`, `files_shareKeys`, `files_shareGrantees`, `files_mountKeys`, `files_mount_nodes`.
- v20 (270-272): `files_mount_file_meta`.
- v21 (279-281): `knownContactDevices`.
- v22 (288-290): `pendingOutgoingMessages`.
- v23 (298-300): `processedGroupEvents` (дедупликация MLS kind:445).
- v24 (307-309): `contactProfiles`.

---

## D. Срезы и медиа

### D1. Назначение и область охвата функций

- **`MediaButtons`** — `src/ui/components/media/media-buttons.jsx:26-38`.
  Чистый презентационный компонент: принимает уже посчитанные `counts`
  (Int32Array(4) либо `{audio,video,image}`) и коллбэк `onOpen(cls)`, сам
  ничего не считает.
- **`mediaClassesByPost`** — `src/domain/content/media-index.js:10-32`.
  Область: **все каналы владельца разом** — сигнатура `(ownerPubkey, dbKey)`
  без `channelId` (комментарий строк 6-9). Сканирует все строки таблиц
  `posts` и `comments` этого владельца целиком (`.toArray()`, строки 11 и 21),
  возвращает `Map<postId, Int32Array(4)>`.
- **`collectChatScope`** — `src/domain/media/scope.js:4-8`. Область: одна
  открытая лента — принимает уже загруженный массив `messages` из состояния
  компонента, сама к Dexie не обращается (без голосовых, `a.voice ? null :
  ...`).
- **`src/domain/media/scope.js`** (файл целиком, 1-50): 4 экспорта —
  `collectChatScope` (для чата), `collectFolderScope` (строка 10, для
  раздела "Файлы" — папка), `findRefPosition` (строка 20, поиск позиции
  клика в уже построенном `refs`), `collectPostScope` (строка 32, один пост +
  дерево комментариев, DFS строки 37-47).

Готовой функции с областью «всё хранилище/все чаты и каналы разом» не
найдено (см. D3).

### D2. Места рендера MediaButtons

4 места (`grep -rn "MediaButtons"`):
1. `src/ui/screens/chat.jsx:698` — область: `collectChatScope(messages)` над
   текущим состоянием `messages` личного чата (`chat.jsx:621-628`,
   `classesInMessages`).
2. `src/ui/screens/files.jsx:678` — область: текущая открытая папка раздела
   "Файлы" (`classesPresent`/`currentFolderId`).
3. `src/ui/components/post-card.jsx:58` — `mediaCounts` передаётся сверху из
   `channel.jsx`, карта из `mediaClassesByPost` (см. D1) — область одного
   поста, посчитанная заранее общим сканом.
4. `channel-chat.jsx` — **не используется** (проверено — нет ни импорта, ни рендера).

### D3. Единый Dexie-запрос на медиа-срез по ВСЕМ каналам и чатам

Не найдено. Данные о вложениях хранятся не в отдельном индексируемом поле, а
внутри зашифрованного поля `attachments`/`text` четырёх разных таблиц:
`messages` (database.js:73-74), `channelMessages` (database.js:107), `posts`
(database.js:100), `comments` (database.js:101). Ни в одной нет индекса по
mime/классу вложения или по «наличию вложения» — только индексы по
`ownerPubkey`/`chatId`/`channelId`/`postId`/времени. Посчитать медиа-срез по
всем каналам и чатам сразу потребовало бы full-scan всех четырёх таблиц с
расшифровкой каждой строки (`fromEncryptedRow`) и разбором `attachments` в
памяти — тем же приёмом, что уже делает `mediaClassesByPost`, но она
сканирует только `posts`+`comments`, не трогая `messages`/`channelMessages`.

### D4. Слот `mediaButtons` (`src/ui/components/screen.jsx`)

Определён в `screen.jsx:20` (проп `mediaButtons` компонента `Screen`),
рендерится в `screen.jsx:50`.

Передают содержимое (`grep -n "mediaButtons="`):
- `src/ui/screens/chat.jsx:698` (личный чат).
- `src/ui/screens/files.jsx:675-682` (Файлы).

Экраны с `Screen`, но без `mediaButtons`: `channel.jsx`, `channels.jsx`,
`contacts.jsx`, `diagnostics.jsx`, `discovery.jsx`, `help.jsx`, `journal.jsx`,
`profile.jsx`, `settings.jsx` (в `channel.jsx` `MediaButtons` рендерится
внутри `PostCard`, не через слот `Screen`; `ChannelChat` вообще не
использует `Screen`).

Экраны, не использующие `Screen` вообще (слот в принципе недоступен):
`placeholder.jsx`, `quick.jsx`, `unlock.jsx`.

---

## E. Файлы

Раздел не сосредоточен в одном компоненте:
- `src/ui/screens/files.jsx` (1077 строк) — экран целиком.
- `src/ui/signals/files.js` (413 строк) — мост UI↔domain для собственного дерева.
- `src/ui/signals/shares.js` (41 строка) — мост для шаринга (сторона владельца).
- `src/ui/signals/mounts.js` (120 строк) — мост для подключённых чужих папок.
- `src/ui/components/file-picker.jsx` (170 строк) — модальный выбор узла, переиспользуется вне раздела (аватар в `profile.jsx`, вложение в `chat.jsx`).
- `src/domain/files/*.js` — доменный слой: `tree.js`, `ops.js`, `clipboard.js`, `undo.js`, `share.js`, `mount.js`, `save-to-own.js`, `permissions.js`, `move-routing.js`, `store.js`, `content.js`, `stream-upload.js`, `thumbnails.js`, `thumbnail-queue.js`, `sync.js`, `sort.js`, `filter.js` и др.

### E1. Разбор возможностей по коду

| Возможность | Файл : строки |
|---|---|
| Просмотр списка файлов | `files.jsx:413-424` (сортировка/фильтр/виртуализация), рендер `files.jsx:790-891`; данные — `signals/files.js:34-38` (`currentEntries`) |
| Просмотр папки | навигация: `signals/files.js:410-413` (`openFolder`); открытие по клику — `files.jsx:477-482`; хлебные крошки — `files.jsx:40-53`, рендер `files.jsx:697-718` |
| Создание папки | domain: `domain/files/ops.js:53-58` (`createFolder`); мост: `signals/files.js:262-269`; UI: форма `files.jsx:734-745`, кнопка `files.jsx:647-649`, обработчик `files.jsx:435-448` |
| Переименование | domain: `ops.js:75-82` (`rename`); мост: `signals/files.js:309-317`; UI: `files.jsx:450-468`, форма `files.jsx:817-829`, пункт меню `files.jsx:862-864`, F2 `files.jsx:615-624` |
| Перетаскивание (drag&drop) | UI целиком: `files.jsx:219-323`; проверка цели — `ops.js:40-51` (`targetInsideSubtree`); атрибуты на `<li>` — `files.jsx:808-813` |
| Буфер обмена | domain FSM: `domain/files/clipboard.js:12-45`; мост: `signals/files.js:371-397`; UI: `files.jsx:576-585`, панель `files.jsx:772-788`, пункты меню `files.jsx:865-870`, Ctrl+C/X/V `files.jsx:590-629` |
| Удаление (в корзину) | domain: `ops.js:151-153` (`remove`, реализовано как `move` в `$trash`); мост: `signals/files.js:329-335`; UI: `files.jsx:558-562`, кнопки `files.jsx:781-783, 882-884`, Delete/Backspace `files.jsx:610-614` |
| Корзина и восстановление | `TRASH_ID` — `domain/files/tree.js:10`; UI: `inTrash` флаг `files.jsx:415`, вход в корзину `files.jsx:713-717`, восстановление `files.jsx:569-574` (`moveNode(id, ROOT_ID)`), кнопка `files.jsx:851-855` |
| Окончательное удаление | domain: `ops.js:155-157` (`purge`); мост: `signals/files.js:337-340` (не кладётся в undo-стек); UI: `files.jsx:564-567`, кнопка `files.jsx:856-858` |
| Общий доступ (шаринг) | domain: `domain/files/share.js:111-139` (`share`); мост: `signals/shares.js:20-26`; UI: открытие `files.jsx:325-329`, отправка `files.jsx:340-359`, компонент `ShareDialog` `files.jsx:931-965`, пункт меню `files.jsx:877-880` |
| Права доступа (permissions) | domain: `domain/files/permissions.js` целиком (решётка `none⊏read⊏write⊏own`, строки 7-67). **В UI нет ни одного элемента, отображающего или запрашивающего уровень прав** — см. E4 |
| Отзыв доступа | domain: `share.js:146-161` (`revoke`); мост: `signals/shares.js:28-36`; UI: `files.jsx:366-369`, панель `AccessPanel` `files.jsx:968-992`, кнопка `files.jsx:980-982` |
| Подключение чужой папки | domain: `domain/files/mount.js:36-55` (`mount`), `:66-88` (`applyMountSubtreeEvent`); мост: `signals/mounts.js:43-65` (монтирование автоматическое при получении гранта, не по клику), `:73-83`; UI только просматривает результат: вкладка `files.jsx:642-644`, `MountsView` `files.jsx:997-1077` |
| Сохранение вложения к себе (из чужой/подключённой папки) | domain: `domain/files/save-to-own.js:17-78`; мост: `signals/mounts.js:97-104`; UI: `files.jsx:377-388`, кнопка `files.jsx:1068-1070` |
| Загрузка файлов с устройства | domain: `domain/files/stream-upload.js:30-87` (`putFileStreaming`); UI: `files.jsx:233-235, 237-270, 272-274`, input `files.jsx:653-660`, кнопка `files.jsx:650-652`, прогресс `files.jsx:751-765` |
| Галереи | одиночный файл: `files.jsx:477-503` (`openEntry` → `openMedia`); плейлист по папке: `files.jsx:514-556` (`openFolderMediaClass`), кнопки `files.jsx:675-682`; миниатюры — `FileThumbnail` `files.jsx:92-158` |

### E2. Возможности, не связанные с вложениями в лентах

**Все возможности E1 работают только с самостоятельными узлами дерева
хранилища и не имеют отношения к конкретным сообщениям/постам.** Обоснование:

1. Схема узла (`mkNode`, `domain/files/tree.js:28-39`) содержит поля `id,
   kind, blob, par, name, origin, purged, mime` — полей
   `messageId`/`postId`/`chatId` нет.
2. Единственное поле, которое по комментарию могло бы нести такую связь —
   `origin` (комментарий `ops.js:63`). Фактически по всему коду `origin`
   **всегда `null`**: единственный производитель новых узлов —
   `createFileEntry` (`signals/files.js:281-292`), вызывается из
   `files.jsx:256` с явным `null`. Других мест, задающих `origin` иначе, не
   найдено.
3. Создание/переименование папок, drag&drop, буфер обмена, корзина/
   восстановление/окончательное удаление, шаринг/права/отзыв, подключение
   чужой папки, сохранение "себе" — все оперируют только `NodeId` и
   `blob`-дайджестом, без ссылки на сообщение/пост.
4. Единственная точка пересечения с лентами — вставка файла из хранилища как
   вложения при отправке (см. E3a) — одностороннее копирование дескриптора,
   без обратной ссылки на узел дерева.

### E3. Связь "файл хранилища" ↔ "вложение в сообщении"

**Две разные сущности**, не общая таблица/схема:
- Узел хранилища — CRDT-узел дерева (`domain/files/tree.js:28-39`,
  персистируется через `domain/files/store.js`, таблицы `files_nodes` и
  т.д.), поля `id, kind, blob, par, name, origin, purged, mime`.
- Вложение сообщения — плоский дескриптор `{type, manifestDigest, fileKey,
  mime, size, name}` (`domain/messaging/attachments.js`, см. C2).

Ни одна не хранит ссылку на другую (у дескриптора нет `nodeId`, у узла нет
`messageId`). Общее — только адресация зашифрованного содержимого через
`manifestDigest`/`fileKey` поверх общего content-addressed слоя
(`domain/files/content.js`).

**(а) Вставка файла из хранилища в сообщение:**
1. `chat.jsx:826` открывает `FilePicker` при `attachmentPickerOpen`.
2. `chat.jsx:434-455` — `handleAttachmentFromStorage([nodeId])`: читает узел
   из `projected.value.nodes`, получает манифест и `fileKey`, вызывает
   `tray.addFromStorage(...)` (строка 454).
3. `ui/hooks/use-attachment-tray.js:13` и
   `ui/hooks/attachment-tray-core.js:51-70` (`addFromStorage`) кладут ссылку
   в состояние подноса вложений.
4. При отправке — `use-attachment-tray.js:18-37` (`uploadAll`), строка 26:
   `referenceStoredFile(job.manifestDigest, job.fileKey, job.manifest)`.
5. Сборка дескриптора без повторной заливки —
   `domain/messaging/attachments.js:61-70` (`referenceStoredFile`).

**(б) Сохранение вложения из сообщения в хранилище файлов:** **не найдено в
коде.** Единственное действие над вложением сообщения в UI — скачивание на
диск (`ui/components/attachment-view.jsx:240-277`,
`AttachmentDownloadLink`, `<a download>`, не создаёт узел дерева).
`createFileEntry` (`signals/files.js:281-292`) вызывается ровно из одного
места (`files.jsx:256`, путь "загрузка с диска"); ни `attachment-view.jsx`,
ни `chat.jsx`, ни `channel.jsx`/`channel-chat.jsx` её не вызывают.

### E4. Признаки неиспользуемых/несвязанных возможностей

1. **`domain/files/permissions.js`** — `joinPerm` (10-12), `effectivePerm`
   (34-42), `effectivePermForChildren` (47-53) **не импортируются нигде в
   `src/ui`** (и нигде в domain, кроме себя). `coveringShares` (60-67)
   импортируется только в `move-routing.js:8`, который сам мёртв (см. п.2).
   Решётка прав реализована целиком, но не используется UI:
   `domain/files/store.js:196-197` фиксирует, что `loadGrantsIndex` жёстко
   присваивает каждому гранту уровень `'read'` строкой — значения
   `write`/`own` из типа `LEVEL` недостижимы нигде в текущем коде,
   `share.js:88-97` (`sendShareGrant`) не принимает параметр уровня.
2. **`domain/files/move-routing.js`**, функция `routeMove` (66-91) —
   экспортируется, но **не вызывается нигде в `src`**. Реальный обработчик
   перемещения (`signals/files.js:319-327`, `moveNode`) вызывает только
   `opMove`/`applyAndPersist`, не обращается к `routeMove`/`grantsIndex` — при
   drag&drop через границу расшаренной папки логика ре-шаринга не
   срабатывает.
3. **`domain/files/stream-upload.js`**, функция `putFilesStreaming` — не
   импортируется нигде в `src`. Реальный путь (`files.jsx:242-267`)
   загружает файлы последовательно через одиночный `putFileStreaming`.
4. Прочие экспорты `domain/files`, не импортируемые напрямую в `src/ui`
   (используются только внутри самого `domain/files`, что ожидаемо):
   `crypto.js`, `manifest.js`, `chunk-cache.js`, `player-session.js`,
   `stream-crypto-worker.js`, часть `share.js`, `content-cache.js`, `blob.js`,
   `attachment-validation.js`. `player-bridge.js`
   (`handleRangeRequest`) не найден вызывающим нигде в `src/ui`, но
   `startPlayerBridge` подключается из `src/app.jsx` — вне `src/ui`, поэтому
   формально не засчитан как связанный с UI, хотя подключён к бутстрапу.
5. Мёртвых обработчиков внутри самого `files.jsx` (объявленных, но не
   подключённых к JSX) не найдено.

---

## F. Люди и каналы

### F1. Контакты vs переписки

- Контакты — сигнал `contacts` (`src/ui/signals/contacts.js:21`, массив
  pubkey), вычисляется из `runtime.listPeersByState("CONTACT")`
  (`contacts.js:31-38`), источник — Dexie `contactRelationships` через
  `contact-runtime.js`.
- Переписки — отдельная функция `listChatPartners(ownerPubkey, dbKey)`
  (`src/ui/signals/chats.js:27-33`): `Promise<string[]>`, объединяет через
  `Set` `contactPubkey` из `mlsGroups` и `chatId` из `messages`, оба
  `.where("ownerPubkey").equals(ownerPubkey)`.

Это **разные структуры/источники**. Готовой функции "только контакты с
перепиской, отсортированные по свежести последнего сообщения" — **не
найдено**. `listChatPartners` не фильтрует по "является ли контактом" и не
сортирует — возвращает `[...new Set(...)]` в порядке появления строк в
Dexie. В UI (`chat.jsx:87-94, 222-229`) результат используется как есть, без
досортировки и без пересечения с `contacts.value`.

Данные, из которых теоретически можно собрать: таблица `messages`
(`chatId`, `lamportTs` plaintext; `sentAt` зашифрован, database.js:73-74);
таблица `mlsGroups` (`contactPubkey`, зашифрован); `contactRelationships`
(`state === "CONTACT"`); `chatSyncState` (`lastReadLamportTs` — про
прочитанность, не про время последнего сообщения).

### F2. Группы контактов

- Хранение: Dexie `groups` (`[owner+id]`, PK) и `groupMembers`
  (`[groupId+pubkey]`, PK) — `database.js:8-9`.
- Форма объекта группы: `{ id, name, memberPubkeys }` —
  `contacts.js:295` (`refreshGroups`), событие `{groupId, name,
  memberPubkeys}` — `domain/contacts/groups.js:6-20`.
- Домен события (kind 30050) — `domain/contacts/groups.js`:
  `buildGroupEvent` (6-12), `parseGroupEvent` (14-20), `addMember` (22-28),
  `removeMember` (30-33), `renameGroup` (35-37).
- Операции сигнального слоя (`src/ui/signals/contacts.js`): создание —
  `createGroupAction` (319-325); переименование — `renameGroupAction`
  (333-339); добавление участника — `addGroupMemberAction` (341-351);
  удаление участника — `removeGroupMemberAction` (353-364); удаление группы —
  `deleteGroupAction` (366-374, kind-5 удаление kind 30050 + транзакция
  Dexie).

### F3. `src/ui/screens/discovery.jsx` — разбивка по коду

**(а) Настройки собственной видимости** — строки **116-161**: тумблер
`visible` (118-120), тумблер `showChannels` (122-131), список чекбоксов
собственных каналов (139-149), кнопка "OK" (155-157). Домен:
`loadDiscoverySettings` (`domain/discovery/discovery.js:30-41`, вызов
discovery.jsx:35); `publishDiscoverySettings` (discovery.js:43-55, вызов
discovery.jsx:56); `listOwnedChannels` (`domain/content/channel.js:118-121`,
вызов discovery.jsx:36).

**(б) Витрина чужих профилей** — строки **163-219**: грид карточек
(169-216), кнопка заявки на карточке (183-202), список каналов внутри
карточки (204-213). Домен/сигналы: `fetchDiscoveryProfiles()` (transport.js,
discovery.jsx:3, вызов :45); `refreshDiscoveryProfiles`
(`signals/discovery.js:9-12`, вызов :46); сигнал `discoveryProfiles`
(discovery.js:5); `sendContactRequestAction`/`cancelContactRequestAction`
(discovery.jsx:10-11, используются в `handleToggleCard`, discovery.jsx:81-97);
`ensureProfilesFetched` (вызов discovery.jsx:48).

### F4. Чужие каналы, доступные для подписки — два пути

`listAvailableChannels` — `domain/content/channel.js:128-131`: читает Dexie
`channels`, фильтр `role === "available"`.

**Путь 1 — экран "Каналы" (`channels.jsx`)**: `listAvailableChannels` читает
полноценные записи канала (name/description/rules/avatar), появившиеся через
`receiveChannelKeyGrant` (channel.js:136-182, роль присваивается ~строка 153)
после VIEW-гранта. Используется в `ChannelsList` (`channels.jsx:293-297`),
рендерится с кнопкой подписки (`handleSubscribe` → `subscribeToChannelAction`,
channels.jsx:304-312).

**Путь 2 — экран "Обзор" (`discovery.jsx`)**: карточки discovery-broadcast
(kind 30073) несут `card.channels` — облегчённые объекты `{id, name,
description}` (не полная запись таблицы `channels`), распаршенные
`parseDiscoveryEvent` (discovery.js:16-28, валидация строк 21-26), хранятся в
таблице `discoveryProfiles`, рендерятся в discovery.jsx:204-213. Собственной
кнопки подписки на канал у этих карточек в прочитанном коде не найдено — они
только информативны, наряду с кнопкой заявки в контакты.

### F5. Группирование/пометки каналов

**Не найдено.** Искал по полям схемы (`CHANNELS_PLAINTEXT_FIELDS`,
`table-fields.js:50`: `["ownerPubkey", "id", "channelTopic", "role",
"creatorPubkey", "createdAt", "updatedAt", "allowChatAttachments",
"lastEventId"]` — нет `pinned`/`favorite`/`hidden`/`muted`), по литералам
создания канала (`channel.js:63-76`), и по всему UI (grep
`pinned|favorite|избранн|закреп|muted|hidden`). Найденные совпадения
относятся к другим механизмам: CSS `var(--muted)` (цвет), `aria-hidden`,
"закреплённый" футер layout (`screen.jsx`), pinned-чанки LRU-кэша файлового
модуля (`chunk-cache.js`), pinned-инфопанель медиаплеера
(`media-overlay.jsx`), тон уведомлений журнала (`journal.jsx:30,35`) — ни
один не про пометки канала как сущности.

Единственное поле категоризации канала — `role`
(`"owner"/"subscriber"/"available"`, `listOwnedChannels`/
`listSubscribedChannels`/`listAvailableChannels`, channel.js:118-131) — тип
отношения к каналу, не пользовательская пометка.

---

## G. Тексты и переводы

### G1. Устройство i18n

Папка `src/ui/i18n/locales/` — 12 словарей: `de, en, es, fr, it, ja, nl, pl,
pt, ru, tr, zh` (`.json`).

`src/ui/signals/i18n.js`:
- `DICTIONARIES` (строка 18) — статический импорт всех 12 JSON через `with {
  type: "json" }` (строки 2-13).
- `currentLocale` — сигнал, инициализируется `detectSystemLocale()` (строка 20).
- `setLocale(code)` (22-24) — если код есть в `DICTIONARIES`, ставит его,
  иначе `DEFAULT_LOCALE`.
- Ключи — dot-path строки, резолвятся `lookup()` (26-28).
- `t(key, vars)` (35-42): `lookup(DICTIONARIES[currentLocale.value], key)`,
  фолбэк на `DICTIONARIES[DEFAULT_LOCALE]`; **если ключа нет ни там, ни
  там** — `console.warn(...)` (строка 38) и **возвращает сам ключ как
  строку** (строка 39), исключение не бросается.
- `tPlural(key, count, vars)` (68-77) — через `Intl.PluralRules(locale)`
  (CLDR `one/few/many/other`), при отсутствии узла — тот же `console.warn` +
  возврат ключа.
- `errorMessage(err)` (50-52) — если у ошибки есть `.key`, переводит через
  `t`, иначе `err.message || String(err)`.
- `SUPPORTED_LOCALES` и `DEFAULT_LOCALE` — не в `i18n.js`, а в
  `src/domain/settings/locale-detection.js`: `SUPPORTED_LOCALES` (12 записей
  `{code, nativeName}`, строки 9-22), `DEFAULT_LOCALE = "en"` (строка 27),
  `detectSystemLocale()` (29-38, сопоставление `navigator.languages`).

### G2. Ключи `nav.*` и места использования

Узел `nav` в `src/ui/i18n/locales/ru.json:25-36`: `journal, messages,
channels, files, contacts, discovery, settings, profile, help, diagnostics`
(10 ключей).

Буквальные вызовы `t("nav.…")`:

| Ключ | Файл:строка |
|---|---|
| `nav.help` | `screens/help.jsx:7`; `screens/unlock.jsx:543` |
| `nav.discovery` | `screens/discovery.jsx:101, 108` |
| `nav.journal` | `screens/journal.jsx:146` |
| `nav.contacts` | `screens/contacts.jsx:267`; `screens/settings.jsx:354, 376`; `screens/chat.jsx:225` |
| `nav.settings` | `screens/settings.jsx:285, 294` |
| `nav.messages` | `screens/settings.jsx:366`; `screens/chat.jsx:169, 686` |
| `nav.channels` | `screens/settings.jsx:401, 421`; `screens/channel.jsx:824, 835, 847`; `screens/channels.jsx:319` |
| `nav.profile` | `screens/profile.jsx:591` |
| `nav.files` | `screens/profile.jsx:705`; `screens/files.jsx:636`; `components/file-picker.jsx:120` |
| `nav.diagnostics` | буквального вызова не найдено — используется только косвенно |

Все 10 ключей используются ещё и косвенно через `t(item.labelKey)`, где
`item` — элемент `NAV_ITEMS` (`ui/nav-items.js:19-28`): рендер сайдбара
(`app.jsx:298`) и заголовок `Placeholder` (`app.jsx:354`).

### G3. Проверка полноты словарей

Найдена — `tests/i18n.test.js:92-111`: `collectKeyPaths()` (11-22) собирает
все dot-path ключи каждого JSON, сравнивает каждый файл с первым
(`referenceKeys`) на `missing`/`extra` (`assert.deepEqual`, 106-109).
Дополнительно `tests/i18n.test.js:135-142` проверяет соответствие
`SUPPORTED_LOCALES.code` файлам в `LOCALES_DIR`. Отдельного скрипта в
`scripts/` или npm-команды нет — `package.json` содержит только
`dev/build/preview/test`, `scripts/` — только bench/room-spike-скрипты.

---

## H. Стили

### H1. CSS сайдбара, шапки экрана, карточки поста

Всё три — в `src/styles/custom.css` (5123 строки);
`src/styles/minimal.css` (1018 строк) — базовый composition/token-слой,
`.card`/`.post`/`.section-header` там не определены.

**Сайдбар:**
- `.sidebar nav .nav-item-btn` — 69, 84, 97-99, 102-104
- `.sidebar nav .nav-badge` — 110
- `.sidebar .exit-btn` — 124, 130
- `.sidebar .theme-status-panel`, `.sidebar .connection-status-panel` — 4034-4072
- Базовое правило `.sidebar` вне медиазапросов не определено — только внутри
  `@media (max-width: 47.99em)` (653-665) и `@media (min-width: 48em)`
  (692-697); базовый layout задаётся composition-классами прямо в JSX
  (`app.jsx:271`).
- `.sidebar-toggle-btn` (бургер) — 569-589, 620-627
- `.sidebar-backdrop` — 649-651, 669-675

**Шапка экрана** (`Screen`, `ui/components/screen.jsx`):
- `.content-section` — custom.css:852-855
- `.section-header` — custom.css:858-860
- `.app-layout .header-actions h1` — custom.css:887-907
- `.action-buttons` — custom.css:913-915, 928-939
- `.media-buttons-zone`, `.media-buttons-bar` — custom.css:867-874
- `.content-area`, `.content-wrapper` — упомянуты в комментариях
  (507, 3738, 3886), декоративная часть в custom.css, композиция — в JSX
  через `.layer`/`.scroller`/`.box`.

**Карточка поста** (`post-card.jsx`, корневой класс `stack post box`, строка 29):
- `.post > p` — custom.css:4502-4504
- `.post__ava` — custom.css:4513-4522
- `.post__ava-fallback` (общий с `.cmt__ava-fallback`) — custom.css:4523-4527
- `.post__author` — custom.css:4528-4531
- Обёртка использует общий `.card` (custom.css:490-495), применяется в
  `channel.jsx:668` (`class="card stack"`).

### H2. Классы «слоя композиции»

Определены в `@layer composition` (`minimal.css:958-1003`; регламент
`PROCESS-DOCS/REGLAMENT.md` запрещает модификаторы вида `.stack-sm` —
параметризация только через CSS custom properties на элементе):

| Класс | Файл:строка | Свойства | Переменные |
|---|---|---|---|
| `.stack` | minimal.css:959 | `flex-direction:column; gap:var(--gap,0)` | `--gap` |
| `.row` | minimal.css:960 | `flex-wrap:wrap; gap:var(--gap,0)` | `--gap` |
| `.bar` | minimal.css:961 | `flex-wrap:nowrap; gap:var(--gap,0)` | `--gap` |
| `.reel` | minimal.css:962-963 | `flex-wrap:nowrap; gap; overflow-x:auto` | `--gap` |
| `.switch` + `> *` | minimal.css:964-967 | формула Хейдона Пикеринга | `--gap`, `--threshold` |
| `.grid` | minimal.css:968-970 | `grid-template-columns: repeat(auto-fit, minmax(min(var(--min,16rem),100%),1fr))` | `--gap`, `--min` |
| `.columns` | minimal.css:972-973 | `flex-direction:column; flex-wrap:wrap; block-size:var(--h)` (без фолбэка у `--h`, намеренно, строка 971) | `--gap`, `--h` (обязателен) |
| `.canvas` | minimal.css:974 | `overflow:auto` | — |
| `.layer` + `> *` | minimal.css:975-976 | `display:grid`; дети `grid-area:1/1` | — |

Производные того же слоя (minimal.css:978-1002): `.grow` (978), `.rigid`
(979), `.self-start/.self-center/.self-end` (980-982), `.over` (983),
`.screen` (985-986), `.shell` (987-988), `.scroller` (989), `.stick` (990),
`.anchored` (991), `.box` (993, `--pad`), `.center` (994, `--measure`),
`.ratio` (999, `--aspect`), `.truncate` (1000-1002, `--lines`).

### H3. Адаптив сайдбара

Всё — `src/styles/custom.css`:
- Точка перелома: `47.99em` (мобильное состояние) / `48em` (десктопное) —
  согласованная пара границ.
- `.sidebar-toggle-btn { display:none; }` (базово, 620-622) →
  `display:flex` внутри `@media (max-width: 47.99em)` (623-627).
- Анимация бургер→крестик: `.hamburger-bar` (598-607) + модификатор
  `.sidebar-toggle-btn.is-open .hamburger-bar:nth-child(1|2|3)` (608-616).
- `.app-layout { flex-direction:column; }` (633-638) базово →
  `flex-direction:row` внутри `@media (min-width:48em)` (689-691).
- Выезжающая панель: `@media (max-width: 47.99em) { .sidebar {position:fixed;
  inset-block:0; inset-inline-start:0; z-index:250; width:min(80vw,20rem);
  transform:translateX(-100%); transition:transform...} }` (652-665);
  `.sidebar.sidebar-open { transform:translateX(0); }` (666-668).
- Подложка: `.sidebar-backdrop {display:none;}` (649-651) →
  `display:block; position:fixed; inset:0; z-index:240;
  background-color:oklch(0.2 0.03 var(--hue) / 0.45);` внутри той же медиа
  (669-675).
- Десктопная ширина: `@media (min-width:48em) { .sidebar { flex:0 0 auto;
  width:15rem; ... } }` (692-697).
- Логика открытия/закрытия — JS: `app.jsx:79` (`useState sidebarOpen`),
  `app.jsx:198-205` (Esc закрывает), `app.jsx:256-265` (кнопка-бургер,
  `aria-expanded`), `app.jsx:268` (backdrop `onClick`), `app.jsx:271` (класс
  `sidebar-open` условно), `app.jsx:221` (`selectNavItem` закрывает панель
  после выбора пункта).

### H4. Литеральные цвета вместо семантических переменных

Выборка не исчерпывающая (по формулировке вопроса H4) — представительные
находки.

**В `src/styles/*.css`:**
- `src/styles/prosemirror.css:40, 54` — `#8cf` (единственные буквальные hex
  во всех CSS-файлах проекта; `custom.css`/`minimal.css` hex-литералов не
  содержат).
- `rgba(0, 0, 0, 0.18)` — `custom.css:2274` (тень тоста).
- `rgba(0, 0, 0, 0.25)` — `custom.css:2383` (тень модалки).
- `custom.css:2524, 2921` — упоминания `rgba(0,0,0,.85)`/`rgba(0,0,0,.25)` в
  **комментариях**, описывающих замену на токены — не действующий код.
- `black`/`white` как аргументы `color-mix()` встречаются часто (пример:
  `custom.css:1782` — `color-mix(in oklch, var(--accent), white 55%)`) — цвет
  смешивается с семантической переменной, не заменяет её целиком.
- `oklch(0.2 0.03 var(--hue) / 0.45)` — `custom.css:674`
  (`.sidebar-backdrop`) — литеральные lightness/chroma с переменным hue, не
  через `--good/--bad/--warn`.

**В `src/ui/*.jsx` (инлайн-стили/JS):**
- `#4a90d9` — `components/room-audio-visualizer.jsx:119` и
  `components/call-overlay.jsx:33` — оба являются фолбэк-копией значения
  `--accent`, не независимым цветом.
- `#fff` (`style={{ color: "#fff" }}`) — `components/media/video-player.jsx:73,
  77`; `components/media/image-viewer.jsx:49, 55`;
  `components/media/audio-player.jsx:50, 54` (текст поверх медиа-оверлея).
- `#888888` — только в **комментариях** `ui/icons/log-out.jsx:2` и
  `ui/icons/quick-room-people.jsx:2`, поясняющих замену на `currentColor`; в
  действующем коде — `currentColor`.

---

## Не найдено

- **A2** — точный полный список форм `pendingNavTarget.screen` не
  документирован нигде "источником истины" в коде (комментарий
  `notification-nav.js:11-13` неполный) — собран вручную по всем местам
  присвоения.
- **A5** — персистентность активного раздела (`activeId`) между запусками —
  отсутствует; проверено через `localStorage`, `DEFAULT_SETTINGS`, `useState`
  в `app.jsx`.
- **G2** — буквальный `t("nav.diagnostics")` нигде не встретился (только
  косвенно через `item.labelKey`).
- **G3** — отдельного скрипта/линтера полноты словарей вне
  `tests/i18n.test.js` не найдено (проверены `scripts/`, `package.json`).
- **H2** — живые потребители класса `.switch` отдельно не искались (вопрос
  касался наличия самого класса в CSS-архитектуре, что подтверждено).
- **B/D** — отдельного файла `ChatWindow.jsx` нет: компонент лежит внутри
  `screens/chat.jsx` вместе с `ChatList`/`ComposeMessage`/`Chat`.
- **D3** — готового единого Dexie-запроса «медиа по всем каналам и чатам
  сразу» нет; проверено `media-index.js`, `scope.js`, все `.where(...)` в
  `chat.js`/`lazy-channel.js`/`lazy-chat.js`/`media-index.js`.
- **B1** — индивидуального «удалить у себя»/«удалить у всех» для сообщений
  чата канала (`channelMessages`) не найдено; в `moderation.js:170` есть
  только массовое удаление всех сообщений канала (архивация/удаление
  канала), `moderation.js:217` — похоже на бан автора, не на удаление своего
  сообщения из UI.
- **B1** — UI-индикатора «прочитано» на уровне отдельного сообщения в
  `ChannelChat` не найдено (сравнение с `STATUS_LABEL_KEYS` в
  `message-bubble.jsx:7-14`).
- **C3** — поля `title`, `deadline/dueDate`, "выполнено", `url` отсутствуют в
  моделях поста и сообщения; искал в `src/domain/content`,
  `src/domain/messaging`, `src/domain/events`.
- **F1** — функции "контакты с перепиской, отсортированные по свежести" нет;
  `listChatPartners` не фильтрует по `contacts` и не сортирует.
- **F4** — явной кнопки/действия "подписаться на канал" из карточки
  Discovery (путь 2) в прочитанном коде не найдено — карточка ведёт только к
  заявке в контакты.
- **F5** — pinned/favorite/hidden/muted для каналов — не найдено нигде в
  `src/domain`, `src/ui`, `table-fields.js`, `database.js`.
- **E1** — переименование расшаренной/подключённой доли в `MountsView`
  (`files.jsx:997-1077`) не найдено — раздел read-only ("Открыть"/
  "Отключить"/"Сохранить себе" — `files.jsx:1009-1013, 1068-1070`).
- **E3(б)** — переход "сохранение вложения сообщения в раздел Файлы" в коде
  не найден; проверены `attachment-view.jsx`, `chat.jsx`, `channel.jsx`,
  `channel-chat.jsx`, `use-attachment-tray.js`, `signals/files.js` через grep
  по `createFileEntry`, `saveAttachmentToFiles`, `attachmentToStorage`,
  `saveMessageAttachment`.
- **E4** — не проверялось, вызывается ли `handleRangeRequest`
  (`domain/files/player-bridge.js:45`) динамически (не статическим
  импортом) — поиск ограничен текстовым grep по имени символа.

---

## Замечания

*(раздел ограничен десятью строками по правилам задания; содержит только то,
что бросилось в глаза при чтении кода, не рекомендации)*

1. `pendingNavTarget` фактически несёт больше форм (`{screen:"contacts"}`,
   "голые" messages/channels), чем описывает `applyNavTarget` и комментарий
   в файле — расхождение документации и кода.
2. `activeId`/`activeChatPubkey`/`activeChannelId` синхронизируются через
   три независимых `useEffect` в `app.jsx`, а не единой функцией — три места
   переключения раздела в обход `selectNavItem`.
3. Личный чат и чат канала не имеют общего компонента отправки/загрузки —
   вся логика продублирована по двум независимым модулям.
4. Решётка прав доступа файлов (`permissions.js`) написана, но не
   подключена — все гранты жёстко `read`.
5. Медиа-срез по постам канала (`mediaClassesByPost`) не покрывает `messages`
   и `channelMessages` — нет симметричной функции для чатов.
6. `move-routing.js` и `putFilesStreaming` — код без единого вызывающего
   места в проекте.
