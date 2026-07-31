# ТЗ: логика контактов и заявок (Уголок) — state machine + redelivery-safety

> Тот же протокол, что VOICE.md (этап 48): Rosen (формальный FSM) → Erickson (робастность, edge cases) → Frisby (модульный контракт). Все три роли — Claude, в этой же сессии (пользователь явно попросил не ходить к Opus отдельно).
> Повод: реальные баги, найденные пользователем — принятый контакт снова падает во "Входящие" после релогина; контакт одновременно висит и во входящих, и в контактах; уведомления валятся пачкой при релогине, как будто пользователь ничего не читал.
> Формат рассчитан на исполнение через Claude Code + субагентов (qwen2.5-coder:7b). Незакрытых пар в таблице переходов нет — воркеру нечего додумывать.

---

## 0. Границы задачи

**Реализуем:** чистое ядро логики контакта/заявки (FSM, ОДНА пара (я, peer) за раз) + runtime, держащий состояния ВСЕХ известных peer'ов и исполняющий команды.
**НЕ реализуем здесь** (отдельно, только контракт): сам Nostr-транспорт (giftWrapSubscriber уже есть в transport.js, здесь только новый kind + маршрутизация), UI (Журнал/списки — отдельная фича, лёгкая, без формализации).

**Стек:** тот же, что call-fsm.js — чистый ES-модуль, `reduce` без I/O/async, изоморфно (браузер + Node), табличные тесты в Node.

**Архитектурный принцип:** тот же functional core / imperative shell, что VOICE.md. `reduce(state, event) → {state, commands}` — вся логика решений здесь; всё с побочным эффектом (публикация rumor, запись в Dexie, EMIT) — команда, исполняемая runtime.

**Найденный корень ОБОИХ багов (не домысел — подтверждено чтением кода, см. отчёт исследования этой же сессии):** при полном relogin/reload relay передоставляет ВСЮ историю gift-wrap событий заново (тот же класс, что чинили в довеске-4 для сообщений/каналов), а обработчик `CONTACT_REQUEST_KIND` в transport.js слепо вставляет строку в `contactRequests` БЕЗ проверки текущего состояния peer'а. Главная цель этого ТЗ — инвариант, который делает ЛЮБУЮ повторную доставку исторического события идемпотентной на уровне СОСТОЯНИЯ (не только на уровне event-id, который уже есть и недостаточен).

---

## 1. Формальная модель (Rosen)

FSM = ⟨Q, Σ_in, Σ_out, δ, q₀⟩, **один экземпляр на каждую пару (я, peer)** — состояния разных peer'ов независимы (в отличие от звонка, где сессия ровно одна).

### 1.1 Состояния Q

| Состояние | Смысл | "Липкое" (sticky)? |
|---|---|---|
| `NONE` | нет связи вовсе | нет |
| `OUTGOING_PENDING` | я отправил(а) заявку, жду решения peer'а | нет |
| `INCOMING_PENDING` | peer прислал заявку, жду МОЕГО решения | нет |
| `CONTACT` | взаимно — оба видят друг друга в контактах | **да** |
| `REJECTED_BY_ME` | я явно отклонил(а) входящую заявку peer'а (НЕ блокировка — peer может попросить снова) | нет |
| `BLOCKED` | я заблокировал(а) peer'а | **да** |

**"Липкое" состояние** — меняется ТОЛЬКО пользовательским действием, НИКОГДА само по себе не даунгрейдится входящим Nostr-событием, независимо от таймстампа. Это осознанное отклонение от чистого "новее — значит применяем": пока я СЧИТАЮ кого-то контактом/заблокированным, входящая заявка от него игнорируется целиком — выйти из этих состояний можно только явным моим действием (`USER_REMOVE_CONTACT`/`USER_UNBLOCK`), не автоматически. Это одновременно проще и надёжнее по UX, чем сравнение таймстампов для этих двух состояний.

Остальные состояния — "решаемые" (resolvable): для них действует инвариант I1 (см. §1.5) — таймстамп-гейт, разрешающий peer'у "постучаться снова" после отказа/отмены, но защищающий от redelivery СТАРОГО, уже разрешённого события.

### 1.2 Данные состояния (per-peer payload)

```
peerState = {
  name,          // одно из Q
  peerPubkey,
  resolvedAt,    // created_at события/действия, которое ПОСЛЕДНИЙ РАЗ перевело
                 // состояние в "решённое" (CONTACT/REJECTED_BY_ME/BLOCKED/NONE-через-cancel).
                 // НЕ обновляется переходами в *_PENDING (это не решение, а ожидание).
  greeting,      // приветствие входящей заявки (только для INCOMING_PENDING, для UI)
}
```

### 1.3 Входной алфавит Σ_in (события)

**A. Пользователь (UI):**
`USER_SEND_REQUEST(peer, greeting)`, `USER_ACCEPT(peer)`, `USER_REJECT(peer)`,
`USER_CANCEL(peer)`, `USER_BLOCK(peer)`, `USER_UNBLOCK(peer)`, `USER_REMOVE_CONTACT(peer)`

**B. Сигналинг из Nostr** (все несут `createdAt` = `rumor.created_at`, кроме тегов идентификации):
`REMOTE_REQUEST(peer, greeting, createdAt)`, `REMOTE_ACCEPT(peer, createdAt)`,
`REMOTE_REJECT(peer, createdAt)`, `REMOTE_CANCEL(peer, createdAt)`

Никаких таймеров (в отличие от звонка — здесь нет "не ответили за 30 секунд", заявки живут, пока их явно не решат).

### 1.4 Выходной алфавит Σ_out (команды)

**Сигналинг наружу:** `PUBLISH_REQUEST(peer, greeting)`, `PUBLISH_ACCEPT(peer)`, `PUBLISH_REJECT(peer)`, `PUBLISH_CANCEL(peer)`
**Локальное состояние:** `UPDATE_CONTACTS_LIST(peer, add|remove)` (republish kind-3), `UPDATE_MUTE_LIST(peer, add|remove)` (republish kind-10000), `UPSERT(peer, fields)` (запись/обновление строки в единой таблице `contactRelationships`, §3), `DELETE(peer)` (перевод строки в `state:"NONE"`, не физическое удаление — см. примечание в §2)
**UI:** `EMIT(peerPubkey, stateName)`, `LOG_JOURNAL(entry)` (см. §6 — мост к фиче "Журнал")

### 1.5 Инварианты (обязательны, покрыть тестами)

- **I1 (redelivery-safety, ГЛАВНЫЙ фикс).** Для "решаемых" состояний (не sticky): входящее Nostr-событие о peer с `createdAt ≤ peerState.resolvedAt` — ИГНОРИРУЕТСЯ целиком (лог, без изменения состояния). Это защищает от повторной доставки СТАРОГО, уже разрешённого события при relogin/reconnect — ТОТ ЖЕ класс проблемы, что чинили для kind 445/30061 в довеске-4, но здесь — на уровне STATE RESOLUTION, не только event-id.
- **I2 (sticky-states immunity).** Пока состояние `CONTACT` или `BLOCKED` — ЛЮБОЕ `REMOTE_REQUEST` игнорируется БЕЗУСЛОВНО (не только по таймстампу, см. §1.1). Выход — только явным пользовательским действием.
- **I3 (crossed-requests / "заявки разошлись" — аналог Glare §2.1 VOICE.md).** Если я в `OUTGOING_PENDING` к peer'у и ОТ ТОГО ЖЕ peer'а приходит `REMOTE_REQUEST` — обе стороны понимают, что взаимно хотели знакомства → переход СРАЗУ в `CONTACT`, БЕЗ дополнительного раунда `PUBLISH_ACCEPT` (симметрично: peer, получив МОЙ более ранний запрос, применит то же правило независимо — синхронизация не нужна, оба разрешают локально).
- **I4 (send-while-incoming = accept).** `USER_SEND_REQUEST(peer)`, поданное, пока peer уже в `INCOMING_PENDING` (т.е. пользователь вместо кнопки "Принять" ввёл npub вручную) — семантически равно `USER_ACCEPT(peer)`. Не создаёт двух противоречащих состояний.
- **I5 (тотальность).** Любая пара (состояние, событие), не описанная в §2 — игнорировать (без изменений), тот же принцип, что VOICE.md.
- **I6 (REJECTED_BY_ME — не терминально).** `REJECTED_BY_ME` можно "переоткрыть" СВЕЖИМ (`createdAt > resolvedAt`) `REMOTE_REQUEST` от того же peer — переход в `INCOMING_PENDING` (решаю заново). Отличие от sticky-состояний намеренное: отказ — не блокировка.

### 1.6 Синхронизация между СВОИМИ устройствами (kind-3/kind-10000) — найдено ПРИ полной унификации

Пользователь выбрал полную унификацию таблиц (развилка №1) — это НЕ чисто косметическое решение: `contacts`/`blockedContacts` СЕЙЧАС не только читаются UI, но ЕЩЁ И зеркалят собственные kind-3 (contact list)/kind-10000 (mute list) — REPLACEABLE-по-факту события для синхронизации МЕЖДУ СВОИМИ устройствами (`handlers.js`'s `foldContactList`/`foldMuteList`, вызываются из `rebuildContactsAndGroups` при каждом `connect()`, `pickLatest` — LWW по `created_at` среди ВСЕХ исторических kind-3/kind-10000 в локальной `events`-таблице). При объединении в `contactRelationships` эта синхронизация обязана продолжать работать — иначе унификация тихо сломает мультиустройство.

Это НЕ per-peer событие (в отличие от §1.3) — целый список сразу, поэтому не вписывается в `reduce(peerState, event)` буквально. Решение: отдельная, тоже ЧИСТАЯ функция в том же `contact-fsm.js`:

```
reconcileList(relationships: Map<peer, peerState>, listKind: "contacts"|"mute", pubkeySet: Set<peer>, createdAt)
  → { relationships: Map<peer, peerState>, commands }
```

Правила (по одной на listKind, симметрично):
- peer ∈ `pubkeySet`, но локально НЕ в целевом sticky-состоянии (`CONTACT` для `"contacts"`, `BLOCKED` для `"mute"`) → перевести в него `[UPSERT(peer,{resolvedAt:createdAt}), EMIT]` — ЭТО И ЕСТЬ, по сути, `REMOTE_ACCEPT` без исходной заявки (другое моё устройство уже приняло решение) — переиспользуем ту же семантику, что переход в CONTACT/BLOCKED в §2, просто источник другой.
- peer, локально В целевом sticky-состоянии, но НЕ в `pubkeySet` → перевести в `NONE` `[DELETE(peer), EMIT]` — **ЕСЛИ** `resolvedAt(peer) ≤ createdAt` (I1 — иначе ЭТО устройство приняло более свежее локальное решение, которое просто ещё не долетело до сети/не попало в последний kind-3/kind-10000; не откатываем).
- peer, локально в ДРУГОМ sticky-состоянии (напр. `BLOCKED`, а событие — `"contacts"`-список без него) → не трогать (списки контактов и мьюта — независимые события, `BLOCKED` не обязан быть в них согласован построчно с обеих сторон одномоментно).
- peer, не упомянутый нигде — не трогать.

Bootstrap для УЖЕ существующих контактов/блокировок (добавленных до этого этапа, `resolvedAt` ещё нет) — решение по развилке №2 ниже.

---

## 2. Таблица переходов δ

Формат: **Событие → Новое состояние `[команды]`**. Не описанное для состояния — I5 (игнор).

### `NONE`
- `USER_SEND_REQUEST(peer, greeting)` → `OUTGOING_PENDING` `[PUBLISH_REQUEST(peer,greeting), UPSERT(peer,{sentAt:now}), EMIT]`
- `REMOTE_REQUEST(peer, greeting, createdAt)` → `INCOMING_PENDING` `[UPSERT(peer,{greeting,createdAt}), EMIT]` *(resolvedAt НЕ трогаем — это не решение, а ожидание)*

### `OUTGOING_PENDING`
- `REMOTE_ACCEPT(peer, createdAt)` — если `createdAt ≤ resolvedAt` → I1 игнор. Иначе → `CONTACT` `[UPDATE_CONTACTS_LIST(peer,add), UPSERT(peer,{resolvedAt:createdAt}), LOG_JOURNAL("принял(а) вашу заявку"), EMIT]`
- `REMOTE_REJECT(peer, createdAt)` — I1-гейт. Иначе → `NONE` `[DELETE(peer), resolvedAt=createdAt (в LOG_JOURNAL, не хранится — NONE=отсутствие строки), LOG_JOURNAL("отклонил(а) вашу заявку"), EMIT]`
- `REMOTE_REQUEST(peer, greeting, createdAt)` от ТОГО ЖЕ peer → **I3, crossed** → `CONTACT` `[UPDATE_CONTACTS_LIST(peer,add), UPSERT(peer,{resolvedAt:createdAt}), LOG_JOURNAL("вы теперь контакты — заявки совпали"), EMIT]`
- `USER_CANCEL(peer)` → `NONE` `[PUBLISH_CANCEL(peer), DELETE(peer), EMIT]`
- `USER_BLOCK(peer)` → `BLOCKED` `[PUBLISH_CANCEL(peer), UPDATE_MUTE_LIST(peer,add), UPSERT(peer,{resolvedAt:now}), EMIT]`

### `INCOMING_PENDING`
- `USER_ACCEPT(peer)` → `CONTACT` `[PUBLISH_ACCEPT(peer), UPDATE_CONTACTS_LIST(peer,add), UPSERT(peer,{resolvedAt:now}), EMIT]`
- `USER_SEND_REQUEST(peer,·)` → **I4** → тот же результат, что `USER_ACCEPT` (см. выше)
- `USER_REJECT(peer)` → `REJECTED_BY_ME` `[PUBLISH_REJECT(peer), UPSERT(peer,{resolvedAt:now}), EMIT]`
- `USER_BLOCK(peer)` → `BLOCKED` `[UPDATE_MUTE_LIST(peer,add), UPSERT(peer,{resolvedAt:now}), EMIT]`
- `REMOTE_CANCEL(peer, createdAt)` — если `createdAt ≤ resolvedAt` → игнор (нечего отменять, уже решено раньше). Иначе → `NONE` `[DELETE(peer), EMIT]`
- `REMOTE_REQUEST(peer, greeting, createdAt)` — та же заявка, свежее `createdAt` → *(остаёмся)* `[UPSERT(peer, обновить greeting/createdAt), EMIT]`

### `CONTACT` (sticky, I2)
- `USER_REMOVE_CONTACT(peer)` → `NONE` `[UPDATE_CONTACTS_LIST(peer,remove), DELETE(peer) с resolvedAt=now перед удалением (см. Frisby — на практике "удалить" здесь означает записать NONE+resolvedAt, не буквально стереть строку, иначе I1 не от чего будет отталкиваться при следующей заявке), EMIT]`
- `USER_BLOCK(peer)` → `BLOCKED` `[UPDATE_CONTACTS_LIST(peer,remove), UPDATE_MUTE_LIST(peer,add), UPSERT(peer,{resolvedAt:now}), EMIT]`
- `REMOTE_REQUEST(·)` → **I2, безусловный игнор** (не по таймстампу — вообще всегда, пока CONTACT)
- `REMOTE_ACCEPT/REMOTE_REJECT/REMOTE_CANCEL(·)` → I5 игнор (нет активной исходящей заявки, если я уже CONTACT)

### `REJECTED_BY_ME`
- `REMOTE_REQUEST(peer, greeting, createdAt)` — `createdAt ≤ resolvedAt` → I1 игнор (старая заявка, уже отклонённая, снова "приехала"). Иначе (**I6**, свежая) → `INCOMING_PENDING` `[UPSERT(peer,{greeting,createdAt}), EMIT]`
- `USER_SEND_REQUEST(peer, greeting)` → `OUTGOING_PENDING` `[PUBLISH_REQUEST(peer,greeting), UPSERT(peer,{sentAt:now}), EMIT]` *(я сам решил(а) написать тому, чью заявку отклонил(а) — независимое действие)*
- `USER_BLOCK(peer)` → `BLOCKED` `[UPDATE_MUTE_LIST(peer,add), UPSERT(peer,{resolvedAt:now}), EMIT]`

### `BLOCKED` (sticky, I2)
- `USER_UNBLOCK(peer)` → `NONE` `[UPDATE_MUTE_LIST(peer,remove), DELETE(peer), EMIT]`
- всё остальное (remote) → I5 игнор безусловно

**Примечание к "NONE = отсутствие строки" vs "нужен resolvedAt даже в NONE":** там, где переход в `NONE` должен защищать от БУДУЩЕЙ redelivery-атаки на I1 (`USER_REMOVE_CONTACT`, `REMOTE_REJECT`→NONE), команда в реализации (`contact-runtime.js`) обязана СНАЧАЛA записать `{state:"NONE", resolvedAt}` (не удалять строку целиком), и только считать физическое отсутствие строки эквивалентным ПЕРВОНАЧАЛЬНОМУ NONE (когда с этим peer вообще никогда не было истории — `resolvedAt` не нужен, отталкиваться не от чего). Это деталь Frisby-реализации, не меняет саму таблицу переходов.

---

## 3. Модульный контракт (Frisby) — заморозить в CONTRACTS.md

```
contact-fsm.js       — pure. export reduce(peerState, event) → {state, commands}
                       И export reconcileList(relationships, listKind, pubkeySet, createdAt)
                       → {relationships, commands} (§1.6). Ноль I/O, ноль async.
                       Только это пишет воркер.
contact-runtime.js   — imperative shell. Держит Map<peerPubkey, peerState> для
                       ВСЕХ известных peer'ов владельца (не одна сессия, как у
                       звонка — состояний много параллельно). Подписан на входящие
                       rumors (giftWrapSubscriber в transport.js маршрутизирует
                       сюда вместо прямой обработки) И на собственные kind-3/
                       kind-10000 (замена foldContactList/foldMuteList — вызывает
                       reconcileList вместо delete-all+bulkAdd), исполняет команды.
```

**Единая таблица (развилка №1 — пользователь выбрал полную унификацию):**
```
contactRelationships: [owner+peer] → {
  owner, peer,
  state,       // "OUTGOING_PENDING" | "INCOMING_PENDING" | "CONTACT" | "REJECTED_BY_ME" | "BLOCKED"
               // ("NONE" без истории — отсутствие строки; "NONE" ПОСЛЕ истории —
               // строка остаётся с state="NONE" ради resolvedAt, см. примечание выше)
  resolvedAt,
  greeting,    // только INCOMING_PENDING
  sentAt,      // только OUTGOING_PENDING
}
```
Заменяет СТРУКТУРНО: `contacts`, `contactRequests`, `blockedContacts`,
`outgoingAcquaintanceRequests` — все четыре читаются как ФИЛЬТРЫ одной таблицы
по `state` (Dexie-индекс `[owner+state]`), а не отдельные таблицы. `contacts.jsx`
это единственное, что должно измениться в UI-слое (п.4, §5).

**Новый kind:** `CONTACT_REJECTED_KIND = 3006` (следующий свободный в кластере rumor-kind'ов 3001-3005) — минимальный rumor (`{kind:3006, content:'', tags:[], created_at}`), тот же паттерн, что `CONTACT_ACCEPTED_KIND`/`ACQUAINT_CANCELLED_KIND` (смысл несёт `rumor.pubkey` после unwrap, не content).

Оба пути отправки заявки ("Добавить контакт" по npub И "Обзор"/acquaintance) публикуют ОДИН и тот же `CONTACT_REQUEST_KIND` и пишут в ОДНУ и ту же `contactRelationships` (сейчас — два независимых механизма с раздельными таблицами, отсюда несогласованность "где мои отправленные"; разбор существующих `contacts`/`contactRequests`/`blockedContacts`/`outgoingAcquaintanceRequests` в единую модель — задача 3, §5).

**Точка интеграции с уведомлениями:** `LOG_JOURNAL(entry)` — команда, добавляющая запись в НОВУЮ фичу "Журнал" (см. §6), а не прямой вызов `notify()`. Разделение специально: FSM не обязан знать про UI-уровень уведомлений, `contact-runtime.js` транслирует `LOG_JOURNAL` в реальный `notify()`+запись в журнал.

---

## 4. Тест-спека (test-first, для gate воркера)

Табличные тесты — строка = `(peerState_in, event) ⇒ (peerState_out, commands)`. Обязательные кейсы:

1. **Happy sender:** NONE → USER_SEND_REQUEST → OUTGOING_PENDING → REMOTE_ACCEPT → CONTACT.
2. **Happy receiver:** NONE → REMOTE_REQUEST → INCOMING_PENDING → USER_ACCEPT → CONTACT.
3. **Отказ (сторона отправителя):** OUTGOING_PENDING → REMOTE_REJECT → NONE, LOG_JOURNAL присутствует.
4. **Отказ (сторона получателя):** INCOMING_PENDING → USER_REJECT → REJECTED_BY_ME, PUBLISH_REJECT командой.
5. **Отмена:** OUTGOING_PENDING → USER_CANCEL → NONE; получатель: INCOMING_PENDING → REMOTE_CANCEL(свежий) → NONE.
6. **I1, redelivery старого REMOTE_ACCEPT:** CONTACT (resolvedAt=T) → REMOTE_ACCEPT(createdAt<T) → состояние НЕ меняется, команды пустые.
7. **I1, redelivery старого REMOTE_REQUEST на уже CONTACT (ГЛАВНЫЙ регресс-тест бага):** CONTACT → REMOTE_REQUEST(любой createdAt) → остаёмся CONTACT, `contactRequests` НЕ создаётся.
8. **I2, sticky BLOCKED:** BLOCKED → REMOTE_REQUEST(любой createdAt, даже очень свежий) → остаёмся BLOCKED.
9. **I3, crossed-requests:** OUTGOING_PENDING → REMOTE_REQUEST(от того же peer) → CONTACT напрямую, БЕЗ PUBLISH_ACCEPT в командах.
10. **I4, send-while-incoming:** INCOMING_PENDING → USER_SEND_REQUEST → тот же результат, что USER_ACCEPT (CONTACT, PUBLISH_ACCEPT).
11. **I6, переоткрытие REJECTED_BY_ME:** REJECTED_BY_ME(resolvedAt=T) → REMOTE_REQUEST(createdAt>T) → INCOMING_PENDING. И обратный: REMOTE_REQUEST(createdAt≤T) → игнор, остаёмся REJECTED_BY_ME.
12. **I5, тотальность:** случайное событие в случайном состоянии, не описанное в δ → без изменений.
13. **Разблокировка:** BLOCKED → USER_UNBLOCK → NONE.
14. **Удаление контакта:** CONTACT → USER_REMOVE_CONTACT → NONE, resolvedAt обновлён (защита от немедленного redelivery-баунса старой заявки).
15. **reconcileList, новый CONTACT с другого устройства:** relationships без peer'а (NONE) + `reconcileList("contacts", {peer}, T)` → peer становится CONTACT, resolvedAt=T.
16. **reconcileList, удаление контакта с другого устройства:** peer CONTACT (resolvedAt=T0) + `reconcileList("contacts", {} без peer'а, T1>T0)` → peer → NONE.
17. **reconcileList, I1 против отката:** peer CONTACT (resolvedAt=T1) + `reconcileList("contacts", {} без peer'а, T0<T1)` → peer ОСТАЁТСЯ CONTACT (список старее локального решения — не откатываем).
18. **reconcileList не трогает несвязанных peer'ов:** relationships с 3 разными peer'ами в разных состояниях + reconcileList по kind="contacts" с одним из них → остальные два не изменились.

Gate воркера: все 18 групп зелёные + `reduce`/`reconcileList` без I/O/async (проверить статикой) → git-чекпоинт.

---

## 5. Декомпозиция для Claude Code + субагентов

| # | Задача | Исполнитель | Почему |
|---|---|---|---|
| 1 | `contact-fsm.js` (`reduce` по §2) + табличные тесты §4 | **воркер** (qwen) | чисто, полностью специфицировано (тот же класс, что call-fsm.js — но, в отличие от него, ПРОЩЕ: нет async-команд с гонкой между собой, поэтому риск ниже) |
| 2 | `contact-runtime.js`: Map состояний, маршрутизация rumor'ов, исполнение команд | **Claude** | интеграция с существующим transport.js/Dexie, миграция существующих таблиц |
| 3 | Миграция данных: разбор текущих `contacts`/`contactRequests`/`blockedContacts`/`outgoingAcquaintanceRequests` в новую модель (bootstrap `resolvedAt` для уже существующих связей — иначе I1 не сработает для старых контактов, добавленных ДО этого этапа) | **Claude** | требует понимания текущей схемы, риск потери данных при миграции |
| 4 | UI: обновить contacts.jsx под новые состояния/названия разделов | **Claude** (JSX) | видимая пользователю часть |

Порядок: 1 первым → 2,3 могут идти параллельно (3 не блокирует 2, но 2 должен ЗНАТЬ результат 3 для bootstrap) → 4 последним.

---

## 6. Приложение А — инвариант для уведомлений (НЕ отдельный FSM)

Лавина уведомлений при релогине — **не новая математическая модель**, а недостающий guard в уже существующем `notify()`-диспетчере (`transport.js`). Инвариант:

**N1 (read-cursor gating).** Перед вызовом `notify()` для контента, привязанного к чату/каналу (сообщение, пост, комментарий, чат канала), диспетчер обязан сверить `createdAt` события с уже известным курсором прочтения (`chatSyncState`/`channelSyncState` — они УЖЕ существуют и уже используются для бейджей). Если `createdAt ≤ cursorAt` — `notify()` не вызывается вовсе (контент уже был прочитан, включая случай "прочитан на другом устройстве" или "прочитан в прошлой сессии до релогина").

Это НЕ заменяет `isNewEvent`/`processedEventIds` (довесок-4) — это ДОПОЛНИТЕЛЬНЫЙ гейт ПОВЕРХ него: `isNewEvent` защищает от повторной обработки в рамках одной сессии; N1 защищает от повторного УВЕДОМЛЕНИЯ о контенте, который пользователь уже читал (возможно, в прошлой сессии, возможно — на другом устройстве).

Для контактных уведомлений (`contacts.newRequests`/`contacts.accepted`) роль курсора прочтения играет сам инвариант I1 из §1.5 — как только redelivery старого `REMOTE_REQUEST`/`REMOTE_ACCEPT` начинает игнорироваться на уровне FSM, `LOG_JOURNAL`/`notify()` для него просто не вызывается (команда не порождается) — отдельного N1-аналога для контактов не нужно, I1 уже всё решает.

## 7. Приложение Б — фича "Журнал" (лёгкий дизайн, не FSM)

Название — **"Журнал"** (короткое, вписывается в ряд Сообщения/Каналы/Контакты/Обзор/Настройки/Профиль/Диагностика; альтернативы "Новости"/"Обновления" отклонены — тут не новости продукта, а лог СОБЫТИЙ пользователя, "Журнал" точнее).

Модель данных (аддитивно, не FSM — обычная append-only таблица):
```
journalEntries: [owner+id] → {
  id,            // uuid
  createdAt,
  category,      // "messages" | "channels" | "contacts" | "calls" | "moderation" (те же категории, что notifier.js)
  title, body,   // тот же текст, что уже показывается в toast/native-уведомлении
  navTarget,     // тот же объект, что уже строит navigateFromNotification (переиспользуем, не изобретаем заново)
  read,          // bool
}
```

`notify()` (`notifier.js`) дополнительно, при каждом реальном срабатывании (level ≠ "off"), пишет `journalEntries`-запись — ОДНА точка входа, не дублировать логику. Клик по записи в "Журнале" помечает `read=true` И вызывает тот же `navigateFromNotification(entry.navTarget)`, что уже используют toast'ы (this session, этап 47).

`Журнал` — новый первый экран после логина (замена `DEFAULT_ACTIVE` в `nav-items.js` с `"messages"` на `"journal"`), непрочитанные — сверху/выделены. НЕ ломает существующие toast/badge — они остаются как есть (быстрая реакция), Журнал — дополнительный, персистентный слой поверх той же точки диспетчеризации.

Это отдельная, обычная (контракты→тесты→код) задача, не требующая табличного FSM — единственная "логика" тут: одна точка записи (в `notify()`), простая бинарная read/unread, и переиспользование уже существующего `navTarget`-механизма.

---

## Развилки — решены явными ответами пользователя (не домысел)

1. **Унификация таблиц.** Решено: **полная унификация** в `contactRelationships` (не аддитивный вариант) — см. §1.6/§3. Больше риска и миграции, чем аддитивный путь, но пользователь предпочёл architecturally чистое решение сразу, не откладывая.
2. **Bootstrap `resolvedAt` для УЖЕ существующих контактов/блокировок** (добавленных до этого этапа) — пользователь не переопределил, беру свою рекомендацию: при миграции (задача 3, §5) проставить `resolvedAt = Date.now()` (момент миграции) для ВСЕХ существующих `CONTACT`/`BLOCKED` записей. Консервативно — не восстанавливает историческую дату, но защищает от любой будущей redelivery немедленно; `CONTACT`/`BLOCKED` всё равно sticky (I2) и не используют resolvedAt для отката, только `contactRequests`/исходящие пострадали бы от неточной даты, а они как раз мигрируют "с нуля" (развилка №3).
3. **Судьба `outgoingAcquaintanceRequests`.** Решено: **чистый старт**, БЕЗ переноса существующих строк — активные исходящие "Обзор"-заявки на момент миграции станут невидимы один раз (не потеряны на уровне протокола — сам Nostr-запрос уже отправлен, просто локальный UI-трекер обнулится; если получатель ответит, `REMOTE_ACCEPT`/`REMOTE_REJECT` всё равно придёт, просто не будет исходной "Отправленной" карточки для него до ответа).

---

## Записка от самого Claude Code

Три вещи, на которые обращу внимание отдельно — тот же принцип, что в VOICE.md, потому что они несут основную нагрузку и легче всего сломать точечной правкой позже:

**I2 vs I1 — это НЕ одно и то же правило, и их легко перепутать при реализации.** I1 (таймстамп-гейт) — для состояний, которые МОГУТ переоткрыться свежим событием (`REJECTED_BY_ME`, разрешение `OUTGOING_PENDING`/`INCOMING_PENDING`). I2 (безусловный игнор, sticky) — только для `CONTACT`/`BLOCKED`, и там taймстамп вообще не участвует в решении. Если воркер (или будущий Claude) реализует I2 через ту же функцию сравнения таймстампов, что I1, — баг вернётся тихо: свежая (по времени) заявка от давно принятого контакта снова создаст `INCOMING_PENDING`, потому что "таймстамп новее". Тест №7 в §4 существует ИМЕННО для этой ловушки — он обязан оставаться зелёным при ЛЮБОМ `createdAt`, включая заведомо будущий.

**`reconcileList` — не per-peer событие, и его легко попытаться "упростить" до вызова `reduce` в цикле.** Нельзя: `reduce` ничего не знает о ДРУГИХ peer'ах (по конструкции, ради чистоты и тестируемости) и не может решить "этого peer'а больше нет в списке — переводи в NONE" — это требует сравнения ВСЕГО текущего Map с ВСЕМ новым списком одновременно. Это осознанно отдельная функция, не вызов `reduce` по кругу.

**REJECTED_BY_ME официально не терминален (I6) — это осознанный выбор, не недосмотр.** Если в будущем понадобится сделать отказ необратимым (peer не может попросить снова вообще никогда), это будет ОТДЕЛЬНОЕ новое состояние (например `REJECTED_PERMANENTLY`), не изменение семантики существующего — иначе сломается тест №11 и весь смысл "отказ ≠ блокировка", ради которого всё это затевалось.

Один момент, где я мог ошибиться и стоит перепроверить при реализации: **§1.6 (kind-3/kind-10000 reconciliation) я формализовал по чтению `foldContactList`/`foldMuteList`, но НЕ проверял живым прогоном, как именно `pickLatest` ведёт себя, если несколько МОИХ УСТРОЙСТВ публикуют kind-3 почти одновременно** (тот же класс гонки, что уже был у `channelSyncState` в довеске-3, где потребовался monotonic `created_at`). Если это всплывёт на практике — решение то же, что там: строго возрастающий `created_at` per-device для кросс-девайсных replaceable-подобных событий, не новая математика.
