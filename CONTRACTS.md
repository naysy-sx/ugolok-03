# CONTRACTS

Контракты между модулями. Принятые контракты прошлых этапов
неизменяемы для воркера (см. skill orchestrate-workers, п.13).

## Этап 1 — каркас проекта

### `src/ui/nav-items.js`

Чистые данные, без JSX. ESM (`package.json` теперь `"type": "module"`).

```js
export const NAV_ITEMS = [
  { id: "contacts", label: "Контакты" },
  { id: "messages", label: "Сообщения" },
  { id: "subscriptions", label: "Подписки" },
  { id: "settings", label: "Настройки" },
  { id: "profile", label: "Профиль" },
  { id: "diagnostics", label: "Диагностика" },
];

export const DEFAULT_ACTIVE = "messages";
```

Инвариант: `id` — уникальный kebab-case (`^[a-z][a-z0-9-]*$`) идентификатор
без пробелов; `label` — непустая строка; `DEFAULT_ACTIVE` — один из `id`
в `NAV_ITEMS`. Список может расширяться в будущих этапах (пункт
"и всё остальное" из PLAN.md), но эти 6 пунктов — обязательный минимум
для этапа 1.

### `src/ui/screens/diagnostics.jsx`

```js
export default function Diagnostics() { /* JSX */ }
```

Самодостаточный компонент: весь текущий функционал экрана диагностики
из `src/main.jsx` (проверки `envChecks`, `useServiceWorker`, `Row`) —
перенесён без изменения поведения, ничего не добавлять и не убирать.

### `src/ui/screens/placeholder.jsx`

```js
export default function Placeholder({ title }) { /* JSX */ }
```

Простая заглушка: заголовок `title` + текст вида "Экран в разработке".
Используется для всех пунктов навигации, кроме `diagnostics`.

### `src/main.jsx`

Рендерит shell: `<aside>` со списком `NAV_ITEMS` (клик по пункту
меняет активный `id` через `useState`) + область контента, которая
рендерит `Diagnostics` при `activeId === "diagnostics"`, иначе
`Placeholder` с `title` из `label` активного пункта.
Сохраняет существующее поведение: `root.replaceChildren()` перед
`render()`, регистрацию обработчика `controllerchange` на `serviceWorker`.

Исправление (этап 2): вывод `BUILD_HASH` / `DEFAULT_RELAYS` в шапке —
это поведение `diagnostics.jsx`, не `main.jsx` (было ошибочно указано
здесь при переносе в этапе 1; `main.jsx` их никогда не выводил).

Приёмка UI (`main.jsx`, `diagnostics.jsx`, `placeholder.jsx`) — не
`node --test` (JSX/DOM), а интеграционная проверка: `npm run dev` +
осмотр в браузере (skill `run`). `node --test` покрывает только
`nav-items.js`.

## Этап 2 — Service Worker + конфиг

Оба файла ниже существовали до принятия skill orchestrate-workers
(`service-worker.js` — коммит `336110b`, до CONTRACTS.md; `src/config.js`
— написан, но не закоммичен, без тестов). Приняты в рамках этапа 2 через
формальную процедуру (тесты + регрессия + адверсарный заход), а не
переписаны воркером заново — код уже корректен, повторная генерация
слабой моделью рискует внести регресс без пользы.

### `src/config.js`

```js
export const BUILD_DEFAULT_RELAYS; // array<string>, из __BUILD_DEFAULT_RELAYS__, фоллбэк []
export const BUILD_HASH;           // string, из __BUILD_HASH__, фоллбэк "dev"
```

Единая точка доступа к build-time константам (define в `vite.config.js`).
Любой модуль, которому нужны `BUILD_HASH`/`BUILD_DEFAULT_RELAYS`,
импортирует их отсюда — не читает `__BUILD_HASH__`/`__BUILD_DEFAULT_RELAYS__`
напрямую (иначе дублирование фоллбэк-логики). Под `node --test` (без
Vite define) обе константы принимают фоллбэк-значения — это ожидаемое,
тестируемое поведение, а не баг.

Приёмка: `node --test` (`tests/config.test.js`) на фоллбэк-ветку;
фактическая build-time подстановка проверяется по содержимому
`dist/index.html` после `npm run build` (интеграционная регрессия,
не unit-тест).

### `service-worker.js`

Классический (non-module) Service Worker script — единственный
разрешённый deploy-артефакт помимо `index.html` (см. CLAUDE.md:
"Два файла"). Не может использовать ESM `import`/`export`, поэтому
не тестируется через `node --test` (тело обращается к глобалам
`self`/`caches`/`clients`, которых нет в Node).

Контракт поведения (F-OF-04/05/06):
- `install`: `self.skipWaiting()`, precache `["./", "./index.html"]` в
  `ugolok-cache-v{BUILD_HASH}`.
- `activate`: удалить все кэши с префиксом `ugolok-cache-`, кроме
  текущего; `self.clients.claim()`.
- `fetch`: не-GET → пропустить (network-only); сам `service-worker.js`
  → пропустить (не кешировать себя); кросс-origin → пропустить
  (network-only, WS/Blossom не трогать); свой origin GET → cache-first
  с фоллбэком на `./index.html` при сетевой ошибке.
- `__BUILD_HASH__` — плейсхолдер, подставляется `emitServiceWorker`
  в `vite.config.js` при сборке (не при dev).

Приёмка: интеграционная (Playwright на собранном `dist/`) — регистрация
SW, версионирование имени кэша, чистка старого кэша при пересборке с
другим `BUILD_HASH`, `controllerchange` → reload. Не unit-тест.

### `src/ui/screens/diagnostics.jsx` (правка контракта этапа 1)

Явное решение Claude (п.13 skill): убрать дублирование — константы
`BUILD_HASH`/`DEFAULT_RELAYS` берутся импортом из `src/config.js`
(`BUILD_DEFAULT_RELAYS as DEFAULT_RELAYS`), а не повторным чтением
`__BUILD_HASH__`/`__BUILD_DEFAULT_RELAYS__` внутри файла. Значения и
поведение идентичны, меняется только источник констант. Требует полной
регрессии (см. DoD этапа 2).

## Этап 3 — IndexedDB-схема + event-log

Тестирование: Dexie требует IndexedDB, которого нет в Node.
Devdependency `fake-indexeddb` (`import "fake-indexeddb/auto"` первой
строкой файла теста, до любого импорта Dexie/database.js) — стандартный
способ юнит-тестировать Dexie вне браузера. Не влияет на бандл
(devDependency, тестовый код). "Видимость в DevTools" (DoD) проверяется
отдельно, интеграционно: `npm run dev` → в консоли браузера
`const m = await import("/src/core/store/database.js"); await m.db.open();`
— без изменения `main.jsx` (файл не входит в список этапа 3).

### `src/core/store/database.js`

```js
export const db; // Dexie-инстанс, имя базы "ugolok" (решение Claude — в TECH.md имя не задано)
```

Схема — `db.version(1).stores({...})`, **дословно** раздел 10 TECH.md
(все таблицы сразу, не только `events` — остальные пока не используются,
но должны существовать и быть видны в DevTools). Значения в
materialized-view таблицах пока НЕ шифруются (шифрование — этап 14,
`encrypted-table.js`); сейчас это просто Dexie-таблицы с обычными
объектами.

### `src/core/store/event-log.js`

```js
export async function appendEvent(event); // -> Promise<number> (seq новой записи)
export async function queryEvents(filter); // -> Promise<NostrEvent[]>
export async function getEventById(id); // -> Promise<NostrEvent | undefined>
export async function hasEvent(id); // -> Promise<boolean>
```

`NostrEvent` — стандартный NIP-01: `{id, pubkey, created_at, kind, tags, content, sig}`.
`tags` — `string[][]` (каждый тег `[name, value, ...rest]`).

**`appendEvent(event)`**: считает `flatTags` из `event.tags` — для
каждого тега с `length >= 2` кладёт строку `` `${tag[0]}:${tag[1]}` ``
в массив (теги короче 2 элементов пропускаются, `name:value` из них не
собрать). Вставляет строку `{...event, flatTags}` в таблицу `events`
через `table.add()` (не upsert — дедупликация по `id` не входит в
контракт этой функции, это забота G-Set merge в этапе 4, который сам
проверяет `hasEvent(id)` перед вызовом). Возвращает `seq` вставленной
записи.

**`queryEvents(filter)`**: `filter` — NIP-01-подобный REQ-фильтр:

```js
{
  ids?: string[],       // OR
  authors?: string[],   // OR, соответствует pubkey
  kinds?: number[],     // OR
  since?: number,        // created_at >= since
  until?: number,        // created_at <= until
  limit?: number,
  // произвольные теговые фильтры в нотации NIP-01, напр. filter["#p"] = ["abc"], filter["#channel"] = ["topic1"]
  // ключ без "#" не трактуется как тег. Внутри одного тега — OR по значениям; между разными тегами и остальными полями — AND.
}
```

Реализация вправе выбрать наиболее селективный Dexie-индекс для
стартовой выборки (`id`, `flatTags`, `[pubkey+kind]`, `created_at`) и
дофильтровать остальные условия в памяти — порядок индекса не часть
контракта, часть контракта — результат.
Результат отсортирован по возрастанию `created_at` (при равенстве —
по `seq`); `limit`, если задан, обрезает до первых `limit` записей
**в этом порядке** (т.е. это не "последние N", а "первые N после
сортировки по возрастанию времени" — простая, детерминированная
семантика; если будущему этапу понадобится другая — правится явным
решением Claude с регрессией).
Фильтр без единого поля (`{}`) возвращает все события (полное
сканирование `events`).

**`getEventById(id)`**: первая запись с `event.id === id`
(`events.where("id").equals(id).first()`), либо `undefined`. Не
`.first()` по всей таблице без индекса — `id` уже проиндексирован.

**`hasEvent(id)`**: `boolean`, эквивалент `(await getEventById(id)) !== undefined`, но не обязана вызывать getEventById буквально — вправе быть отдельным (более дешёвым) запросом типа `.count()`.

### `src/ui/screens/diagnostics.jsx` (правка контракта, по просьбе пользователя после этапа 3)

Добавлена проверка статуса базы данных — по образцу уже существующей
`useServiceWorker()`: асинхронный хук `useDatabaseStatus()`, импортирует
`db` из `../../core/store/database.js`, в `useEffect` вызывает
`db.open()`:
- успех → `` `открыта (${db.tables.length} таблиц)` ``
- ошибка → `"ошибка: " + (e?.message || e)`

Рендерится отдельным абзацем (по образцу строки "Service Worker: …"),
цвет `<strong>` — `var(--ok)` если статус начинается с "открыта",
`var(--bad)` если с "ошибка", иначе `var(--muted)` (пока идёт проверка).
Это первое место в приложении, где `database.js` реально импортируется
из работающего UI (раньше — только вручную из консоли браузера) —
теперь Vite увидит `dexie` в графе модулей уже при обычном
`npm run dev`, без ручного `import()`.

Приёмка — интеграционная (Playwright/`npm run dev`), не `node --test`,
по прецеденту остальных частей `diagnostics.jsx`.

### `src/ui/screens/diagnostics.jsx` (вторая правка — статус кэша, довесок к этапу 2)

По просьбе пользователя: видимость результата работы Service Worker
кэширования (F-OF-04/05/06), не только факта регистрации SW. Хук
`useCacheStatus()`, по образцу `useServiceWorker()`/`useDatabaseStatus()`:

- Cache API нет в браузере → `"не поддерживается"`
- `import.meta.env.DEV` → `"пропущено (dev — кэш появляется только в vite build)"`
  (кэш реален только в собранном `dist/`, как и сам SW)
- иначе: поллинг `caches.keys()` (до 20 попыток по 200мс — install
  асинхронный, может не успеть к моменту рендера) ищет ключ с
  префиксом `ugolok-cache-`:
  - не нашли за отведённое время → `"ошибка: кэш не создан за отведённое время"`
  - нашли, но `cache.keys()` внутри пуст → `` "ошибка: кэш `${name}` создан, но пуст (precache не сработал)" ``
  - нашли и непусто → `` "${match}, ${cachedKeys.length} файлов в кэше" `` (имя кэша содержит `BUILD_HASH`, поэтому это же подтверждает версионирование)

Тон (`cacheTone`): `state.startsWith("ugolok-cache-")` → `var(--ok)`;
`state.startsWith("ошибка")` → `var(--bad)`; иначе `var(--muted)`.
Рендерится строкой "Кэш (Service Worker): …" после строки "Service
Worker: …". Приёмка — интеграционная на собранном `dist/`
(`vite preview`, не `npm run dev`), т.к. поведение принципиально
build-only.

## Этап 4 — валидатор событий + CRDT-примитивы

Design-обоснование (триаж, инварианты, псевдокод) — см. DESIGN.md,
раздел "Этап 4". Здесь — только сигнатуры и формат данных.

`NostrEvent` — как определено в этапе 3 (event-log.js): `{id, pubkey,
created_at, kind, tags, content, sig}`.

### `src/domain/events/validators.js`

```js
export function validateEventId(event); // -> boolean, синхронная
```

Пересчитывает `id` через `getEventHash` из `nostr-tools/pure` (canonical
serialization + SHA-256) и сравнивает с `event.id`. На любой ошибке
(некорректная форма события — `getEventHash`/`serializeEvent` внутри
nostr-tools бросают на невалидной структуре) — возвращает `false`, не
пробрасывает исключение. НЕ проверяет `sig` (это отдельная забота,
`verifySig`/этап 9/10) — только соответствие `id` и его хеша.

### `src/core/sync/g-set.js`

```js
export async function mergeEvent(event); // -> Promise<{ added: boolean }>
```

`added: true` — событие было новым и добавлено в `events` (через
`appendEvent` из `../store/event-log.js`); `added: false` — `id` уже
был в `events` (`hasEvent`), вызов — идемпотентный no-op. Порядок
"проверить-затем-вставить" — часть контракта (инвариант G1 в DESIGN.md),
не деталь реализации.

### `src/core/sync/lww.js`

```js
export function lwwWinner(a, b); // -> a | b (объект события), синхронная, чистая
export function pickLatest(events); // -> событие-победитель непустого массива
```

`lwwWinner`: максимум по отношению `≺` из DESIGN.md — сравнение по
`created_at` (число), при равенстве — по `id` (строка, лексикографически,
большее побеждает). `pickLatest`: свёртка массива через `lwwWinner`
(`reduce` без начального значения — на пустом массиве стандартно
бросает `TypeError`, это не обрабатывается отдельно, вызов с пустым
массивом — ошибка на стороне вызывающего кода).

### `src/ui/screens/diagnostics.jsx` (третья правка — статус этапа 4)

По установившейся практике (пользователь просит показывать результат
каждого этапа на экране диагностики): хук `useCoreLogicStatus()`,
асинхронный self-check трёх примитивов этапа 4 прямо в браузере:

1. `validateEventId` на ФИКСИРОВАННОМ тестовом векторе (не через
   `nostr-tools` генерацию ключей/подпись — это утяжелило бы бандл
   secp256k1/schnorr раньше срока, этапа 7/9; `validateEventId` сама
   по себе тянет только SHA-256 через `getEventHash`, это уже
   приемлемо для этапа 4). Вектор (посчитан заранее через
   `getEventHash`, см. DESIGN.md/лог этапа 4):
   ```js
   { pubkey: "0".repeat(64), created_at: 1700000000, kind: 1, tags: [], content: "diagnostics-self-check",
     id: "33e86c5abb6f63c5ddb082aaf603171c2532d8e886710c491f02111c1f3697d3" }
   ```
   Проверяет: вектор с этим `id` → `true`; тот же вектор с испорченным
   `content` → `false`.
2. `mergeEvent` — вызывается ДВАЖДЫ на синтетическом событии с
   уникальным id (`"diag-selfcheck-" + Date.now()`), проверяет
   `{added:true}` затем `{added:false}`; **обязательно** удаляет
   тестовую строку из реальной `events` после проверки
   (`db.table("events").where("id").equals(...).delete()`) — self-check
   не должен оставлять мусор в БД пользователя.
3. `lwwWinner` — детерминированный тайбрейк на двух заранее заданных
   объектах с равным `created_at`, разным `id`.

Любой сбой (несовпадение ожидания, исключение) → `"ошибка: " + сообщение`.
Все три успешны → `` "ok (validateEventId, mergeEvent, lwwWinner)" ``.
Тон — по тому же принципу, что `dbTone`/`cacheTone`: `startsWith("ok")` →
`var(--ok)`, `startsWith("ошибка")` → `var(--bad)`, иначе `var(--muted)`.
Рендерится строкой "Этап 4 (CRDT-примитивы): …". Приёмка —
интеграционная (Playwright/`npm run dev`), не `node --test` (это UI).

## Этап 5 — App shell + hash-роутер + outbox-заглушка

Триаж (п.13a): **рутинная (а)** для всех трёх файлов — whitelist-роутинг
по `hashchange`, CRUD-обёртка над Dexie-таблицей `outbox` (уже созданной
в этапе 3), рефакторинг существующего JSX без изменения его логики.
Design-записка не нужна.

**Важный архитектурный нюанс (обнаружен чтением TECH.md §11, структура
проекта, до начала работы, по просьбе пользователя):** `main.jsx` и
`app.jsx` — РАЗНЫЕ файлы уже в целевой структуре проекта. Сейчас (после
этапов 1–2) `main.jsx` сам рендерит nav-shell (aside + контент,
`NAV_ITEMS`). Явное решение Claude (п.13, локальный контракт этапа 1/2
меняется): shell-JSX переезжает в `app.jsx` как содержимое маршрута
`/main`; `main.jsx` становится тонким bootstrap (SW-регистрация +
`render(<App/>)`), без прикладной логики. Это необходимо, чтобы
навигация между `#/onboarding`/`#/main`/`#/unlock` (DoD этапа 5) была
реально видна и кликабельна в браузере, а не осталась мёртвым кодом —
см. прецедент этапа 3 (там БД без интеграции была допустима, т.к. DoD
ограничивался "видно в DevTools"; здесь DoD прямо требует навигацию).
Требует полной регрессии + интеграционной проверки (npm run dev,
переключение `location.hash` вручную и через клики).

### `src/ui/router.js`

```js
export const ROUTES = ["/onboarding", "/main", "/unlock"];
export const DEFAULT_ROUTE = "/main";

export function parseRoute(hash); // -> string, чистая функция, БЕЗ обращения к DOM
export function useRoute();       // -> string, preact-хук: useState(parseRoute(location.hash)) + useEffect на 'hashchange'
export function navigate(path);   // -> void, location.hash = path
```

`parseRoute(hash)`: принимает сырую строку (с `#` или без — так проще
тестировать чистой функцией и передавать `location.hash` напрямую).
Убирает ведущий `#`, если он есть. Если результат — один из `ROUTES`,
возвращает его; иначе (пустая строка, неизвестный путь) —
`DEFAULT_ROUTE`. Никакого редиректа/логики авторизации здесь нет —
это появится в этапе 12 (auth-состояние); сейчас чистый whitelist +
фоллбэк.

`useRoute`/`navigate` — тонкие обёртки над `parseRoute`/`location.hash`,
зависят от DOM (`window`, `location`) → не тестируются `node --test`,
только интеграционно. `parseRoute` — чистая, тестируется `node --test`
без DOM.

### `src/core/store/outbox.js`

Таблица `outbox` уже существует (этап 3): `"++seq, eventId, status, retryCount"`.
Это ЗАГЛУШКА (полная реализация с drain — этап 17): только CRUD, без
сети, без publisher/subscriber (их ещё нет).

```js
export async function enqueue(eventId);   // -> Promise<number> (seq); вставляет {eventId, status: "pending", retryCount: 0}
export async function listPending();      // -> Promise<OutboxEntry[]>, где status === "pending", по возрастанию seq (FIFO)
export async function markSent(seq);      // -> Promise<void>; status = "sent"
export async function markFailed(seq);    // -> Promise<void>; status = "failed", retryCount += 1
```

Статусы (решение Claude, в TECH.md не заданы явно): `"pending"` →
`"sent"` | `"failed"`. Никакой логики повторной отправки/backoff —
это этап 17.

### `src/app.jsx`

Новый корневой компонент. Использует `useRoute()` из `router.js`:
- `/onboarding` → `<Placeholder title="Онбординг" />`
- `/unlock` → `<Placeholder title="Разблокировка" />`
- `/main` (и фактический дефолт) → существующий nav-shell из этапа 1
  (aside с `NAV_ITEMS`, контент с `Diagnostics`/`Placeholder`) —
  перенесён **без изменения поведения**, тот же принцип, что перенос
  `diagnostics.jsx` в этапе 1.

### `src/main.jsx` (правка контракта этапов 1/2)

Сохраняет: `root.replaceChildren()` перед `render()`, регистрацию
`controllerchange`. Теряет: весь shell-JSX (переехал в `app.jsx`).
Новое содержимое — импорт `App` из `./app.jsx` и `render(<App/>, ...)`.

Приёмка `app.jsx`/`main.jsx`/`router.js` (кроме `parseRoute`) —
интеграционная (`npm run dev` + Playwright), по прецеденту UI-файлов
этапов 1–2.

### `src/ui/screens/diagnostics.jsx` (четвёртая правка — статус этапа 5)

Хук `useRoute()` из `../../ui/router.js` — показывает текущий маршрут
и список доступных (`` "/main (доступны: /onboarding, /main, /unlock)" ``).
Плюс self-check `outbox.js` (по образцу этапа 4): `enqueue` синтетического
`eventId` → проверка что попал в `listPending` → `markSent` → проверка
что пропал из `listPending` → **обязательная очистка** тестовой строки
(`db.table("outbox").delete(seq)`, т.к. в контракте `outbox.js` нет
функции удаления — чистим напрямую через `db`, уже импортирован в файле).
Формат ошибки/успеха и тон — тот же принцип, что `coreLogicTone`.
Рендерится строкой "Этап 5 (роутер + outbox): …".

## Этап 6 — воспроизводимая сборка (NF-18)

Триаж (п.13a): **рутинная (а)** — bash-скриптинг + документация,
применение готовых инструментов (`npm ci`, `gpg`) по документации.
Design-записка не нужна.

**Пробел знания, закрытый вопросом пользователю (п.9a):** TECH.md
(NF-18/§13.2) требует "хеш … подписывается ключом владельца", но НЕ
называет инструмент подписи. Спрошено явно — **выбор: GPG**
(`gpg --detach-sign`). Не искать других вариантов (minisign, своя
schnorr-подпись) без нового явного запроса пользователя.

**Терминологическая нестыковка (решение Claude, не вопрос пользователю):**
TECH.md пишет `--frozen-lockfile` — это флаг yarn/pnpm. Проект на
**npm** (`package-lock.json`), эквивалент — `npm ci` (ставит строго по
lockfile, падает при расхождении с `package.json`). Использован `npm ci`.

**Два разных хеша, не перепутать (см. комментарий в `vite.config.js`
из этапа 1/2):** `BUILD_HASH` (define-константа, версionирует
Service-Worker-кэш, по умолчанию `git rev-parse --short HEAD`) — это
**не** тот хеш, что требует NF-18. NF-18 — это content-hash (SHA-256)
собранного файла `dist/index.html`, считается ПОСЛЕ сборки, в
`release-hash.sh`.

### `scripts/release-hash.sh`

Bash-скрипт (`set -euo pipefail`), без аргументов или с необязательным
`$1` = GPG key id (`--local-user`, если задан). Шаги:

1. Проверить наличие `gpg` в `PATH` — если нет, понятная ошибка и
   `exit 1` (не пытаться подписывать без него).
2. `npm ci` — детерминированная установка строго по `package-lock.json`.
3. `rm -rf dist` (чистое состояние, не смешивать со старой сборкой).
4. `npm run build` (использует `BUILD_HASH` по умолчанию из
   `vite.config.js` — не переопределять здесь).
5. Посчитать SHA-256 `dist/index.html` в файл `dist/SHA256SUMS`
   (формат вывода `sha256sum`/`shasum -a 256`: `` "<hex>  index.html" ``,
   именно так, чтобы `sha256sum -c` мог сверить). Портируемо: если есть
   `sha256sum` — использовать её; иначе `shasum -a 256`
   (macOS не имеет `sha256sum` из коробки, но имеет `shasum`).
6. `gpg --detach-sign --armor` (плюс `--local-user "$1"`, если `$1`
   задан) → `dist/SHA256SUMS.asc`.
7. Напечатать в stdout: хеш, путь к `SHA256SUMS`/`SHA256SUMS.asc`,
   инструкцию "опубликуйте оба файла вместе с релизом".

Приёмка — не `node --test` (это bash + реальные внешние тулы), а
прогон самого скрипта дважды подряд из одного и того же git-коммита:
`SHA256SUMS` (сам хеш, без учёта подписи — подпись каждый раз разная
даже для одного контента, это нормально для GPG) должен совпасть
побайтово между прогонами — это и есть проверка воспроизводимости
(AC-INTEGRITY). Плюс: `gpg --verify SHA256SUMS.asc SHA256SUMS`
проходит без ошибок.

### `docs/verify.md`

Инструкция для стороннего проверяющего (не разработчика этого репо):
1. Как получить публичный GPG-ключ владельца и импортировать
   (`gpg --import`).
2. Как склонировать репозиторий на нужный коммит/тег, `npm ci`,
   `npm run build`.
3. Как посчитать SHA-256 своей сборки и сверить с опубликованным
   `SHA256SUMS` (`sha256sum -c SHA256SUMS` / `shasum -a 256 -c`).
4. Как проверить подпись (`gpg --verify SHA256SUMS.asc SHA256SUMS`).
5. Как сверить УЖЕ РАЗВЁРНУТЫЙ (отданный сервером) `index.html` с
   опубликованным хешем (например, `curl` + `shasum`) — замыкает цепь
   "то, что я аудировал, — это то, что мне реально отдаёт сервер".

Не код — приёмка человеком (Claude сверяет содержание с TECH.md/NF-18,
не тестами).

### `src/ui/screens/diagnostics.jsx` (пятая правка — статус этапа 6)

У этапа 6 нет браузерного рантайм-компонента (это build/release-процесс,
а не логика приложения) — обычный self-check-патторн этапов 3–5 сюда
не переносится буквально. Вместо этого — практически полезный аналог
шага 5 из `docs/verify.md` прямо в UI: хук `useReleaseHashStatus()`
считает SHA-256 реально загруженного `index.html` через
`crypto.subtle.digest` (`fetch(location.href, {cache:"no-store"})` →
`arrayBuffer` → digest → hex), чтобы пользователь мог сверить с
опубликованным `SHA256SUMS` одним взглядом, без терминала.
Только в build (`import.meta.env.DEV` → `"пропущено (dev — актуально
только для собранного index.html)"`, как и SW/кэш-проверки).
Рендерится строкой "Этап 6 (release-хеш): …".

## Этап 7 — деривация ключей (NIP-06)

Триаж (п.13a): криптография — по п.13b это отдельная категория:
формализация = выбор готового примитива и параметров, не собственная
конструкция. Примитив и параметры уже зафиксированы в TECH.md §4.3/16.1
(BIP-39 → BIP-32 → путь `m/44'/1237'/0'/0/0` → secp256k1 privkey →
schnorr pubkey), значит формализация уже сделана автором ТЗ —
Design-записка не нужна, сразу к тестам.

**Проверено запуском (не поверено на слово):** тестовый вектор из
§16.1 TECH.md воспроизведён на установленных версиях библиотек
(`@scure/bip39@2.2.0`, `@scure/bip32`, `@noble/curves`) — оба хеша
(privKey/pubKey) совпали посимвольно. **Фактическая поправка к
документу** (не решение, не вопрос пользователю): импорт wordlist в
установленной версии требует расширение — `@scure/bip39/wordlists/english.js`,
не `.../english` как в тексте TECH.md (устаревший путь экспорта).

### `src/core/crypto/mnemonic.js`

```js
export function generateMnemonic();               // -> string, 12 слов, 128 бит энтропии, английский wordlist
export function validateMnemonic(mnemonic);        // -> boolean
export async function mnemonicToPrivateKey(mnemonic); // -> Promise<Uint8Array> (32 байта)
```

`mnemonicToPrivateKey` НЕ валидирует мнемонику сама — по пайплайну
онбординга (TECH.md §12.1, вариант B) `validateMnemonic` вызывается
ОТДЕЛЬНО и раньше, перед деривацией; дублировать проверку здесь не
нужно (не боевая граница системы — вызывающий код уже проверил).
Реализация: `bip39.mnemonicToSeed(mnemonic)` → `HDKey.fromMasterSeed(seed)`
→ `.derive("m/44'/1237'/0'/0/0")` → `.privateKey`.

### `src/core/crypto/keys.js`

```js
export function getPublicKey(privateKey); // -> Uint8Array (32 байта, x-only schnorr pubkey)
```

Прямая обёртка над `schnorr.getPublicKey` из `@noble/curves/secp256k1.js`
(тот же примитив, что в смоук-тесте). Возвращает raw bytes, не hex —
hex-конвертация (`bytesToHex` из `@noble/hashes/utils.js`) — на
границе вызывающего кода, не здесь (согласовано с тем, что
`mnemonicToPrivateKey` тоже возвращает raw bytes, а не hex).

### `src/ui/screens/diagnostics.jsx` (шестая правка — статус этапа 7)

По установившейся практике — self-check NIP-06: прогоняет ТОЧНО тот же
вектор §16.1 (`mnemonicToPrivateKey` + `getPublicKey`) прямо в браузере,
сверяет с зашитыми ожидаемыми hex. Процесс сборки диагностики на этот
раз изменён (решение Claude, не правка контракта, а изменение
собственной практики): после двух серьёзных браков подряд на
перезаписи всего файла целиком (галлюцинация без `--ctx` на этапе 4,
обрезание по лимиту токенов на этапе 6) — воркеру дан ТОЛЬКО новый
фрагмент (без `--ctx` всего файла, без просьбы вернуть файл целиком),
вставлен в файл точечно через Edit. И код, и способ вставки
задокументированы здесь, т.к. `diagnostics.jsx` — растущий файл и это,
вероятно, станет стандартной практикой для будущих этапов.
Рендерится строкой "Этап 7 (NIP-06): …".

## Этап 8 — KeyStore + деривация секретов

Триаж (п.13a): криптография (п.13b) — формализация = выбор готового
примитива/параметров, уже сделан TECH.md. Design-записка не нужна.

**Найдено и исправлено расхождение PLAN.md ↔ TECH.md (см. заметку в
PLAN.md, этап 8):** PLAN.md писал "ChaCha20-Poly1305" для шифрования
`privKey` — TECH.md (F-ID-05, §12.1 `encryptAndStore`, §12.9 `onUnlock`)
однозначно требует **PBKDF2-SHA256 (600000 итераций) + AES-GCM через
Web Crypto API**. Следую TECH.md. ChaCha20-Poly1305 в проекте
применяется в других местах (шифрование БД — этап 14, channel keys —
этап 28, файлы — этап 26), но НЕ для keystore.

**Проверено запуском (не поверено на слово):** PBKDF2+AES-GCM
round-trip через `crypto.subtle` (доступен в Node без полифилов),
HKDF через `@noble/hashes/hkdf.js`, `opaqueDTag` — точный смоук-тест
§16.3 TECH.md — все прогнаны лично, совпадают/детерминированы.
**Фактическая поправка к документу** (как в этапе 7, не вопрос
пользователю): пути импорта `@noble/hashes` в TECH.md устарели для
установленной версии 2.2.0 — нужны `hmac.js`, `sha2.js` (не `sha256`),
`utils.js`, `hkdf.js`.

### `src/core/crypto/derivation.js`

```js
export function deriveMasterSecret(privKey);              // -> Uint8Array(32)
export function deriveDbKey(masterSecret);                // -> Uint8Array(32)
export function opaqueDTag(masterSecret, kind, logicalKey); // -> string (64 hex символа)
```

- `deriveMasterSecret`: `HKDF-SHA256(privKey, salt=utf8("Ugolok/v1/master"), info=utf8(""), length=32)`.
- `deriveDbKey`: `HKDF-SHA256(masterSecret, salt=utf8("Ugolok/v1/db"), info=utf8(""), length=32)`.
- `opaqueDTag`: `HMAC-SHA256(masterSecret, utf8(\`${kind}:${logicalKey}\`))`, hex-строка. Сигнатура и порядок
  аргументов — ровно как в смоук-тесте §16.3 (`masterSecret` — явный
  параметр, не читается из замыкания/глобала — "никогда не покидает
  устройство" означает не персистится на диск, а не что функция не
  может быть чистой).

Все три — синхронные чистые функции (HKDF/HMAC в `@noble/hashes` не
асинхронны в отличие от Web Crypto).

### `src/core/crypto/keystore.js`

```js
export async function encryptAndStore(privKey, password); // -> Promise<void>
export async function decryptPrivateKey(password);         // -> Promise<Uint8Array> (32 байта)
```

Таблица `keystore` уже существует (этап 3, схема `"id"`). Константа
`KEYSTORE_ID = "privkey"` (решение Claude — TECH.md не даёт значение
`id`, в проекте одна локальная идентичность на профиль браузера,
мультиаккаунт вне скоупа MVP).

`encryptAndStore(privKey, password)`:
1. `salt = crypto.getRandomValues(new Uint8Array(16))`
2. `iv = crypto.getRandomValues(new Uint8Array(12))`
3. `passwordKey = crypto.subtle.importKey("raw", utf8(password), "PBKDF2", false, ["deriveKey"])`
4. `encKey = crypto.subtle.deriveKey({name:"PBKDF2", salt, iterations:600000, hash:"SHA-256"}, passwordKey, {name:"AES-GCM", length:256}, false, ["encrypt","decrypt"])`
5. `ciphertext = crypto.subtle.encrypt({name:"AES-GCM", iv}, encKey, privKey)`
6. `db.table("keystore").put({id: KEYSTORE_ID, salt, iv, ciphertext})` — сырые `Uint8Array`/`ArrayBuffer`, IndexedDB structured clone хранит их без hex-конвертации.

`decryptPrivateKey(password)`:
1. `record = await db.table("keystore").get(KEYSTORE_ID)`; если `undefined` —
   `throw new Error("keystore: приватный ключ не найден")` (реальный
   достижимый сценарий — unlock до первого onboarding; боевая граница,
   валидировать нужно).
2. Повторить деривацию `encKey` с `record.salt` + данным `password`
   (шаги 3–4 из `encryptAndStore`).
3. `crypto.subtle.decrypt({name:"AES-GCM", iv: record.iv}, encKey, record.ciphertext)`
   → `Uint8Array` (`privKey`). Неверный пароль → `crypto.subtle.decrypt`
   сам бросает (AES-GCM tag mismatch) — не оборачиваем, даём
   исключению дойти до вызывающего кода как есть (интерпретация
   "неверный пароль" — забота UI, этап 11/12).

### `src/ui/screens/diagnostics.jsx` (седьмая правка — статус этапа 8)

**Важно про безопасность self-check'а (решение Claude):** таблица
`keystore` — ОДНА запись с фиксированным id (`"privkey"`). В отличие
от `events`/`outbox` (где синтетическая тестовая запись безопасно
добавляется и удаляется рядом с боевыми данными), здесь тестовый
round-trip `encryptAndStore`/`decryptPrivateKey` НЕИЗБЕЖНО пишет в ТУ
ЖЕ ячейку, что и настоящий сохранённый ключ пользователя (когда он
появится, начиная с этапа 11). Поэтому self-check ОБЯЗАН сначала
проверить `db.table("keystore").get("privkey")`:
- если запись уже существует — деструктивную проверку `keystore.js`
  пропустить целиком (`"пропущено (уже есть сохранённый ключ — не
  трогаем боевые данные)"`), проверить только чистые функции
  `derivation.js` (безопасны, ничего не пишут).
- если записи нет (текущее состояние проекта — онбординг ещё не
  реализован) — прогнать полный round-trip на одноразовом
  ФИКТИВНОМ ключе с последующим ОБЯЗАТЕЛЬНЫМ `db.table("keystore").delete("privkey")`.

**Правка (после перехода keystore.js на мультиаккаунт, см. ниже):**
защита "пропустить, если уже есть запись" — БОЛЬШЕ НЕ НУЖНА. С
`id`-параметром self-check использует собственный уникальный
`"diag-selfcheck-" + Date.now()`, физически не может задеть боевые
записи (разные `id`) — упрощено, ветка с проверкой существования
убрана.

Рендерится строкой "Этап 8 (KeyStore + деривация): …", тон — тот же
принцип (`ok`/`ошибка`/иначе muted). Способ работы с воркером — как в
этапе 7: только новый фрагмент без `--ctx` всего файла, вставка через
Edit вручную.

## Этап 9 — Подпись + NIP-44 + NIP-59

Триаж (п.13b): криптография. `nostr-tools` — референсная реализация
NIP-01/44/59 (TECH.md, таблица зависимостей) — `sign.js`/`nip44.js`/
`nip59.js` реализованы как тонкие обёртки над `nostr-tools/pure` и
`nostr-tools/nip44`/`nip59`, не переизобретаются. Исходники этих
модулей лично прочитаны (не только типы) и сверены построчно с
псевдокодом TECH.md §12.6 (rumor/seal/wrap, kind 13/1059, эфемерный
ключ на wrap, `created_at = random(-2d..now)`) — совпадают.

**Находка 1 (реальная уязвимость доверия в nostr-tools, не в этом
проекте) — исправлена в контракте.** `finalizeEvent`/`verifyEvent`
кэшируют результат проверки в **enumerable** `Symbol`-свойстве
объекта события. Проверено лично: после `{...signedEvent, content:
"x"}` (обычный spread, обычная практика в JS/React-стиле кода) символ
копируется вместе с остальными полями, и `verifyEvent` на испорченной
копии **молча возвращает `true`** — сигнатура не пересчитывается.
Даже прямая мутация поля на исходном объекте даёт тот же ложный
результат. Только `JSON.parse(JSON.stringify(...))` (или явная
пересборка объекта по полям) стирает символ и заставляет
`verifyEvent` перепроверить по-настоящему. **Наш `verify()` обязан
защищаться** — не тонкая обёртка 1:1, а пересборка объекта из
СТАНДАРТНЫХ NIP-01 полей (`id, pubkey, created_at, kind, tags,
content, sig`) явным деструктурированием (не spread — spread копирует
символы, деструктуризация по именам полей — нет) перед вызовом
`verifyEvent`. Проверено: после фикса `verify(tamperedSpread) ===
false` — сигнатура пересчитывается по-настоящему каждый раз.

**Находка 2 (расхождение TECH.md с актуальным протоколом, спрошено у
пользователя, не угадано).** TECH.md заявляет "жёсткий лимит
plaintext NIP-44: 65535 байт" как будто это ограничение протокола.
Проверено: (а) официальная спецификация NIP-44
(github.com/nostr-protocol/nips/blob/master/44.md) поддерживает
payload до ~4 ГБ через расширенный 6-байтный префикс длины для
сообщений ≥ 65536 байт; (б) установленный `nostr-tools` это
реализует корректно — лично зашифровал 100000 байт без ошибки.
Значит "жёсткий лимит" TECH.md — не факт о протоколе, а (возможно
неявное) намерение НАЛОЖИТЬ ограничение на уровне приложения.
**Решение пользователя:** сохранить лимit 65535 байт как явную
app-политику в `nip44.js.encrypt` (throw, если plaintext длиннее) —
не полагаться на протокол/библиотеку в этом вопросе. Обоснование
пользователя: закрывает исходный замысел TECH.md (F-AT-08 и бюджет
голосовых уже посчитаны под этот лимит).

### `src/core/crypto/sign.js`

```js
export function sign(eventTemplate, privateKey); // -> событие с id/pubkey/sig (обёртка над nostr-tools/pure finalizeEvent)
export function verify(event); // -> boolean; пересобирает объект по 7 стандартным полям перед проверкой (защита от Symbol-кэша, см. находку 1)
```

### `src/core/crypto/nip44.js`

```js
export function encrypt(plaintext, privateKey, recipientPublicKey); // -> string (base64 payload)
export function decrypt(payload, privateKey, senderPublicKey); // -> string (plaintext)
```

`encrypt`: если `new TextEncoder().encode(plaintext).length > 65535`
— `throw new Error(...)` ДО вызова `nostr-tools/nip44` (app-политика,
находка 2). Иначе — `getConversationKey(privateKey, recipientPublicKey)`
→ `nip44.v2.encrypt(plaintext, conversationKey)`. `decrypt`: та же
деривация ключа с `(privateKey, senderPublicKey)` (ECDH симметричен —
даёт тот же `conversationKey`, что и на стороне отправителя) →
`nip44.v2.decrypt(payload, conversationKey)`. Лимит на `decrypt` не
нужен — decrypt получает уже готовый payload, а не произвольный
plaintext заранее неизвестной длины от вызывающего кода.

### `src/core/crypto/nip59.js`

```js
export function wrap(rumorTemplate, privateKey, recipientPublicKey); // -> gift wrap событие (kind 1059)
export function unwrap(giftWrap, privateKey); // -> rumor (объект события kind 14, без sig)
```

Прямая обёртка над `nostr-tools/nip59` `wrapEvent`/`unwrapEvent` —
сигнатуры совпадают буквально, переименование только для единого
нейминга проекта (`wrap`/`unwrap`, не `wrapEvent`/`unwrapEvent`).
Внутри уже: rumor (kind 14, без подписи) → seal (kind 13, `NIP44.encrypt`
+ подпись реальным ключом) → gift wrap (kind 1059, `NIP44.encrypt`
+ подпись ЭФЕМЕРНЫМ ключом, генерируемым заново на каждый wrap).
`created_at` каждого слоя — `random(now - [0..2d])`.

### `src/ui/screens/diagnostics.jsx` (восьмая правка — статус этапа 9)

Self-check полностью в памяти (генерирует одноразовые тестовые ключи
через `nostr-tools/pure`, ничего не пишет в `db`) — не нужна защита
"не трогать боевые данные", как в этапе 8. Проверяет по цепочке:
sign→verify (включая обнаружение подмены после подписи — та же
проверка, что находка 1), nip44 round-trip, nip59 wrap→unwrap
round-trip (content и `rumor.pubkey` совпадают с отправителем).
Рендерится строкой "Этап 9 (sign/NIP-44/NIP-59): …". Способ работы с
воркером — фрагмент без `--ctx`, вставка вручную (практика с этапа 7).

## Этап 10 — файловое шифрование + crypto worker

Триаж (п.13b): криптография (файловое шифрование) — примитив и
параметры уже зафиксированы TECH.md §12.6 (`fileKey ← random(32)`,
`ChaCha20-Poly1305(file, fileKey, nonce)`). Design-записка не нужна.
Проверено лично до контракта: `@noble/ciphers/chacha.js`
`chacha20poly1305(key, nonce)` → `.encrypt`/`.decrypt`, 12-байтный
nonce, 16-байтный tag, неверный ключ → `throw "invalid tag"`.

**Инженерное решение по формату (не в TECH.md явно, решено самостоятельно
по стандартной практике AEAD-шифрования файлов, не угадано наугад —
обосновано):** TECH.md §5.х (F-AT-02) описывает ссылку на вложение как
`{type, sha256, blossomUrl, encryptionKey, mime, size, name}` — **без
отдельного поля под nonce**. Значит nonce обязан путешествовать
вместе с шифротекстом одним блобом (иначе негде его хранить/передавать
для расшифровки при скачивании в этапе 26). Стандартная практика:
`nonce (12 байт) ‖ ciphertext+tag` как единый блоб, который и
загружается на Blossom. `encryptFile` возвращает `{key, blob}`, где
`blob` — то, что реально грузится; `decryptFile(blob, key)`
самостоятельно вычитывает nonce из первых 12 байт.

### `src/core/crypto/file-crypto.js`

```js
export function encryptFile(fileBytes); // -> { key: Uint8Array(32), blob: Uint8Array } — генерирует случайные key(32)+nonce(12)
export function decryptFile(blob, key); // -> Uint8Array (исходные байты файла)
```

`encryptFile`: `key = crypto.getRandomValues(32)`, `nonce =
crypto.getRandomValues(12)`, `blob = concat(nonce, chacha20poly1305(key,
nonce).encrypt(fileBytes))`.
`decryptFile`: `nonce = blob.subarray(0,12)`, `ciphertext =
blob.subarray(12)`, `chacha20poly1305(key, nonce).decrypt(ciphertext)`.
Не проверяет размер файла (лимиты F-AT-04 — граница загрузки, этап 26,
не крипто-примитива).

### `src/workers/crypto.worker.js`

```js
// экспонируется через Comlink.expose(api), не ES export
api.batchVerify(events); // -> boolean[] (тот же порядок, что events)
```

Тонкая Comlink-обвязка над `verify()` из `sign.js` (этап 9, уже со
встроенной защитой от Symbol-кэша) — `batchVerify = (events) =>
events.map(verify)`. Не логика `verify` дублируется — переиспользуется.

**Приёмка — НЕ `node --test`, только интеграционная (Playwright,
реальный `new Worker(...)`).** Проверено лично: `Comlink.expose(...)`
обращается к `ep.addEventListener` безусловно (`ep` по умолчанию —
`globalThis`); под чистым Node `globalThis.addEventListener` не
существует → `TypeError` при простом импорте файла. Тот же класс
ограничения, что `service-worker.js` в этапе 2 (там — `self`/`caches`
недоступны в Node). Импортировать `crypto.worker.js` в `node --test`
невозможно в принципе, не только нежелательно.

### `src/ui/screens/diagnostics.jsx` (девятая правка — статус этапа 10)

Этот self-check — ЕДИНСТВЕННЫЙ способ вообще проверить
`crypto.worker.js` (не только на диагностике — в принципе, см. выше:
не тестируется в Node). Совмещает роль "self-check по практике
пользователя" и "интеграционная приёмка воркера" в одном. Оборачивает
`Comlink.wrap`, вызывает `batchVerify` на паре [валидное событие, то
же с испорченным `content`] — ожидает `[true, false]`.
`worker.terminate()` в `finally` (не оставлять висящий Worker). Плюс
`file-crypto.js` round-trip (дёшево, без Worker). Рендерится строкой
"Этап 10 (файлы + crypto worker): …".

**Реальное расхождение со стек-решением CLAUDE.md, найдено сборкой,
не документом (важно).** CLAUDE.md фиксирует: "Деплой: Два файла:
`index.html` + `service-worker.js`". Инстанцирование воркера через
стандартный Vite-паттерн `new Worker(new URL("./crypto.worker.js",
import.meta.url), {type:"module"})` заставляет Vite эмитить
`crypto.worker.js` ОТДЕЛЬНЫМ файлом (`dist/crypto.worker-[hash].js`,
проверено сборкой — `vite-plugin-singlefile` инлайнит только главный
скрипт/CSS в HTML-теги, воркер-чанки не трогает). Это стало бы ТРЕТЬИМ
файлом деплоя — прямое нарушение уже принятого решения.

**Решение (техническое, не архитектурный компромисс — вопрос
пользователю не понадобился):** импортировать воркер с суффиксом
`?worker&inline` — нативная возможность Vite (проверено чтением
исходника `vite/dist/node/chunks/node.js`, `workerOrSharedWorkerRE` +
`inlineRE`), инлайнит воркер как base64 data URL прямо в бандл, без
отдельного файла:

```js
import CryptoWorker from "../../workers/crypto.worker.js?worker&inline";
// ...
const worker = new CryptoWorker(); // не new Worker(new URL(...))
```

Проверено сборкой: с `?worker&inline` — снова ровно 2 файла
(`dist/index.html`, `dist/service-worker.js`), без
`crypto.worker-*.js`. Цена — дублирование крипто-кода между главным
потоком и воркером внутри одного бандла (+~30 КБ gzip: 77→107 КБ,
в пределах бюджета NF-11 280 КБ) и base64-оверхед (~33%) вместо
бинарного файла. **Это канонический способ инстанцировать
`crypto.worker.js` для ВСЕХ последующих этапов** (bootstrap — этап 18,
event handlers — этап 21 и т.д.) — не `new Worker(new URL(...))`.

## Этап 11 — экран онбординга

Триаж (п.13a): рутинная — UI-склейка над уже готовыми крипто-примитивами
этапов 7–9 (`generateMnemonic`/`validateMnemonic`/`mnemonicToPrivateKey`,
`getPublicKey`, `encryptAndStore`) + `nostr-tools/nip19` (`decode`,
`npubEncode`). Design-записка не нужна.

Приёмка `onboarding.jsx`/`mnemonic-display.jsx` — НЕ `node --test`
(JSX), интеграционная (Playwright), по прецеденту всех UI-файлов
(main.jsx, app.jsx, diagnostics.jsx, placeholder.jsx). Логика внутри
не выносится в отдельный тестируемый модуль — вся использованная
крипто-логика уже юнит-протестирована в своих модулях (этапы 7–9),
здесь только склейка с UI-состоянием.

**Пробел в TECH.md, закрыт инженерным решением (не вопрос
пользователю — стандарт, не произвольный выбор):** минимальная длина
пароля нигде не задана. Применено **NIST SP 800-63B** (§5.1.1.2):
минимум 8 символов, БЕЗ принудительных правил сложности (спецсимволы/
цифры/регистр не требуются — это устаревшая практика, которую сам
NIST 800-63B прямо не рекомендует, т.к. она ухудшает выбираемые
пользователем пароли на практике). `MIN_PASSWORD_LENGTH = 8`.

**Пробел в TECH.md, закрыт защитным инженерным решением (по аналогии
с этапом 8, не изобретено с нуля):** роутинг (этап 5) пока не проверяет
auth-состояние — auth-signal и связанный с ним редирект появляются
только в этапе 12. Значит СЕЙЧАС ничто не мешает случайно открыть
`#/onboarding`, когда `keystore` уже содержит настоящий ключ, и
затереть его созданием нового аккаунта (`encryptAndStore` — upsert,
`.put()`). Экран онбординга сам проверяет при монтировании
`db.table("keystore").get("privkey")` — если запись уже есть,
показывает блокирующее предупреждение вместо формы, ничего не даёт
создать. Временная защита до появления полноценного auth-gating в
этапе 12 (там появится решение получше — редирект на `/unlock`).

### `src/ui/components/mnemonic-display.jsx`

```js
export default function MnemonicDisplay({ words }); // words: string[12]
```

Чисто презентационный компонент, без состояния. Нумерованный список
слов (`.grid-auto`, чтобы красиво заполнялось по ширине), моноширинный
шрифт для слов (`var(--font-mono)` — легче отличить похожие слова при
переписывании на бумагу).

### `src/ui/screens/onboarding.jsx`

```js
export default function Onboarding(); // без пропсов
```

Внутреннее состояние — простой шаг-стейт (`useState`, не формальный
ДКА из `src/core/fsm/` — тот предназначен для доменных сущностей типа
сообщений/постов, экран мастера онбординга им не является):

```
"guard"              — проверка keystore при монтировании (короткий, не рендерит форму)
"blocked"            — keystore уже занят, блокирующее предупреждение
"choose"             — выбор варианta A/B/C
"create-generate"    — (A) сгенерированная мнемоника показана (MnemonicDisplay), кнопка "я сохранил"
"create-confirm"     — (A) повторный ввод 12 слов, сверка с сгенерированной
"import-mnemonic"    — (B) ввод существующей мнемоники, validateMnemonic
"import-key"         — (C) ввод nsec ИЛИ 64-символьного hex (F-ID-04)
"password"           — (A/B/C общий) пароль + подтверждение, MIN_PASSWORD_LENGTH=8
"done"               — encryptAndStore выполнен, показывает npub (F-ID-06), кнопка → `navigate("/main")`
```

Переход `"password"` → `"done"`: `await encryptAndStore(privKey, password)`,
затем `getPublicKey(privKey)` → `nip19.npubEncode(bytesToHex(pubKey))`
для отображения. **Не публикует kind 0/10002, не подключается к
relay, не инициализирует Lamport clock** — это шаги 8–10 TECH.md §12.1,
явно вне скоупа этапа 11 (нет ещё relay pool/publisher/lamport.js).
После "done" — только `navigate("/main")` из `router.js` (этап 5).

Вариант C принимает `nsec1...` (через `nip19.decode`, требует
`type === "nsec"` — если пользователь случайно вставил `npub`, явная
ошибка, не путаница) ИЛИ сырой 64-символьный hex (`/^[0-9a-f]{64}$/i`,
через `hexToBytes`).

**Найденное несоответствие разметки и `minimal.css` (по просьбе
пользователя — максимально переиспользовать существующие стили).**
Правило `label:not(:has(input, select, textarea)) {font-weight:bold;
...}` в `minimal.css` стилизует ТОЛЬКО label, который не оборачивает
контрол — рассчитано на паттерн `<label for="id">Текст</label>`
РЯДОМ с полем, а не `<label>Текст<input/></label>` вокруг него.
Проверено визуально (скриншот Playwright до/после): обёрнутый вариант
не получал жирного начертания/отступа подписи. **Все поля формы в
`onboarding.jsx` используют раздельный паттерн** `<label for="…">` +
`<input id="…">` — не оборачивающий. Это канонический паттерн для
всех будущих форм проекта (settings — этап 30, permission-editor —
этап 22 и т.д.), не только онбординга.

### Доработки этапа 11 по прямому запросу пользователя (после приёмки)

1. **`mnemonic-display.jsx`**: сетка мнемоники — явно 4 колонки × 3
   строки (`gridTemplateColumns: "repeat(4, 1fr)"` вместо auto-fit
   от `.grid-auto`), не зависит от ширины окна.
2. **`onboarding.jsx`, шаг `"blocked"`**: добавлено поле пароля +
   кнопка "Войти" — вызывает `decryptPrivateKey(password)` (этап 8) и
   при успехе `navigate("/main")`. Это НЕ полноценный auth-signal —
   просто способ попасть в приложение с уже сохранённым ключом, не
   дожидаясь этапа 12. Решение Claude: этап 12 может позже
   переосмыслить/заменить этот код полноценным экраном `/unlock` —
   явно отмечено как временное здесь и там.
3. **`onboarding.jsx`, шаг `"import-key"`**: добавлен поясняющий
   абзац — что такое приватный ключ, формат `nsec1...` (NIP-19,
   bech32), пример-строка (сгенерирована один раз, зашита в JSX,
   явно подписана "это лишь пример формата, не настоящий ключ" — не
   вычисляется рантаймом).

### Довесок: "Быстрая регистрация" — 4-й вариант входа (явное решение пользователя, продолжает TECH.md, не переписывает)

**Контекст решения.** В системе нет понятия "логин" — идентичность
это ключ, производный от мнемоники, а не пара логин/пароль на
сервере (сервера-аутентификатора нет вообще, relay не хранит
учётки). Пользователь явно попросил "вход по логину-паролю" как
ГЛАВНЫЙ для себя и большинства пользователей способ входа. Обсуждено
и выбрано пользователем осознанно (из 3 вариантов с честно
названными компромиссами): **мнемоника генерируется и используется
как обычно (полная 128-битная энтропия, НЕ password-derived
brainwallet), но не показывается и не требует подтверждения** —
пользователь работает только с паролем. TECH.md F-ID-02 (обязательный
показ+подтверждение мнемоники) остаётся действовать для варианта
"Создать новый аккаунт" — этот новый 4-й вариант ДОПОЛНЯЕТ набор
способов входа, не заменяет и не выбрасывает исходный.

**Осознанный компромисс, показан пользователю на экране `"done"`
только для этого пути:** мнемоника нигде не отображена и не
подтверждена пользователем → при утере устройства/браузерного
хранилища восстановить аккаунт нечем (нет сервера с бэкапом). Показ
мнемоники "в настройках" для желающих сделать бэкап задним числом —
явно ОТЛОЖЕН (settings — этап 30, ещё не существует), зафиксировано
здесь как известный TODO, чтобы не забылось.

`onboarding.jsx`: новая кнопка "Регистрация" на шаге `"choose"` →
`chooseVariant("quick")` → `setStep("quick-register")`.

**Уточнение пользователя (тот же запрос, мид-тёрн):** нужен ещё и
"логин", чтобы форма выглядела как обычная регистрация, без намёков
на криптографию/nostr в этом конкретном пути. Отдельный шаг
`"quick-register"` — СВОЯ форма (Логин + Пароль + Повторите пароль +
"Зарегистрироваться"), не переиспользует общий шаг `"password"`
(там текст про "шифрование ключа" — крипто-жаргон, ровно то, что
просили спрятать). Генерация мнемоники/ключа отложена до нажатия
кнопки (не при выборе варианта).

**"Логин" — не функциональная учётная запись** (сервера-аутентификатора
нет, уникальность логина никем не проверяется, идентичность — это
ключ, не логин). Хранится как обычное (не зашифрованное — это не
секрет) поле `login` в ТОЙ ЖЕ записи `keystore` (`id: "privkey"`)
через `db.table("keystore").update("privkey", {login})` СРАЗУ ПОСЛЕ
`encryptAndStore` — не через изменение контракта `keystore.js`
(`encryptAndStore` из этапа 8 не тронут, доп. поле дописывается
отдельным вызовом из `onboarding.jsx`, у которого уже есть прямой
доступ к `db` для guard-проверки). Пригодится позже для отображения
имени профиля (kind 0, F-ID-08, этап 19) — сейчас нигде, кроме
самой записи, не используется.

Флаг `isQuickRegister` (boolean) по-прежнему отличает этот путь на
шаге `"done"` — только там рендерится предупреждение о
невозможности восстановления.

## Правка контракта этапа 8 + переработка этапа 11 (мультиаккаунт, вкладки, семантика)

По прямому запросу пользователя: (1) на одном устройстве/браузере
должно помещаться НЕСКОЛЬКО зарегистрированных пользователей с
видимыми именами рядом с формой входа — сейчас `keystore` физически
не может хранить больше одной записи (фиксированный `id: "privkey"`);
(2) Регистрация и Вход — один экран с вкладками, как в "первой версии
Уголка", а не мастер из отдельных шагов; (3) название "Онбординг"
непонятно обычному пользователю; (4) крипто-подробности (мнемоника,
nsec-импорт) не убираются (понадобятся для входа с другого
устройства/сети в "свой профиль" — сами мнемоники и ключи ОБЯЗАНЫ
остаться), но не должны быть на виду по умолчанию; (5) вёрстка должна
полнее использовать семантику: `<form>`, `<fieldset>`/`<legend>`,
группировка полей.

**Решение по мультиаккаунту (Claude, инженерное — TECH.md не описывает
мультиаккаунт explicitly, но и не запрещает; естественный
идентификатор в Nostr — pubkey, не произвольная строка).** Контракт
`keystore.js` меняется (п.13 skill — явное решение, полная регрессия
обязательна):

```js
export async function encryptAndStore(privKey, password, id, meta = {}); // -> Promise<void>
export async function decryptPrivateKey(password, id);                    // -> Promise<Uint8Array>
export async function listAccounts();                                     // -> Promise<Array<{id, login}>>
```

- `id` — теперь ОБЯЗАТЕЛЬНЫЙ третий параметр (был захардкожен как
  `KEYSTORE_ID = "privkey"`) — вызывающий код (`onboarding.jsx`)
  передаёt `bytesToHex(getPublicKey(privKey))`: pubkey — естественный,
  уже уникальный, всегда доступный идентификатор аккаунта в этой
  системе, отдельная генерация "логина как ключа" не нужна.
- `meta` — необязательный объект доп. НЕЗАШИФРОВАННЫХ полей
  (например `{login}`) — вставляется в ту же запись `keystore`
  ОДНИМ вызовом `.put({id, salt, iv, ciphertext, ...meta})` (раньше
  `login` дописывался отдельным `.update()` из `onboarding.jsx` —
  теперь эта логика переехала в сам `keystore.js`, единая точка
  правды по формату записи).
- `decryptPrivateKey(password, id)` — расшифровывает КОНКРЕТНУЮ
  запись по `id` (раньше — единственную, без выбора).
- `listAccounts()` — `db.table("keystore").toArray()`, возвращает
  ТОЛЬКО `{id, login}` на запись (не отдаёт `salt`/`iv`/`ciphertext`
  наружу — не нужны вызывающему UI-коду, минимизация поверхности).
  Пустой массив — валидный ответ (ни одного аккаунта ещё нет).

**Обратная совместимость сознательно НЕ обеспечивается** — старые
записи с `id: "privkey"` (созданные до этой правки) станут
недостижимы через `listAccounts()`/новый `decryptPrivateKey(password,
id)` без явного знания старого id. Приемлемо: проект в разработке,
боевых пользователей нет, `IndexedDB` для тестового профиля браузера
можно очистить вручную при необходимости.

### `src/ui/screens/onboarding.jsx` — переработка (вкладки, мультиаккаунт, семантика)

Заголовок экрана меняется с "Онбординг" на **"Вход и регистрация"**
(понятнее обычному пользователю, термин "онбординг" исчезает из
видимого UI — остаётся только как внутреннее имя файла/этапа в
PLAN.md/CONTRACTS.md, не пользовательский текст).

Верхнеуровневая структура — ДВЕ вкладки (`role="tablist"`/`role="tab"`,
локальное состояние `authTab: "register" | "login"`, без изменения
маршрута — по-прежнему один `#/onboarding`):

**Вкладка "Регистрация"** — `<form>` с `<fieldset><legend>` вокруг
Логин/Пароль/Повторите пароль (семантическая группировка полей формы,
явный запрос пользователя), `<button type="submit">` вместо
`type="button"` + `onClick` (правильная семантика формы — Enter тоже
сабмитит). Логика — бывший `handleQuickRegister`, теперь использует
`bytesToHex(getPublicKey(key))` как `id` для `encryptAndStore`.

Ниже формы — `<details><summary>Другие способы (мнемоника,
существующий ключ)</summary>...</details>`: сюда переехали "Создать
новый аккаунт" (с полным показом/подтверждением мнемоники, F-ID-02),
"Войти по мнемонике", "Войти по ключу (nsec)" — со всей существующей
логикой этапа 11 без изменений, просто НЕ на виду по умолчанию
(`<details>` — нативный сворачиваемый виджет, уже стилизован
`minimal.css`, JS не нужен для самого сворачивания).

**Вкладка "Вход"** — при монтировании/переключении на неё —
`listAccounts()`. Если список пуст — подсказка перейти на
"Регистрация". Если непусто — `<fieldset><legend>Выберите
аккаунт</legend>` со списком `login` (или `id.slice(0,16)+"…"`, если
`login` пуст — но обычно есть, задаётся при регистрации) как
radio-группа (`<label><input type="radio" name="account" .../>
{login}</label>`), затем поле пароля, `decryptPrivateKey(password,
selectedId)` → `navigate("/main")`.

**Экран `"blocked"`/guard-проверка "уже есть ключ" — УДАЛЯЮТСЯ**: при
мультиаккаунте регистрация нового пользователя (`id` = его pubkey)
физически не может затереть чужую запись (разные `id`) — сама
проблема, которую решал guard в этапе 11, больше не существует.
`useEffect` при монтировании просто вызывает `listAccounts()` для
вкладки "Вход", без блокировки экрана.

**Визуальная находка при проверке скриншотами (не только тестами):**
`role="tab"` + `aria-selected` сами по себе не дают визуального
различия — `minimal.css` не содержит специфичных стилей для табов
(это отдельный виджет, не входит в базовый набор `elements`/`utilities`
проекта). Добавлено намеренное различие инлайн-стилем: невыбранная
вкладка — `background: transparent, border-color: var(--border)`
(похоже на "призрачную" кнопку), выбранная — стандартный акцентный
`button` без переопределений. Побочный эффект открытия: `role="tab"`
на `<button>` переопределяет его неявную ARIA-роль "button" —
`getByRole("button", …)` в тестах больше не находит вкладки, нужен
`getByRole("tab", …)` (учтено в тестовых сценариях; правильная
семантика важнее совместимости со старыми селекторами).

## Этап 12 — Auth-состояние + экран unlock

Триаж (п.13a): рутинная — состояние на `@preact/signals` (уже
зависимость) + склейка с готовыми `keystore.js`/`derivation.js`.
Design-записка не нужна.

**Реальный пробел, закрытый этим этапом:** до сих пор `onboarding.jsx`
после входа/регистрации делал только `navigate("/main")` — приложение
НИГДЕ не хранило "кто вошёл". Перезагрузка вкладки, `#/main` в адресной
строке без пароля — ничего не защищало реальный экран. Этап 12 это чинит.

### `src/ui/signals/auth.js`

```js
export const currentUser;   // signal<{id, login} | null>
export const privKeySig;    // signal<Uint8Array | null> — in-memory, никогда не персистится сырым
export const masterSecretSig; // signal<Uint8Array | null>
export const dbKeySig;      // signal<Uint8Array | null>
```

Точные сигнатуры функций — ниже (раздел о разделении чистого/DOM-кода);
здесь только сигналы.

**Разделение чистого/DOM-зависимого (решение Claude — если бы
`login()` сама трогала `localStorage`, даже сигнальная часть стала бы
нетестируемой в Node):**

```js
export function login(id, login, privKeyBytes, now = Date.now()); // ЧИСТАЯ: 4 сигнала + touch(now); localStorage не трогает
export function lock();                          // ЧИСТАЯ: сброс 4 сигналов в null
export function touch(now = Date.now());          // ЧИСТАЯ: lastActivity = now (не сигнал, внутренняя переменная)
export function isIdle(now = Date.now());          // ЧИСТАЯ: now - lastActivity > 24ч; now — параметр и здесь, и в touch/login — для тестов без реального ожидания 24 часов

export function setRememberedAccountId(id);        // DOM: localStorage.setItem
export function getRememberedAccountId();           // DOM: localStorage.getItem — throw в Node без localStorage
export function startIdleWatcher();                 // DOM: setInterval(1мин) + click/keydown-слушатели → touch()/lock()
```

**Проверено лично** (не угадано): в чистом Node 24 `localStorage` НЕ
определён глобально (`ReferenceError`) — `setRememberedAccountId`/
`getRememberedAccountId`/`startIdleWatcher` тестируются ТОЛЬКО
интеграционно (браузер/Playwright), не `node --test`. `login`/`lock`/
`touch`/`isIdle` — тестируются `node --test` (`@preact/signals` —
обычный JS-модуль, сигналы работают и в Node без DOM).

Вызывающий код (`onboarding.jsx`/`unlock.jsx`) при успешном входе
вызывает ОБЕ функции явно: `login(id, login, privKey)` +
`setRememberedAccountId(id)` — не одна функция, которая делала бы
и то, и другое (тестируемость).

### `src/ui/screens/unlock.jsx`

Фокусированный (не мульти-таб, в отличие от `onboarding.jsx`) экран:
предзаполняет аккаунт из `getRememberedAccountId()`, если он есть в
`listAccounts()`; иначе — тот же radio-список, что на вкладке "Вход"
онбординга. Пароль → `decryptPrivateKey` → `login()` (не просто
`navigate`, как раньше в онбординге) → `navigate("/main")`. Ссылка
"Другой способ входа" → `navigate("/onboarding")` (для смены
аккаунта/регистрации нового).

### `src/app.jsx` — auth-гейтинг (правка контракта этапа 5)

```
если currentUser.value !== null:
  всегда MainShell (игнорируя route — уже залогинен, /onboarding и /unlock не имеют смысла)
иначе:
  route === "/onboarding" → Onboarding
  иначе (включая "/main" без сессии) → Unlock
```

Это должно быть реактивно на `currentUser` (Preact-сигналы
авто-подписывают функциональный компонент на `.value`-чтения в теле
рендера — `@preact/signals` уже зависимость, доп. хуков не требует).

### `src/ui/screens/onboarding.jsx` (правка) и `src/main.jsx` (правка)

`handleLoginSubmit` в онбординге вызывает `login(id, login, privKey)`
из `auth.js` ПЕРЕД `navigate("/main")` — раньше просто расшифровывал и
переходил, сессия нигде не сохранялась. Эта ветка не имеет
промежуточного экрана подтверждения, поэтому вызов синхронный.

**Правка контракта (найдено адверсарной фазой, не угадано заранее):**
`handleRegisterSubmit`/`handleAdvancedPasswordSubmit` — НЕ вызывают
`login()` синхронно. `currentUser` — реактивный сигнал, `app.jsx`
читает его в теле рендера, значит присвоение `login()` немедленно
размонтирует `Onboarding` (гейтинг переключается на `MainShell`) —
для веток с промежуточным шагом `"done"` (показ `npub`, для
quick-flow — предупреждение "фраза не показывалась") это стирало сам
шаг подтверждения раньше, чем пользователь успевал его увидеть.
Правильная последовательность: обработчики сабмита сохраняют
`privKey`/`pendingLogin` в локальном state и переходят на
`setStep("done")`; `login(id, pendingLogin, privKey)` +
`setRememberedAccountId(id)` вызываются только из `onClick` кнопки
"Перейти в приложение" на этом экране — сессия активируется не раньше,
чем пользователь осознанно подтвердил экран с идентификатором.

`main.jsx`: добавлен вызов `startIdleWatcher()` при загрузке
(бутстрап приложения — единственное подходящее место, вызывается один раз).

## Довесок к этапу 12: экран профиля (по прямому запросу пользователя)

Триаж (п.13a): рутинная — CRUD-обёртка над уже используемой таблицей
`keystore` (прецедент: `login` уже пишется туда же как plaintext-meta,
см. этап 11 "Довесок к довеску") + файловый `<input type="file">` →
`FileReader.readAsDataURL`. Design-записка не нужна.

Пользователь просит главный экран после входа: профиль с аватаром
(заглушка, если не задан; замена через `input type="file"`), полем
био (редактируемым и сохраняемым), и блоком файлов — НЕ функциональным
сейчас, просто интерфейс на будущее. Формально это территория этапа 19
(kind 0, синхронизация профиля по relay) — сделано сейчас как явно
запрошенный локальный стенд-ин, минуя relay.

**Решение о хранении:** avatar/bio — НЕ секреты (в отличие от
privKey), поэтому хранятся как открытые (не зашифрованные) поля той
же записи `keystore`, тем же путём, что уже используется для `login`
(`db.table("keystore").update(id, patch)`, прецедент — этап 11,
довесок 47). `avatar` — data URL (`data:image/...;base64,...`) строкой,
`bio` — обычная строка. Это временное локальное состояние; этап 19
заменит его на настоящую kind-0 запись с публикацией на relay — при
миграции эти же поля станут кэшем/черновиком, а не источником истины.

### `src/core/crypto/keystore.js` (правка — новые функции, старые не тронуты)

```js
export async function getProfile(id);            // -> {login, avatar, bio} (avatar/bio — "" если не заданы), throw если id не найден
export async function updateProfile(id, patch);   // patch: {avatar?, bio?} — обновляет только переданные поля
```

### `src/ui/screens/profile.jsx` (новый файл)

Читает `currentUser.value.id` из `auth.js` (экран монтируется только
внутри `MainShell`, то есть только когда `currentUser.value !== null` —
`id` гарантированно есть). При монтировании — `getProfile(id)`.

- Аватар: `<img>` если `avatar` задан, иначе CSS-заглушка (круг с
  инициалом логина). `<input type="file" accept="image/*">` (скрытый,
  триггерится кнопкой/лейблом) → `FileReader.readAsDataURL` → превью
  сразу в `<img>` (оптимистично) → `updateProfile(id, {avatar})`.
- Био: `<textarea>` + кнопка "Сохранить" → `updateProfile(id, {bio})`.
  Кнопка неактивна, пока текст не отличается от загруженного (простой
  dirty-флаг), после сохранения — статус "Сохранено" на 2 секунды.
- Блок "Файлы": НЕФУНКЦИОНАЛЬНЫЙ — `<section>` с поясняющим текстом
  "Загрузка файлов появится позже" и декоративным
  `<input type="file" disabled multiple>` для визуальной законченности
  интерфейса. Реальная функциональность — отдельный будущий этап
  (Blossom-загрузка, вне текущего скоупа).
- Семантика: `<section>` на каждый блок с `<h2>`, `<label for>`+`id`
  пары, никакого текста про nostr/ключи/kind — тот же принцип
  "не приложение для гиков", что и в онбординге.

### `src/app.jsx` (правка) — MainShell

Вкладка `"profile"` рендерит `<Profile />` вместо
`<Placeholder title="Профиль" />`.

## Этап 13 — MLS-спайк

Полная формализация и обоснование решений — DESIGN.md, раздел
"Этап 13". Здесь — только сигнатуры контракта.

### `src/domain/events/kinds.js` (новый файл)

```js
export const KIND_MLS_KEY_PACKAGE = 443;       // NIP-EE: публикация своего KeyPackage
export const KIND_MLS_WELCOME = 444;           // NIP-EE: приглашение (gift-wrap NIP-59, без подписи)
export const KIND_MLS_GROUP_MESSAGE = 445;     // NIP-EE: сообщение группы, h-тег = nostr_group_id
export const KIND_MLS_KEY_PACKAGE_RELAYS = 10051; // NIP-EE: replaceable список relay для KeyPackage
```

### `src/core/crypto/mls-session.js` (новый файл)

Ciphersuite зафиксирован константой внутри модуля (не параметр наружу
— единый выбор на весь проект, см. DESIGN.md обоснование):
`MLS_CIPHERSUITE = "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519"`.

Модуль владеет ВСЕМ wire-кодированием сам — вызывающий код (будущий
`chat.js`, этап 24) работает только с сырыми байтами, которые идут
прямо в/из `content` Nostr-событий 443/444/445, не имеет дела с
форматами `ts-mls` напрямую.

```js
// credential.identity = UTF-8 байты "${nostrPubkeyHex}:${deviceId}" (правка контракта,
// этап 25 — было ГОЛЫМ nostrPubkeyHex; см. "Этап 25" ниже, раздел про credential-конфликт)
export async function createOwnKeyPackage(nostrPubkeyHex, deviceId);
// -> { publicPackage, privatePackage, wireBytes }
// wireBytes уже закодирован (mlsMessageEncoder, wireformat=mls_key_package) — готов как content kind 443
// persist privatePackage — забота этапа 14, не этого модуля
// deviceId — ОБЯЗАТЕЛЬНЫЙ параметр (throw, если пустая строка/не строка), не дефолтится молча

export async function createGroup(nostrPubkeyHex, ownKeyPackage, groupIdBytes);
// -> sessionState (непрозрачный объект-обёртка над ts-mls clientState; наружу не парсится)

// theirKeyPackageWireBytes — сырой content чужого kind 443 (декодируется внутри, бросает при wireformat != mls_key_package)
export async function addMember(sessionState, theirKeyPackageWireBytes);
// -> { newSessionState, welcomeWireBytes, commitWireBytes }
// welcomeWireBytes -> content kind 444 (gift-wrap NIP-59 — этап 24)
// commitWireBytes -> content kind 445 после NIP-44-конверта (см. ниже)
// createCommit вызывается с ratchetTreeExtension:true (обязательное расширение NIP-EE,
// проверено вживую) — welcome самодостаточен, отдельно передавать ratchetTree НЕ требуется
// ВНУТРИ: consumed.forEach(zeroOutUint8Array) в finally — SM-1, наружу consumed не отдаётся

// welcomeWireBytes — сырой content чужого kind 444 (после NIP-59 unwrap)
export async function joinFromWelcome(ownKeyPackage, welcomeWireBytes);
// -> sessionState

// message — Uint8Array (уже прикладной plaintext, напр. rumor JSON из NIP-17)
export async function encryptApplicationMessage(sessionState, message);
// -> { newSessionState, wireBytes }  (wireBytes — сериализованный MLSMessage, ГОТОВ к шагу NIP-44 ниже)
// ВНУТРИ: SM-1 (zeroOutUint8Array в finally)

export async function decryptApplicationMessage(sessionState, wireBytes);
// -> { newSessionState, message } | { newSessionState, kind: "control" } (proposal/commit, не app-сообщение)
// ВНУТРИ: SM-1

// exporter_secret эпохи -> ключи для NIP-44-конверта kind 445 (NIP-EE §5)
export async function deriveNostrEnvelopeKeys(sessionState);
// -> { privateKey, publicKey }  (privateKey = сырые 32 байта exporter_secret; publicKey = getPublicKey(privateKey) из keys.js)
// label="nostr", context=new Uint8Array(0), length=32 — зафиксировано, не параметризуется

export function serializeState(sessionState); // -> Uint8Array, для персиста этапом 14 (clientStateEncoder)
export function deserializeState(bytes);       // -> sessionState (clientStateDecoder)
```

**Обёртка kind 445 content (используют этапы 16+/24, не этот модуль
напрямую — но контракт кодирования фиксируется здесь, т.к. завязан на
`deriveNostrEnvelopeKeys`):** `wireBytes` из
`encryptApplicationMessage`/перед `decryptApplicationMessage` — бинарные,
а `nip44.js` (этап 9) шифрует ТОЛЬКО строки (`pad()`/`unpad()` из
`nostr-tools/nip44` гоняют plaintext через `TextEncoder`/`TextDecoder`,
UTF-8 — произвольные байты через них не проходят байт-в-байт).
Обязательный порядок: `wireBytes → base64 (btoa/Buffer) → nip44.encrypt(base64Str, envelopeKeys.privateKey, envelopeKeys.publicKey) → kind 445 content`.
Тот же паттерн уже применён в проекте для голосовых (TECH.md §16.4).

**Смок-тест `node --test` (отдельно от DESIGN.md — постоянная
регрессия, не разовая проверка):** полный цикл
`createOwnKeyPackage(alice) → createGroup → createOwnKeyPackage(bob) →
addMember → joinFromWelcome(bob) → encryptApplicationMessage(alice) →
decryptApplicationMessage(bob) == исходное сообщение`, плюс
`deriveNostrEnvelopeKeys` даёт одинаковый результат у alice и bob в
одной эпохе (округление до публичного API `ts-mls`, зафиксировано
вручную — см. DESIGN.md). НЕ заменяет 785 официальных векторов
(см. DESIGN.md, "Эмпирическая проверка") — только ловит поломку
интеграции/установки при каждом обычном прогоне.

**Граница ответственности (важно, не подразумевается — прочитать перед
использованием модуля в будущих этапах):** `mls-session.js` НЕ проверяет,
что байты KeyPackage/Welcome/Commit, переданные в `addMember`/
`joinFromWelcome`/`decryptApplicationMessage`, действительно исходят от
заявленного в `credential.identity` Nostr pubkey — эта проверка требует
доступа к внешнему Nostr-событию (kind 443/444/445) и его подписи,
которых у этого модуля нет. **Обязанность вызывающего кода** (этап 24):
проверить подпись обёртывающего события (`verify()` из `sign.js`) и
сверить `event.pubkey === credential.identity` (после декодирования
KeyPackage) ДО вызова функций этого модуля. Внутри модуля используется
собственный `nostrCredentialAuthService` (не `unsafeTestingAuthenticationService`
из `ts-mls` — та всегда возвращает `true` без проверок, см. DESIGN.md)
— делает только структурную проверку формы credential, не подменяет
внешнюю проверку подписи.

## Этап 14 — шифрование БД + конечные автоматы

Формализация и инварианты — DESIGN.md, раздел "Этап 14". Здесь —
сигнатуры.

### `src/core/fsm/machine.js`

```js
export function transition(transitions, state, event);
// -> string (новое состояние)
// transitions: { [state]: { [event]: state }, "*"?: { [event]: state } }
// throw Error, если transitions[state]?.[event] и transitions["*"]?.[event] оба не определены
// приоритет: конкретное state важнее "*" для той же пары событие/эффективное-состояние
// ЧИСТАЯ функция: не мутирует transitions, не хранит состояние между вызовами
```

### `src/core/crypto/db-crypto.js`

```js
export function encryptRow(value, dbKey);
// -> { nonce: Uint8Array(12), ciphertext: Uint8Array }
// value — ЛЮБОЕ JSON-сериализуемое значение (не Uint8Array/Map/Set напрямую —
// такие поля base64-оборачивает вызывающий код ДО передачи сюда)
// nonce — crypto.getRandomValues(12) на каждый вызов, ChaCha20-Poly1305(dbKey, nonce)

export function decryptRow(encrypted, dbKey);
// -> исходное значение (JSON.parse после расшифровки)
// encrypted: { nonce, ciphertext } — неверный dbKey/испорченный ciphertext -> throw (AEAD tag mismatch, не оборачивается)
```

### `src/core/store/encrypted-table.js`

```js
export function wrapEncryptedTable(table, plaintextFields, dbKey);
// table — Dexie-таблица (db.table("..."))
// plaintextFields — string[], ДОЛЖНЫ совпадать с полями, участвующими в индексе таблицы (Dexie primary key ОБЯЗАН быть в этом списке)
// -> { put(record), get(key) }

// put(record): поля из plaintextFields — как есть в топ-левел объект;
//   ВСЕ остальные поля record — один encryptRow(...) под ключами { ...plainFields, nonce, ciphertext } -> table.put(...)
// get(key): table.get(key); если undefined -> undefined;
//   иначе { ...plainFields, ...decryptRow({nonce,ciphertext}, dbKey) }
```

Осознанно НЕ входит в контракт: `where`/`toArray`/`delete` — каждый
домен (контакты/сообщения/каналы, этапы 21+) строит query поверх
СЫРОЙ `table` (для plaintext-полей это штатно — они не зашифрованы)
и `decryptRow` для расшифровки найденных строк, а не через эту
обёртку — см. DESIGN.md, обоснование сужения скоупа.

### `src/core/store/database.js` (правка контракта этапа 3)

Добавлена таблица (без миграции версии — `db.version(1)` правится
напрямую, проект в разработке, прецедент — мультиаккаунт этапа 11):

```js
mlsGroups: "groupId",
```

`plaintextFields` для будущего оборачивания (этап 24, не этот этап):
`["groupId"]` — единственное поле, остальное (`clientState`
сериализован через `serializeState()` из `mls-session.js`, base64,
плюс `ownDeviceId`) — зашифровано.

## Этап 15 — P-SPIKE

Методология — DESIGN.md, раздел "Этап 15".

### `src/domain/events/synthetic-fixtures.js` (новый файл, тестовый генератор — не прикладной модуль)

```js
export async function generateSyntheticEvents(count, options);
// -> Promise<{
//   fixtures: Array<{ event: NostrEvent, kindGroup: "profile"|"giftwrap"|"permission-proxy"|"channel-proxy", foldKey: string|null, channelKey?: Uint8Array }>,
//   // channelKey присутствует ТОЛЬКО для kindGroup==="channel-proxy" (нужен для decrypt конкретно этого поста)
//   giftwrapRecipientPrivKey: Uint8Array, // ВСЕ giftwrap-события адресованы этому одному "владельцу" (bootstrap = расшифровка своего инбокса, не случайных чужих пар)
// }>
// options: { profile, giftwrap, permission, channel } — доли (по умолчанию 0.10/0.50/0.15/0.25, сумма = 1)
// foldKey — синтетический "логический ключ" для группировки в LWW (для giftwrap — null, journal-тип, не replaceable)
// Все события — с ВАЛИДНОЙ подписью (sign() из sign.js) и, где применимо, ВАЛИДНЫМ шифротекстом
// (nip44.encrypt/nip59.wrap/chacha20poly1305) — не мусорные данные, моделирует нормальный (не атакующий) трафик.
```

### `scripts/p-spike-bench.mjs`

Не модуль с экспортами — исполняемый Node-скрипт (`node scripts/p-spike-bench.mjs`).
Оркестрирует: `vite build` → `vite preview` (порт задаётся внутри) →
Playwright headless Chromium → `page.evaluate()` запускает пайплайн
ВНУТРИ браузера (реальный `crypto.worker.js`, реальный IndexedDB) →
два прогона (1× и CDP `Emulation.setCPUThrottlingRate({rate: 1.5})`)
→ сравнение с порогом NF-09 (30000 мс) → `process.exit(1)` при провале
любого из двух прогонов, иначе `process.exit(0)` с отчётом в stdout.

Пайплайн внутри `page.evaluate()` (использует уже принятые модули
`sign.js`/`nip44.js`/`nip59.js`/`g-set.js`/`lww.js`/`encrypted-table.js`/
`db-crypto.js`, `crypto.worker.js` через `?worker&inline`):
1. batch-verify всех 5000 событий одним вызовом `batchVerify` (Comlink).
2. per-kind: giftwrap → `unwrap` → `mergeEvent` (журнал, `events`);
   profile/proxy-kinds → decrypt → `pickLatest` по `foldKey` →
   `encryptRow`/через одноразовую `wrapEncryptedTable` (throwaway
   Dexie-таблица бенчмарка, НЕ реальная схема `database.js`) — не
   трогает боевые таблицы.
3. `performance.now()` до/после — единственная измеряемая метрика.

**Где физически живёт пайплайн (решено по ходу работы, не описано
заранее).** Собранный `dist/` — единый инлайненный файл, ничего не
экспортирует наружу; `crypto.worker.js` инстанцируется корректно
только в build (этап 10). Поэтому пайплайн — НЕ отдельный `src/`-модуль
с публичным API, а хук `usePSpikeBenchmark()` в `diagnostics.jsx`, по
прецеденту self-check-паттерна (`useCoreLogicStatus` и т.д. этапов
1-10) — но КНОПКОЙ, не авто-запуском на монтировании (5000 событий —
десятки секунд, недопустимо тяжело для обычного визита на экран
диагностики). `scripts/p-spike-bench.mjs` управляет браузером снаружи:
регистрирует тестовый аккаунт → открывает "Диагностика" → жмёт кнопку
→ читает результат из DOM.

### `src/main.jsx` / `src/ui/screens/diagnostics.jsx` (правка контракта этапов 1/2/5 — найдено этапом 15)

Реальный баг, не архитектурное решение — см. DESIGN.md "Побочная
адверсарная находка" этапа 15. Изменения:

- `diagnostics.jsx`: удалён дублирующийся модульный код
  `navigator.serviceWorker.addEventListener("controllerchange", …)` —
  SW lifecycle отныне управляется ТОЛЬКО из `main.jsx`, не дублируется
  в UI-экранах.
- `main.jsx`: `controllerchange` → `location.reload()` теперь условен —
  перезагрузка происходит, только если `navigator.serviceWorker.controller`
  уже был не-`null` ДО регистрации (то есть это обновление уже
  активного SW). Первая установка SW в свежей вкладке (controller был
  `null`) больше не вызывает перезагрузку — раньше это стирало
  in-memory сессию (`currentUser`) без единой ошибки в консоли, что
  особенно опасно, т.к. регистрация SW в `useServiceWorker()` ленивая
  (только при первом реальном показе экрана "Диагностика", который с
  этапа 12 доступен ТОЛЬКО после входа).

## Инфраструктура: локальный тестовый relay (подготовка к этапу 16)

Не код-контракт между модулями проекта — инфраструктурное решение,
записано здесь по той же дисциплине (явное решение + обоснование, не
принимается молча).

**Решение:** тестовый relay — **strfry** (тот же, что зафиксирован в
CLAUDE.md для продакшена), не лёгкая заглушка/мок. Обоснование:
NIP-42 AUTH/whitelist (этап 17, AC-14) — часть модели угроз проекта
(CLAUDE.md: локальная сеть, self-hosted); тестировать этот механизм
против самодельного мок-relay рискует проверить не то поведение, что
будет в реальном деплое.

Размещение — `server/strfry/` (не `src/`, не часть клиентского
бандла). В git — только `strfry.conf`, `run.sh`, `setup.sh`,
`server/README.md`. НЕ в git — `strfry-src/` (269 МБ исходников +
сборка, платформозависимый бинарник) и `strfry-db/` (LMDB, локальные
тестовые данные) — оба в `.gitignore`.

**Эмпирически проверено (не предположено):** `relay.auth.enabled = true`
в конфиге strfry делает relay СПОСОБНЫМ на NIP-42 (объявляет kind 42 в
`supported_nips` NIP-11), но САМ ПО СЕБЕ не требует AUTH и не
блокирует запись — проверено вживую: событие от произвольного
(незнакомого) ключа принято (`["OK", id, true, ""]`) без единого
AUTH-сообщения за весь коннект. Это значит:

1. Реальное принуждение whitelist — работа `relay.writePolicy.plugin`
   (сейчас пусто, то есть "принять всё"), не самого флага
   `auth.enabled`. Настоящий whitelist-плагин (проверка pubkey из
   AC-14) — предметное решение этапа 17: где хранится список, как
   синхронизируется с клиентом — не заглушка "для галочки" сейчас.
2. **Важно для дизайна автомата соединения (этап 16, TECH.md §9.3):**
   клиент не может полагаться на то, что relay пришлёт AUTH-challenge
   сразу при коннекте — переход `authenticating` в автомате должен
   уметь корректно вести себя И когда challenge пришёл (реальный NIP-42
   relay с включённым принуждением), И когда не пришёл вовсе (открытая
   запись, публичные relay, или strfry с пустым `writePolicy.plugin`,
   как сейчас настроен тестовый инстанс) — не тайм-аутить/не зависать
   в ожидании challenge, которого может не быть.

Запуск: `server/strfry/setup.sh` (один раз, сборка) → `server/strfry/run.sh`
(поднимает `ws://127.0.0.1:7777`). Подробности — `server/README.md`.

## Этап 16 — Relay pool + pluggable транспорт

Формализация автомата и обоснование правки контракта TECH.md §9.3 —
DESIGN.md, раздел "Этап 16". Здесь — сигнатуры.

### `src/core/transport/relay-pool.js`

```js
export function computeBackoffDelay(attempt, config = DEFAULT_BACKOFF);
// attempt — целое ≥0 (номер попытки, 0-indexed)
// config: { baseMs: 1000, maxMs: 30000, multiplier: 2, jitter: 0.2 }
// -> number (мс): min(baseMs * multiplier^attempt, maxMs) ± случайный джиттер (доля jitter)
// ЧИСТАЯ функция, кроме встроенного Math.random() для джиттера — тестируется проверкой ГРАНИЦ диапазона, не точного значения

export function createRelayConnection(url, options = {});
// options: {
//   WebSocketImpl = globalThis.WebSocket,   // инъекция для тестов — фейковый WS без реальной сети
//   backoff = DEFAULT_BACKOFF,
//   onMessage(parsedJsonArray),              // СЫРОЙ наблюдатель — видит ВСЕ сообщения, ни на что не влияет (логирование/отладка), не interceptor
//   onStateChange(newState, oldState),
//   autoReconnect = true,                    // реконнект с backoff при CLOSE/ERROR, если close() не был вызван явно
// }
// -> {
//   getState(): string,                      // текущее состояние автомата (см. DESIGN.md таблицу)
//   getUrl(): string,                         // (этап 19) — url, переданный при конструировании
//   addMessageHandler(handler): void,         // (правка контракта, этап 19, см. DESIGN.md) — регистрирует message-interceptor (handler(msg): boolean); пробуются по очереди, первый true останавливает цепочку
//   connect(): void,                          // CONNECT -> connecting; сама заводит WS, сама транслирует WS-события open/close/error в OPEN/CLOSE/ERROR автомата
//   send(msgArray): void,                     // JSON.stringify(msgArray) -> ws.send; throw, если state не "connected"/"subscribed"/"authenticating"
//     (правка контракта, этап 17: "authenticating" тоже разрешён — relay-auth.js обязан отправить AUTH-ответ именно в этом состоянии, WS реально открыт)
//   reportAuthChallenge(): void,              // -> transition(..., "AUTH_CHALLENGE"); вызывает relay-auth.js (этап 17), разобрав сырое AUTH-сообщение
//   reportAuthOk(): void,
//   reportAuthFail(): void,
//   reportAuthTimeout(): void,
//   reportSubscribed(): void,                 // вызывает subscriber.js (этап 18) после успешной подписки
//   close(): void,                            // намеренное закрытие — CLOSE в автомат, отключает autoReconnect до следующего connect()
// }
```

Таблица переходов — константа внутри модуля (не параметр наружу,
единственная версия автомата на весь проект — см. DESIGN.md).
Реконнект: при переходе в `disconnected` НЕ по явному `close()` —
планируется повторный `connect()` через `computeBackoffDelay(attempt)`,
`attempt` растёт при каждом провале подряд, сбрасывается в 0 при
успешном `OPEN`.

### `src/core/transport/transport.js`

```js
export function createEndpointList(urls);
// urls: string[], непустой (throw на пустом массиве — вызывающая ошибка, не сетевая)
// -> {
//   current(): string,   // текущий URL
//   next(): string,       // round-robin: переход к следующему (после последнего — снова к первому), возвращает НОВЫЙ текущий
//   reset(): void,        // возврат к urls[0]
// }
```

Чистый, детерминированный, без сети и без знания о `relay-pool.js` —
политику "когда звать `next()`" (сколько неудачных реконнектов
`relay-pool.js` считать поводом сменить endpoint) реализует вызывающий
код (этап 18, publisher/subscriber — первый реальный потребитель),
не зашита сюда: у `transport.js` этого этапа ещё нет достаточно
информации о реальных паттернах отказов, чтобы не гадать (см. DESIGN.md).

## Этап 17 — NIP-42 AUTH

Обоснование пробела/решения пользователя — DESIGN.md, раздел "Этап 17".

### `src/core/transport/relay-auth.js`

```js
export function buildAuthEvent(challenge, relayUrl, privKey);
// -> NostrEvent (kind 22242, подписанное, sign() из sign.js)
// tags: [["relay", relayUrl], ["challenge", challenge]], content: "", created_at: Math.floor(Date.now()/1000)

export function createAuthHandler(connection, relayUrl, privKey, options = {});
// connection — объект от createRelayConnection (relay-pool.js, этап 16)
// options: { timeoutMs = 10000 }
// -> function handleMessage(msgArray): boolean
//    ["AUTH", challenge]                      -> connection.reportAuthChallenge(); buildAuthEvent(...); connection.send(["AUTH", authEvent]); запускает таймер timeoutMs -> connection.reportAuthTimeout(), если OK не пришёл; возвращает true
//    ["OK", <id ожидаемого auth-события>, ok, msg] -> connection.reportAuthOk()/reportAuthFail() (гасит таймер); возвращает true
//    любое другое сообщение -> false (не обработано, пусть смотрит следующий обработчик в цепочке — publisher.js/subscriber.js, этап 18)
```

Не владеет `onMessage` монопольно — возвращает функцию-перехватчик,
вызывающий код (этап 18+) комбинирует несколько таких функций в
цепочку по паттерну "первый, кто вернул true — обработал".

### Инфраструктура: whitelist на запись (правка `server/strfry/`)

Решение пользователя (DESIGN.md) — whitelist по `event.pubkey`, не по
NIP-42 `authed`. Добавлен `server/strfry/whitelist-plugin.mjs`
(Node-скрипт, протокол plugin — построчный JSON stdin/stdout, по
`docs/plugins.md` strfry) + `server/strfry/whitelist.json` (список
разрешённых hex-pubkey, версionируется — тестовые фикстуры, не боевой
секрет). `strfry.conf`: `relay.writePolicy.plugin =
"./whitelist-plugin.mjs"`.

## Этап 18 — Publisher + subscriber + outbox

Обоснование батчинга/bulk-транзакции/drain-семантики — DESIGN.md,
раздел "Этап 18". Здесь — сигнатуры.

### `src/core/sync/g-set.js` (правка контракта этапа 4 — добавлена функция, `mergeEvent` не менялся)

```js
export async function mergeEvents(events);
// events: NostrEvent[]
// -> Promise<{ addedIds: string[] }>  // id событий, реально добавленных (не дублей)
// ОДНА db.transaction("rw", db.events, ...) на весь массив (F-CS-08)
```

### `src/core/transport/publisher.js`

```js
export function createPublisher(connection, options = {});
// connection — объект от createRelayConnection (relay-pool.js, этап 16)
// options: { batchSize = 100, batchWindowMs = 200 }
// -> {
//   publish(event): Promise<{ ok: boolean, reason: string }>,  // резолвится по OK от relay; событие уходит на ближайшем флаше очереди
//   flush(): void,                                              // принудительный немедленный флаш (не ждать size/timer)
//   handleMessage(msg): boolean,                                 // message-interceptor: ["OK", id, ok, reason] для событий из этой очереди
// }
```

### `src/core/transport/subscriber.js`

```js
export function createSubscriber(connection, options);
// options: {
//   batchSize = 100, batchWindowMs = 200,
//   verifyBatch: async (events) => boolean[],      // инъекция — реально crypto.worker.js batchVerify (этап 10), тесты дают фейк
//   onBatch: async (validEvents, subId) => void,      // инъекция — реально mergeEvents (см. выше), тесты дают фейк; subId — чтобы вызывающий код мог различать подписки (разные таблицы/маршруты)
// }
// -> {
//   subscribe(subId, filters): void,   // -> connection.send(["REQ", subId, ...filters])
//   unsubscribe(subId): void,          // -> connection.send(["CLOSE", subId])
//   handleMessage(msg): boolean,       // message-interceptor: ["EVENT", subId, event] копится в очередь subId; ["EOSE", subId] форсирует флаш этой подписки
// }
```

Флаш триггеры (per-subscription очередь, у каждого `subId` своя):
`size(batchSize)` ИЛИ `time(batchWindowMs)` ИЛИ `EOSE` — что раньше.
На флаше: `verifyBatch(batch)` → события, где `verified[i]===true` →
`onBatch(validEvents)`.

### `src/core/store/outbox.js` (правка — добавлена функция, CRUD этапа 5 не менялся)

```js
export async function drain(publishFn);
// publishFn: async (eventRecord) => { ok: boolean }  // обычно createPublisher(...).publish, но принимает NostrEvent, не outbox-запись — см. примечание
// -> Promise<{ sentCount: number, failedCount: number }>
// Последовательно (не параллельно, см. DESIGN.md) по listPending() (FIFO): publishFn(event) -> ok ? markSent(seq) : markFailed(seq)
```

**Примечание о форме данных outbox.** Таблица `outbox` (этап 5) хранит
`{seq, eventId, status, retryCount}` — НЕ само событие целиком, только
`eventId`. `drain` для реальной публикации нуждается в полном
NostrEvent — забота вызывающего кода (этап 19+, bootstrap/chat.js)
достать событие по `eventId` через `getEventById` (этап 3) ПЕРЕД
вызовом `publishFn`. `drain` в этом контракте принимает уже готовую
функцию `publishFn(eventRecord)`, где `eventRecord = {seq, eventId,
event}` — резолвинг `eventId → event` тоже на стороне вызывающего
(инъекция), не хардкод `getEventById` внутрь `outbox.js` (тестируется
без реальной БД).

## Этап 19 — Lamport-часы + bootstrap cold start

Формализация и обоснование сужения скоупа `bootstrap.js` — DESIGN.md,
раздел "Этап 19". Здесь — сигнатуры.

### `src/core/transport/subscriber.js` (правка контракта этапа 18 — добавлена опция, остальное не менялось)

```js
export function createSubscriber(connection, options);
// options добавлено: onEose(subId): void  — вызывается ПОСЛЕ flush() текущего батча на EOSE
```

### `src/core/sync/lamport.js`

```js
export function createLamportClock(initialValue = 0);
// -> { tick(): number, receive(remoteT: number): number, getValue(): number }
// ЧИСТЫЙ, in-memory, без побочных эффектов на БД (см. DESIGN.md — persist это забота вызывающего кода, в одной транзакции с записью сообщения)

export async function computeInitialLamportValue();
// -> Promise<number>
// Сканирует db.table("messages") (materialized view, поле lamportTs) -> max(0, max{lamportTs}) + 1
// ВСЕГДА пересчитывает от фактических данных, не читает закэшированное значение из clock (см. DESIGN.md, инвариант L2)

export async function persistLamportValue(value);
// -> Promise<void>
// db.table("clock").put({ id: "lamport", value }) — вызывающий код кладёт ВНУТРИ своей Dexie-транзакции
// (передаёт транзакционный контекст через уже открытую db.transaction(...) — Dexie резолвит вложенные вызовы в текущую транзакцию автоматически, если она открыта)
```

### `src/core/sync/bootstrap.js`

Скоуп (что реализовано и что явно отложено) — таблица в DESIGN.md.

```js
export async function runBootstrap(connection, pubkey, options = {});
// connection — ОДНО уже подключённое соединение (createRelayConnection, connected/subscribed)
// options: { verifyBatch, subId = "bootstrap" } (verifyBatch — та же инъекция, что subscriber.js, этап 18)
// -> Promise<{ addedCount: number, lamportValue: number }>
//
// 1. subscriber = createSubscriber(connection, { verifyBatch, onBatch: (events) => mergeEvents(events), onEose: ... })
// 2. subscriber.subscribe(subId, [{ authors: [pubkey] }, { "#p": [pubkey], kinds: [30053] }])
// 3. Promise резолвится по onEose (после того, как последний batch этой подписки обработан onBatch)
// 4. После EOSE: lamportValue = await computeInitialLamportValue(); await persistLamportValue(lamportValue)
// 5. await setSyncState(<url соединения>, Math.floor(Date.now()/1000))
// 6. -> { addedCount (сумма addedIds.length по всем onBatch-вызовам), lamportValue }

export async function getSyncState(relayUrl);
// -> Promise<number | undefined>  — db.table("syncState").get(relayUrl)?.lastSeen

export async function setSyncState(relayUrl, lastSeen);
// -> Promise<void> — db.table("syncState").put({ relay: relayUrl, lastSeen })
// Экспортируется отдельно — этап 20 (инкрементальная синхронизация, F-CS-09) читает то же значение, не дублирует формат
```

**Не в скоупе (см. таблицу DESIGN.md):** расшифровка приватных kind,
channel keys, comment allowlist, fold в domain-таблицы кроме
журнального `events`, rebuild `effectivePerms`, UI-уведомление о
готовности. Каждое — правка контракта на своём будущем этапе (21/28/30).

## Этап 20 — Инкрементальная синхронизация + профиль

Обоснование миграции профиля и сужения скоупа — DESIGN.md, раздел
"Этап 20". Здесь — сигнатуры.

### `src/domain/identity/profile.js`

```js
export function buildProfileEvent(privKey, { name, about } = {});
// kind 0, content = JSON.stringify({ name, about }) — поле picture НЕ пишется
// (см. DESIGN.md: аватар остаётся локальным до Blossom, этап 26)
// -> подписанный NostrEvent (sign() из sign.js)

export function parseProfileEvent(event);
// -> { name?: string, about?: string, picture?: string } — parse ЧУЖОГО kind 0,
// picture может присутствовать (чужой клиент его опубликовал), просто наш build его не создаёт
// event.content не валидный JSON -> throw (боевая граница: данные из relay, не наши)
```

### `src/domain/identity/relay-list.js`

```js
export function buildRelayListEvent(privKey, relayUrls);
// kind 10002, tags = relayUrls.map(url => ["r", url]), content = ""
// -> подписанный NostrEvent

export function parseRelayListEvent(event);
// -> string[] — urls из тегов ["r", url]
```

### `src/core/sync/incremental-sync.js`

```js
export async function startIncrementalSync(connection, pubkey, options = {});
// options: {
//   verifyBatch,                          // как в subscriber.js/bootstrap.js
//   subId = "incremental-sync",
//   onCaughtUp: () => void,                 // EOSE — историческая часть догнана, дальше живой поток (F-CS-10)
//   onEvent: (addedCount) => void,           // после каждого обработанного батча
//   onClockSkew: (skewSeconds) => void,      // |Date.now()/1000 - event.created_at| > 30 для события ИЗ ТЕКУЩЕГО батча (F-RL-06)
// }
// -> Promise<{ stop(): void }>
// since = (await getSyncState(connection.getUrl())) ?? 0 — читает то же значение, что пишет bootstrap.js (этап 19), не дублирует формат
// В отличие от runBootstrap (этап 19, резолвится один раз после EOSE) — эта подписка
// ОСТАЁТСЯ ОТКРЫТОЙ после EOSE (F-CS-10, фоновый live-поток), .stop() — явное завершение
```

**Осознанно НЕ в скоупе** (см. таблицу-аналог DESIGN.md этапа 19):
расшифровка приватных kind, rebuildCache permissions/contacts/groups,
`lamport.receive` для сообщений в открытых чатах, обновление channel
allowlist — правка контракта на этапах 21/22/24/30.

### `src/ui/components/sync-indicator.jsx`

```js
export default function SyncIndicator({ state, synced, url });
// state — строка состояния relay-pool.js (disconnected/connecting/authenticating/connected/subscribed)
// synced — boolean (onCaughtUp уже сработал хотя бы раз)
// url — опционально, адрес relay; если передан, рендерится рядом с текстом
//   статуса вне зависимости от state (в т.ч. в "офлайн") — правка по прямой
//   просьбе пользователя (диагностика должна показывать, К ЧЕМУ идёт попытка
//   подключения, не только факт её состояния)
// Чисто презентационный компонент (по прецеденту MnemonicDisplay, этап 11) —
// не создаёт соединение сам, родитель передаёт состояние через props
```

Маппинг `state`→текст (решение Claude, TECH.md не даёт готовых
строк): `disconnected`→"офлайн", `connecting`/`authenticating`→
"подключение…", `connected`+`!synced`→"синхронизация…",
`connected`/`subscribed`+`synced`→"на связи".

### Правка контракта: dev-режим — локальный relay поднимается автоматически

По прямой просьбе пользователя после визуального осмотра diagnostics.jsx
(таймаут "disconnected" на пустом месте — relay не был запущен).
Затрагивает `vite.config.js` и `server/strfry/whitelist.json`:

```js
function buildDefaultRelays(command);
// command === "serve" (npm run dev) и BUILD_DEFAULT_RELAYS не задан явно
// через env → ["ws://127.0.0.1:7777"] (локальный strfry, не placeholder).
// command === "build"/"preview" → прежнее поведение, ["wss://relay.example"]
// (продакшн-плейсхолдер, обязана переопределить конфигурация деплоя).
// Явный env BUILD_DEFAULT_RELAYS всегда выигрывает в обоих режимах.

function devRelayPlugin(); // apply: "serve" — на build/preview не действует
// configureServer: если server/strfry/strfry-src/strfry не собран — warn и
// no-op (диагностика останется без живого relay, но dev-сервер не падает);
// иначе mkdir strfry-db при отсутствии, spawn server/strfry/run.sh,
// stdout/stderr прокинуты в терминал vite с префиксом "[strfry]", kill при
// закрытии dev-сервера (process "exit" + httpServer "close").
```

`server/strfry/whitelist.json` — правка дефолта: раньше `[]` (deny-all),
теперь содержит РОВНО один pubkey —
`d5b776f29d9783a9f33e422f285c723cb6cc5b4442d6778e4c24b723f0eae998`,
детерминированная тестовая identity диагностического self-check'а
(`DIAGNOSTICS_SELF_CHECK_PRIVKEY` в diagnostics.jsx = `sha256("ugolok-
diagnostics-self-check-v1")`). Раньше `useTransportSyncCheck` генерировал
случайный privKey на каждый клик — pubkey непредсказуем, поэтому write-
whitelist (этап 17, AC-14) гарантированно отклонял публикацию при первом
же запуске на свежесобранном relay (см. log.md, этап 20). Фиксированная
identity не секрет (используется только для этого self-check, не несёт
реальных данных) — предсказуемый pubkey можно внести в whitelist один раз;
свойство "whitelist реально блокирует не-whitelisted pubkey" не ослаблено,
проверяется отдельно (AC-14, этап 17).

## Этап 21 — Битовая маска прав + журнальный движок

Формализация решётки join/meet и инварианта монотонности R6-5 —
DESIGN.md, раздел "Этап 21". Здесь — сигнатуры. Все три модуля работают
над АБСТРАКТНЫМИ данными (не nostr-событиями) — см. границы скоупа в
конце раздела.

### `src/domain/auth/bitset.js`

```js
export const ACTIONS; // { VIEW: 1, COMMENT: 2, WRITE: 4, MODERATE: 8, ADMIN: 16 } — TECH.md §4.2
export const ALL_ACTIONS; // VIEW|COMMENT|WRITE|MODERATE|ADMIN (для complement)

export function join(a, b);        // a | b
export function meet(a, b);        // a & b
export function complement(a);     // (~a) & ALL_ACTIONS — относительно ALL_ACTIONS, не 32-битного ~a буквально
export function effective(allowMask, denyMask); // allowMask & ~denyMask; effective(0,0) === 0 (fail-closed)
export function can(mask, action); // (mask & action) !== 0
```

Алгебраические свойства (коммутативность/ассоциативность/идемпотентность
`join`/`meet`, поглощение, де Морган через `complement`) — контракт,
проверяемый тестами этапа, не документируется отдельно от кода теста.

### `src/domain/auth/permissions.js`

```js
export function createPermissionRecord({ subject, resource, allowMask, denyMask, lamportTs, eventId });
// Фабрика формы записи журнала (PermissionRecord). Валидирует обязательные
// поля (throw при отсутствии/неверном типе subject/resource/lamportTs/eventId);
// allowMask/denyMask по умолчанию 0. НЕ проверяет подпись/issuer — это
// ответственность вызывающего кода (см. "Границы скоупа" ниже).
// -> { subject, resource, allowMask, denyMask, lamportTs, eventId }
```

### `src/domain/auth/engine.js`

```js
export function rebuildCache(records);
// records: PermissionRecord[] (любой порядок, не обязательно отсортирован)
// Группирует по (subject, resource), внутри группы сортирует по
// (lamportTs asc, eventId asc), сворачивает: acc = 0; for r in order:
// acc = (acc | r.allowMask) & ~r.denyMask. Псевдокод и формальный
// инвариант R6-5 — DESIGN.md.
// -> Map<string, number> — ключ JSON.stringify([subject, resource]), значение effectiveMask

export function can(cache, subject, resource, action);
// cache.get(JSON.stringify([subject, resource])) ?? 0, затем bitset.can(mask, action)
// undefined-запись (subject/resource без единой записи в журнале) -> 0 -> false (fail-closed)
```

### Границы скоупа этапа 21 (явное сужение, DESIGN.md)

Не в скоупе: разбор/подпись/публикация nostr-событий, выбор конкретного
`kind` для permission-событий, проверка "issuer == владелец resource",
интеграция с contacts/groups (subject/resource — просто opaque-строки
здесь). Всё это — `handlers.js` этапа 22 ("fold для kinds 3, 30050,
30051" по PLAN.md), который будет вызывать `rebuildCache` с уже
провалидированными записями — ровно как `mergeEvent`/`g-set.js`
доверяет `validateEventId`, проверенному ДО вызова, не внутри.

## Этап 22 — Контакты + группы + блокировка + NIP-09

Триаж (п.13a): **рутина** — склейка уже готовых примитивов (mergeEvent,
sign/NIP-44, createPermissionRecord/rebuildCache из этапа 21). DESIGN.md
формальный раздел не пишется (нет нетривиального инварианта), но
протокольные решения ниже — реальные находки/несоответствия, требующие
явной фиксации, не молчаливого выбора.

### Находки и решения (до сигнатур)

**1. `kind 30051` для журнала прав — устарел, заменён на `kind 5051`.**
TECH.md сам предупреждает не читать старую форму "kind 30051" буквально
после R6-5 (журнальная модель, этап 21): диапазон 30000-39999 —
parameterized-replaceable, relay схлопывает записи по `(pubkey, kind,
d-tag)` — несовместимо с append-only журналом (новый `grant`/`revoke`
исчезнет, останется только последняя запись, что убивает саму цель R6-5).
TECH.md строка 240 сама определяет диапазон 1000-9999 как "журнальный"
(relay хранит все экземпляры) — уже используется в проекте для gift wrap
(1059). Выбран **`kind 5051`** (не занят, мнемонически перекликается со
старым 30051). `d-tag` сохраняется как `opaqueDTag(masterSecret, 5051,
subject + ":" + resource)` — на non-replaceable kind relay его не
использует для замены, но он остаётся полезен клиенту как фильтр
(`#d`) для точечного query конкретной пары (subject, resource), не
только для замены. PLAN.md формулировка "fold для kinds 3/30050/30051"
читается с этой поправкой (30051 → 5051), не буквально.

**2. Блокировка — новый `kind 10000` (NIP-51 Mute List).** TECH.md
(F-CT-05) описывает ПОВЕДЕНИЕ (события заблокированных игнорируются),
но не называет конкретный kind для синхронизации блок-листа между
устройствами одного пользователя (мультиустройство — уже принятое
требование проекта, NF-15). Стандартный NIP-51 kind 10000 (replaceable)
выбран по прецеденту уже принятого использования стандартных NIP kind
там, где применимо (0, 3, 10002) — не самодельный формат без причины.

**3. Таблица `permissions` в `database.js` (этап 3) — не используется
новым кодом.** Схема была зафиксирована ДО решения R6-5 (журнальная
модель прав — решение ревизии 6.0, схема БД — этап 3, задолго до этого).
Компаунд-ключ `[owner+subject+resource]` физически допускает только
ОДНУ строку на пару — несовместим с журналом (много permission-событий
на одну и ту же пару, разных `lamportTs`). Журнал живёт в уже
существующей общей таблице `events` (журнальный G-Set, этап 3/4,
фильтр `[pubkey+kind]`); материализованный результат `rebuildCache` —
таблица `effectivePerms` (тот же файл, УЖЕ подходящая схема — один
эффективный `mask` на `[owner+subject+resource]`, ровно то, что
`rebuildCache` производит). Таблица `permissions` остаётся в файле
(миграция версии Dexie-схемы ради удаления неиспользуемого поля —
несоразмерный риск), но код её не читает и не пишет.

**4. Явное сужение скоупа (по прецеденту `bootstrap.js`/`incremental-sync.js`).**
Не в скоупе этого этапа:
- F-CT-02, часть "чат архивируется" — `messaging`/`chat.js` не
  существует (этап 24).
- F-CT-02, часть "права отзываются" (каскад) — технически ВЫПОЛНИМО
  уже сейчас (`engine.js` этапа 21 готов), но сознательно НЕ зашито
  неявно внутрь `removeContact` — чистый domain-модуль не должен молча
  оркестровать публикацию revoke-permission-событий поверх удаления
  контакта из списка (тот же принцип, что и в `bitset.js`/`permissions.js`
  этапа 21: домен не публикует события сам). Каскад — явная отдельная
  операция orchestration-слоя (UI, этап 23): "удалить контакт" И "отозвать
  права" — два явных вызова, не один неявный.
- F-CT-04 (запрос профиля при добавлении контакта) — транспортная
  операция (subscribe kind 0), UI/orchestration слой, этап 23.
- NIP-09 (kind 5, F-EV-08/AC-17) — реализована ТОЛЬКО как чистая
  проверочная функция (`validateDeletion`), без domain-специфичного
  эффекта: ни contacts (kind 3), ни groups (kind 30050) физически не
  нуждаются в kind 5 (оба replaceable — "удаление" это публикация новой
  версии без записи), permission-журнал (kind 5051) НЕ должен допускать
  удаления записей (противоречило бы цели R6-5 — сохранности истории
  для аудита). Реальный потребитель `validateDeletion` — messaging/content,
  этапы 24/28/30.

### `src/domain/contacts/contacts.js`

```js
export function buildContactListEvent(privKey, pubkeys);
// kind 3 (NIP-02), tags = pubkeys.map(pk => ["p", pk]), content = ""
// -> подписанный NostrEvent

export function parseContactListEvent(event);
// -> string[] — pubkeys из тегов ["p", pubkey, ...]

export function addContact(pubkeys, newPubkey);
// -> новый массив (не мутирует), идемпотентно (уже есть -> тот же список без дублей)

export function removeContact(pubkeys, pubkeyToRemove);
// -> новый массив без указанного pubkey (без каскада — см. "Находки", п.4)

export function buildMuteListEvent(privKey, pubkeys);
// kind 10000 (NIP-51 Mute List), tags = pubkeys.map(pk => ["p", pk]), content = ""
// -> подписанный NostrEvent

export function parseMuteListEvent(event);
// -> string[]

export function isBlocked(blockedPubkeys, pubkey);
// -> boolean, blockedPubkeys.includes(pubkey)
```

### `src/domain/contacts/groups.js`

```js
export function buildGroupEvent(privKey, { groupId, name, memberPubkeys });
// kind 30050, tags = [["d", groupId]] (F-GR-04, d-tag = UUID группы, в открытом виде —
// TECH.md §4.8: только владелец читает свои kind 30050, opaque-обфускация не нужна)
// content = NIP-44(JSON.stringify({ name, memberPubkeys }), privKey, ownPubkey) — self-encrypt
// -> подписанный NostrEvent

export function parseGroupEvent(event, privKey);
// decrypt content через NIP-44(event.content, privKey, event.pubkey), JSON.parse
// -> { groupId (из d-tag), name, memberPubkeys }
// content не расшифровывается/не валидный JSON -> throw (боевая граница, данные с relay)

export function addMember(group, pubkey);
// -> новый group-объект с добавленным pubkey в memberPubkeys (идемпотентно, без дублей)

export function removeMember(group, pubkey);
// -> новый group-объект без pubkey в memberPubkeys

export function renameGroup(group, newName);
// -> новый group-объект с изменённым name
```

F-GR-02 ("контакт в нескольких группах") не требует отдельной
структуры — естественное следствие того, что группы независимы, один
и тот же pubkey может присутствовать в `memberPubkeys` нескольких групп
одновременно.

### `src/domain/events/handlers.js`

```js
export async function foldContactList(event);
// kind 3 -> parseContactListEvent -> транзакция: удалить все db.contacts
// WHERE owner=event.pubkey, вставить строки {owner: event.pubkey, pubkey} для каждого
// contact pubkey (replaceable — новая версия ПОЛНОСТЬЮ замещает старый список)

export async function foldMuteList(event);
// kind 10000 -> parseMuteListEvent -> аналогично foldContactList, таблица db.blockedContacts

export async function foldGroup(event, privKey);
// kind 30050 -> parseGroupEvent(event, privKey) -> транзакция:
// upsert db.groups {owner: event.pubkey, id: groupId, name},
// заменить db.groupMembers WHERE groupId=groupId новыми строками {groupId, pubkey}
// для каждого memberPubkeys (replaceable — та же логика, что foldContactList)

export function buildPermissionEvent(privKey, { subject, resource, allowMask = 0, denyMask = 0, lamportTs });
// kind 5051 (см. "Находки", п.1), tags = [["d", opaqueDTag(deriveMasterSecret(privKey), 5051,
// subject + ":" + resource)]] — derivation.js (этап 8), masterSecret вычисляется внутри,
// не передаётся отдельным параметром (вызывающий код не обязан знать про него)
// content = NIP-44(JSON.stringify({ subject, resource, allowMask, denyMask, lamportTs }), privKey, ownPubkey) — self-encrypt
// lamportTs — параметр, НЕ вычисляется внутри (вызывающий код сам делает lamportClock.tick(),
// по прецеденту DM/rumor.lamportTs, TECH.md §4.4 — часы не забота domain-модуля построения события)
// -> подписанный NostrEvent

export function parsePermissionEvent(event, privKey);
// decrypt NIP-44(event.content, privKey, event.pubkey), JSON.parse ->
// { subject, resource, allowMask, denyMask, lamportTs }
// НЕ создаёт PermissionRecord сам (нет eventId в возвращаемом объекте) — вызывающий код
// (rebuildEffectivePermissions) добавляет eventId = event.id и передаёт в createPermissionRecord

export async function rebuildEffectivePermissions(ownerPubkey, privKey);
// 1. db.events.where("[pubkey+kind]").equals([ownerPubkey, 5051]).toArray()
// 2. для каждого: parsePermissionEvent(event, privKey) -> createPermissionRecord(
//    { ...поля, eventId: event.id })
// 3. cache = engine.rebuildCache(records) (этап 21, полный пересчёт — MVP-алгоритм,
//    TECH.md §4.2; 10000 записей < 100мс уже подтверждено perf-тестом этапа 21)
// 4. транзакция: удалить db.effectivePerms WHERE owner=ownerPubkey, вставить
//    {owner, subject, resource, mask} для каждой пары в cache
// НЕ вызывается на каждое единичное событие — вызывающий код (этап 23/handlers-диспетчер)
// решает, когда пересчитывать (после батча fold, не после каждого mergeEvent)

export function validateDeletion(deleteEvent, targetEvent);
// F-EV-08/AC-17: deleteEvent.kind === 5 И deleteEvent.pubkey === targetEvent.pubkey
// -> boolean. Чистая функция, без побочных эффектов, без domain-эффекта (см. "Находки", п.4) —
// вызывающий код решает, что делать с true/false для конкретного домена
```

## Этап 23 — UI контактов + редактор прав

Триаж (п.13a): **рутина** для сигналов/CRUD-обвязки; для `contacts.jsx`
и `permission-editor.jsx` действует урок из PLAN.md ("Уроки предыдущих
этапов" — крупные JSX-экраны со связанным состоянием писать напрямую,
не воркером) — оба security/session-смежные (права, идентичность),
пишутся Claude напрямую с самого начала, не после found brak'а.

### Находки и решения (до сигнатур)

**1. Гэп инфраструктуры: до этого этапа ни один экран не держит
постоянного соединения с relay от лица РЕАЛЬНОГО залогиненного
пользователя** — `diagnostics.jsx`'s `useTransportSyncCheck` поднимает
одноразовое соединение с фиктичной self-check identity, `profile.jsx`
целиком локален (не публикует). Добавлен `src/ui/signals/transport.js`
— НЕ в исходном списке файлов PLAN.md для этого этапа, но необходимое
следствие: без него "добавление контакта" осталось бы локальной
имитацией, а не реальной публикацией/синхронизацией. Транспортный
стек (16-20) не меняется — `transport.js` лишь первый настоящий
потребитель уже готового `createRelayConnection`/`createPublisher`/
`runBootstrap`/`startIncrementalSync` от лица сессии, а не self-check.

**2. Исправление находки этапа 22: "группы не нуждаются в kind 5"
было неверно для УДАЛЕНИЯ ЦЕЛОЙ группы.** Этап 22 корректно рассудил,
что удаление УЧАСТНИКА группы не требует kind 5 (republish kind 30050
без него). Но полное удаление группы — другое: kind 30050
parameterized-replaceable не имеет "пустой" версии, означающей
"группы больше нет" — нужна явная tombstone-семантика. NIP-09
поддерживает это штатно через `a`-тег (адресуемое удаление:
`["a", "{kind}:{pubkey}:{d-tag}"]`), в отличие от `e`-тега (по id
конкретного события, для kind 5, F-EV-08 этапа 22). Добавлена
`buildAddressableDeletionEvent`; `validateDeletion` (этап 22) остаётся
как есть (`e`-тег форма, для будущих regular-kind доменов) — это
ДОПОЛНЕНИЕ, не замена.

### `src/domain/events/handlers.js` (правка контракта этапа 22 — добавлены 2 функции)

```js
export function buildAddressableDeletionEvent(privKey, kind, dTag);
// ownPubHex = bytesToHex(getPublicKey(privKey))
// kind 5, tags = [["a", `${kind}:${ownPubHex}:${dTag}`]], content = ""
// -> подписанный NostrEvent (NIP-09, адресуемое удаление)

export async function rebuildContactsAndGroups(ownerPubkey, privKey);
// 1. contacts: db.table("events").where("[pubkey+kind]").equals([ownerPubkey, 3]).toArray()
//    -> если непусто, lww.pickLatest(events) -> foldContactList(latest)
// 2. mute list: та же схема, kind 10000 -> foldMuteList(latest)
// 3. группы: db.table("events").where("[pubkey+kind]").equals([ownerPubkey, 30050]).toArray(),
//    группировка по d-tag (Map), внутри группы — lww.pickLatest -> latestByDTag
// 4. удаления: db.table("events").where("[pubkey+kind]").equals([ownerPubkey, 5]).toArray(),
//    отфильтровать теги ["a", target] -> Set deletedTargets (только форма "30050:pubkey:dtag")
// 5. для каждого (dTag, event) из latestByDTag: если `30050:${ownerPubkey}:${dTag}` НЕ в
//    deletedTargets -> foldGroup(event, privKey); ИНАЧЕ -> удалить из db.groups/db.groupMembers
//    (группа была смэтериализована раньше, потом удалена — явно почистить, не оставлять висеть)
// MVP — полный пересчёт (тот же принцип, что rebuildEffectivePermissions), не инкрементально
```

### `src/ui/signals/transport.js` (новый, по находке 1)

```js
export const connState;  // signal<string> — состояние relay-pool.js (disconnected/connecting/.../subscribed)
export const synced;     // signal<boolean> — onCaughtUp сработал хотя бы раз в этой сессии

export async function ensureConnected(pubkeyHex, privKey);
// Идемпотентно (singleton connection на вкладку) — повторные вызовы, пока соединение
// уже устанавливается/установлено, await'ят ТУ ЖЕ попытку, не открывают вторую.
// relayUrl = DEFAULT_RELAYS[0] ?? "ws://127.0.0.1:7777" (config.js, этап 2/20)
// connect() -> дождаться "connected" -> CryptoWorker/Comlink verifyBatch (по образцу
// diagnostics.jsx) -> runBootstrap(pubkeyHex, {verifyBatch}) -> ПОСЛЕ bootstrap:
// rebuildContactsAndGroups(pubkeyHex, privKey) + rebuildEffectivePermissions(pubkeyHex, privKey)
// -> startIncrementalSync(pubkeyHex, {verifyBatch, onEvent: (addedCount) => { if (addedCount > 0)
//    { rebuildContactsAndGroups(...); rebuildEffectivePermissions(...); } }})
// -> Promise<void>, резолвится после bootstrap+первого rebuild (incremental sync остаётся в фоне)

export async function publish(event);
// ensureConnected() уже должен быть вызван раньше (throw, если соединения ещё нет —
// не пытается неявно подключаться само, вызывающий код управляет жизненным циклом явно)
// -> publisher.publish(event) (publisher.js, этап 18) -> { ok: boolean, reason: string }

export async function nextLamportTick();
// Единый Lamport-счётчик НА СЕССИЮ (module-level singleton), не per-компонент —
// PermissionEditor монтируется многократно (по разу на контакт/группу), отдельный
// счётчик на каждый экземпляр нарушил бы причинный порядок между permission-событиями.
// Ленивая инициализация через computeInitialLamportValue() (lamport.js, этап 19) при
// первом вызове, persistLamportValue() после каждого tick(). -> Promise<number>
```

### `src/ui/signals/contacts.js`

```js
export const contacts;         // signal<string[]>  — pubkeys
export const blockedContacts;  // signal<string[]>
export const groups;           // signal<{ id, name, memberPubkeys }[]>

export async function refreshContacts(ownerPubkey);        // читает db.contacts -> contacts.value
export async function refreshBlockedContacts(ownerPubkey); // читает db.blockedContacts -> blockedContacts.value
export async function refreshGroups(ownerPubkey);           // читает db.groups + db.groupMembers (join по id) -> groups.value
export async function refreshAll(ownerPubkey);               // все три параллельно (Promise.all)

export function decodePubkeyInput(input);
// npub1... -> nip19.decode, .type !== 'npub' -> throw; 64-hex -> lowercase как есть;
// иначе throw new Error("не похоже на npub или hex-ключ")

// Действия — build (contacts.js/handlers.js, этап 22) -> publish (transport.js) -> fold локально
// (не ждать incremental-sync round-trip для мгновенного отклика UI) -> refresh соответствующего сигнала:
export async function addContactAction(ownerPubkey, privKey, npubOrHex, publish);
export async function removeContactAction(ownerPubkey, privKey, pubkeyToRemove, publish);
export async function blockContactAction(ownerPubkey, privKey, npubOrHex, publish);   // decodePubkeyInput внутри, как addContactAction
export async function unblockContactAction(ownerPubkey, privKey, npubOrHex, publish); // decodePubkeyInput внутри, как addContactAction
export async function createGroupAction(ownerPubkey, privKey, name, publish);
export async function renameGroupAction(ownerPubkey, privKey, groupId, newName, publish);
export async function addGroupMemberAction(ownerPubkey, privKey, groupId, pubkey, publish);
export async function removeGroupMemberAction(ownerPubkey, privKey, groupId, pubkey, publish);
export async function deleteGroupAction(ownerPubkey, privKey, groupId, publish);
// publish — явно инъецируемая функция (event) => Promise<{ok, reason}>, ПО ОБРАЗЦУ
// verifyBatch (subscriber.js/bootstrap.js) и publishFn (outbox.js) — не скрытый импорт
// transport.js внутри contacts.js. contacts.jsx передаёт transport.publish; тесты —
// свой stub. Держит contacts.js юнит-тестируемым (node --test) без реальной сети.
// publish(event) может вернуть { ok: false } (relay reject/timeout) — действие в этом случае
// НЕ фолдит локально и НЕ обновляет сигнал (не показывать успех, которого не было),
// бросает Error с reason, чтобы UI показал ошибку
```

### `src/ui/components/permission-editor.jsx`

```js
export default function PermissionEditor({ ownerPubkey, privKey, subject, resource });
// subject — pubkey контакта ИЛИ id группы (вызывающий код решает, что это; компонент не
// различает — engine.js/effectivePerms работают с opaque-строками одинаково для обоих)
// resource — opaque-строка. РЕАЛЬНОГО resource-picker домена ещё нет (каналы — этапы 28/30),
// поэтому UI даёт свободный текстовый ввод идентификатора ресурса — сознательное
// временное упрощение, не выдаётся за готовый продукт (лейбл явно "Идентификатор ресурса")
//
// Показывает текущий effectivePerms.mask для (subject, resource) (db.effectivePerms,
// этап 22), чекбоксы VIEW/COMMENT (ТОЛЬКО эти два действия — PLAN.md явно ограничивает
// скоуп этого этапа; WRITE/MODERATE/ADMIN осмысленны только с реальными ресурсами,
// остаются на будущее). Изменение чекбокса -> buildPermissionEvent (allowMask/denyMask
// считаются от ТЕКУЩЕГО эффективного состояния: включение бита -> allow=bit, denyMask=0;
// выключение -> allow=0, denyMask=bit) с lamportTs = следующий tick сессионных часов
// (см. ниже) -> publish -> rebuildEffectivePermissions -> обновить локальное отображение
```

Lamport для permission-событий этого экрана — сессионный in-memory
счётчик (`createLamportClock`, этап 19), инициализированный через
`computeInitialLamportValue()` при первом обращении к экрану,
`persistLamportValue` после каждого `tick()` — тот же паттерн, что
уже принят для остальных Lamport-меток в проекте (единый счётчик на
пользователя, TECH.md §4.4), не отдельный per-permission-событие счётчик.

### `src/ui/screens/contacts.jsx`

Экран: список контактов (карточка = pubkey/npub, теги групп на
карточке, кнопки "Заблокировать"/"Удалить"), панель групп (чекбокс-
фильтр по нескольким группам одновременно, "+ создать группу", "..."
меню группы: переименовать/удалить), форма добавления контакта
(поле npub/hex). Каждый контакт/группа — раскрываемая секция с
`PermissionEditor`. Вызывает `ensureConnected` в `useEffect` при
монтировании (лениво, не при логине — см. "Находки", п.1), показывает
`connState`/`synced` (переиспользует `SyncIndicator`, этап 20) как
статус-строку. UX-элементы (групповой фильтр, теги на карточке,
inline-меню группы) — по референсу пользователя (скриншоты v0.1),
кроме модели добавления контакта (одностороннее по npub/hex, не
invite-key+confirm — решение этапа 22, F-CT-01).

## Правка после этапа 23: собственный npub в профиле + профиль контакта (F-CT-04)

По прямой обратной связи пользователя, реально попробовавшего добавить
контакт: свой npub негде было увидеть, чтобы передать другому
пользователю; список контактов показывал только усечённый pubkey, не
никнейм/аватар/био. Оба пункта — доведение уже решённого в этапе 22
как "отложено до UI-слоя" (F-CT-04), не новая архитектура.

### `src/ui/screens/profile.jsx` (правка контракта этапа 12/довеска)

Добавлена секция "Ваш идентификатор" — `npubEncode(id)` в `<code
role="button" tabIndex="0">`, клик/Enter/Space копирует в буфер
(`navigator.clipboard.writeText`), статус "Скопировано" на 2с (по
образцу `bioStatus`). Текст-пояснение под ним — по формулировке
пользователя.

`handleBioSubmit` теперь ДОПОЛНИТЕЛЬНО публикует kind 0 (`
buildProfileEvent(privKey, {name: login, about: bio})`) через
`ensureConnected`+`publish` (transport.js) после локального сохранения
в keystore. **Важно**: локальное сохранение НЕ зависит от публикации
и не блокируется ей — профиль в этом экране хранится в keystore
напрямую (не materialized fold из журнала событий, в отличие от
contacts/groups), поэтому офлайн-редактирование остаётся полностью
рабочим; публикация — отдельный best-effort шаг с собственным
статусом ("не опубликовано для других: <reason>"), не подменяющий
"Сохранено".

### `src/ui/signals/transport.js` (правка контракта этапа 23 — добавлена функция)

```js
export async function fetchProfiles(pubkeys);
// pubkeys: string[] -> Promise<Map<pubkey, {name?, about?, picture?}>>
// Одноразовый REQ kind 0 + EOSE (не постоянная подписка), unsubscribe после EOSE.
// kind 0 replaceable — relay сам отдаёт только последнюю версию, клиентский
// pickLatest не нужен. Побитый/не-JSON профиль чужого клиента — пропускается
// (не роняет остальной fetch). throw, если ensureConnected() ещё не вызывался
// (НЕ пустой Map — иначе вызывающий код (ensureProfilesFetched) закэшировал бы
// "профиль не найден" только из-за отсутствия соединения, навсегда).
// Известное ограничение MVP: relay-pool.js не имеет removeMessageHandler —
// обработчик этого одноразового запроса остаётся в цепочке до конца сессии
// (дёшево, сверяет subId); вызывается только для НЕ закэшированных pubkey.
```

### `src/ui/signals/contacts.js` (правка контракта этапа 23 — добавлены сигнал и функция)

```js
export const profiles; // signal<Record<pubkey, {name?,about?,picture?} | null>> — null = запрошен, не найден

export async function ensureProfilesFetched(pubkeys, fetchProfilesFn);
// fetchProfilesFn — инъекция (по образцу publish), реально transport.fetchProfiles
// Исключает уже закэшированные pubkey (в т.ч. null) из запроса; пустой remainder
// после фильтра -> fetchProfilesFn вообще не вызывается
```

### `src/ui/screens/contacts.jsx` (правка)

`ContactIdentity({ pubkey })` — заменяет голый усечённый pubkey:
аватар (`profile.picture` или круг с первой буквой никнейма), имя
(`profile.name` или усечённый npub как раньше), био (`profile.about`,
если есть) под именем. Подгрузка — `ensureProfilesFetched` вызывается
дважды: (1) после `ensureConnected` резолвится (начальный список
контактов), (2) при каждом изменении `contacts.value` (новые контакты
после того, как соединение уже установлено). Пока соединения нет,
`fetchProfiles` бросает — `ensureProfilesFetched` в этом случае НИЧЕГО
не кэширует (ошибка проглатывается на уровне вызова в `contacts.jsx`,
эффект №1 подхватит после успешного `ensureConnected`).

## Правка после реального использования: whitelist по умолчанию + защита от невалидного pubkey

Пользователь попробовал добавить контакт на свежих аккаунтах — оба
столкнулись с `blocked: pubkey not on whitelist`, плюс в логе relay
обнаружился `bad req: error parsing authors: uneven size input to
from_hex` (невалидный, нечётной длины, hex в фильтре — похоже на
повреждённый pubkey текущей сессии).

**`server/strfry/whitelist-plugin.mjs`/`whitelist.json`**: добавлен
спецэлемент `"*"` (allow-all). Дефолт `whitelist.json` изменён с
единственного diagnostics-pubkey на `["*"]`. Deny-by-default
(конкретный список без `"*"`) остаётся рабочим режимом для проверки
самого механизма (AC-14, этап 17) — переключается содержимым файла,
не кодом; ни один `node --test` не был завязан на дефолтное содержимое
(проверено), регрессия не затронута.

**`src/ui/signals/transport.js`**: добавлена `assertValidPubkeyHex`
внутри `connect()` — throw с понятным сообщением ДО открытия
соединения, если `pubkeyHex` не ровно 64 hex-символа. Раньше невалидный
pubkey молча долетал до REQ-фильтра bootstrap'а и ронял WebSocket на
стороне relay без внятной причины на экране пользователя. Живым тестом
(два новых аккаунта, ни одного ручного whitelist-шага) подтверждено:
добавление контакта работает сразу; воспроизвести исходный "uneven
hex" не удалось — если повторится, теперь будет ясная ошибка вместо
тихого обрыва, что укажет точный источник.

## Правка UI Контактов: три секции (Запросы/Контакты/Заблокированные) + ссылка на чат

По прямой просьбе пользователя, до начала этапа 24. Layout контактов:
"Запросы (N)" → "Контакты (N)" (с фильтром по группам, как раньше) →
"Заблокированные (N)", группы-фильтр слева без изменений.

### `src/ui/screens/contacts.jsx` (правка контракта этапа 23)

- Секция "Запросы (0)" — заготовка без данных (протокол — этап 24,
  см. PLAN.md); текст объясняет, что появится, кнопок нет — нечего
  ими подтверждать без реальных входящих запросов.
- Секция "Контакты" — теперь показывает только `contacts \ blockedContacts`
  (заблокированные исключены). `ContactIdentity` принимает `onClick` —
  здесь передаётся `() => openChat(pubkey)`; кнопка "Заблокировать"
  больше не переключается на "Разблокировать" (заблокированный вообще
  не появляется в этой секции).
- Секция "Заблокированные" (новая) — из `blockedContacts`, `ContactIdentity`
  БЕЗ onClick (не кликабельна — открывать чат с заблокированным не имеет
  смысла), кнопка "Разблокировать".

### `src/ui/format.js` (новый, вынесено из contacts.jsx)

```js
export function shortPubkey(pubkey); // npub, усечённый до "npub1xxx…yyyyyy"
```

### `src/ui/signals/chat.js` (новый)

```js
export const activeChatPubkey; // signal<string|null>
export function openChat(pubkey); // activeChatPubkey.value = pubkey
```

Лёгкая связка "клик по контакту → открыть чат", без самого экрана
чата (строится этапом 24). `app.jsx` реагирует на изменение
`activeChatPubkey` переключением вкладки на "Сообщения"; пока экрана
чата нет — показывает `Placeholder` с заголовком "Чат с {shortPubkey}"
(подтверждение перехода, не имитация переписки).

### Правка контракта: `blockContactAction` теперь отписывает

`src/ui/signals/contacts.js`: блокировка контакта, который БЫЛ в
`contacts`, теперь публикует ОБА обновления — kind 10000 (добавить в
mute) И kind 3 (убрать из контактов). Разблокировка НЕ восстанавливает
контакт автоматически (отдельное явное действие). Обоснование —
находка пользователя: "контакт либо реальный, либо заблокированный",
взаимоисключающие категории, не показываются одновременно.

### Находка (адверсарная, при проверке UI): гонка created_at при быстрых повторных действиях

Блокировка сразу за разблокировкой (или любая пара публикаций одного
kind в ту же wall-clock секунду) может дать ДВА события с одинаковым
`created_at` (секундная точность). `lww.js`'s тай-брейк по `id`
(AC-18, TECH.md §17.5, контракт этапа 4 — **менять нельзя**, спек-
мандатное поведение) никак не связан с реальным порядком публикации —
`rebuildContactsAndGroups` (полный пересчёт из журнала, срабатывает и
на эхо СВОИХ ЖЕ событий через incremental-sync) мог в этом случае
"воскресить" более старую версию kind 3/10000/30050.

Исправлено в источнике, не в `lww.js`: `buildContactListEvent`/
`buildMuteListEvent` (`domain/contacts/contacts.js`, правка контракта
этапа 22) и `buildGroupEvent` (`domain/contacts/groups.js`, правка
этапа 22) теперь принимают опциональный третий параметр `createdAt`
(по умолчанию — прежнее поведение, `Math.floor(Date.now()/1000)`, ни
один существующий вызов не ломается). `signals/contacts.js` держит
`nextCreatedAt(key)` — module-level Map, гарантирует строго
неубывающий `created_at` для последовательных публикаций одного kind
(contacts/mute — ключ `3`/`10000`) или одной группы (ключ
`"group:" + groupId`, т.к. коллизия релевантна per-d-tag, не глобально)
в рамках вкладки/сессии. Живой тест (блокировка → немедленная
разблокировка, без задержки — ровно сценарий, ловивший гонку) — после
фикса контакт остаётся в "Заблокированные (0)"/"Контакты (0)", не
воскресает.

## Этап 24 — Личные сообщения: ядро

Формализация (ДКА сообщения, MLS/NIP-17 оркестрация 1:1-разговора,
contact-request протокол) — DESIGN.md, раздел "Этап 24". Здесь —
сигнатуры.

### `src/domain/messaging/machine.js`

```js
export const MESSAGE_TRANSITIONS; // {state: {event: state}} — TECH.md §9.1, буквально:
// created: {SEND: "sending"}
// sending: {ACK: "sent", FAIL: "failed"}
// sent: {READ: "read"}
// failed: {RETRY: "sending", DISCARD: "discarded"}
// (read/discarded — финальные, без исходящих переходов)

export function transitionMessage(state, event);
// -> transition(MESSAGE_TRANSITIONS, state, event) (core/fsm/machine.js, этап 14)
// throw на любой не перечисленной паре (state, event) — уже гарантия machine.js, не переопределяется здесь
```

### `src/domain/contacts/requests.js`

```js
export const CONTACT_REQUEST_KIND = 3001;

export function buildContactRequestRumor(greeting = "");
// -> { kind: 3001, content: greeting, tags: [], created_at: Math.floor(Date.now()/1000) }
// НЕ подписывается здесь (rumor — подписывает/оборачивает nip59.wrap выше по стеку,
// как для kind 444, DESIGN.md п.6) — просто шаблон rumor-события

export function parseContactRequestRumor(rumor);
// -> { greeting: rumor.content, senderPubkey: rumor.pubkey, createdAt: rumor.created_at }
// (rumor.pubkey уже проверен вызывающим кодом — nip59.unwrap проверяет rumor.pubkey===seal.pubkey, F-EV-05)
```

### `src/domain/events/kinds.js` (правка контракта этапа 13 — добавлены константы)

```js
export const KIND_CONTACT_REQUEST = 3001;
export const KIND_GROUP_MESSAGE = 445; // алиас KIND_MLS_GROUP_MESSAGE, для симметрии с новыми константами
```

### `src/core/store/database.js` (правка схемы, `db.version(2)`, аддитивно)

```js
ownKeyPackage: "id",                              // одна строка, id="self": { id, publicPackage, privatePackage, wireBytes }
contactRequests: "[owner+senderPubkey], owner",   // { owner, senderPubkey, greeting, createdAt }
```

Остальные таблицы (включая `mlsGroups`) не меняются — Dexie наследует
их из `version(1)` автоматически. Новая версия схемы нужна ТОЛЬКО
из-за добавления двух новых таблиц (Dexie требует явного `version()`
bump при изменении списка stores, даже аддитивном).

### `src/domain/messaging/chat.js`

```js
export function computeGroupId(pubkeyHexA, pubkeyHexB);
// sortedPair = [pubkeyHexA, pubkeyHexB].sort()
// -> sha256(utf8(sortedPair.join(":"))) как Uint8Array(32) (DESIGN.md п.2)
// Детерминировано для обеих сторон, не хранится отдельно как "chatId->groupId" маппинг.

export async function ensureOwnKeyPackagePublished(ownerPubkey, privKey, publish);
// db.table("ownKeyPackage").get("self") — если есть,no-op (не идёт в сеть повторно)
// иначе: createOwnKeyPackage(ownerPubkey) (mls-session.js, этап 13) -> персист
// { id: "self", publicPackage, privatePackage, wireBytes } (encrypted-table, dbKey)
// -> build kind 443 { tags: [], content: base64(wireBytes) } -> sign(privKey) -> publish -> requirePublishOk
// -> Promise<void>

export async function ensureChatEstablished(ownerPubkey, privKey, contactPubkey, publish, fetchKeyPackage);
// groupId = computeGroupId(ownerPubkey, contactPubkey)
// db.table("mlsGroups").get(toHex(groupId)) уже есть -> no-op, Promise<void> сразу
// иначе (DESIGN.md п.3, шаги 2-6):
//   theirWireBytes = await fetchKeyPackage(contactPubkey) -- инъекция (по образцу fetchProfiles,
//     этап 23) -- throw, если не найден ("у контакта нет опубликованного ключа для сообщений")
//   ownKeyPackage = createOwnKeyPackage(ownerPubkey) (СВЕЖИЙ, не переиспользует ownKeyPackage.self)
//   state = createGroup(ownerPubkey, ownKeyPackage, groupId)
//   { newSessionState, welcomeWireBytes } = addMember(state, theirWireBytes) // commitWireBytes отброшен
//   персист newSessionState -> mlsGroups.put({ groupId: toHex(groupId), contactPubkey, state: serializeState(...) })
//   (SM-2, ДО publish; contactPubkey хранится РЯДОМ с состоянием, не отдельной таблицей —
//   groupId однонаправленный хэш пары pubkey, из него нельзя восстановить контакта обратно,
//   а именно это нужно диспетчеру входящих kind 445, который знает только h-тег)
//   welcomeEvent = nip59.wrap({ kind: 444, content: base64(welcomeWireBytes), tags: [] }, privKey, contactPubkey)
//   await requirePublishOk(publish, welcomeEvent)
// -> Promise<void>
//
// ОБЯЗАТЕЛЬНОЕ ПРАВИЛО ВЫЗОВА (найдено живой проверкой, не в исходном плане):
// вызывающий код ОБЯЗАН вызвать transport.refreshGroupMessageSubscription(ownerPubkey)
// СРАЗУ ПОСЛЕ успешного ensureChatEstablished. chat.js намеренно не импортирует
// transport.js (домен не зависит от UI-слоя, тот же принцип, что publish/fetchKeyPackage
// инъекция) — но БЕЗ этого вызова инициатор разговора никогда не подпишется на входящие
// kind 445 для НОВОГО groupId и не увидит ответные сообщения контакта. Симметричная
// сторона (принявшая Welcome через диспетчер) получает это автоматически — см.
// transport.js ниже, acceptWelcome сам вызывает refreshGroupMessageSubscription.
// Пропуск этого вызова — тихий баг (соединение и отправка работают, ответы не приходят),
// не бросает исключение нигде — требует явной дисциплины вызывающего кода (будущий
// chat.jsx/orchestration, этап 27).

export async function acceptWelcome(ownerPubkey, welcomeSenderPubkey, welcomeWireBytes);
// Вызывается диспетчером входящих gift wrap (transport.js) на rumor.kind===444.
// welcomeSenderPubkey = rumor.pubkey (уже проверен nip59.unwrap — F-EV-05) — это и есть
// контакт, устанавливающий разговор, с ПОЛУЧАЮЩЕЙ стороны (симметрично ensureChatEstablished
// со стороны инициатора).
// groupId = computeGroupId(ownerPubkey, welcomeSenderPubkey)
// mlsGroups уже есть запись -> no-op (повторная доставка того же Welcome, EOSE-повтор и т.п.)
// иначе: ownKeyPackageRow = db.table("ownKeyPackage").get("self") -- нет записи -> throw
//   ("нет собственного KeyPackage — вызовите ensureOwnKeyPackagePublished() раньше")
//   state = joinFromWelcome({ publicPackage, privatePackage }, welcomeWireBytes)
//   mlsGroups.put({ groupId: toHex(groupId), contactPubkey: welcomeSenderPubkey, state: serializeState(state) })
// -> Promise<void>

export async function sendMessage(ownerPubkey, privKey, contactPubkey, text, lamportTs, publish);
// groupId = computeGroupId(ownerPubkey, contactPubkey); throw, если mlsGroups нет записи
// (вызывающий код обязан был вызвать ensureChatEstablished раньше — граница та же,
// что mls-session.js само декларирует про credential-проверку, этап 13)
// state = deserializeState(row.state)
// msgId = bytesToHex(crypto.getRandomValues(new Uint8Array(16)))  // правка этапа 25 —
//   генерируется здесь ОДИН РАЗ, кладётся в plaintext И в зеркало (см. CONTRACTS.md "Этап 25")
// plaintextBytes = new TextEncoder().encode(JSON.stringify({ text, lamportTs, msgId }))
// // encryptApplicationMessage(state, message) ожидает Uint8Array, не строку — подтверждено
// // tests/mls-session.test.js (setupGroupWithBob + new TextEncoder().encode(...) в тестах этапа 13)
// { newSessionState, wireBytes } = encryptApplicationMessage(state, plaintextBytes)
// персист newSessionState (SM-2, ДО publish) -- ВАЖНО: put() перезаписывает всю строку,
// contactPubkey (row.contactPubkey) обязан переноситься тем же вызовом, иначе следующий
// приём/отправка потеряет обратную ссылку на контакт (найдено тестами, не спекуляция)
// { privateKey, publicKey } = deriveNostrEnvelopeKeys(newSessionState)
// content = nip44Encrypt(base64(wireBytes), privateKey, bytesToHex(publicKey)) -- deriveNostrEnvelopeKeys
//   возвращает publicKey СЫРЫМИ байтами (core/crypto/keys.js), nip44.js ожидает hex-строку —
//   несовпадение форматов, найдено тестами (не третий параметр как есть)
// ephemeralPriv = generateSecretKey() (nostr-tools/pure) -- НОВЫЙ на это сообщение, не переиспользуется
// event = sign({ kind: 445, tags: [["h", toHex(groupId)]], content, created_at }, ephemeralPriv)
// await requirePublishOk(publish, event)
// -> upsertMessage({ chatId: contactPubkey, lamportTs, senderPubkey: ownerPubkey,
//    id: event.id, text, status: "sent", msgId }) (FSM: created->SEND->sending->ACK->sent, см. machine.js;
//    "sending" функционально пропускается для MVP — publish() уже ждёт ack синхронно, publisher.js этапа 18)
// -> зеркало (best-effort, этап 25, см. ниже) -> Promise<{ eventId: string }>

export async function receiveGroupMessageEvent(ownerPubkey, privKey, event, publish);
// ПРАВКА СИГНАТУРЫ (этап 25, было (ownerPubkey, event)): privKey/publish добавлены —
// нужны ТОЛЬКО для зеркала best-effort (mirrorBestEffort ниже), сам приём/расшифровка
// MLS не требует privKey (deriveNostrEnvelopeKeys берёт ключ конверта из MLS-состояния,
// не из identity-ключа). Все вызывающие места (transport.js, тесты) обновлены.
// groupId из event.tags (["h", hex]); mlsGroups нет записи -> discard (чужая/неизвестная группа) -> null
// contactPubkey = row.contactPubkey (НЕ параметр функции — берётся из строки, установленной
// ensureChatEstablished/acceptWelcome; вызывающему коду не нужно заранее знать, чей это чат)
// state = deserializeState(row.state); { privateKey, publicKey } = deriveNostrEnvelopeKeys(state)
// wireBytes = base64decode(nip44Decrypt(event.content, privateKey, bytesToHex(publicKey)))
// { newSessionState, message } | { newSessionState, kind: "control" } = decryptApplicationMessage(state, wireBytes)
// персист newSessionState (SM-2), contactPubkey переносится тем же put() (см. sendMessage, та же находка)
// kind==="control" -> Promise<null> (проposal/commit, не текст, MVP не показывает UI для этого)
// иначе: parsed = JSON.parse(new TextDecoder().decode(message)); upsertMessage({ chatId: contactPubkey,
//   lamportTs: parsed.lamportTs, senderPubkey: contactPubkey, id: event.id, text: parsed.text,
//   status: "sent", msgId: parsed.msgId }) -> зеркало (best-effort, этап 25, см. ниже)
// -> Promise<{ text, lamportTs } | null>

export async function getChatHistory(contactPubkey);
// db.table("messages").where("chatId").equals(contactPubkey).toArray()
// сортировка по (lamportTs, senderPubkey, eventId=id) лексикографически по senderPubkey/id
// при равенстве lamportTs (F-MS-05/AC-05) -> Promise<MessageRow[]>
```

**Разделение обязанностей (важно для тестируемости):** `sendMessage`/
`receiveGroupMessageEvent`/`ensureChatEstablished`/`ensureOwnKeyPackagePublished`
принимают `publish` (и `fetchKeyPackage` для establish) как явные
параметры — тот же паттерн инъекции, что `signals/contacts.js` (этап
23), не скрытый импорт `transport.js`. Persist-вызовы (`mlsGroups`,
`messages`, `ownKeyPackage`) идут напрямую через `db` (как
`handlers.js`, этапы 22-23) — `chat.js` не чисто-функционален (не может
им быть, MLS state обязан жить в БД между вызовами), но транспорт
инъецируется, а не импортируется напрямую.

### `src/ui/signals/transport.js` (правка контракта этапа 23 — добавлен диспетчер входящих gift-wrap)

```js
export async function ensureConnected(pubkeyHex, privKey);
// ДОПОЛНЕНО (после bootstrap, наравне с rebuildContactsAndGroups/rebuildEffectivePermissions):
// подписка НА ВХОДЯЩИЕ { "#p": [pubkeyHex], kinds: [1059] } — ПЕРВАЯ в проекте подписка
// не по "authors: [я]", а по адресату (DESIGN.md, этап 24, п.6). На каждое входящее:
//   rumor = nip59.unwrap(event, privKey)
//   rumor.kind === 444  -> welcomeContactPubkey = (rumor.pubkey === pubkeyHex && есть тег "contact")
//     ? tag(rumor,"contact") : rumor.pubkey   -- ПРАВКА этапа 25: Welcome от sibling-устройства
//     приходит от МЕНЯ ЖЕ (rumor.pubkey === pubkeyHex) — devices.js кладёт contactPubkey тегом,
//     т.к. rumor.pubkey в этом случае не годится как "с кем этот 1:1-чат" (DESIGN.md, "Этап 25", раздел 1b)
//     -> acceptWelcome(pubkeyHex, welcomeContactPubkey, decodeBase64(rumor.content)) -> mlsGroups.put
//   rumor.kind === 3001 -> parseContactRequestRumor(rumor) -> contactRequests.put
//   иначе -> discard
// Подписка на kind 445 (Group Message) — { "#h": [...все groupId из mlsGroups] }, тоже
// заводится здесь; список groupId в фильтре обновляется при каждом новом ensureChatEstablished
// (пересоздание REQ с обновлённым списком тегов — простая, не инкрементальная схема, MVP)
```

## Этап 25 — Личные сообщения: периферия + multi-device

Формализация (распознавание sibling-устройств + массовое добавление
в MLS-группы, зеркало истории с ключом от мнемоники, идемпотентное
слияние двух путей доставки) — DESIGN.md, раздел "Этап 25". Здесь —
сигнатуры.

### `src/domain/identity/device.js` (новый файл, рутина)

```js
export function getOrCreateDeviceId();
// db.table("deviceIdentity").get("self") -- если есть, вернуть row.deviceId
// иначе: deviceId = bytesToHex(crypto.getRandomValues(new Uint8Array(16))) (32 hex символа)
//   -> db.table("deviceIdentity").put({ id: "self", deviceId }) -> вернуть deviceId
// Синхронная обёртка невозможна (Dexie async) -- функция async, вызывающий код await'ит
// -> Promise<string>
```

### `src/core/crypto/derivation.js` (правка контракта этапа 8 — добавлена функция, аддитивно)

```js
export function deriveMirrorKey(masterSecret); // -> Uint8Array(32)
```

- `HKDF-SHA256(masterSecret, salt=utf8("Ugolok/v1/mirror"), info=utf8(""), length=32)` —
  параллельно уже принятой `deriveDbKey` (та же входная цепочка, другая
  соль). Существующие `deriveMasterSecret`/`deriveDbKey`/`opaqueDTag` не
  меняются.

### `src/domain/messaging/mirror.js` (новый файл, крипто-обёртка — пишет Claude напрямую, по прецеденту `file-crypto.js`/`db-crypto.js`)

```js
export const KIND_MESSAGE_MIRROR = 446;

export function encryptMirrorPayload(payload, mirrorKey);
// payload: { text, lamportTs, senderPubkey, contactPubkey, msgId }
// msgId — сгенерирован ОДИН РАЗ в sendMessage (chat.js), тождественен между
// live-MLS путём и зеркалом ДЛЯ ОДНОГО И ТОГО ЖЕ логического сообщения — единственное
// поле, по которому upsertMessage распознаёт дубликат (DESIGN.md, этап 25, п.3;
// (chatId, lamportTs, senderPubkey) НЕ годится — легитимная коллизия при multi-device,
// найдено адверсарным прогоном уже принятого теста этапа 24 до кода этого этапа)
// plaintext = utf8(JSON.stringify(payload))
// nonce = crypto.getRandomValues(12); ciphertext = ChaCha20-Poly1305(mirrorKey, nonce, plaintext)
// -> base64(nonce ‖ ciphertext+tag)  (формат блоба как file-crypto.js, этап 10 — nonce не отдельным полем)

export function decryptMirrorPayload(base64Content, mirrorKey);
// обратное: base64decode -> split(nonce(12), rest) -> ChaCha20-Poly1305.decrypt
// -> { text, lamportTs, senderPubkey, contactPubkey, msgId } (throw при неверном ключе/испорченном блобе, AEAD tag mismatch)

export function buildMirrorEvent(payload, mirrorKey, groupIdHex, createdAt);
// -> { kind: 446, tags: [["h", groupIdHex]], content: encryptMirrorPayload(payload, mirrorKey), created_at: createdAt }
// НЕ подписывает (sign() -- обычной identity-подписью, вызывается в chat.js, не здесь --
// та же граница ответственности, что buildContactRequestRumor/nip44.js: этот модуль только
// формат/шифрование, подпись и публикация -- вызывающий код)
```

### `src/domain/messaging/devices.js` (новый файл — пишет Claude напрямую, самая рискованная логика этапа, тот же класс риска что `chat.js`)

```js
export async function syncDeviceMembership(ownerPubkey, privKey, publish, fetchOwnKeyPackageAnnounces);
// fetchOwnKeyPackageAnnounces: () => Promise<Array<{ wireBytes: Uint8Array, deviceId: string, eventPubkey: string }>>
//   -- инъекция, one-shot REQ { authors: [ownerPubkey], kinds: [443] } (реализация в transport.js)
// myDeviceId = await getOrCreateDeviceId()
// for each announce:
//   if announce.deviceId undefined or === myDeviceId: continue  (легаси без тега / собственный анонс)
//   knownRow = db.table("knownDevices").get([ownerPubkey, announce.deviceId])
//   if !knownRow: knownRow = { ownerPubkey, deviceId: announce.deviceId, wireBytes: announce.wireBytes, addedGroupIds: [] }
//   allGroups = db.table("mlsGroups").toArray()
//   for group of allGroups:
//     if knownRow.addedGroupIds.includes(group.groupId): continue
//     state = deserializeState(group.state)
//     { privateKey: oldEnvPriv, publicKey: oldEnvPub } = deriveNostrEnvelopeKeys(state)  // СТАРАЯ эпоха, ДО addMember
//     { newSessionState, welcomeWireBytes, commitWireBytes } = addMember(state, knownRow.wireBytes)
//     await db.table("mlsGroups").put({ groupId: group.groupId, contactPubkey: group.contactPubkey, state: serializeState(newSessionState) })  // SM-2
//     // ОБЯЗАТЕЛЬНО (правка найдена при подготовке живой проверки, DESIGN.md п.1c):
//     // commitWireBytes НЕ отбрасывается (в отличие от ensureChatEstablished, этап 24) —
//     // group.contactPubkey уже существующий участник, ему нужен именно коммит, чтобы
//     // продвинуть эпоху; иначе он застревает на старой эпохе молча (не throw нигде)
//     commitContent = nip44Encrypt(base64(commitWireBytes), oldEnvPriv, bytesToHex(oldEnvPub))
//     commitEvent = sign({ kind: 445, tags: [["h", group.groupId]], content: commitContent, created_at }, generateSecretKey())
//     await requirePublishOk(publish, commitEvent)  // contactPubkey получает его через уже существующую
//       // ветку result.kind==="control" в receiveGroupMessageEvent (chat.js, этап 24) — без правки chat.js
//     welcomeEvent = nip59.wrap({ kind: 444, content: base64(welcomeWireBytes), tags: [["contact", group.contactPubkey]] }, privKey, ownerPubkey)
//     await requirePublishOk(publish, welcomeEvent)
//     knownRow.addedGroupIds.push(group.groupId); await db.table("knownDevices").put(knownRow)
//     // персист СРАЗУ после каждой группы (не одним put в конце) — сбой на N-й группе
//     // не должен откатывать уже сохранённый прогресс по 1..N-1
// -> Promise<void>
// Вызывается ОДИН РАЗ за connect() (transport.js, после ensureOwnKeyPackagePublished) —
// не живой push, см. DESIGN.md "явное сужение скоупа"
```

### `src/domain/messaging/chat.js` (правка контракта этапа 24 — добавлены зеркало и upsert-дедупликация)

```js
export async function upsertMessage(row);
// row: { chatId, lamportTs, senderPubkey, id, text, status, msgId }
// try: db.table("messages").add(row); catch (только по уникальному индексу [chatId+msgId]): no-op
// -> Promise<void>
// Заменяет прямые db.table("messages").add(...) во ВСЕХ 4 местах: sendMessage,
// receiveGroupMessageEvent, mirror-write (п.ниже), syncMirroredHistory (transport.js)

// ensureOwnKeyPackagePublished — ПРАВКА ПОВЕДЕНИЯ (не сигнатуры, этап 25, п.13 skill,
// явное решение + полная регрессия): tags больше не [], а [["device", await getOrCreateDeviceId()]].
// Существующие уже опубликованные (легаси, без тега) kind 443 из более ранних тестовых
// прогонов этого этапа НЕ мигрируются (проект в разработке, боевых пользователей нет,
// прецедент этапа 11) — ensureOwnKeyPackagePublished остаётся no-op, если "self" уже
// существует локально, повторной публикации с тегом не происходит для уже онбордженных
// тестовых аккаунтов; чистые новые аккаунты получают тег сразу.

// sendMessage — ПРАВКА ФОРМАТА application-message plaintext (этап 24 п.7,
// явное решение + полная регрессия): msgId = bytesToHex(crypto.getRandomValues(new
// Uint8Array(16))), СГЕНЕРИРОВАН ЗДЕСЬ, ОДИН РАЗ на сообщение; plaintextBytes теперь
// utf8(JSON.stringify({ text, lamportTs, msgId })), не { text, lamportTs }.
// receiveGroupMessageEvent — parsed.msgId читается из уже расширенного плейнтекста
// (обратной совместимости со старыми (msgId-less) сообщениями не требуется — проект
// в разработке, прецедент этапа 11).
//
// sendMessage/receiveGroupMessageEvent — ДОПОЛНЕНО (после успешной MLS-операции, best-effort,
// сбой зеркала -- console.warn, НЕ throw, не блокирует основной путь):
//   mirrorKey = deriveMirrorKey(deriveMasterSecret(privKey))  // privKey — параметр sendMessage
//   (уже было) и receiveGroupMessageEvent (правка сигнатуры этапа 25, см. выше)
//   event = sign(buildMirrorEvent({ text, lamportTs, senderPubkey, contactPubkey, msgId }, mirrorKey, groupIdHex, created_at), privKey)
//   try { await requirePublishOk(publish, event) } catch (e) { console.warn(...) }
// db.table("messages").add(...) в обеих функциях заменяется на upsertMessage(... , msgId)
```

### `src/ui/signals/transport.js` (правка контракта этапа 24 — добавлены device-sync и mirror catch-up)

```js
export async function fetchOwnKeyPackageAnnounces(ownerPubkey);
// one-shot REQ { authors: [ownerPubkey], kinds: [443] }, EOSE -> для каждого event:
//   { wireBytes: base64decode(event.content), deviceId: tag(event,"device"), eventPubkey: event.pubkey }
// -> Promise<Array<{...}>> (пустой массив, если ни одного -- НЕ throw, в отличие от fetchKeyPackage:
//   отсутствие анонсов -- нормальный случай для аккаунта без второго устройства)

export async function syncMirroredHistory(ownerPubkey, mirrorKey);
// one-shot REQ { authors: [ownerPubkey], kinds: [446] }, EOSE -> для каждого event:
//   payload = decryptMirrorPayload(event.content, mirrorKey)  -- неверный ключ/битый блоб -> skip + console.warn, не throw на весь батч
//   upsertMessage({ chatId: payload.contactPubkey, lamportTs: payload.lamportTs,
//     senderPubkey: payload.senderPubkey, id: event.id, text: payload.text, status: "sent", msgId: payload.msgId })
// -> Promise<void>

// ensureConnected -- ДОПОЛНЕНО, после ensureOwnKeyPackagePublished и ДО refreshGroupMessageSubscription:
//   await syncDeviceMembership(pubkeyHex, privKey, publisher.publish, () => fetchOwnKeyPackageAnnounces(pubkeyHex))
//   mirrorKey = deriveMirrorKey(deriveMasterSecret(privKey)); await syncMirroredHistory(pubkeyHex, mirrorKey)
// (после -- refreshGroupMessageSubscription(pubkeyHex) уже существующий, подхватит и новые
// группы, если syncDeviceMembership только что что-то добавил -- для СЕБЯ добавление не
// создаёт новых mlsGroups строк, только для добавляемого сиблинга, так что фактически
// refreshGroupMessageSubscription здесь ничего нового не находит -- но порядок вызовов
// сохраняется для консистентности с остальным connect())
```

### `src/core/store/database.js` (правка схемы, `db.version(3)`, аддитивно)

```js
deviceIdentity: "id",
knownDevices: "[ownerPubkey+deviceId], ownerPubkey",
messages: "++seq, &[chatId+msgId], [chatId+lamportTs+senderPubkey+id], chatId, id, status, deleted",
inboxRequests: "[owner+senderPubkey], owner, senderPubkey, createdAt"
```

Остальные таблицы не меняются. `messages` переопределяется целиком в
`version(3)` (Dexie требует полного списка индексов таблицы при
изменении хотя бы одного) — новый unique-индекс `[chatId+msgId]`
(дедупликация, п. выше) добавлен РЯДОМ со старым неуникальным индексом
`[chatId+lamportTs+senderPubkey+id]` (сортировка `getChatHistory`,
не трогается) — два индекса, два разных назначения, не заменяют друг
друга. Строки без `msgId` (тестовые фикстуры этапа 24, `bulkAdd` до
этого этапа) не индексируются unique-индексом (IndexedDB пропускает
запись в compound-индексе при отсутствующем поле key path) — не
требуют правки задним числом. `inboxRequests` переопределена (была
`"id, senderPubkey, created_at"`, version(1), никем не использовалась
с этапа 3) — owner-scoping, тот же пробел мультиаккаунта, что уже
исправлен для `contactRequests` (этап 24), просто не замечен раньше
(мёртвая таблица); `createdAt` camelCase для единообразия.

### `src/domain/messaging/inbox-requests.js` (новый файл)

```js
export async function isKnownContact(ownerPubkey, candidatePubkey);
// db.table("contacts").get([ownerPubkey, candidatePubkey]) -> Boolean(row)

export async function storeInboxRequest(ownerPubkey, senderPubkey, welcomeWireBytes, createdAt);
// db.table("inboxRequests").put({ owner: ownerPubkey, senderPubkey, welcomeWireBytes, createdAt })
// welcomeWireBytes хранится СЫРЫМ (Uint8Array, Dexie структурно клонирует) — Welcome НЕ
// распаковывается (joinFromWelcome НЕ вызывается), пока пользователь явно не примет решение
// -> Promise<void>

export async function listInboxRequests(ownerPubkey);
// db.table("inboxRequests").where("owner").equals(ownerPubkey).toArray() -> Promise<Array<{owner,senderPubkey,welcomeWireBytes,createdAt}>>

export async function acceptInboxRequest(ownerPubkey, senderPubkey);
// row = db.table("inboxRequests").get([ownerPubkey, senderPubkey]); нет записи -> throw
// await chat.acceptWelcome(ownerPubkey, senderPubkey, row.welcomeWireBytes)  -- переиспользует
//   этап 24 буквально, без изменений; ownKeyPackage.self НЕ ротируется (известное
//   упрощение этапа 24) -- joinFromWelcome сработает той же приватной половиной
// await db.table("inboxRequests").delete([ownerPubkey, senderPubkey])
// -> Promise<void>
// ВАЖНО: вызывающий код (будущий chat.jsx, этап 27) ОБЯЗАН вызвать
// transport.refreshGroupMessageSubscription после acceptInboxRequest — тот же принцип,
// что ensureChatEstablished (этап 24, CONTRACTS.md) — inbox-requests.js не импортирует transport.js

export async function rejectInboxRequest(ownerPubkey, senderPubkey);
// db.table("inboxRequests").delete([ownerPubkey, senderPubkey]) -- MLS-группа никогда не
// создавалась (Welcome не распаковывался), удалять больше нечего -> Promise<void>
```

### `src/ui/signals/transport.js` (правка контракта этапа 24/25 — whitelist-гейт для Welcome)

```js
// Диспетчер входящих gift-wrap, rumor.kind === 444 — ПРАВКА (после self-Welcome-тега, раздел 1b):
//   isSibling = rumor.pubkey === pubkeyHex
//   welcomeContactPubkey = isSibling && contactTag ? contactTag[1] : rumor.pubkey
//   if isSibling || await isKnownContact(pubkeyHex, welcomeContactPubkey):
//     acceptWelcome(pubkeyHex, welcomeContactPubkey, decodeBase64(rumor.content)); refreshGroupMessageSubscription(...)
//   else:
//     storeInboxRequest(pubkeyHex, welcomeContactPubkey, decodeBase64(rumor.content), rumor.created_at)
//     // НЕ acceptWelcome — Welcome от настоящего незнакомца не создаёт MLS-группу автоматически (AC-IB-01)
```

### `src/domain/messaging/deletions.js` (новый файл)

```js
export function buildDeletionText(msgId);
// -> "__ugolok_delete__:" + msgId

export function parseDeletionText(text);
// -> text.slice(prefix.length), если начинается с префикса; иначе null

export async function deleteMessage(ownerPubkey, privKey, contactPubkey, msgId, lamportTs, publish);
// targetRow = db.table("messages").where("[chatId+msgId]").equals([contactPubkey, msgId]).first()
// !targetRow || targetRow.senderPubkey !== ownerPubkey -> throw ("нельзя удалить чужое сообщение")
//   -- найдено адверсарным тестом (не домысел): без этой проверки можно было бы локально
//   "удалить" чужое (Боба) сообщение — та же F-EV-08 граница, что и на приёмной стороне
// { eventId } = await chat.sendMessage(ownerPubkey, privKey, contactPubkey, buildDeletionText(msgId), lamportTs, publish)
//   -- переиспользует ВЕСЬ криптографический путь этапа 24 буквально, без изменений chat.js
// db.table("messages").where("[chatId+msgId]").equals([contactPubkey, msgId]).modify({ deleted: true, text: "" })
//   -- своя копия помечается СРАЗУ (не дожидаясь приёма контактом) -- UX «Сообщение удалено» мгновенно
// -> Promise<{ eventId: string }>

export async function applyIncomingDeletionIfMarker(event, receivedResult);
// receivedResult — возврат receiveGroupMessageEvent (chat.js): { text, lamportTs } | null
// if !receivedResult: return false
// targetMsgId = parseDeletionText(receivedResult.text); if null: return false (обычное сообщение, не маркер)
// hTag = event.tags.find(t => t[0]==="h"); groupRow = db.table("mlsGroups").get(hTag[1]); if !groupRow: return false
// deleterPubkey = groupRow.contactPubkey  -- НЕ event.pubkey (эфемерный на kind 445, та же находка
//   этапа 24 п.7) -- тот же способ, что receiveGroupMessageEvent резолвит contactPubkey
// targetRow = db.table("messages").where("[chatId+msgId]").equals([groupRow.contactPubkey, targetMsgId]).first()
// if !targetRow or targetRow.senderPubkey !== deleterPubkey: return false
//   -- авторизация: аналог validateDeletion (этап 22) F-EV-08 -- только автор может удалить своё
// db.table("messages").where("[chatId+msgId]").equals([groupRow.contactPubkey, targetMsgId]).modify({ deleted: true, text: "" })
// -> Promise<boolean>  -- true, если реально применено
// Вызывается ПОСЛЕ receiveGroupMessageEvent в диспетчере kind 445 (transport.js), не внутри chat.js.
// Строка самого маркера (delete-запрос как "сообщение") НЕ скрывается здесь -- backlog UI, этап 27.
```

## Этап 26 — Lazy-load чата + read status + черновики

Триаж (п.13a): **рутина** — CRUD/fold-обвязка по прецеденту `groups.js`/
`handlers.js` (этапы 22-24), никакого нового пространства состояний с
неочевидными переходами. Design-записка не пишется (п.13a), находки —
ниже, по прецеденту предыдущих рутинных этапов.

### Находки (архитектурные расхождения с TECH.md, до кода)

**1. F-CSL-01/6.4 писались ДО пивота на MLS (этап 13) — не переносятся
буквально.** Оригинальный псевдокод предполагает REQ к relay по kind
1059 "при открытии чата с контактом X" — модель, где сообщения НЕ
материализуются локально заранее. С этапа 24/25 вся история чата УЖЕ
материализуется в `messages` НЕЗАВИСИМО от того, открыт ли конкретный
чат в UI (живая подписка по ВСЕМ `groupId` сразу + зеркало по
`authors:[me]` сразу, этапы 24-25). "Lazy-load" здесь — ЛОКАЛЬНАЯ
операция над уже заполненной IndexedDB (окно последних N при открытии,
подгрузка более старых при скролле), БЕЗ обращения к relay. Тот же
класс правки, что self-mirror (этап 25).

**2. Окна "по 100" — контракт UI (сколько показывается за раз), не
буквальная курсорная оптимизация физического запроса.** `messages`
одного 1:1 чата в MVP-масштабах — не миллионы строк; `.where("chatId").
equals(...).toArray()` + сортировка+срез в памяти — тот же осознанный
компромисс, что `queryEvents` этапа 3 ("полное сканирование, без
оптимизации через индексы — допустимо для этого объёма"). Настоящая
Dexie-курсорная оптимизация (реальный частичный запрос без full-scan
таблицы) — backlog, если понадобится по перформансу.

**3. `chatSyncState` (схема с этапа 3, `"chatId"`) — мёртвая таблица
до этого этапа, первый реальный потребитель.** Одна строка на чат несёт
`{chatId, lastReadLamportTs, draftText, draftUpdatedAt, oldestLoadedSeq}`
— не заводится отдельных таблиц под read-status/draft/lazy-курсор
(Dexie не требует фиксированной схемы столбцов, только индексов) —
проще, чем три отдельные таблицы ради трёх независимых kind'ов,
которые в UI всё равно читаются вместе (открытие чата).

**4. Read-status monotonic guard.** `foldReadStatus` не должен
откатывать `lastReadLamportTs` НАЗАД, если локально уже есть более
свежее значение (relay не гарантирует порядок доставки replaceable
kind'ов) — симметрично `nextCreatedAt`-дисциплине этапа 23/24, но
здесь монотонность проверяется НА ЧТЕНИИ (fold), не на записи.

**5. Идемпотентность fold read-status относительно ДКА сообщения.**
`transitionMessage("read", "READ")` не определён (finalное состояние,
machine.js бросает) — повторный fold ТОЙ ЖЕ версии kind 30070 не
должен падать: `foldReadStatus` пропускает строки, уже `status ===
"read"`, ДО вызова `transitionMessage`, а не глушит исключение try/catch
(прозрачнее — ошибка перехода для НЕожиданного случая по-прежнему
всплывает).

### `src/domain/messaging/read-status.js` (новый файл)

```js
export function buildReadStatusEvent(privKey, { chatId, lastReadLamportTs }, createdAt = Math.floor(Date.now()/1000));
// createdAt — необязательный параметр (по прецеденту buildGroupEvent, этап 24/23-довесок) —
// вызывающий код может передать nextCreatedAt()-подобное монотонное значение против
// коллизии в ту же секунду; дефолт — текущее время.
// kind 30070, tags=[["d", chatId]] (d-tag = chatId В ОТКРЫТОМ ВИДЕ — TECH.md: для этого
// kind'а d-tag не privacy-чувствителен, opaqueDTag не нужен, по прецеденту buildGroupEvent)
// content = NIP-44(JSON.stringify({ lastReadLamportTs }), privKey, ownPubkey) — self-encrypt
// -> подписанный NostrEvent

export function parseReadStatusEvent(event, privKey);
// decrypt NIP-44(event.content, privKey, event.pubkey), JSON.parse
// -> { chatId (из d-tag), lastReadLamportTs }

export async function foldReadStatus(event, privKey);
// { chatId, lastReadLamportTs } = parseReadStatusEvent(event, privKey)
// existing = db.table("chatSyncState").get(chatId)
// if existing?.lastReadLamportTs >= lastReadLamportTs: return  -- monotonic guard, находка 4
// db.table("chatSyncState").put({ ...existing, chatId, lastReadLamportTs })
// rows = db.table("messages").where("chatId").equals(chatId).toArray()
// for row of rows:
//   if row.senderPubkey === event.pubkey: continue  --자신의 исходящие не переводятся тут
//     (F-MS-07: READ относится к сообщениям, которые Я прочитал ОТ контакта, не к своим же)
//   if row.lamportTs > lastReadLamportTs: continue
//   if row.status !== "sent": continue  -- уже "read" (идемпотентность, находка 5) или иной статус
//   db.table("messages").update(row, { status: transitionMessage(row.status, "READ") })
// -> Promise<void>

export async function markChatAsRead(ownerPubkey, privKey, contactPubkey, lastReadLamportTs, publish);
// event = buildReadStatusEvent(privKey, { chatId: contactPubkey, lastReadLamportTs })
// await requirePublishOk(publish, event)  -- та же дисциплина, что chat.js/devices.js
// await foldReadStatus(event, privKey)  -- локально применяем СРАЗУ, не ждём эха от relay
// -> Promise<void>

export async function getUnreadCount(ownerPubkey, contactPubkey);
// existing = db.table("chatSyncState").get(contactPubkey); lastRead = existing?.lastReadLamportTs ?? 0
// db.table("messages").where("chatId").equals(contactPubkey).toArray()
//   .filter(m => m.senderPubkey === contactPubkey && m.lamportTs > lastRead).length
// -> Promise<number>
```

### `src/domain/messaging/drafts.js` (новый файл)

```js
export function buildDraftEvent(privKey, { chatId, text }, createdAt = Math.floor(Date.now()/1000));
// kind 30071, tags=[["d", chatId]] (один активный черновик на чат, d-tag в открытом виде,
// тот же принцип, что read-status — TECH.md: 30071 d-tag не privacy-чувствителен)
// content = NIP-44(JSON.stringify({ text }), privKey, ownPubkey) — self-encrypt
// text === "" -- валиден (republish с пустым text = стирание черновика)
// -> подписанный NostrEvent

export function parseDraftEvent(event, privKey);
// -> { chatId (из d-tag), text }

export async function foldDraft(event, privKey);
// { chatId, text } = parseDraftEvent(event, privKey)
// db.table("chatSyncState").put({ ...(await db.table("chatSyncState").get(chatId)), chatId,
//   draftText: text, draftUpdatedAt: event.created_at })
// -- LWW по created_at уже даёт "последнюю версию" на уровне raw-события (та же гарантия,
//   что contacts/groups, этапы 22-24) -- foldDraft не нужен собственный monotonic guard
// -> Promise<void>

export async function saveDraft(ownerPubkey, privKey, contactPubkey, text, publish);
// event = buildDraftEvent(privKey, { chatId: contactPubkey, text })
// await requirePublishOk(publish, event); await foldDraft(event, privKey)
// -> Promise<void>

export async function getDraft(contactPubkey);
// (await db.table("chatSyncState").get(contactPubkey))?.draftText ?? ""
// -> Promise<string>
```

### `src/core/sync/lazy-chat.js` (новый файл)

```js
export async function loadChatWindow(contactPubkey, { limit = 100, beforeSeq } = {});
// rows = db.table("messages").where("chatId").equals(contactPubkey).toArray()
// sorted = rows.sort(та же компаратор-функция, что getChatHistory: (lamportTs, senderPubkey, id))
// source = beforeSeq === undefined ? sorted : sorted.slice(0, sorted.findIndex(m => m.seq === beforeSeq))
//   (findIndex не найден (-1) -> source = sorted, курсор устарел/невалиден -- не throw)
// windowRows = source.slice(-limit)
// -> Promise<{ messages: MessageRow[], hasMore: boolean }>  -- hasMore = source.length > limit

export async function markWindowLoaded(contactPubkey, oldestLoadedSeq);
// db.table("chatSyncState").put({ ...(await db.table("chatSyncState").get(contactPubkey)),
//   chatId: contactPubkey, oldestLoadedSeq })
// -- курсор для UI (chat.jsx, этап 27): "докуда догружено", не влияет на sort/filter сам по себе
// -> Promise<void>
```

Требует `sendMessage`'s `requirePublishOk` семантику (throw при `!result.ok`)
— `read-status.js`/`drafts.js` НЕ импортируют её из `chat.js` (не
экспортирована) — своя копия хелпера, тот же паттерн, что `devices.js`
(этап 25).

## Этап 27 — UI чата

Триаж (п.13a): **рутина** — склейка уже готовых доменов (этапы 24-26)
в реальный UI, по прецеденту `contacts.jsx` (этап 23). Найдены и
закрыты здесь три пробела, оставленные предыдущими этапами открытыми
(явно, не молчаливо):

### Находка 1: кто отправляет contact-request (kind 3001) — DESIGN.md этапа 24 не уточнял

Дословный сценарий пользователя (сохранён в log.md с самого начала
проекта): тот, кто ВВОДИТ чужой ключ в форму "Добавить контакт" —
инициатор. Решение: форма "Добавить контакт" теперь ДЕЛАЕТ ДВЕ вещи
одним действием — (1) `addContactAction` как раньше (инициатор сразу
видит адресата в СВОИХ контактах — это его собственное намерение),
(2) ДОПОЛНИТЕЛЬНО отправляет gift-wrapped `contact-request` (kind
3001) адресату. Адресат видит запрос во "Входящих" — Принять
(`addContactAction` взаимно + удалить запись — теперь ОБЕ стороны
видят друг друга), Отклонить (`blockContactAction` + удалить запись),
Игнорировать (ничего не делать, запись остаётся).

### Находка 2: реактивность UI на входящее (новое сообщение/Welcome/запрос) — диспетчер живёт вне React

`transport.js`'s диспетчеры (gift-wrap, kind 445) работают ФОНОВО, не
через React re-render. Без явного сигнала открытый экран чата не
узнает о новом сообщении, пока пользователь не переключит вкладку.
Решение: один общий сигнал `messagingActivity` (`signals/chats.js`,
`signal(0)`) — инкрементируется diспетчером transport.js на КАЖДОЕ
успешно обработанное входящее (Welcome, contact-request,
kind-445-сообщение/коммит, зеркало). `chat.jsx`/`contacts.jsx`
подписываются на `messagingActivity.value` в `useEffect`-зависимостях
и перезапрашивают своё локальное состояние (окно чата / списки
запросов) при любом изменении — грубая, но простая и надёжная схема
(перечитать всё активное состояние целиком, не point-to-point
диффинг) — оправдана объёмом MVP (не миллионы событий).

### Находка 3: `acceptInboxRequest`/ручной `ensureChatEstablished` не запускают `refreshGroupMessageSubscription` сами — обязательное правило вызова, как и раньше

Тот же класс находки, что уже задокументирован для `ensureChatEstablished`
(этап 24): создание НОВОЙ MLS-группы (через `acceptInboxRequest`, или
через первую отправку сообщения новому контакту) не подписывает
устройство на её `#h` само — вызывающий UI-код ОБЯЗАН вызвать
`transport.refreshGroupMessageSubscription` сразу следом. Оба
UI-orchestration-модуля ниже (`chats.js`/`inbox.js`) принимают её
инъекцией (тот же паттерн, что `publish`/`fetchKeyPackage`) — не
импортируют `transport.js` напрямую, вызывающий JSX передаёт её,
получив из `transport.js` (тот же паттерн, что `contacts.jsx`
уже делает для `ensureConnected`/`publish`/`fetchProfiles`).

### `src/ui/signals/chats.js` (новый файл)

```js
export const messagingActivity = signal(0); // сигнал-триггер живого обновления (находка 2)
export function bumpMessagingActivity(); // messagingActivity.value++ — вызывается ТОЛЬКО transport.js

export async function listChatPartners(ownerPubkey);
// db.table("mlsGroups").toArray() -> уникальные contactPubkey (у кого есть активный чат)
// -> Promise<string[]>

export async function sendChatMessageAction(ownerPubkey, privKey, contactPubkey, text, lamportTs, publish, fetchKeyPackage, refreshGroupMessageSubscription);
// await chat.ensureChatEstablished(ownerPubkey, privKey, contactPubkey, publish, fetchKeyPackage) -- no-op, если уже есть
// await refreshGroupMessageSubscription(ownerPubkey, privKey, publish) -- ОБЯЗАТЕЛЬНО (находка 3),
//   безусловно на каждую отправку -- сама идемпотентна (пересоздаёт REQ текущим списком groupId),
//   дешевле и надёжнее, чем проверять "было ли реально создано"
// -> await chat.sendMessage(ownerPubkey, privKey, contactPubkey, text, lamportTs, publish)
// throw "у контакта нет опубликованного ключа для сообщений" всплывает как есть
//   (fetchKeyPackage, этап 24) -- UI показывает понятную ошибку, не крашится

export async function deleteChatMessageAction(ownerPubkey, privKey, contactPubkey, msgId, lamportTs, publish);
// await deletions.deleteMessage(ownerPubkey, privKey, contactPubkey, msgId, lamportTs, publish)
// throw "нельзя удалить чужое сообщение" (deletions.js, этап 25) всплывает как есть

export async function markChatReadAction(ownerPubkey, privKey, contactPubkey, lastReadLamportTs, publish);
// await readStatus.markChatAsRead(...) -- вызывается при ОТКРЫТИИ чата (chat.jsx), lastReadLamportTs =
//   lamportTs последнего сообщения в уже загруженном (самом свежем) окне

export async function saveChatDraftAction(ownerPubkey, privKey, contactPubkey, text, publish);
// await drafts.saveDraft(...)
```

### `src/ui/signals/inbox.js` (новый файл)

```js
export async function refreshInboxRequests(ownerPubkey);
// возвращает Promise<Array<{owner,senderPubkey,welcomeWireBytes,createdAt}>> (listInboxRequests, этап 25) —
// вызывающий JSX держит в локальном useState (не отдельный @preact/signals сигнал —
// re-render уже триггерится messagingActivity, доп. сигнал не нужен)

export async function acceptInboxRequestAction(ownerPubkey, privKey, senderPubkey, refreshGroupMessageSubscription, publish);
// await inboxRequests.acceptInboxRequest(ownerPubkey, senderPubkey)
// await refreshGroupMessageSubscription(ownerPubkey, privKey, publish) -- ОБЯЗАТЕЛЬНО (находка 3)
// openChat(senderPubkey) -- сразу переключить UI на новый чат (signals/chat.js, этап 23-довесок)

export async function rejectInboxRequestAction(ownerPubkey, senderPubkey);
// await inboxRequests.rejectInboxRequest(ownerPubkey, senderPubkey)
```

### `src/ui/signals/contacts.js` (правка контракта — добавлены contact-request функции)

```js
export const contactRequests = signal([]); // [{owner, senderPubkey, greeting, createdAt}]

export async function refreshContactRequests(ownerPubkey);
// db.table("contactRequests").where("owner").equals(ownerPubkey).toArray() -> contactRequests.value

export async function sendContactRequestAction(ownerPubkey, privKey, npubOrHex, greeting, publish);
// await addContactAction(ownerPubkey, privKey, npubOrHex, publish) -- находка 1, инициатор видит адресата сразу
// targetPubkey = decodePubkeyInput(npubOrHex) (повторный вызов чистой функции — не проблема)
// rumor = buildContactRequestRumor(greeting) (domain/contacts/requests.js, этап 24)
// giftWrap = nip59.wrap(rumor, privKey, targetPubkey)
// await requirePublishOk(publish, giftWrap)

export async function acceptContactRequestAction(ownerPubkey, privKey, senderPubkey, publish);
// await addContactAction(ownerPubkey, privKey, senderPubkey, publish) -- взаимно
// await db.table("contactRequests").delete([ownerPubkey, senderPubkey])
// await refreshContactRequests(ownerPubkey)

export async function rejectContactRequestAction(ownerPubkey, privKey, senderPubkey, publish);
// await blockContactAction(ownerPubkey, privKey, senderPubkey, publish)
// await db.table("contactRequests").delete([ownerPubkey, senderPubkey])
// await refreshContactRequests(ownerPubkey)
```

### `src/ui/signals/transport.js` (правка контракта — bumpMessagingActivity)

```js
// giftWrapSubscriber.onBatch -- после успешной обработки rumor.kind===444 (и sibling, и
//   от контакта, и inbox-request ветка), rumor.kind===CONTACT_REQUEST_KIND: bumpMessagingActivity()
// refreshGroupMessageSubscription.onBatch -- после receiveGroupMessageEvent (успешно, не discard)
//   и после applyIncomingDeletionIfMarker: bumpMessagingActivity()
```

### `src/ui/components/message-bubble.jsx` (новый файл, presentational)

```js
export default function MessageBubble({ message, isOwn, onDelete });
// message: { text, lamportTs, senderPubkey, status, deleted, msgId }
// deleted === true -> курсивный плейсхолдер "Сообщение удалено", кнопка удаления не показывается
// иначе: текст сообщения; isOwn -> выравнивание вправо + статус (значок/подпись по
//   MESSAGE_TRANSITIONS state: created/sending/sent/read/failed/discarded, machine.js этап 24);
//   onDelete показывается ТОЛЬКО для isOwn && !deleted (F-EV-08 — чужое не потрогать)
```

### `src/ui/screens/chat.jsx` (новый файл, пишет Claude напрямую — стейтфул экран, урок PLAN.md)

Два режима одного экрана (`activeChatPubkey.value` пуст/не пуст),
как список диалогов и сама переписка внутри ОДНОГО компонента (по
прецеденту `contacts.jsx`'s локальных подкомпонентов):

- **Список** (`activeChatPubkey.value === null`): секция "Входящие"
  (`inboxRequests`, Принять/Отклонить, находка 3), секция "Чаты"
  (`listChatPartners` + `getUnreadCount` бейдж на каждого + клик →
  `openChat`).
- **Переписка** (`activeChatPubkey.value !== null`): кнопка "Назад"
  (`openChat(null)`), `loadChatWindow` (этап 26, догрузка при скролле
  вверх через `beforeSeq`), `MessageBubble` на каждое сообщение,
  форма ввода (лимит 10000 символов, F-MS-08, клиентская валидация),
  черновик (`getDraft` при открытии → поле ввода, `saveChatDraftAction`
  debounced при вводе), `markChatReadAction` при открытии (lastReadLamportTs
  = lamportTs последнего сообщения самого свежего окна).
- `useEffect` на `[activeChatPubkey.value, messagingActivity.value]` —
  перезагружает и список, и открытую переписку (находка 2).
- `busyRef`-дисциплина на отправку/удаление/accept/reject (тот же
  паттерн гонки, что `contacts.jsx`, этап 23).

### Находка 4 (найдено ЖИВЫМ E2E-прогоном через реальный relay, не адверсарным юнит-тестом): черновик нельзя перезагружать на каждый `messagingActivity`

Первая версия держала загрузку окна сообщений И черновика в ОДНОМ
`useEffect`, зависящем от `messagingActivity.value`. Реальный
сценарий (два настоящих браузерных контекста, Playwright как
библиотека — MCP-инструмента нет в этой сессии, но `playwright`
уже установлен пакетом проекта и запускается обычным Node-скриптом)
вскрыл гонку: пока пользователь печатает ответ (текст ещё не
сохранён как черновик — debounce 1с), ЛЮБОЕ фоновое событие
(входящее сообщение, свой же bootstrap) инкрементирует
`messagingActivity` → эффект перезапускается → `getDraft()`
перезаписывает `text` ПОСЛЕДНИМ СОХРАНЁННЫМ (устаревшим/пустым)
черновиком, стирая только что введённый пользователем текст. Внешне
проявлялось как "кнопка Отправить внезапно снова disabled".

Исправлено разделением на два независимых `useEffect`: загрузка окна
сообщений + `markChatReadAction` реагирует на `messagingActivity.value`
(это корректно — новые сообщения ДОЛЖНЫ подгружаться); загрузка
черновика (`getDraft`) реагирует ТОЛЬКО на смену `contactPubkey` (смена
самого чата) — черновик, единожды загруженный при открытии, дальше
живёт только в `text` (React state) и debounce-сохранении, фоновая
активность его не трогает.

### Живая проверка (Playwright как библиотека, реальный `strfry`, два независимых браузерных контекста — Alice/Bob)

Полный сценарий, буквально запрошенный пользователем в начале работы
над messaging-частью проекта: регистрация обоих → Боб вводит npub
Алисы в форму "Добавить контакт" → видит её сразу в своих контактах
(находка 1) → Алиса ЖИВЬЁМ (без reload) видит входящий запрос →
принимает → оба видят друг друга взаимно → Боб кликает на Алису →
переходит в чат → отправляет сообщение → видит его сразу у себя →
Алиса ЖИВЬЁМ видит новый чат в списке с непрочитанным счётчиком →
открывает → реально расшифровывает MLS-сообщение → отвечает → Боб
получает ответ → Алиса удаляет своё сообщение → у обеих сторон
отображается "Сообщение удалено". Все шаги подтверждены реальным
сетевым обменом через работающий `strfry`, не заглушкой.

## Этап 24-27-довесок — owner-scoping messaging-таблиц (критическая находка реального использования)

Найдено пользователем ПРИ ПЕРВОМ РЕАЛЬНОМ ИСПОЛЬЗОВАНИИ (не адверсарным
тестом, не Playwright-эмуляцией): `ownKeyPackage`, `mlsGroups`,
`messages`, `chatSyncState` НИКОГДА не были owner-scoped — в отличие
от `contacts`/`blockedContacts`/`groups`/`contactRequests`/
`inboxRequests`/`knownDevices` (owner-scoped с самого начала).
Молчаливое допущение "одна identity = одно устройство = одна БД"
(этапы 13/24) не учло, что мультиаккаунт на ОДНОМ устройстве (этап
11, `listAccounts()`) означает НЕСКОЛЬКО identity, делящих ОДНУ
IndexedDB (один origin). Симптомы пользователя: `ownKeyPackage` хранил
ОДНУ запись `"self"` на всё устройство — второй локальный аккаунт
молча получал MLS-credential ПЕРВОГО, что ts-mls закономерно отверг
как "участник уже в группе" (`Commit cannot contain an Add proposal
for someone already in the group`); `mlsGroups`/`messages`/
`chatSyncState` были голыми (без owner) — второй локальный аккаунт
видел ЧУЖИЕ переписки/собеседника в заголовке чата.

**Правка схемы (`db.version(4)`, аддитивно):**
```js
ownKeyPackage: "ownerPubkey",                        // было "id" со значением "self"
mlsGroups: "[ownerPubkey+groupId], ownerPubkey",     // было "groupId"
messages: "++seq, &[ownerPubkey+chatId+msgId], [ownerPubkey+chatId+lamportTs+senderPubkey+id], [ownerPubkey+chatId], id, status, deleted",
chatSyncState: "[ownerPubkey+chatId], ownerPubkey"   // было "chatId"
```
`deviceIdentity` НЕ owner-scoped НАМЕРЕННО и остаётся так — `deviceId`
это метка ФИЗИЧЕСКОГО устройства, общая для всех identity на нём
(credential = `identity:deviceId` уже различает identity через первую
часть).

**Правка сигнатур (owner-scoping):** `getChatHistory(ownerPubkey,
contactPubkey)` (было без ownerPubkey), `getDraft(ownerPubkey,
contactPubkey)`, `loadChatWindow(ownerPubkey, contactPubkey, opts)`,
`markWindowLoaded(ownerPubkey, contactPubkey, seq)`,
`applyIncomingDeletionIfMarker(ownerPubkey, event, receivedResult)`
(было без ownerPubkey). `foldReadStatus`/`foldDraft` НЕ получили новый
параметр — `ownerPubkey = event.pubkey` внутри (read-status/draft
всегда self-signed, отдельный параметр избыточен).

**Правка мест, где `ownerPubkey` УЖЕ БЫЛ параметром, но не
использовался для scoping запроса (тихая порча данных, не throw):**
`devices.js`'s `syncDeviceMembership` (`mlsGroups.toArray()` без
фильтра — добавляло сиблинга в группы ВСЕХ локальных аккаунтов),
`transport.js`'s `refreshGroupMessageSubscription` (та же проблема),
`chats.js`'s `listChatPartners` (та же проблема), `transport.js`'s
`syncMirroredHistory` (upsertMessage без `ownerPubkey` в row).

**Найдено ЖИВЫМ E2E-прогоном мультиаккаунтного сценария (Playwright
как библиотека, ОДИН browser context = ОДИН origin = ОДНА IndexedDB,
реальная перезагрузка страницы `page.reload()` между регистрацией
naysy и matero — именно так пользователь переключался между
локальными аккаунтами, отдельной кнопки logout в UI нет):**
`chat.jsx`'s асинхронная загрузка черновика (`getDraft`) при
монтировании МОЖЕТ резолвиться ПОСЛЕ того, как пользователь уже начал
печатать — `setText(draft)` стирает введённый текст. В обычном
человеческом использовании маловероятно (БД быстрее печати), но не
гарантировано. Исправлено флагом `userEditedRef` (`useRef`) — как
только пользователь хоть раз редактировал текст, асинхронная загрузка
черновика больше не имеет права его перезаписывать; сбрасывается при
смене `contactPubkey` (новый чат).

Полный мультиаккаунтный сценарий (naysy регистрируется → устанавливает
чат с carol → реальная перезагрузка страницы (F5) → matero
регистрируется НА ТОМ ЖЕ устройстве → НЕ видит переписку naysy
(owner-scoping) → устанавливает СВОЙ чат с carol БЕЗ MLS credential
conflict → carol видит ОБА чата как отдельные) подтверждён живьём
через реальный `strfry`.

## Этап 27-довесок-2 — синхронизация Lamport-часов на приём (реальная находка)

Пользователь сообщил: порядок сообщений между сторонами иногда
путается (последнее отправленное сообщение отображается ВЫШЕ уже
полученных), но восстанавливается при повторном открытии чата.
Найдено чтением кода (grep по `.receive(`, не гадание):
`lamportClock.receive()` (lamport.js, этап 19, инвариант L1 — уже
покрыт юнит-тестами) НИ РАЗУ не вызывался нигде в проекте — только
`.tick()` для исходящих. Часы Алисы и Боба тикали НЕЗАВИСИМО, никогда
не синхронизируясь между собой — если один участник молчит, пока
другой отправляет несколько сообщений подряд, его следующий `tick()`
может дать МЕНЬШИЙ lamportTs, чем уже отправленные сообщения
собеседника, путая сортировку `(lamportTs, senderPubkey, id)`.

**Правка (`src/ui/signals/transport.js`):**
```js
export async function receiveLamportTick(remoteLamportTs);
// clock.receive(remoteLamportTs) (lamport.js) -> persistLamportValue(value) -> value
// Та же ленивая инициализация lamportClock, что nextLamportTick (вынесена в
// общую ensureLamportClock()).
```
Вызывается на КАЖДОЕ входящее (не на control-сообщения — `receivedResult`
уже `null` для них): `refreshGroupMessageSubscription`'s onBatch (после
`receiveGroupMessageEvent`) и `syncMirroredHistory`'s onBatch (после
`decryptMirrorPayload`).

Живая E2E-проверка (Playwright как библиотека, два браузерных
контекста): Алиса шлёт 3 сообщения подряд, Боб дожидается получения
всех трёх (его часы синхронизируются через `receive()` на каждое),
затем отвечает — ответ Боба корректно оказывается ПОСЛЕДНИМ в порядке
сортировки у ОБЕИХ сторон.

**Отложено (не в скоупе этого фикса, известное ограничение):**
`lamport.js`'s `computeInitialLamportValue()`/`clock` (таблица) сама
по себе НЕ owner-scoped (в отличие от messaging-таблиц, довесок выше)
— при мультиаккаунте на одном устройстве начальное значение часов
считается по ВСЕМ сообщениям всех локальных аккаунтов. Не создаёт
конфликтов данных (часы остаются монотонными, просто более
консервативны) — тот же класс находки, что отмечен в этапе 26, не
исправлен там же по той же причине (не создаёт видимых симптомов).

## Этап 27-довесок-3 — профиль: вечное кэширование био (реальная находка); аватар — известное ограничение

Пользователь сообщил два симптома: (1) если собеседник меняет био,
контакты продолжают видеть старое; (2) аватары в списке чатов —
заглушки, хотя био подгружается.

**(2) Аватар — НЕ баг, известное архитектурное ограничение (этап 20,
F-ID-08).** Подтверждено чтением `profile.jsx`: `buildProfileEvent`
собирает kind-0 только с `{name, about}` — поле аватара НИКОГДА не
публикуется в relay, `updateProfile(id, {avatar})` пишет только в
локальную IndexedDB текущего пользователя. F-ID-08 требует аватар как
ссылку на Blossom-blob (не base64 в событии — событие раздулось бы
и/или превысило лимиты relay), а Blossom появляется только в Этапе 28.
Фикс без Blossom означал бы либо (а) публиковать base64 в kind-0
(нарушает уже принятый контракт F-ID-08), либо (б) городить временный
транспорт для картинок, который придётся выбросить через один этап —
осознанно отложено, не переделывается сейчас.

**(1) Био — реальный баг, найден чтением кода.** `ensureProfilesFetched`
(`src/ui/signals/contacts.js`, этап 23) фильтрует `pubkeys.filter((pk)
=> !(pk in profiles.value))` — уже закэшированный профиль (успешный
ИЛИ `null`) никогда не перезапрашивается повторно. Это было осознанным
решением этапа 23 (не долбить relay повторными запросами по каждому
рендеру) — но с появлением реальной публикации kind-0 при смене био
(этап 23-довесок, `profile.jsx`) это же кэширование стало багом:
свежее био собеседника никогда не долетает до уже открытого списка
контактов/чата.

**Правка (`src/ui/signals/contacts.js`):**
```js
export async function refreshProfiles(pubkeys, fetchProfilesFn);
// Безусловно перезапрашивает ВСЕ переданные pubkeys (без фильтра
// "уже закэшировано") и перезаписывает profiles.value. Пустой список
// -> no-op, не найденный профиль -> null (перезаписывает устаревшую
// запись, а не оставляет её). Сиблинг ensureProfilesFetched, которая
// остаётся для случая "дозаполнить отсутствующее без лишних сетевых
// вызовов".
```
Вызывается в точках "экран открыт" (не на каждый рендер и не на каждое
входящее сообщение внутри уже открытого экрана, где это оправдано):
- `chat.jsx` ChatWindow: эффект на смену `contactPubkey` (вход в чат) —
  было `ensureProfilesFetched([contactPubkey], ...)`, стало
  `refreshProfiles`.
- `chat.jsx` ChatList: эффект на `[ownerPubkey, messagingActivity.value]`
  (список чатов, включая обновление при новой активности) — было
  `ensureProfilesFetched(allPubkeys, ...)`, стало `refreshProfiles`.
- `contacts.jsx`: эффект на `[ownerPubkey]` (первичное открытие экрана
  контактов после `ensureConnected`) — было `ensureProfilesFetched
  (contacts.value, ...)`, стало `refreshProfiles`. Точки "подтянуть
  профиль для НОВОГО контакта/запроса" (эффекты на `[contacts.value]`
  и на `contactRequests`) намеренно оставлены на `ensureProfilesFetched`
  — там свежести не требуется (запись новая, кэш ещё пуст).

Тесты: `tests/contacts-signals.test.js` — 3 новых (перезапись
закэшированного профиля свежими данными; пустой список -> no-op;
пропавший контакт -> перезаписывает на `null`, не оставляет
устаревшую запись). Регрессия: 434/434, сборка 222.68 КБ gzip.

## Этап 27-довесок-4 — автопрокрутка к последнему сообщению при входе в чат

Пожелание пользователя (явно названо им упущением, не багом): при
открытии переписки нужно сразу видеть последнее сообщение, не
скроллить вручную.

**Важная находка живым E2E (не домысел, дважды перепроверено):**
внутренний `<div overflowY:"auto">` со списком сообщений в
`ChatWindow` (`chat.jsx`) в реальной вёрстке НИКОГДА не переполняется
сам по себе — его `height:"100%"` считается от предка с
`minHeight:"100dvh"` (не `height`), поэтому предок просто растёт
вместе с контентом, а скроллится ФАКТИЧЕСКИ `document`
(`document.scrollingElement`). Первая версия фикса (`ref` на
внутренний div + `scrollTop = scrollHeight`) была бы no-op в этой
вёрстке — поймано живым Playwright-прогоном (см. ниже), не
статическим анализом. Так как перекраивать цепочку высот вложенных
контейнеров ради этого — расширение блэст-радиуса за рамки
пожелания (затронуло бы и другие экраны), решение — не завязываться
на КОНКРЕТНЫЙ скроллящийся элемент:

**Правка (`src/ui/screens/chat.jsx`, `ChatWindow`):**
```js
const bottomRef = useRef(null);      // сентинел — пустой div ПОСЛЕ списка сообщений
const pendingScrollRef = useRef(false);

useEffect(() => { pendingScrollRef.current = true; }, [contactPubkey]);

useEffect(() => {
	// messages стартует с [] — этот же эффект стартует и на пустом начальном значении,
	// длину проверяем, чтобы не погасить pendingScrollRef ДО того, как loadChatWindow
	// реально подгрузит историю (найдено живым прогоном — без проверки длины прокрутка
	// срабатывала на пустом списке и потом уже не срабатывала на реальных данных).
	if (pendingScrollRef.current && messages.length > 0 && bottomRef.current) {
		bottomRef.current.scrollIntoView({ block: "end" });
		pendingScrollRef.current = false;
	}
}, [messages]);
```
`scrollIntoView()` сам находит РЕАЛЬНО скроллящегося предка (будь то
внутренний div или document) — не завязано на конкретную вёрстку.
Срабатывает один раз на смену `contactPubkey` (вход в чат), не на
каждое последующее фоновое сообщение (иначе выдёргивало бы
пользователя, читающего историю выше).

**Живая E2E-проверка (Playwright как библиотека, два контекста,
viewport 800×500 — намеренно маленький, чтобы список реально не
помещался):** Алиса отправляет 20 сообщений, Боб (который НИ РАЗУ не
взаимодействовал с полем ввода — контроль от случайного
"фокус-скролла" браузера) открывает чат — последнее сообщение
("сообщение номер 20") видно во вьюпорте сразу (`getBoundingClientRect`
внутри окна 500px по высоте), без ручного скролла. Адверсарная
проверка: тот же прогон с ЗАКОММЕНТИРОВАННЫМ вызовом `scrollIntoView`
подтверждённо ПАДАЕТ (последнее сообщение оказывается на
`top: 2572px` — далеко за пределами вьюпорта) — тест реально
чувствителен к наличию фикса, не проходит тривиально.

Regression: `npm test` 434/434 (сборка не меняет тестируемую
поверхность — эффект на DOM/scrollIntoView не юнит-тестируется в
node:test без DOM, проверено живым E2E). `npm run build` 222.74 КБ
gzip.

## Этап 27-довесок-5 — очистка своей копии переписки + "удалить у себя/у обоих"

Пожелание пользователя (явно принято как некомплексное, в отличие от
редактирования — этап 27-довесок-6). Триаж 13a: рутинная задача
(локальные операции над уже существующей таблицей `messages` по уже
существующему индексу `[ownerPubkey+chatId]`/`[ownerPubkey+chatId+msgId]`,
без нового протокольного пространства состояний) — DESIGN-записка не
нужна, сразу к тестам.

**Ключевое протокольное ограничение (не баг, осознанная граница):**
"удалить у обоих" технически возможно ТОЛЬКО для собственных
сообщений — `deleteMessage` (deletions.js, этап 22/24) уже проверяет
`targetRow.senderPubkey !== ownerPubkey` и отказывает. Форсированно
удалить сообщение СОБЕСЕДНИКА с ЕГО стороны нельзя (у нас нет
полномочий на его MLS-состояние) — поэтому "выбор" удалить у
себя/у обоих показывается ТОЛЬКО у своих сообщений; у сообщений
собеседника доступно только "удалить у себя" (без диалога выбора,
т.к. второй вариант в принципе недоступен).

**Новое (`src/domain/messaging/deletions.js`) — оба чисто локальные,
БЕЗ публикации в relay, БЕЗ проверки авторства (в отличие от
`deleteMessage`/"у обоих" — здесь скрывается только ВАША локальная
копия, чужие данные не затрагиваются):**
```js
export async function deleteMessageForMe(ownerPubkey, contactPubkey, msgId);
// db.table("messages").where("[ownerPubkey+chatId+msgId]")...delete() —
// ЖЁСТКОЕ удаление строки (не soft-delete с плейсхолдером "Сообщение
// удалено" — та пометка используется только для "у обоих", где ОБЕ
// стороны знают об удалении; здесь только я, для меня сообщение просто
// исчезает, как будто его никогда не грузили).

export async function clearChatHistory(ownerPubkey, contactPubkey);
// db.table("messages").where("[ownerPubkey+chatId]")...delete() —
// удаляет ВСЕ сообщения этого чата у ownerPubkey. mlsGroups-запись
// (сама переписка/канал) НЕ трогается — listChatPartners читает из
// mlsGroups, не из messages (chats.js:20), поэтому чат остаётся в
// списке "Чаты", просто пустым; переписка продолжает работать при
// следующей отправке/приёме.
```

**Обёртки (`src/ui/signals/chats.js`):** `deleteMessageForMeAction(ownerPubkey,
contactPubkey, msgId)`, `clearChatHistoryAction(ownerPubkey, contactPubkey)` —
тонкие обёртки, как остальные `*Action` в этом файле. Существующая
`deleteChatMessageAction` (удаление "у обоих") не меняется.

**UI (`src/ui/components/message-bubble.jsx`, `src/ui/screens/chat.jsx`):**
- `MessageBubble` — кнопка "Удалить" теперь показывается для ЛЮБОГО
  сообщения (не только `isOwn`, как было раньше). Клик открывает
  ЛОКАЛЬНОЕ состояние компонента (раскрывающийся выбор, без
  модалки/библиотеки — бюджет бандла): у своих сообщений — две кнопки
  ("Удалить у себя" / "Удалить у обоих"), у чужих — одна ("Удалить у
  себя"). Пропы `onDeleteForMe(msgId)` / `onDeleteForBoth(msgId)`
  (заменяют старый единственный `onDelete`).
- `ChatWindow` — новая кнопка в шапке "Очистить переписку" рядом с "←
  Назад", с подтверждением через `window.confirm` (единственный доступный
  диалоговый примитив без добавления UI-зависимостей) — необратимо и
  затрагивает ВСЮ локальную историю, обычный клик недостаточен.

Тесты: `tests/deletions.test.js` — `deleteMessageForMe` (удаляет чужое
ИЛИ своё сообщение локально, без публикации — publish не вызывается;
не найденный msgId — no-op, не бросает); `clearChatHistory` (удаляет
все сообщения owner+chatId, не трогает сообщения ДРУГОГО chatId и
ДРУГОГО owner — owner-scoping, тот же класс проверки, что и везде в
проекте с этапа 26).

## Этап 27-довесок-6 — редактирование сообщения

Пожелание пользователя (явно принято как сложное). Триаж 13a:
алгоритмическая задача — LWW-инвариант для конкурентных правок,
формализован в DESIGN.md ("Этап 27-довесок-6"). Обвязка по прямому
прецеденту `deletions.js`.

**Новый модуль `src/domain/messaging/edits.js`** (написан Claude
напрямую, не воркером — авторизационная логика поверх MLS-канала,
та же причина, что `deletions.js`):
```js
export function buildEditText(msgId, newText);
export function parseEditText(text);
// __ugolok_edit__: + JSON.stringify({msgId, text}) — JSON, не
// произвольная конкатенация (текст правки может содержать любые
// символы, включая ":"). parseEditText защищается от повреждённого/
// адверсарного JSON — try/catch -> null, не бросает.

export async function editMessage(ownerPubkey, privKey, contactPubkey, msgId, newText, lamportTs, publish);
// Авторизация — targetRow.senderPubkey === ownerPubkey (иначе throw
// "нельзя редактировать чужое сообщение", тот же паттерн, что
// deleteMessage). targetRow.deleted === true -> throw (нельзя
// редактировать удалённое). Публикует edit-маркер через sendMessage
// (тот же криптографический путь, что deleteMessage) И СИНХРОННО,
// ОПТИМИСТИЧНО обновляет СВОЮ строку (text/edited/editedAt) — не
// дожидаясь доставки, тот же UX, что мгновенное "Сообщение удалено"
// у deleteMessage.

export async function applyIncomingEditIfMarker(ownerPubkey, event, receivedResult);
// Вызывается ПОСЛЕ applyIncomingDeletionIfMarker в диспетчере
// transport.js (refreshGroupMessageSubscription, НЕ в
// syncMirroredHistory — та же уже принятая граница, что и delete).
// LWW: targetRow.editedAt !== undefined && targetRow.editedAt >=
// editLamportTs -> false (устаревшая правка, игнорируется), иначе
// применяет и возвращает true. targetRow.deleted -> false. !targetRow
// (правка раньше оригинала) -> false, тот же прецедент, что delete.
```

**`src/ui/signals/chats.js`**: `editChatMessageAction(ownerPubkey,
privKey, contactPubkey, msgId, newText, lamportTs, publish)` — тонкая
обёртка, как остальные `*Action`.

**Побочная находка (не баг, но пришлось решить, иначе редактирование
получало бы уродливый побочный эффект):** `sendMessage` (chat.js)
создаёт СОБСТВЕННУЮ строку `messages` на КАЖДОЕ отправленное
kind-445-сообщение, включая маркеры (delete/edit) — это уже
существовало для delete (DESIGN.md, "Этап 25", раздел 5,
"Явное упрощение MVP") и было явно оставлено как backlog
("Фильтрация маркерных строк из отображаемой истории — ответственность
UI"), но НИКОГДА не было реализовано. Без фильтрации редактирование
оставляло бы в истории ДВЕ строки: саму отредактированную (текст верно
обновлён — хорошо) И отдельную "сиротскую" строку с сырым JSON
маркера (плохо, хуже, чем непрочитанный тег на удалении, где хотя бы
оригинал превращается в чистый плейсхолдер). Исправлено ЗАОДНО с этой
задачей (маленький, самостоятельный фикс, тот же файл): `loadChatWindow`
(`src/core/sync/lazy-chat.js`) теперь отфильтровывает строки, чей
`text` распознаётся `parseDeletionText` ИЛИ `parseEditText`, ДО
сортировки/оконной нарезки (упрощает и `hasMore`/пагинацию — маркерные
строки больше не съедают место в окне `limit`).

**UI (`message-bubble.jsx`, `chat.jsx`):** `MessageBubble` — у своих
сообщений (не удалённых) добавлена кнопка "Редактировать", раскрывающая
инлайн `<textarea>` + "Сохранить"/"Отмена" (без модалки/библиотеки, тот
же принцип, что выбор удаления этапа 27-довесок-5). Отредактированное
сообщение помечается меткой "(изменено)" рядом со статусом (косметика,
из уже хранимого `edited`). `ChatWindow.handleEdit(msgId, newText)` —
валидирует `MAX_MESSAGE_LENGTH` (тот же лимит F-MS-08, что при отправке),
тикает `nextLamportTick()`, вызывает `editChatMessageAction`,
`reloadWindow()`.

Тесты: `tests/edits.test.js` (новый файл, по образцу
`deletions.test.js`) — round-trip маркера, применение своей правки
локально и мгновенно, LWW при неупорядоченной доставке (правка с
БОЛЬШИМ editLamportTs побеждает правку с меньшим независимо от порядка
прихода), отклонение правки на чужое сообщение (адверсарный сценарий,
как в deletions.test.js), отклонение правки на удалённое сообщение,
отклонение правки, пришедшей раньше оригинала. `tests/lazy-chat.test.js`
— маркерные строки (delete и edit) не попадают в `loadChatWindow`.

## Этап 27-довесок-7 — живая подписка на изменение профиля контакта

Пользователь сообщил: изменение био (уже исправленное этапом
27-довесок-3, `refreshProfiles`) видно только после ухода с экрана
"Контакты" и возврата — не появляется само на уже открытом экране.
Причина: `fetchProfiles`/`refreshProfiles` — ОДНОРАЗОВЫЙ REQ+EOSE
(kind 0), вызывается только в mount-эффектах (`[ownerPubkey]`,
`[contacts.value]`) — без перемонтирования компонента вызвать их
заново нечем.

**Правка (`src/ui/signals/transport.js`):**
```js
export async function refreshLiveProfileSubscription(ownerPubkey);
// Аналог refreshGroupMessageSubscription, но для kind 0: ПОСТОЯННАЯ
// подписка (не unsubscribe на EOSE) по {authors: contactPubkeys,
// kinds:[0]} — relay сначала отдаёт текущее состояние (REQ backlog),
// затем стримит НОВЫЕ kind-0 по мере публикации контактами. onBatch
// напрямую обновляет profiles.value (сигнал из signals/contacts.js,
// импортирован сюда — transport.js уже импортирует bumpMessagingActivity
// из chats.js, тот же класс межмодульной зависимости) + bumpMessagingActivity
// (этап 27, находка 2 — открытые экраны перечитывают profiles реактивно).
// Переподписка тем же subId идемпотентна (тот же приём, что
// groupMessageSubscriber.subscribe на каждую отправку) — вызывается
// повторно при добавлении нового контакта, подхватывает его в live-набор.
```
Вызывается: `contacts.jsx` (после `ensureConnected` на mount, и на
`[contacts.value]` — новый контакт), `chat.jsx` (`Chat()`, после
`ensureConnected`, чтобы список чатов тоже получал живые обновления
профиля, даже если "Контакты" ни разу не открывались в этой сессии).

Живая E2E-проверка (Playwright, 2 контекста): Алиса остаётся на
экране "Контакты" (НЕ переходит никуда, не перезагружает страницу),
Боб меняет био — новое био появляется у Алисы САМО в течение
нескольких секунд. Адверсарный контроль: тот же сценарий с
ЗАКОММЕНТИРОВАННЫМИ вызовами `refreshLiveProfileSubscription`
подтверждённо ПАДАЕТ (био не долетает) — тест не тривиален.

Regression: `npm test` 452/452 (transport.js не юнит-тестируется,
проверено только живым E2E — та же причина, что и предыдущие правки
этого файла). `npm run build` 223.50 КБ gzip.

## Этап 28 — Blossom-клиент + загрузка/скачивание файлов

TECH.md §13.8/§5.8 (F-AT-01..10). Скоуп по PLAN.md: только клиент +
крипто-обвязка + автомат состояния передачи — БЕЗ UI, БЕЗ превью/
голоса (thumbnails.js/voice.js/UI — этап 29), БЕЗ wiring в chat.js
(это F-AT-02, вложения в сообщениях — тоже этап 29, когда есть что
показать в UI).

### `src/domain/attachments/validation.js` (F-AT-04/05, рутина)

```js
export const ALLOWED_MIME_TYPES; // Set<string> — буквально список F-AT-05
export const MAX_IMAGE_FILE_SIZE = 20 * 1024 * 1024; // image И документы (F-AT-04: "image/file — 20 MB")
export const MAX_VIDEO_SIZE = 20 * 1024 * 1024;      // отдельная константа от image, хоть число то же —
                                                       // TECH.md перечисляет video отдельной строкой, оставляем
                                                       // раздельно настраиваемым на будущее
export const MAX_VOICE_SIZE = 3 * 1024 * 1024;       // audio — F-AT-04 "≤3 минуты, ≤3 MB на opus 96kbps"

export function validateAttachment({ mime, size }); // throw с понятным текстом при нарушении MIME
                                                       // ИЛИ размера; не throw -> файл допустим
```
Лимит размера выбирается по префиксу mime (`video/*` → MAX_VIDEO_SIZE,
`audio/*` → MAX_VOICE_SIZE, иначе — MAX_IMAGE_FILE_SIZE, включая
документы). MIME не в `ALLOWED_MIME_TYPES` — отказ независимо от
размера (AC-AT-05, `.exe` типично `application/x-msdownload`/
`application/octet-stream`, не в списке — отклоняется этой же
проверкой, без спецкейса под расширение файла).

### `src/core/transport/blossom-client.js` (F-AT-01/03/10, рутина)

По ПРЯМОМУ прецеденту `relay-pool.js`'s `options.WebSocketImpl ??
globalThis.WebSocket` — тот же приём для fetch, не новый стиль DI:
```js
export async function uploadBlob(serverUrl, encryptedBytes, sha256Hex, privKey, options = {});
// options.fetchImpl ?? globalThis.fetch. Собирает auth-событие kind 24242
// (F-AT-10): tags [["t","upload"],["x",sha256Hex],["expiration", String(now+300)]],
// content: "upload blob", подписывает privKey (sign() из core/crypto/sign.js).
// Authorization: `Nostr ${base64(JSON(event))}`. PUT {serverUrl}/upload,
// body=encryptedBytes. !response.ok -> throw с status+telом ответа.
// Возвращает response.json() как есть — {sha256, size, type, url} (F-AT-01),
// поля НЕ переименовываются на этом уровне (переименование в blossomUrl
// происходит на уровне upload.js, см. ниже).

export async function downloadBlob(serverUrl, sha256Hex, options = {});
// options.fetchImpl ?? globalThis.fetch. GET {serverUrl}/{sha256Hex} —
// БЕЗ Authorization (F-AT-10: "GET — без авторизации"). !response.ok -> throw.
// Возвращает Uint8Array (response.arrayBuffer()).
```
`expiration` — 300 секунд (5 минут): auth-событие одноразовое, живёт
ровно на время одного запроса, не переиспользуется и не хранится.

### `src/domain/attachments/upload.js` / `download.js` (F-AT-01/02/03, рутина)

```js
export async function uploadAttachment(serverUrl, fileBytes, { mime, name }, privKey, options = {});
// validateAttachment({mime, size: fileBytes.length}) -> encryptFile(fileBytes)
// (file-crypto.js, этап 10, {key, blob}) -> sha256Hex = bytesToHex(sha256(blob))
// (хэш ШИФРОТЕКСТА — то, что реально лежит на сервере и проверяется его
// же авторизацией, не хэш оригинала) -> uploadBlob(serverUrl, blob, sha256Hex, privKey, options).
// Возвращает дескриптор F-AT-02 буквально:
// {type, sha256, blossomUrl, encryptionKey, mime, size, name}
//   type — категория для UI (этап 29): "image"/"video"/"audio"/"file" по
//     префиксу mime, НЕ из ответа сервера (сервер про это не знает).
//   sha256/size — из ОТВЕТА сервера response.sha256, НЕ из локального
//     расчёта (сервер — источник истины по факту сохранённого; size —
//     размер ШИФРОТЕКСТА на сервере, не оригинала — то, что реально там лежит).
//   blossomUrl — serverUrl (параметр функции, НЕ response.url) — по
//     F-AT-03 буквально: "GET {blossomUrl}/{sha256}" требует БАЗОВЫЙ URL
//     сервера, конкатенация с уже полным response.url дала бы битый путь.
//   encryptionKey — base64(key) (F-AT-02 явно требует base64 для этого
//     поля, единственное отступление от hex-конвенции проекта — не
//     самодеятельность, буквально по спецификации).
//   mime/name — переданы как есть.

export async function downloadAttachment({ sha256, blossomUrl, encryptionKey }, options = {});
// downloadBlob(blossomUrl, sha256, options) -> ПРОВЕРКА ЦЕЛОСТНОСТИ:
// bytesToHex(sha256(blob)) === sha256 иначе throw ("Blossom-сервер вернул
// подменённые данные") — content-addressing существует ИМЕННО для того,
// чтобы клиент мог сам проверить, а не только полагаться на сервер;
// без этой проверки скомпрометированный/чужой Blossom-сервер мог бы
// молча подменить контент (найдено design-фазой, не адверсарным тестом
// постфактум — добавлено сразу, не задним числом). -> decryptFile(blob,
// decodeBase64(encryptionKey)) -> Uint8Array оригинала.
```

### `src/domain/attachments/transfer-machine.js` (TECH.md §9.4, ФОРМАЛИЗОВАНО В DESIGN.md ДО кода)

Прямой прецедент `domain/messaging/machine.js` (этап 24) — тот же
generic `core/fsm/machine.js`, буквально те же 5 переходов, что в
TECH.md §9.4, без единого отклонения/добавления:
```js
export const TRANSFER_TRANSITIONS; // ровно 5 переходов, см. DESIGN.md
export function transitionTransfer(state, event);
```
`completed` — терминальное состояние (нет исходящих переходов), как
`read`/`discarded` в message-machine.

### Явное сужение скоупа

Не в скоупе: превью изображений/постеры видео (F-AT-06/07, этап 29);
голосовые сообщения/inline ≤32KB (F-AT-08, этап 29); UI (file picker,
progress, voice-recorder — этап 29); список Blossom-серверов в
settings (F-AT-09, kind 30072 — этап 32, там же остальные настройки);
wiring дескриптора вложения в `chat.js`/rumor сообщения — тоже этап 29
(нет UI, некуда класть). Живая проверка против РЕАЛЬНОГО Blossom-
сервера НЕ проводилась — в отличие от strfry (relay), готового
Blossom-сервера в `server/` нет; протокольная корректность (формат
auth-события, заголовки, реконструкция URL) проверена интеграционным
тестом с ЛОКАЛЬНЫМ HTTP-сервером на `node:http` (реальный HTTP,
не мок объекта) — см. tests/blossom-client.test.js. Спросить
пользователя перед этапом 29/финалом, нужна ли живая проверка против
конкретной реализации Blossom-сервера.

### Адверсарная фаза (находка)

`serverUrl` с завершающим `/` (пользователь неизбежно введёт его то
с, то без — F-AT-09, ручной ввод списка серверов, этап 32) давал
`.../upload` → `...//upload` (двойной слэш) — часть Blossom-серверов
трактует это как ДРУГОЙ путь, не `/upload`. Исправлено:
`stripTrailingSlash()` в `blossom-client.js`, применяется к
`serverUrl` в обеих функциях перед конкатенацией пути. Тест —
`tests/blossom-client.test.js`.

## Этап 28-довесок — живой Blossom-сервер (по просьбе пользователя)

Пользователь спросил, можно ли развернуть Blossom-сервер локально,
как strfry, и запускать автоматически — да, развёрнуто. Выбрана
`sebdeveloper6952/blossom-server` (Go, BUD-01/02/04/06/08) — НЕ
официальный референс `hzrd149/blossom-server-ts` (проверено: помечен
`deprecated` на npm, тянет `sharp`/`better-sqlite3`/`minio` — нативная
сложность уровня strfry без её оправдания качеством; Go-вариант
собирается одной командой `go build`, без brew-дерева зависимостей
кроме самого `go`).

**Инфраструктура (`server/blossom/`, зеркалирует `server/strfry/`
буквально):** `setup.sh` (ставит `go` через brew при отсутствии,
клонирует, `CGO_ENABLED=1 go build -o bin/app ./cmd/api` — headless,
без Svelte admin UI, не нужна), `run.sh` (копирует версионируемый
`config.yml` в `blossom-src/config.yml` при КАЖДОМ запуске — у
сервера нет флага `--config`, путь фиксирован относительно cwd,
поэтому синхронизация конфига обязана происходить на каждый старт, не
один раз при setup), `config.yml` (`127.0.0.1:8080`, лимит 20 MB —
совпадает с `validation.js`, `ALLOW ALL` — permissive, тот же принцип,
что `strfry.conf`'s пустой `writePolicy.plugin`). `vite.config.js`:
`devBlossomPlugin()` — прямой аналог `devRelayPlugin()`, поднимает
сервер вместе с `vite dev`.

**Живая проверка (реальный сервер, не заглушка node:http из юнит-
тестов):**
- `uploadBlob`/`downloadBlob` — полный round-trip против реального
  запущенного сервера, ответ содержит настоящие `{sha256, size, type,
  url}` (плюс поля `uploaded`/`nip94`, которые клиент игнорирует —
  не в контракте F-AT-01, лишние поля ответа не ломают клиент).
- `uploadAttachment`/`downloadAttachment` — тот же round-trip через
  полный домен-слой (шифрование → загрузка → скачивание →
  расшифровка), дескриптор совпадает с ожидаемой формой.
- Адверсарный сценарий против РЕАЛЬНОГО сервера: заведомо неверный
  `x`-тег в auth-событии → сервер реально отвечает `400 {"message":
  "blob hash doesn't match auth event 'x' tag"}` → клиент корректно
  пробрасывает ошибку с текстом ответа.

Данные — `server/blossom/blossom-db/` (SQLite, блобы хранятся ВНУТРИ
базы, не отдельными файлами) — не версионируется, тот же принцип, что
`strfry-db/`.

## Этап 29 — Превью + голосовые + UI вложений

Пожелание пользователя (дословно): иконка прикрепления рядом с полем
ввода; картинка → превью + проверка размера + выбор "над/под
сообщением"; клик по картинке в бабле → модалка с кнопкой закрыть;
голосовое — запрос разрешения на микрофон, удобный интерфейс записи,
отмена/отправка, проигрывание сразу после отправки; видео и
музыка/аудио — встроенный проигрыватель; прочие файлы (документы,
таблицы, архивы) — иконка/текст типа + имя файла; таймstamp в
message-bubble. Библиотека плеера и лайтбокса — на моё усмотрение.

### Решение по бюджету (измерено, не гадание) — ПЛЕЕР

Пользователь предложил Plyr для видео/аудио. Проверено на реальной
сборке (временная установка + `npm run build`, не догадка):
- **Plyr 3.8.4 → +36.89 КБ gzip**.
- **media-chrome (минимальный набор: controller+play+time+mute+
  volume+fullscreen) → +33.02 КБ gzip**, из них **+21.54 КБ — база
  фреймворка ДО единой кнопки** (добавлена ради сравнения, не для
  использования).

Бюджет NF-11 (280 КБ) на момент проверки — 223.50 КБ, то есть всего
56.5 КБ запаса на ВСЕ оставшиеся этапы (29-32: каналы, посты,
комментарии, финальная полировка). Любая "единообразная" плеер-
библиотека съедает 55-65% этого запаса за ОДНУ фичу. Решение
пользователя (после предъявления цифр): **нативные `<video
controls>`/`<audio controls>` + собственный CSS** — 0 КБ прироста,
функционал (play/pause/перемотка/громкость/fullscreen) идентичен,
разница только в скине между браузерами (Chrome/Firefox/Safari) —
приемлемо для проекта с бюджетом жёстче большинства.

### Решение по МОДАЛКЕ для изображений — БЕЗ библиотеки

Требование пользователя: клик по картинке → модалка + кнопка
"закрыть" (никаких галерей/зума/свайпов не запрошено). Библиотека
уровня fancybox/lightbox/PhotoSwipe добавила бы вес, сравнимый с
плеер-библиотеками (тот же класс "разметка + анимации + a11y-
обвязка"), ради функционала, который заведомо покрывается ~40
строками Preact (fixed-overlay, `<img>`, кнопка закрытия, закрытие по
клику на фон/Escape). Решение — собственный компонент `image-
modal.jsx`, без зависимости.

### Решение по превью/thumbnails — СУЖЕНИЕ СКОУПА относительно PLAN.md

PLAN.md/TECH.md (F-AT-06/07) предполагали ОТДЕЛЬНЫЙ зашифрованный и
загруженный на Blossom объект-превью (max 400×700, canvas-resize) и
ОТДЕЛЬНЫЙ объект-постер видео — предназначение: получатель видит
маленькую копию, не скачивая оригинал целиком (экономия трафика).
Буквальный запрос пользователя ýже: "отобразить превью" относится к
ЛОКАЛЬНОМУ превью в момент прикрепления (до отправки), не к отдельному
загруженному объекту для получателя. Учитывая: (а) оригинал уже
ограничен 20 МБ (validation.js, этап 28), (б) проект разворачивается
в локальной сети, не публичный интернет (CLAUDE.md) — трафик-
экономия отдельного превью менее критична, чем для публичного SaaS,
(в) отдельный объект — это ВТОРАЯ загрузка/шифрование/дескриптор на
КАЖДОЕ изображение, весь этот путь пришлось бы тестировать и
поддерживать отдельно.

**Решение:** `thumbnails.js` НЕ создаётся — пустой модуль без
реальной логики хуже отсутствия файла. Компоновка превью —
`URL.createObjectURL(file)` (нативный браузерный API, 0 строк кода,
0 КБ) для локального превью до отправки; получатель просто скачивает
и показывает ОРИГИНАЛ (уже ограниченный 20 МБ), CSS ограничивает
отображаемый размер в бабле. Постер видео на стороне получателя —
`<video preload="metadata">` показывает первый кадр нативно, без
загрузки отдельного постера. Явное отступление от PLAN.md, записано
здесь как решение, не забыто.

### Модель данных — расширение контракта `chat.js` (ПРАВКА, не новый файл)

`sendMessage`/`receiveGroupMessageEvent`/`upsertMessage` (этапы 22/24,
уже принятый контракт) — правка вносится Claude напрямую (skill,
п.12: "правка контрактов прошлых этапов — только Claude, с немедленной
полной регрессией"), не воркером.

**Новое поле `sentAt`** (секунды unix-времени, `Math.floor(Date.now()/
1000)`) — генерируется автором при отправке, передаётся в JSON-
полезной нагрузке ТАК ЖЕ, как `msgId`/`lamportTs` — обе стороны видят
ОДИНАКОВОЕ время "отправлено", не время получения. `lamportTs`
(логические часы, порядок сортировки) НЕ трогается — назначение
разное, смешивать нельзя.

**Новое поле `attachment`** (опционально, `undefined` для обычных
текстовых сообщений — обратная совместимость, старые сообщения без
поля продолжают работать):
```js
attachment = {
  type,               // "image" | "video" | "audio" | "file" — как upload.js (этап 28)
  sha256, blossomUrl, encryptionKey, mime, size, name,  // F-AT-02, как есть из upload.js
  position,           // "above" | "below" — ТОЛЬКО для type==="image", относительно текста
  voice,              // true — ТОЛЬКО для голосовых (запись с микрофона, не выбор файла)
  voiceInline,        // base64 raw webm/opus — ТОЛЬКО когда voice===true И raw≤32КБ
                       // (F-AT-08/AC-AT-03b); ВЗАИМОИСКЛЮЧАЮЩЕ с sha256/blossomUrl/
                       // encryptionKey/size — inline-голосовое НИКОГДА не грузится на
                       // Blossom вообще, эти поля просто отсутствуют.
}
```
`sendMessage(ownerPubkey, privKey, contactPubkey, text, lamportTs, publish, attachment)` —
новый 7-й параметр, необязательный (`undefined` по умолчанию — старые
вызовы без изменений). `text` может быть пустой строкой, если есть
`attachment` (сообщение "только картинка/голосовое", без подписи) —
проверка "непустое сообщение" при отправке переносится на UI-уровень
(`chat.jsx`): разрешить отправку, если ЛИБО текст непустой, ЛИБО есть
вложение.

### `src/domain/attachments/voice.js` (F-AT-08/AC-AT-03b)

```js
export const VOICE_INLINE_MAX_BYTES = 32 * 1024; // F-AT-08

export function shouldInlineVoice(rawByteLength);
// rawByteLength <= VOICE_INLINE_MAX_BYTES -> true (inline), иначе false (через Blossom).
// ЧИСТАЯ функция — юнит-тестируется без DOM, включая граничное значение AC-AT-03b
// (ровно 32768 байт -> true).

export function createVoiceRecorder(options = {});
// options.MediaRecorderImpl ?? globalThis.MediaRecorder,
// options.getUserMediaImpl ?? navigator.mediaDevices.getUserMedia — тот же приём DI,
// что relay-pool.js/blossom-client.js (options.XImpl ?? globalThis.X).
// Возвращает { start(): Promise<void>, stop(): Promise<Blob>, cancel(): void }.
// start() — запрашивает разрешение на микрофон (getUserMedia({audio:true})), создаёт
// MediaRecorder(stream, {mimeType: 'audio/webm;codecs=opus'}), начинает запись.
// stop() — останавливает запись, ОСТАНАВЛИВАЕТ ТРЕКИ МИКРОФОНА (stream.getTracks().
// forEach(t=>t.stop()) — иначе браузер держит иконку "микрофон активен" бесконечно,
// найдено design-фазой, не постфактум), резолвится собранным Blob.
// cancel() — то же самое (останавливает MediaRecorder и треки микрофона), но
// отбрасывает записанные chunks — Blob не собирается, промис start() что вызвал
// stop() не задействуется (вызывающий код просто не отправляет).
// MediaRecorder/getUserMedia — браузерные API, не юнит-тестируются в node:test без
// DOM — проверяется живым Playwright (--use-fake-device-for-media-stream, реальный
// синтетический аудиопоток, не мок объекта).
```

### Конфигурация — `BUILD_DEFAULT_BLOSSOM_SERVERS` (src/config.js, vite.config.js)

По прямому прецеденту `BUILD_DEFAULT_RELAYS`/`buildDefaultRelays()`
(этап 16): без НИКАКОГО способа сослаться на URL сервера вложения
не отправить в принципе — список серверов в settings (F-AT-09) только
в этапе 32, поэтому сейчас нужен тот же паттерн "dev — локальный,
прод — плейсхолдер, обязана переопределить конфигурация деплоя":
```js
// config.js
export const BUILD_DEFAULT_BLOSSOM_SERVERS = typeof __BUILD_DEFAULT_BLOSSOM_SERVERS__ !== "undefined"
  ? __BUILD_DEFAULT_BLOSSOM_SERVERS__ : [];
// vite.config.js — buildDefaultBlossomServers(command), тот же приём, что
// buildDefaultRelays: env override -> иначе dev: ["http://127.0.0.1:8080"]
// (server/blossom/, довесок этапа 28), прод: ["https://blossom.example"] (плейсхолдер).
```

### UI (`chat.jsx`, `message-bubble.jsx`, новые компоненты)

- **`src/ui/components/image-modal.jsx`** (новый) — полноэкранный
  оверлей, кнопка "Закрыть", закрытие по клику на фон и по Escape.
- **`src/ui/components/attachment-preview.jsx`** (новый) — превью
  ВЫБРАННОГО, ещё НЕ отправленного файла: для image — `<img>` от
  `URL.createObjectURL`, переключатель позиции (радио "Над
  сообщением"/"Под сообщением"); для остальных типов — иконка/текст
  типа + имя файла + размер; кнопка "Убрать".
- **`chat.jsx`** — кнопка "📎" (скрытый `<input type=file>`), кнопка
  "🎤" (запуск `createVoiceRecorder`), состояние записи (таймер,
  Отмена/Остановить), состояние "голосовое записано, не отправлено"
  (проигрывание нативным `<audio>` + Отправить/Отменить). `handleSend`
  расширен: если есть `attachmentFile` — `validateAttachment` →
  `uploadAttachment(blossomServerUrl, bytes, {mime,name}, privKey)` →
  дескриптор с `position` (если image); если есть голосовой Blob —
  `shouldInlineVoice` решает inline (base64) или тоже
  `uploadAttachment`. Кнопка "Отправить" разблокирована, если текст
  ИЛИ вложение непусты (было — только текст).
- **`message-bubble.jsx`** — таймstamp (`sentAt`, человекочитаемое
  локальное время) рядом со статусом; рендер по `attachment.type`:
  image — `<img>` (позиция `attachment.position` — до/после `<p>`
  текста), клик открывает `image-modal.jsx` (сначала скачивает+
  расшифровывает через `downloadAttachment`, показывает spinner на
  время загрузки); video — `<video controls preload="metadata">`;
  audio/voice — `<audio controls>`; file — иконка (по `mime`/
  расширению) + имя + размер + ссылка на скачивание (расшифровывает
  во blob URL по клику, не заранее — не скачивать всё молча).

### Явное сужение скоупа

Не в скоупе: отдельные загруженные thumbnail/poster-объекты (см.
решение выше); список Blossom-серверов в settings (F-AT-09, этап 32
— сейчас используется `BUILD_DEFAULT_BLOSSOM_SERVERS[0]` напрямую);
редактирование ВЛОЖЕНИЯ уже отправленного сообщения (пользователь не
просил — редактирование текста уже есть с этапа 27-довесок-6, на
вложение не распространяется); раздел "мои файлы" с папками/
режимами отображения (пользователь явно отметил "не сейчас", задел на
будущее — модель дескриптора вложения уже переиспользуема оттуда).

### Реализация и проверка (закрытие этапа)

`voice.js` — воркер, с первого захода все 11 тестов зелёные
(shouldInlineVoice чистая + createVoiceRecorder на застабленных
MediaRecorder/getUserMedia, глобальный `Blob` в Node 24 достаточен для
юнит-теста сборки chunks без DOM). `image-modal.jsx`/`attachment-
preview.jsx`/`attachment-view.jsx` написаны напрямую (небольшие, но
`attachment-view.jsx` вынесен в отдельный переиспользуемый компонент —
задел на будущий раздел "мои файлы", та же отрисовка по `type`).
`chat.jsx`/`message-bubble.jsx` — напрямую, по прецеденту "Уроки"
(крупные JSX с межшаговым состоянием воркер регулярно ломает).

Живая E2E-проверка (Playwright, `--use-fake-device-for-media-stream`
+ `--use-fake-ui-for-media-stream` — РЕАЛЬНАЯ запись с синтетического
микрофона, не мок MediaRecorder):
- картинка с `position="above"` — видна в бабле, клик открывает
  модалку, кнопка "Закрыть" реально закрывает; ОТДЕЛЬНО проверен DOM-
  порядок для `position="below"` (`<p>` перед `<img>`).
- голосовое — запись, локальное прослушивание ПЕРЕД отправкой
  (`<audio>` с валидным src уже в момент "recorded"), у получателя
  плеер со своим src.
- видео — ленивая загрузка (плейсхолдер с кнопкой "Воспроизвести" →
  `<video>` появляется только после клика).
- файл-документ — имя, размер, кнопка "Скачать".
- таймstamp — паттерн `HH:MM` присутствует в отрисованном бабле.

Адверсарная фаза: файл 25 МБ — `AttachmentPreview` показывает ошибку
размера, кнопка "Отправить" остаётся заблокированной, вложение НЕ
отправляется; `.exe` (`application/x-msdownload`) — отклонён по MIME
той же проверкой. Оба сценария проверены живьём в UI, не только
`validateAttachment()` напрямую (уже покрыто этапом 28).

Regression: `npm test` 493/493. `npm run build` 226.99 КБ gzip
(было 223.50, +3.49 КБ на всю фичу целиком — 53.01 КБ остаётся до
лимита NF-11 на этапы 30-32).

## Этап 29-довесок — лимиты 50 МБ (видео/аудио) + прелоадер загрузки

Пользователь: лимиты малы (video/audio были 20 МБ/3 МБ), поднять до
50 МБ; при загрузке вложения показывать прелоадер.

**Лимиты** (`src/domain/attachments/validation.js`): `MAX_VIDEO_SIZE`
и `MAX_VOICE_SIZE` (последний покрывает ВЕСЬ `audio/*` — и голосовые,
и музыкальные файлы, одна константа с этапа 28) — оба подняты до
50 МБ. `MAX_IMAGE_FILE_SIZE` (изображения/документы) НЕ тронут —
пользователь просил только видео/музыку.

**Серверный потолок** (`server/blossom/config.yml`,
`max_upload_size_bytes`) поднят СИММЕТРИЧНО до 55 МБ (50 МБ клиента +
запас) — иначе клиент пропускал бы файл локально, а сервер отклонял
бы его уже ПОСЛЕ шифрования (хуже UX, чем отказ сразу). Дублирование
лимита между клиентом и сервером остаётся сознательным
(defense-in-depth, см. этап 28) — сервер по-прежнему не источник
истины для клиентских лимитов, только НЕ должен быть строже них.
Живая проверка: 30 МБ blob реально принят работающим сервером
(превышало бы старый потолок 20 МБ и на клиенте, и на сервере).

**Прелоадер** — CSS-спиннер (`.spinner` + `@keyframes spin`,
`src/styles/minimal.css`, слой utilities) без библиотеки:
`border-top-color` отличается от остального бордера, вращение через
`animation`; `prefers-reduced-motion` уже глушит анимацию глобально
(существующий override внизу файла, ничего не потребовалось менять).
Используется в четырёх местах: `chat.jsx` (статус "Загрузка
вложения…" при отправке), `attachment-view.jsx` (загрузка картинки/
аудио — текст; видео/файл — внутри кнопки "Воспроизвести"/"Скачать"
на время загрузки).

Живая E2E-проверка: видео 30 МБ (симулирует файл, который раньше
превышал бы лимит) — не отклонено на клиенте, спиннер виден во время
шифрования+загрузки, сообщение доходит до собеседника и корректно
отображается (ленивая загрузка с кнопкой "Воспроизвести", как и
раньше).

Regression: `npm test` 493/493 (обновлены 2 теста в
`attachments-validation.test.js` — старые лимиты 3 МБ/20 МБ заменены
на 50 МБ). `npm run build` 227.12 КБ gzip (+0.13 КБ — CSS-спиннер,
без новых зависимостей).

## Этап 30 — Каналы: создание + группы-видимость + VIEW/подписка + навигация

### Разрешённый архитектурный конфликт

Пользователь предоставил детальное ТЗ на функциональность каналов
("версия 0.1"), но описанная там архитектура — звёздчатая топология
(участник → владельцу → владелец вручную релеит всем, контент
шифруется только "для себя" at rest, по сети — plaintext) —
несовместима с тем, что уже построено в этом проекте с самого начала
(TECH.md §4.7/§5.9: relay-broadcast, сквозное шифрование channelKey,
offline-first — работает без участия владельца онлайн). Решение
пользователя (после предъявления конфликта): функциональность/UX —
из ТЗ, архитектура — уже принятая (relay-broadcast). Объём вырос
кратно относительно исходных 3 этапов (30-32) — переразбит на 5
(30-34, см. PLAN.md). Этот этап — первый из пяти: создание канала,
видимость по группам контактов, различение VIEW/COMMENT
("Доступные"/"Подписки"), навигация. Посты/комментарии — этап 31
(уже планировался); общий чат канала — этап 32 (новое); модерация
(жалобы/бан/игнор/rate-limit) — этап 33 (новое); настройки/финал —
этап 34 (было 32).

### Найденный пробел и правка контракта (DESIGN.md, формализация 1)

TECH.md §10 буквально: kind 30060 (метаданные канала) — "NIP-44 для
себя", читает только владелец. Не даёт способа для VIEW-получателей
узнать имя/описание/правила/аватар канала — необходимо для
"Доступные"/"Подписки". **Правка:** kind 30060 шифруется
`channelKey[v_current]` (тот же версионированный конверт, что посты,
F-CH-03), остаётся replaceable — владелец переиздаёт при
редактировании БЕЗ повторной раздачи ключей. kind 30053 несёт ТОЛЬКО
ключевой материал (`channelId`, `channelTopic`, `channelKey`), не
метаданные — единственный источник истины для метаданных — kind
30060.

### `src/core/crypto/channel-key.js`

```js
export function generateChannelKey(); // Uint8Array(32), crypto.getRandomValues
export function generateChannelTopic(); // Uint8Array(16), crypto.getRandomValues — routing tag #channel

export function encryptChannelKeyGrant(channelId, channelTopicHex, channelKeyHex, ownerPrivKey, readerPubkey);
// NIP-44(JSON({channelId, channelTopic: channelTopicHex, channelKey: channelKeyHex}), ownerPrivKey, readerPubkey)
// -> строка content для kind 30053. ТОЛЬКО ключевой материал (см. правку выше).

export function decryptChannelKeyGrant(content, readerPrivKey, ownerPubkey);
// NIP-44.decrypt(content, readerPrivKey, ownerPubkey) -> JSON.parse -> {channelId, channelTopic, channelKey}
// Повреждённый/чужой контент -> throw (вызывающий код решает, отбросить событие или нет).

export function encryptChannelContent(plaintext, channelKeyHex, version);
// base64(uint32BE(version) ‖ nonce(12) ‖ ChaCha20-Poly1305(utf8(plaintext), key, nonce)) — F-CH-03
// буквально, версия — заголовок конверта, не часть JSON-плейнтекста.

export function decryptChannelContent(base64Content, channelKeysByVersion);
// channelKeysByVersion: Map<number, hexString> ИЛИ {[version]: hexString}.
// Читает version из заголовка, берёт channelKeysByVersion[version]; версия неизвестна
// (никогда не было VIEW на эту эпоху) -> return null, НЕ throw (тот же принцип, что
// receiveGroupMessageEvent -> null на "не наша группа", не exception на каждое чужое событие).
// Иначе -> строка plaintext.
```

### `src/core/crypto/comment-allowlist.js`

```js
export function buildAllowlistEvent(channelId, channelTopicHex, version, allowedAuthors, channelKeyHex, ownerPrivKey);
// kind 30054, tags: [['d', opaqueDTag(masterSecret, 30054, channelId+':'+version)], ['channel', channelTopicHex]]
// (тот же HMAC-обфусцированный d-tag, что TECH.md §4.8 — но masterSecret передаётся
// вызывающим кодом, этот модуль masterSecret не хранит и не деривирует сам).
// content: encryptChannelContent(JSON.stringify({channelId, version, allowedAuthors}), channelKeyHex, version)
// подписывается ownerPrivKey (sign() из core/crypto/sign.js).

export function parseAndVerifyAllowlist(event, channelKeyHex, expectedOwnerPubkey);
// event.pubkey !== expectedOwnerPubkey -> return null (allowlist не владельцем — F-EV-07 аналог)
// иначе decryptChannelContent(event.content, {[version]: channelKeyHex}) -> JSON.parse
// -> {version, allowedAuthors} или null при любой неудаче (не throw — злонамеренное
// событие должно тихо отбрасываться, F-EV-06 принцип).

export function canAuthorComment(authorPubkey, verifiedAllowlist);
// verifiedAllowlist === null -> false; иначе authorPubkey ∈ allowlist.allowedAuthors.
```

### `src/domain/content/channel-access.js` (VIEW/COMMENT протокол)

```js
export const CHANNEL_SUBSCRIBE_REQUEST_KIND = 3002; // новый rumor kind, по прецеденту
// CONTACT_REQUEST_KIND=3001 (contacts/requests.js) — gift-wrap (kind 1059), не публичный.

export async function sendViewGrant(ownerPubkey, ownerPrivKey, channel, readerPubkey, publish);
// channel: {channelId, channelTopic (hex), channelKey (hex)}. Строит kind 30053
// (encryptChannelKeyGrant + sign), tags: [['p', readerPubkey]], publish. НЕ проверяет
// "уже был грант этому reader" — идемпотентно на уровне relay (повторная публикация
// того же гранта безвредна), проверка "уже подписан" — на уровне вызывающего кода
// (channel.js), не здесь.

export function buildSubscribeRequestRumor(channelId);
// { kind: CHANNEL_SUBSCRIBE_REQUEST_KIND, content: '', tags: [['channel_id', channelId]],
//   created_at: now } — по прецеденту buildContactRequestRumor (requests.js).

export async function sendSubscribeRequest(requesterPrivKey, ownerPubkey, channelId, publish);
// nip59Wrap(buildSubscribeRequestRumor(channelId), requesterPrivKey, ownerPubkey) -> publish.

export async function handleIncomingSubscribeRequest(ownerPubkey, ownerPrivKey, channelId, requesterPubkey, publish);
// Владелец: читает текущий channelKeyMeta/commentAllowlists (владелец САМ хранит и
// поддерживает allowlist, он же его подписывает) для channelId у СЕБЯ; если
// requesterPubkey уже в списке — no-op (идемпотентно); иначе — новый allowedAuthors
// (та же ВЕРСИЯ channelKey — COMMENT не ротирует ключ, F-CH-05), buildAllowlistEvent,
// sign, publish. НЕ проверяет, что requesterPubkey реально имеет VIEW (доверяет
// прикладному вызову — group-видимость уже была решением владельца; злонамеренный
// requester без VIEW всё равно не сможет РАСШИФРОВАТЬ канал, allowlist только про
// право ПИСАТЬ, симметрично F-CH-05).
```

### `src/domain/content/channel.js` (создание, локальные списки, приём событий)

```js
export async function createChannel(ownerPubkey, ownerPrivKey, {name, description, rules, avatarDescriptor}, groupIds, publish);
// groupIds: string[] (ID контакт-групп, groups.js). Резолвит -> Set<pubkey> (объединение
// groupMembers всех groupIds, дедуп). Генерирует channelKey/channelTopic (v=1),
// публикует kind 30060 (метаданные, channelKey-зашифрованные), персистит channels
// {role:"owner"} + channelKeys[v=1] + channelKeyMeta{currentVersion:1} локально у
// СЕБЯ, ЗАТЕМ sendViewGrant КАЖДОМУ pubkey из Set (пустой Set -> ни одного гранта,
// канал остаётся сугубо локальным "заметочником", буквально по ТЗ). Возвращает
// {channelId}.

export async function listOwnedChannels(ownerPubkey);
export async function listSubscribedChannels(ownerPubkey);
export async function listAvailableChannels(ownerPubkey);
// Все три — db.table('channels').where('ownerPubkey').equals(ownerPubkey), фильтр по
// полю role ("owner"/"subscriber"/"available" соответственно).

export async function receiveChannelKeyGrant(ownerPubkey, readerPrivKey, channelOwnerPubkey, event);
// decryptChannelKeyGrant(event.content, readerPrivKey, channelOwnerPubkey) -> throw
// перехватывается ВЫЗЫВАЮЩИМ кодом (transport.js, тот же принцип, что остальные live-
// подписки — сбой одного события не роняет батч), не здесь. Персистит channelKeys/
// channelKeyMeta; если локальной записи channels для этого channelId ЕЩЁ нет — создаёт
// с role:"available", creatorPubkey: channelOwnerPubkey; если УЖЕ есть (повторный
// грант/новая эпоха после revoke) — обновляет channelKeys, роль НЕ понижает.

export async function receiveChannelMetadata(ownerPubkey, event);
// kind 30060 — decryptChannelContent через уже известные channelKeys данного канала
// (находится по channelTopic из тега #channel); null (эпоха неизвестна) -> no-op, не
// наш канал ещё/уже. Обновляет name/description/rules/avatar в локальной строке
// channels (upsert полей, роль не трогает).

export async function receiveAllowlistUpdate(ownerPubkey, myPubkey, event);
// kind 30054 — parseAndVerifyAllowlist; myPubkey ∈ allowedAuthors И текущая локальная
// роль НЕ "owner" -> апгрейд role "available"->"subscriber" (владелец не апгрейдится
// сам себе, он и так полный доступ имеет). Персистит commentAllowlists (верифицированный
// кэш) — используется ПОЗЖЕ (этап 31) для проверки авторства входящих комментариев.

export async function subscribeToChannelAction(ownerPubkey, ownerPrivKey, channelId, publish);
// Тонкая обёртка — читает channelOwnerPubkey из локальной строки channels, зовёт
// sendSubscribeRequest (channel-access.js).
```

### Схема БД — `db.version(5)`, owner-scoping (найдено рассуждением, см. DESIGN.md)

`channels`/`channelKeys`/`channelKeyMeta`/`commentAllowlists` в
`db.version(1)` объявлены БЕЗ `ownerPubkey` — тот же класс пробела,
что уже исправлен для messages/mlsGroups/ownKeyPackage/chatSyncState
(этапы 25-27). Никогда не использовались кодом — правка без риска
миграции. `channelTopics` (отдельная таблица) сворачивается в поле
`channels.channelTopic` — та же информация, не нужна отдельная
таблица.

### Навигация

`src/ui/nav-items.js`: `{ id: "subscriptions", label: "Подписки" }` →
`{ id: "channels", label: "Каналы" }`. `src/ui/screens/channels.jsx`
(новый) — 3 вкладки (Мои каналы/Подписки/Доступные) + кнопка
"Создать канал" (форма: имя/описание/правила/аватар/чекбоксы групп) +
кнопка "Подписаться" на карточках "Доступные".

### Явное сужение скоупа

Отзыв VIEW после создания; редактирование метаданных после создания
(kind 30060 дешёво переиздать, но UI — этап 31, экран канала);
resize аватара 200×200 (грузится как есть через `uploadAttachment`,
canvas-resize — backlog polish, единичная операция на канал, не
поток); посты/комментарии/чат/модерация — этапы 31-33.

### Найденная живым прогоном протокольная ошибка — правка контракта TECH.md

TECH.md §4.7/§4.8/§5.9 буквально предлагал многобуквенный тег
`#channel` для маршрутизации по `channelTopic` (kind 30060/30061/
30062/30054). Первый живой E2E-прогон (два реальных браузерных
контекста + настоящий strfry) показал: metadata/allowlist никогда не
доходят до получателя — VIEW-грант (kind 30053, тег `#p`, однобуквенный)
доставляется штатно, а подписка `{"#channel": [...]}` относительно
`h-` тега молча не даёт результатов. Прямая проверка сырым WebSocket-
запросом к strfry подтвердила причину: `strfry` вернул `CLOSED
"ERROR: bad req: error parsing #channel: unindexed tag filter"` —
**NIP-12 индексирует и делает queryable ТОЛЬКО однобуквенные теги**
(`a-zA-Z`), многобуквенные теги (`channel`) relay не индексирует и не
обязан обслуживать по спецификации. Это ошибка в самой TECH.md
спецификации (написана до эмпирической проверки против реального
relay), не в реализации.

**Правка:** маршрутизирующий тег для kind 30060/30061/30062/30054 —
`h` (не `channel`) — тот же однобуквенный routing-принцип, что уже
используется для MLS-групп (kind 445, `h`-тег с этапа 24). Естественное
расширение уже принятого паттерна на новый класс контента, не новая
концепция. Затронуты: `channel.js` (kind 30060, тег при публикации и
при чтении), `comment-allowlist.js` (kind 30054), `transport.js`
(фильтр подписки `refreshChannelContentSubscription`). Тесты обновлены
(`comment-allowlist.test.js`). TECH.md остаётся историческим
документом замысла (не переписан построчно), правка зафиксирована
здесь и в log.md — по прецеденту всех предыдущих отклонений от
исходной спецификации в проекте.

## Этап 31 — Посты + комментарии + lazy-load канала

### `src/domain/content/post-machine.js`

```js
export const POST_TRANSITIONS = {
  draft: { PUBLISH: "published" },
  published: { ARCHIVE: "archived", UNPUBLISH: "draft" },
};
export function transitionPost(state, event); // transition() из core/fsm/machine.js, этап 14
```

### `src/domain/content/post.js`

```js
export async function createDraftPost(ownerPubkey, channelId, { text, attachments });
// Локальная запись ТОЛЬКО (status:"draft") — НИЧЕГО не публикуется (DESIGN.md,
// формализация 1: черновик не должен утекать на relay до PUBLISH). postId =
// crypto.randomUUID(). attachments — до 10 дескрипторов (upload.js, этап 28/29),
// validateAttachment уже применена на уровне UI при выборе файла. Возвращает {postId}.

export async function publishPost(ownerPubkey, ownerPrivKey, postId, publish);
// transitionPost(текущий статус, "PUBLISH") — бросает на недопустимый переход
// (already published без UNPUBLISH сначала и т.п., generic FSM уже это даёт).
// Шифрует channelKey[v_current] СВОЕГО канала (владелец всегда знает актуальный клюx),
// публикует kind 30061: d-tag = `${channelId}:${postId}` (НЕ opaque, TECH.md §4.8),
// тег `h` = channelTopic (routing, этап 30-довесок фикс). Локально: status="published".

export async function archivePost(ownerPubkey, ownerPrivKey, postId, publish);
export async function unpublishPost(ownerPubkey, ownerPrivKey, postId, publish);
// Оба — republish ТОГО ЖЕ d-tag с обновлённым status в payload (DESIGN.md,
// формализация 1) — параметризованно-replaceable событие заменяет предыдущую версию.

export async function deletePost(ownerPubkey, ownerPrivKey, postId, publish);
// F-CH-10 — kind 5 (NIP-09) на id последней опубликованной версии события; локально
// deleted:true. Черновик (никогда не публиковался) — просто локальное удаление
// строки, kind 5 не нужен (нечего отзывать на relay).

export async function receivePost(ownerPubkey, event);
// DESIGN.md, формализация 2 (найденная адверсарная угроза) — event.pubkey ДОЛЖЕН
// совпадать с channelRow.creatorPubkey, иначе discard (return false), НЕЗАВИСИМО от
// того, что контент корректно расшифровывается (любой VIEW-держатель технически может
// зашифровать валидный kind 30061 тем же channelKey — авторство поста не то же самое,
// что владение ключом). Канал/эпоха неизвестны -> discard. Иначе upsert локальной
// строки posts (d-tag даёт postId), return true.

export async function listChannelPosts(ownerPubkey, channelId); // без пагинации —
// см. lazy-channel.js для windowed-версии (F-CSC-01); эта — простой список для
// случаев, где окно не нужно (напр. подсчёт для UI).
```

### `src/domain/content/comments.js`

```js
export async function addComment(ownerPubkey, ownerPrivKey, channel, postId, parentId, text, attachments, publish);
// channel: {channelId, channelTopic, channelKey (текущая версия — только владелец
// или подписчик с COMMENT могут вызывать, но эта функция НЕ проверяет права заранее:
// сеть/allowlist на приёмной стороне — источник истины, локальная проверка была бы
// просто UX-подсказкой, добавлена в UI-слое, не здесь). parentId — postId (комментарий
// верхнего уровня) ИЛИ commentId (ответ на комментарий), вложенность произвольная.
// commentId = crypto.randomUUID(). kind 30062, d-tag = `${postId}:${commentId}`
// (не opaque), тег `h` = channelTopic. Локально upsert в comments сразу (оптимистично,
// как chat.js). До 4000 символов/5 вложений — проверка на UI-уровне (как MAX_MESSAGE_LENGTH).

export async function receiveComment(ownerPubkey, event);
// DESIGN.md, формализация 3 (F-EV-06) — канал/эпоха неизвестны -> discard. Иначе
// decryptChannelContent -> canAuthorComment(event.pubkey, локальный кэш
// commentAllowlists[текущая версия]) -> false -> discard (return false), НЕ throw:
// малициозный VIEW-держатель без COMMENT — рутинный случай в потоке, не исключение.
// true -> upsert локальной строки comments, return true.

export async function getCommentsTree(ownerPubkey, postId);
// Плоский список из comments (по postId) -> buildTree: группировка по parentId,
// корень — записи с parentId===postId. Возвращает [{...comment, replies: [...]}].
```

### `src/core/sync/lazy-channel.js` (F-CSC-01)

```js
export async function loadPostsWindow(ownerPubkey, channelId, { limit = 10, beforeCreatedAt } = {});
// Аналог loadChatWindow (этап 25) — сортировка по createdAt (один автор — простая
// хронология, Lamport не нужен). Возвращает published+archived (черновики ЧУЖИЕ не
// видны вовсе — не upsert'ятся получателем; СВОИ черновики — отдельный запрос
// listChannelPosts с фильтром status==="draft", не через это окно).

export async function loadCommentsWindow(ownerPubkey, postId, { limit = 50, beforeCreatedAt } = {});
// Тот же принцип, до 50 за раз (пользовательское ТЗ).
```

### Wiring — `transport.js`

`refreshChannelContentSubscription` расширяется: `kinds: [30060, 30054,
30061, 30062]` (было только 30060/30054) — тот же фильтр `{"#h":
topics}`, тот же диспетчер, ветки `receivePost`/`receiveComment`
добавляются рядом с уже существующими.

### Схема БД — `db.version(6)`, owner-scoping (DESIGN.md)

`posts`/`comments` в `db.version(1)` были объявлены без `ownerPubkey`
— никогда не использовались кодом, переопределение без риска
миграции (тот же прецедент, что channels/channelKeys этапа 30).

### Явное сужение скоупа

Экран канала целиком (владелец-only вкладки — этапы 32-33); общий
чат канала (этап 32); редактирование ОПУБЛИКОВАННОГО поста как
отдельная функция (UNPUBLISH+редактирование локально+PUBLISH заново
уже даёт этот эффект, отдельная "кнопка редактировать" — backlog);
удаление одного комментария в UI (F-CH-10 покрывает оба случая
одинаково на уровне домена, но кнопка в интерфейсе — только у постов
в этом этапе).

### Подтверждено живым прогоном — видимость по группе снимается ОДИН РАЗ, при создании

`createChannel` резолвит членов выбранных групп В МОМЕНТ создания
канала — добавление контакта в уже используемую для видимости группу
ПОСЛЕ создания канала НЕ выдаёт ему VIEW задним числом (симметрично
уже принятому "отзыв VIEW после создания — не в скоупе", этап 30).
Найдено и подтверждено ИМЕННО живым E2E при подготовке адверсарного
сценария (не домысел): тестовый сценарий пришлось перестроить — Mallory
добавлена в группу ДО создания канала, иначе она не видит канал вовсе,
даже "Доступные" пусто. Это ожидаемое поведение снимка-при-создании,
не баг, но заслуживает явной фиксации здесь, раз найдено практикой.
Живое повторное приглашение (пересканировать группу и разослать
недостающие гранты) — backlog, тот же класс, что revoke.

## Этап 32 — Общий чат канала

Рутина (PLAN.md-триаж): переиспользует ту же broadcast-схему, что
посты/комментарии (channelKey-шифрование, `#h`-роутинг, replaceable
d-tag), не новый примитив — DESIGN.md-формализация не требуется.
Новый kind 30063 (следующий свободный в диапазоне 30060-30069,
parameterized-replaceable, тот же класс, что 30061/30062).

### Разрешение вложений в чате — расширение метаданных канала

ТЗ: "вложения только если владелец разрешил в настройках канала".
Поле `allowChatAttachments` (boolean, default `true`) добавляется в
payload kind 30060 (рядом с name/description/rules/avatar) и в
`channels`-строку — тот же канал передачи, что уже несёт остальные
метаданные, отдельного события не требуется. `createChannel` принимает
его в объекте опций; `CreateChannelForm` — чекбокс (по умолчанию
отмечен). Редактирование после создания — часть Этапа 34 (настройки),
не в этом этапе.

**Решение (не security-инвариант, UX/политика):** проверка на
отправке — только подсказка в UI (кнопка "📎" не рендерится, если
`!channelRow.allowChatAttachments`), как и везде в проекте источник
истины — приёмная сторона. На приёме, если `!channelRow.
allowChatAttachments` и во входящем сообщении есть вложение —
вложение обрезается (текст сообщения остаётся), а не всё сообщение
целиком отбрасывается: это политика отображения, а не нарушение
авторизации (у любого участника COMMENT и так есть channelKey и право
писать в чат — вложение в обход настройки не даёт ему ничего, что он
не мог бы сделать иначе, просто нарушает пожелание владельца по
UX/трафику).

### `src/domain/content/channel-chat.js`

```js
export async function sendChannelMessage(ownerPubkey, ownerPrivKey, channelId, text, attachments, publish);
// Резолвит channelRow/channelKeys/channelKeyMeta локально (как addComment).
// messageId = crypto.randomUUID(). kind 30063, d-tag = `${channelId}:${messageId}`,
// тег `h` = channelRow.channelTopic. content = encryptChannelContent(JSON.stringify(
// {text, attachments}), channelKey[v_current], v_current). Права COMMENT не проверяются
// здесь заранее (тот же принцип, что addComment) — источник истины на приёме.
// Локально upsert в channelMessages сразу (оптимистично). attachments — до 1 элемента
// (как посты/комментарии), формат данных [] сохранён для единообразия.

export async function receiveChannelMessage(ownerPubkey, event);
// Тот же контур, что receiveComment: `h`-тег -> channelRow -> channelKeyMeta/channelKeys
// -> decryptChannelContent (null -> discard). Владелец канала — неявно разрешён
// (тот же спецкейс, что receiveComment, этап 31). Иначе — canAuthorComment против
// ЛОКАЛЬНО закэшированного commentAllowlists[v_current] (PLAN.md буквально: "allowlist
// COMMENT = право писать в чат тоже", тот же allowlist, отдельного для чата не заводим).
// Не авторизован -> discard (return false). Авторизован, но !channelRow.
// allowChatAttachments && parsed.attachments?.length -> upsert с attachments:[] (обрезка,
// см. решение выше), НЕ discard. upsert в channelMessages, return true.
```

### `src/core/sync/lazy-channel.js` — добавление

```js
export async function loadChannelChatWindow(ownerPubkey, channelId, { limit = 15, beforeCreatedAt } = {});
// Буквально тот же паттерн, что loadPostsWindow/loadCommentsWindow — сортировка по
// createdAt, slice(-limit), hasMore = source.length > limit. Пользовательское ТЗ — 15
// за окно (было 10/50 у постов/комментариев).
```

### Схема БД — `db.version(7)`

```js
channelMessages: "[ownerPubkey+id], [ownerPubkey+channelId+createdAt]"
```

Owner-scoped с рождения (не постфактум-правка, как посты/комментарии
этапа 31, — паттерн уже усвоен, таблица объявляется правильно сразу).

### Wiring — `transport.js`

`refreshChannelContentSubscription` расширяется: `kinds: [30060, 30054,
30061, 30062, 30063]`. Диспетчер получает ветку `receiveChannelMessage`
рядом с `receivePost`/`receiveComment`.

### UI

`src/ui/components/channel-chat.jsx` — список сообщений (без дерева,
плоская лента, свежие внизу — тот же принцип отображения, что
`chat.jsx`) + композер (текст + опциональное вложение, кнопка
прикрепления скрыта при `!channelRow.allowChatAttachments`) + "Загрузить
более старые". `channel.jsx` (`ChannelDetail`) получает переключатель
вкладок "Посты"/"Чат" (аналог табов `channels.jsx`, `role="tablist"`).
Право писать в чат — то же `canComment`, что уже вычислено для
комментариев (`role === "owner" || role === "subscriber"`), без
`canComment` — только чтение ленты чата.

### Явное сужение скоупа

Редактирование/удаление отдельного сообщения чата — не в этом этапе
(в отличие от постов/комментариев, F-CH-10 здесь не применяется);
статусы отправки (sending/sent/failed, как в личных чатах) — не в
этом этапе, отправка либо сразу `requirePublishOk` бросает, либо
считается успешной (тот же уровень, что posts/comments сейчас).

### Правка контракта этапа 30 (найдено живым E2E, не домысел) — `sendViewGrant` без d-тега

При живой проверке этапа 32 (два подписчика на один канал) обнаружена
РЕАЛЬНАЯ протокольная ошибка контракта этапа 30: `sendViewGrant`
публиковал kind 30053 с тегами `[['p', readerPubkey]]` — БЕЗ d-тега
вовсе. NIP-01 трактует отсутствующий d как `d=""` для parameterized-
replaceable кинда (30000-39999): второй грант (Мэллори) от того же
владельца (тот же pubkey+kind+d="") ЗАМЕЩАЛ на relay грант первого
читателя (Боба) — Боб терял VIEW навсегда при следующей выборке по
`#p`. Комментарий контракта этапа 30 называл это "идемпотентностью"
("повторная публикация того же гранта безвредна"), не учтя, что
РАЗНЫЕ читатели с пустым d-tag коллизируют друг с другом, не только
каждый сам с собой. TECH.md §4.8 уже специфицировал HMAC d-tag для
kind 30053 — реализация этапа 30 просто не перенесла его в код.

**Правка:** `sendViewGrant(ownerPubkey, ownerPrivKey, channel,
readerPubkey, keyVersion, publish)` — добавлен параметр `keyVersion`,
d-tag = `opaqueDTag(masterSecret, 30053, channelId+":"+readerPubkey+
":"+keyVersion)`, буквально по TECH.md §4.8. Получатель по-прежнему
находит свой грант через `#p`, d-tag вычислять не должен (TECH.md:
"d-tag не нужен получателю"). Вызывающий код (`channel.js:
createChannel`) — передаёт уже известную `version` (пока всегда 1,
ротации в этом этапе нет). Регрессионный тест зафиксирован в
`tests/channel.test.js`: два гранта одного канала ОБЯЗАНЫ иметь
РАЗНЫЕ d-теги (юнит-тесты не симулируют relay-коллизию напрямую —
захват publish() не моделирует хранение по (kind,pubkey,d-tag), но
свойство "разные d-теги" — то самое, что коллизию предотвращает).
Немедленная полная регрессия после правки: `npm test` 551/551.

## Этап 32-довесок — восстановление после несовместимой схемы локальной БД

Найдено пользователем (не тестом): реальный браузер с непустыми
таблицами, чей primary key менялся между версиями (`channels`/
`posts`/`comments` — этапы 30/31), падает на `db.open()` с
`UpgradeError: Not yet support for changing primary key` — юнит-тесты
этого не ловят (fake-indexeddb в них всегда стартует с пустой базы).
`Onboarding`/`Unlock` не оборачивали `await listAccounts()` в try/catch
— необработанный rejection оставлял экран на "Проверка…" навсегда,
без какого-либо выхода для пользователя, кроме ручного вмешательства
через DevTools.

**Правка:** `src/core/store/database.js` — `resetLocalDatabase()`
(`db.delete()`, дев-стадия не подразумевает миграции реальных
данных). `onboarding.jsx`/`unlock.jsx` — `listAccounts()` в try/catch,
при ошибке — экран с объяснением и кнопкой "Очистить локальные данные
и начать заново" (`resetLocalDatabase()` + `location.reload()`) вместо
вечного "Проверка…".

Тест: `tests/database.test.js` (`resetLocalDatabase` удаляет и
пересоздаёт схему) — последний в файле (уничтожает БД, следующие
тестовые файлы запускаются в отдельном процессе `node --test`, не
разделяют состояние). Живой E2E (Playwright, сырой IndexedDB API
эмулирует непустую `channels` под version(1)'s primary key `id`,
затем reload): экран восстановления появляется, кнопка сбрасывает
базу и возвращает к рабочей регистрации — подтверждено.

Regression: `npm test` 552/552. `npm run build` 233.63 КБ gzip.

## Этап 32-довесок-2 — найдено живым использованием (комментарии/чат канала)

Три независимых UI-находки при ручном тестировании этапа 31/32:

1. **Вложения комментария не отображались.** Данные доходили корректно
   (`addComment`/`receiveComment` уже несли `attachments`), но
   `CommentNode` (`channel.jsx`) никогда не рендерил
   `comment.attachments?.[0]` через `AttachmentView` — в отличие от
   `PostCard`/`ChannelChat`, у которых это уже было. Правка: одна
   строка JSX + импорт `AttachmentView`.

2. **Никнеймы участников чата канала/комментаторов показывали сырой
   npub вместо имени.** `CommentNode`/`ChannelChat` использовали
   `shortPubkey(pubkey)` напрямую, никогда не читая уже существующий
   кэш `profiles` (`signals/contacts.js`, заполняется через
   `ensureProfilesFetched`/kind 0, F-CT-04) и не переиспользуя уже
   готовый `ContactIdentity` (`contacts.jsx`) — тот же компонент, что
   уже показывает никнейм+аватар в списке контактов и личных чатах.
   Правка: `CommentNode`/`ChannelChat` теперь рендерят
   `<ContactIdentity pubkey={...} />` вместо `shortPubkey`; при
   загрузке ленты/чата вызывается `ensureProfilesFetched(authors,
   fetchProfiles)` — авторы постов/комментариев/сообщений чата канала
   не обязаны быть КОНТАКТАМИ владельца, поэтому кэш профилей
   пополняется отдельно от списка контактов.

3. **Счётчик "Комментарии (N)" показывал 0 до первого клика.**
   `PostWithComments` брал `tree.length` из состояния, заполняемого
   только при `expanded===true`. Добавлена `countTopLevelCommentsByPost
   (ownerPubkey, postIds)` (`comments.js`) — ОДИН скан таблицы
   `comments` на весь список постов канала разом (не N вызовов
   `getCommentsTree`), считает только `parentId===postId` (тот же
   критерий, что корень `buildTree` — бейдж не расходится со
   значением после раскрытия). `ChannelDetail` вычисляет карту
   `commentCounts` в `refresh()` и передаёt её вниз; `PostWithComments`
   дополнительно обновляет счётчик локально сразу после
   `refreshComments()` (мгновенно для СВОЕГО же нового комментария, не
   дожидаясь эхо-события через relay, которое единственное дёргает
   `messagingActivity`).

Живой E2E (2 браузера): пост → комментарий с вложением от подписчика →
владелец сразу видит "Комментарии (1)" без клика, никнейм автора и
вложение — с обеих сторон (автор видит своё, получатель — чужое).

Regression: `npm test` 553/553. `npm run build` без существенного
роста (JSX-правки, один новый маленький доменный запрос).

## Этап 33 — Модерация: жалобы + бан + игнор + rate-limiting

DESIGN.md, "Этап 33" — прочитать перед этим разделом (найденный
барьер NIP-09, крипто-обоснование почему ротации ключа достаточно
для блокировки нового контента забаненного, формализация игнора и
почему разбан невозможен в этой модели).

### Правка контракта этапа 30 (аддитивная) — `channelReaders`

`createChannel` (`channel.js`) ДОПОЛНИТЕЛЬНО персистит для каждого
`readerPubkey` из group-snapshot: `db.table("channelReaders").put({
ownerPubkey, channelId, readerPubkey})` — рядом с уже существующим
`sendViewGrant`. Ничего в существующей сигнатуре/поведении не
меняется, только новая побочная запись. Существующие тесты
(`channel.test.js`) не ломаются (не проверяли отсутствие этой
таблицы).

### `src/domain/content/rate-limiter.js`

```js
export function createRateLimiter(windowMs = 5000);
// -> { tryAction(actionType, now = Date.now()): boolean }
// true и записывает now как lastActionAt[actionType], ЕСЛИ now - lastActionAt[actionType] >= windowMs
// (или actionType ещё не встречался). Иначе false, БЕЗ обновления lastActionAt (окно не сдвигается
// повторными отклонёнными попытками — иначе спам-клики продлевали бы блокировку бесконечно).
```

### `src/domain/content/moderation.js`

```js
export const CHANNEL_REPORT_KIND = 3003; // gift-wrap rumor, прецедент CHANNEL_SUBSCRIBE_REQUEST_KIND=3002
export const CHANNEL_BAN_KIND = 30064; // parameterized-replaceable, следующий свободный после чата (30063)

export async function reportContent(reporterPubkey, reporterPrivKey, channelOwnerPubkey, { channelId, targetPubkey, contentType, contentId, contentText, reason }, publish);
// reason: "report" | "ignore". rumor = {kind: CHANNEL_REPORT_KIND, content: contentText, tags:
// [["channel_id", channelId], ["target", targetPubkey], ["content_type", contentType],
// ["content_id", contentId], ["reason", reason]], created_at}. nip59Wrap(rumor, reporterPrivKey,
// channelOwnerPubkey) -> publish. Owner различает "report"/"ignore" по тегу reason на приёме.

export async function receiveReport(ownerPubkey, { reporterPubkey, channelId, targetPubkey, contentType, contentId, contentText, reason, createdAt });
// ПРАВКА КОНВЕНЦИИ (согласовано с уже существующим диспетчером giftWrapSubscriber,
// transport.js): unwrap делает ТОЛЬКО transport.js (как для CONTACT_REQUEST_KIND/
// CHANNEL_SUBSCRIBE_REQUEST_KIND — домен получает уже РАСПАКОВАННЫЕ примитивы, не сырой
// gift-wrap и не приватный ключ; reporterPubkey = rumor.pubkey, аутентичный отправитель
// из unwrap, НЕ из тега). upsert channelReports: {ownerPubkey, id: crypto.randomUUID(),
// channelId, reporterPubkey, targetPubkey, contentType, contentId, contentText, reason,
// viewed: false, createdAt}. return true.

export async function ignoreMember(viewerPubkey, viewerPrivKey, channelOwnerPubkey, { channelId, targetPubkey, contentType, contentId, contentText }, publish);
// db.table("channelIgnores").put({ownerPubkey: viewerPubkey, channelId, ignoredPubkey: targetPubkey}) —
// ЛОКАЛЬНО, идемпотентно (put, не add). Затем reportContent(..., reason: "ignore", ...) — авто-репорт
// с контекстом (ТЗ). Не проверяет, был ли уже проигнорирован (повторный вызов — no-op по эффекту,
// лишний report владельцу — не страшно, тот же принцип, что sendViewGrant "публикация того же —
// безвредна", здесь дополнительно: сам channelIgnores.put идемпотентен по PK).

export async function getIgnoredSet(viewerPubkey, channelId);
// -> Set<pubkey>. Читает channelIgnores[viewerPubkey, channelId, *]. Используется lazy-channel.js
// для фильтрации ленты чата/комментариев ТОЛЬКО у смотрящего.

export async function banMember(ownerPubkey, ownerPrivKey, channelId, targetPubkey, publish);
// DESIGN.md формализация 1, шаги 1-5 буквально:
// 1. meta = channelKeyMeta[ownerPubkey,channelId]; v_old = meta.currentVersion; keyOld = channelKeys[...,v_old].
// 2. v_new = v_old + 1; channelKeyNew = generateChannelKey(); persist channelKeys[...,v_new],
//    channelKeyMeta.currentVersion = v_new.
// 3. readers = channelReaders[ownerPubkey,channelId,*] minus targetPubkey; для каждого —
//    sendViewGrant(ownerPubkey, ownerPrivKey, {channelId, channelTopic: channelRow.channelTopic,
//    channelKey: channelKeyNew}, readerPubkey, v_new, publish) (реиспользует правку этапа 32-довесок).
// 4. Если commentAllowlists[...,v_old] существует — buildAllowlistEvent с v_new, allowedAuthors
//    минус targetPubkey -> sign(ownerPrivKey) -> publish; persist commentAllowlists[...,v_new] локально.
// 5. banEvent = sign({kind: CHANNEL_BAN_KIND, tags: [["d", `${channelId}:ban:${targetPubkey}`],
//    ["h", channelRow.channelTopic]], content: encryptChannelContent(JSON.stringify({targetPubkey}),
//    keyOld, v_old), created_at}, ownerPrivKey) -> requirePublishOk.
// 6. Локально: bannedMembers.put({ownerPubkey, channelId, pubkey: targetPubkey, bannedAt}); удалить
//    targetPubkey из channelReaders[ownerPubkey,channelId,*].
// Не бросает, если targetPubkey не в readers/allowlist (VIEW-only без COMMENT — валидный бан-кейс).

export async function receiveBanAnnouncement(ownerPubkey, event);
// DESIGN.md, раздел "Приём kind 30064", шаги 1-5 буквально. Собирает ВСЕ channelKeys[ownerPubkey,
// channelId,*] в map version->key (не только current — единственное место в этапе, где это нужно).
// event.pubkey !== channelRow.creatorPubkey -> discard (return false). decrypt null -> discard.
// targetPubkey === ownerPubkey -> deleteChannelLocally(ownerPubkey, channelRow.id) (новая приватная
// функция — стирает channels-строку и ВСЕ связанные таблицы этого channelId у себя). Иначе —
// bulk-update comments/channelMessages (deleted:true) где authorPubkey===targetPubkey И
// channelId===channelRow.id; bannedMembers.put(...) (у ВСЕХ получателей, не только владельца).
// return true.

export async function listReports(ownerPubkey, channelId); // -> [{...report}] сортировка по createdAt desc
export async function markReportViewed(ownerPubkey, reportId);
export async function markAllReportsViewed(ownerPubkey, channelId);
export async function getModerationStats(ownerPubkey, channelId);
// -> {total, unviewed, topIgnored: [{pubkey, count}]} — topIgnored: группировка reports с
// reason==="ignore" по targetPubkey, count = число РАЗНЫХ reporterPubkey (Set), сортировка desc,
// top-5.
export async function listBannedMembers(ownerPubkey, channelId); // -> [pubkey]
```

### `src/core/sync/lazy-channel.js` — правка (фильтрация игнора)

`loadCommentsWindow`/`loadChannelChatWindow` дополнительно исключают
строки с `deleted===true` (`channelMessages` теперь тоже может иметь
этот флаг — правка бана) И строки, чей `authorPubkey` ∈
`getIgnoredSet(ownerPubkey, channelId)` (ownerPubkey здесь — ВСЕГДА
"я, локальный смотрящий", тот же параметр, что везде в этой схеме).

### Схема БД — `db.version(8)`

```js
channelReaders: "[ownerPubkey+channelId+readerPubkey], [ownerPubkey+channelId]",
channelReports: "[ownerPubkey+id], [ownerPubkey+channelId], viewed",
channelIgnores: "[ownerPubkey+channelId+ignoredPubkey], [ownerPubkey+channelId]",
bannedMembers: "[ownerPubkey+channelId+pubkey], [ownerPubkey+channelId]"
```

### Wiring — `transport.js`

- `refreshChannelContentSubscription`: kinds += `CHANNEL_BAN_KIND`
  (30064), диспетчер получает ветку `receiveBanAnnouncement`.
- Диспетчер gift-wrap (`giftWrapSubscriber`, уже существующий для
  contact-request/subscribe-request) получает ветку для
  `CHANNEL_REPORT_KIND` (3003) → `receiveReport`.

### UI

- Кнопки "Пожаловаться"/"Игнорировать" — у каждого комментария
  (`CommentNode`) и сообщения чата (`ChannelChat`), видны всем КРОМЕ
  автора (нельзя пожаловаться на себя). "Пожаловаться" — модалка/форма
  с опциональным текстом причины (используется как `contentText`
  репорта — ЕСЛИ пусто, берётся текст самого сообщения); "Игнорировать"
  — сразу, без формы (авто-контекст = текст сообщения), с
  `window.confirm` (необратимо для не-владельца — see DESIGN.md).
- Владелец: вкладка "Модерация" (третья, рядом с "Посты"/"Чат") —
  список репортов (реиспользует `ContactIdentity` для reporter/target),
  бейджи report/ignore, "Пометить просмотренным"/"Пометить всё
  просмотренным", статистика (`getModerationStats`), кнопка "Забанить"
  прямо из строки репорта (`targetPubkey` уже известен) с
  `window.confirm`.
- `ChannelDetail`: если после `refresh()` канал не найден в
  `channels` (не "ещё грузится", а "пропал") — отдельный экран "Вы
  были удалены из этого канала владельцем" вместо вечного "Загрузка…"
  (тот же класс находки, что onboarding/unlock, этап 32-довесок —
  различать "loading" и "пропало" явно).
- Rate limiter: один `createRateLimiter()` на `ChannelDetail`
  (`useState(() => createRateLimiter())`), передаётся в
  `PostComposer`/`CommentComposer`/`ChatComposer`; `tryAction(...)
  === false` -> локальный статус-параграф "Слишком быстро — подождите
  немного" (тот же паттерн, что `bioStatus` в profile.jsx), сабмит не
  происходит.

### Явное сужение скоупа

Массовая рассылка предупреждений (без бана) — backlog. Разбан и снятие
игнора владельцем — backlog (см. DESIGN.md, невозможно в модели без
отдельного сетевого механизма). Владелец в списке читателей/
allowlist не проверяется отдельно (не может забанить сам себя
осмысленно, но и не запрещено явно — безвредно).

### Найдено АДВЕРСАРНЫМ ТЕСТОМ (не живым прогоном) — грант VIEW не нёс версию

При написании адверсарного теста для `banMember` ("после бана Боб не
может писать новые комментарии") обнаружено: `encryptChannelKeyGrant`
(этап 30) никогда не включала номер версии в payload гранта (только
`{channelId, channelTopic, channelKey}`), а `receiveChannelKeyGrant`
хардкодила `version = 1` для ЛЮБОГО полученного гранта — комментарий
кода буквально предвидел это как временное упрощение ("если появится
revoke, kind 30053 обязан нести версию явно"). Ротация ключа при бане
(`banMember`) прислала переизданный грант с v_new — получатель молча
ЗАТИРАЛ им же сохранённый v_old ПОД ТЕМ ЖЕ номером версии "1",
разрушая исторический доступ и вызывая `Error: invalid tag` (AEAD)
при попытке расшифровать что угодно старым эпохом.

**Правка (контракт этапа 30, немедленная полная регрессия):**
`encryptChannelKeyGrant(channelId, channelTopicHex, channelKeyHex,
version, ownerPrivKey, readerPubkey)` — версия теперь обязательный
параметр, часть payload. `receiveChannelKeyGrant` читает
`grant.version` вместо хардкода; `channelKeyMeta.currentVersion =
Math.max(уже известное, пришедшее)` — защита от переупорядоченной
доставки (старый грант, пришедший после нового, не откатывает
текущую версию назад). `sendViewGrant` (этап 32-довесок уже добавил
параметр `keyVersion` для d-тега) теперь передаёт его же и в
содержимое гранта — d-тег и payload больше не расходятся.

Regression: `npm test` 573/573 (полная регрессия, не только этап 33).

## Этап 34 — Настройки: тема, масштаб, язык, уведомления, relay/Blossom-серверы

Рутина (PLAN.md-триаж: "[рутина + AC-чеклист в конце, не код]") — глюe
поверх уже существующей CSS-системы токенов (`--accent-hue`,
`--font-size-base`) и уже специфицированного F-SY-03 (kind 30072).
DESIGN.md-формализация не требуется (нет состояния/автомата — только
пара точных решений о приоритете источников данных, см. ниже).

### Скрин-референс пользователя (v0.1, https://ibb.co/WWQNbYJ6)

Секции: масштаб интерфейса (dropdown), акцентный цвет (сетка
именованных swatches), язык интерфейса (dropdown), уведомления
(вложенные тумблеры), приватность (онлайн-статус/последний
визит/показ в поиске). **Приватность — вне скоупа этого этапа**
(решение пользователя): presence-протокол и поиск пользователей не
существуют в архитектуре проекта вовсе, это отдельная будущая фича,
не настройка поверх существующего.

### Найденное решение — приоритет источников для активного relay

Активный relay нужен ДО того, как можно получить что-либо с relay
(включая kind 30072 с синхронизированным списком) — классическая
бутстрап-проблема. Решение: локальный кэш (`uiSettings.activeRelayUrl`)
— источник истины для ТЕКУЩЕГО подключения этого устройства; kind
30072 — best-effort синхронизация между СВОИМИ устройствами (тот же
принцип, что profile.jsx: публикация не блокирует и не гейтит
локальное сохранение). Первый запуск без локальной записи — фолбэк на
`BUILD_DEFAULT_RELAYS[0]` (build-time дефолт), который тут же
сохраняется в `uiSettings`, чтобы дальше локальный кэш был
единственным источником, который читает `connect()`.

### Найденное решение — уведомления модерации всегда включены

Инфо-бокс мокапа буквально: "Предупреждения, бан и удаление канала
показываются всегда" — `notify()` для категории `moderation`
(бан/report-acted-on/удаление канала) НЕ проверяет тумблеры вовсе,
только `Notification.permission === "granted"`. Остальные категории
(contacts/messages/channels) гейтятся вложенными тумблерами буквально
по дереву мокапа.

### `src/ui/theme/accent-palette.js`

```js
export const ACCENT_COLORS = [
  { id: "blue", label: "Blue", hue: 255 }, { id: "indigo", label: "Indigo", hue: 275 },
  { id: "sky", label: "Sky", hue: 230 }, { id: "teal", label: "Teal", hue: 185 },
  { id: "cyan", label: "Cyan", hue: 200 }, { id: "lavender", label: "Lavender", hue: 290 },
  { id: "violet", label: "Violet", hue: 305 }, { id: "terracotta", label: "Terracotta", hue: 35 },
  { id: "amber", label: "Amber", hue: 75 }, { id: "peach", label: "Peach", hue: 45 },
  { id: "saffron", label: "Saffron", hue: 85 }, { id: "orange", label: "Orange", hue: 55 },
  { id: "olive", label: "Olive", hue: 115 }, { id: "moss", label: "Moss", hue: 140 },
]; // hue — то же число, что уже управляет --accent-hue в styles/minimal.css,
   // просто именованные точки на круге, ничего нового в CSS не вводится.

export function applyAccentColor(colorId);
// document.documentElement.style.setProperty("--accent-hue", ACCENT_COLORS.find(...).hue).
// Неизвестный colorId -> no-op (не бросает — вызывающий код мог прочитать устаревший
// локальный кэш до правки палитры, деградация в "текущий акцент остаётся", не крах).
```

### `src/ui/theme/ui-scale.js`

```js
export const SCALE_OPTIONS = [
  { id: "small", label: "Small (90%)", percent: 90 },
  { id: "medium", label: "Medium (100%)", percent: 100 },
  { id: "large", label: "Large (110%)", percent: 110 },
  { id: "xlarge", label: "Extra Large (125%)", percent: 125 },
];

export function applyUiScale(scaleId);
// document.documentElement.style.fontSize = `${percent}%` — весь остальной дизайн
// уже rem-относительный (--space-unit, --step-*), масштабируется целиком бесплатно.
```

### `src/domain/settings/ui-settings.js`

```js
export const KIND_UI_SETTINGS = 30072; // F-SY-03, d-tag='settings' буквально (не opaque —
// не privacy-чувствительно, тот же принцип, что read-status/drafts этапа 26).

export const DEFAULT_NOTIFICATIONS = {
  enabled: true, sound: true,
  contacts: { enabled: true, newRequests: true, accepted: true },
  messages: { enabled: true, incoming: true },
  channels: { enabled: true, newPosts: true, chatMessages: true },
};
export const DEFAULT_SETTINGS = {
  accentColorId: "blue", uiScale: "medium", language: "ru",
  notifications: DEFAULT_NOTIFICATIONS,
  relayUrls: [], activeRelayUrl: null, // заполняются BUILD_DEFAULT_RELAYS при первом сохранении
  blossomUrls: [], activeBlossomUrl: null,
};

export function buildUiSettingsEvent(privKey, settings, createdAt = Math.floor(Date.now()/1000));
// kind 30072, tags=[['d','settings']], content = NIP-44(JSON.stringify(settings), privKey, ownPub).

export function parseUiSettingsEvent(event, privKey);
// NIP-44.decrypt -> JSON.parse -> {...DEFAULT_SETTINGS, ...parsed} (глубокое слияние notifications
// отдельно — старый payload без нового поля не должен терять остальные разделы дерева).

export async function loadUiSettings(ownerPubkey);
// db.table("uiSettings").get(ownerPubkey) ?? DEFAULT_SETTINGS (с relayUrls/activeRelayUrl,
// заполненными из BUILD_DEFAULT_RELAYS/BUILD_DEFAULT_BLOSSOM_SERVERS на лету, не персистентно,
// ЕСЛИ строки в БД ещё нет вовсе — первый вызов).

export async function saveUiSettings(ownerPubkey, privKey, settings, publish);
// Локально put СРАЗУ (офлайн-first). Публикация — best-effort, ошибка публикации НЕ бросает
// наружу (тот же принцип, что profile.jsx: publishStatus вместо throw).

export async function rebuildUiSettings(ownerPubkey, privKey);
// Тот же паттерн, что rebuildContactsAndGroups (handlers.js): db.table("events").where(
// "[pubkey+kind]").equals([ownerPubkey, KIND_UI_SETTINGS]).toArray() -> pickLatest -> parse -> put.
// Вызывается из transport.js's connect(), рядом с rebuildContactsAndGroups/rebuildEffectivePermissions —
// событие уже приходит через существующий bootstrap-фильтр {authors:[я]}, нового REQ не нужно.

export async function addRelayUrl(ownerPubkey, privKey, url, publish);
export async function removeRelayUrl(ownerPubkey, privKey, url, publish);
export async function setActiveRelayUrl(ownerPubkey, privKey, url, publish);
// Все три — читают loadUiSettings, мутируют relayUrls/activeRelayUrl, saveUiSettings. setActiveRelayUrl
// НЕ переподключает сама — вызывающий UI-код (settings.jsx) обязан после неё вызвать
// transport.js's reconnectWithNewSettings (явный шаг, не скрытый побочный эффект в доменной функции).

export async function addBlossomUrl(ownerPubkey, privKey, url, publish);
export async function removeBlossomUrl(ownerPubkey, privKey, url, publish);
export async function setActiveBlossomUrl(ownerPubkey, privKey, url, publish);
// Тот же паттерн — Blossom не требует переподключения (URL читается per-upload, не держит
// постоянное соединение), setActiveBlossomUrl достаточно самой по себе.
```

### `src/domain/notifications/notifier.js`

```js
export async function requestNotificationPermission();
// Notification.requestPermission() — обёртка для тестируемости (DI через переданный
// NotificationImpl, по прецеденту WebSocketImpl/MediaRecorderImpl).

export function notify(settings, category, subcategory, { title, body });
// category: "contacts"|"messages"|"channels"|"moderation". "moderation" — ВСЕГДА (см. находку
// выше), игнорирует settings целиком. Остальные — settings.notifications.enabled &&
// settings.notifications[category].enabled && settings.notifications[category][subcategory] !== false
// (subcategory может отсутствовать — тогда только verhний уровень категории). Permission !==
// "granted" -> no-op молча (это UX-фича, не критичный путь — как клиентский rate-limit этапа 33).
```

### Wiring — `transport.js`

- `connect()`: `const localSettings = await loadUiSettings(pubkeyHex); const relayUrl =
  localSettings.activeRelayUrl ?? DEFAULT_RELAYS[0] ?? "ws://127.0.0.1:7777";` вместо жёсткого
  `DEFAULT_RELAYS[0]`. После `rebuildEffectivePermissions` — `await rebuildUiSettings(pubkeyHex,
  privKey);`.
- Новый экспорт `reconnectWithNewSettings(pubkeyHex, privKey)`: `teardown(); connectedForPubkey =
  null; connectPromise = null; return ensureConnected(pubkeyHex, privKey);` — полный разрыв и
  чистое переподключение (новый `connect()` уже читает свежий `activeRelayUrl` из локального кэша).
- `notify(...)` вызывается в существующих ветках диспетчера: `upsertMessage` (входящее сообщение,
  category "messages"/"incoming"), contact-request-accepted (существующий kind 3 fold, "contacts"),
  `receivePost`/`receiveChannelMessage` ("channels", "newPosts"/"chatMessages"),
  `receiveBanAnnouncement`/`receiveReport` ("moderation", всегда).

### Профиль — relay/Blossom management UI

Не отдельный экран — секция в уже существующем `profile.jsx` (пользователь: "в профиль
необходимо добавить"). Список текущих relay/Blossom с кнопкой "Удалить" (кроме активного —
нельзя удалить то, к чему подключены прямо сейчас, сначала переключиться), форма добавления
нового URL, радио/кнопка "Сделать активным" на каждой строке (relay — вызывает
`reconnectWithNewSettings` явно после `setActiveRelayUrl`).

### `src/ui/screens/settings.jsx`

Масштаб (select из `SCALE_OPTIONS`), акцент (grid кнопок `ACCENT_COLORS`, применяется сразу по
клику — превью без сохранения, `saveUiSettings` по явному сабмиту секции, тот же принцип, что
`--accent-hue` уже CSS-переменная — смена мгновенная, без reload), язык (select с ЕДИНСТВЕННОЙ
опцией "Русский" — намеренно, в проекте нет i18n-инфраструктуры, вторая опция появится только
вместе с реальным переводом строк, это НЕ фиктивный переключатель "заглушка", а честно урезанный
список валидных значений), уведомления (вложенные чекбоксы 1:1 по дереву мокапа, вызывает
`requestNotificationPermission()` при первом включении верхнего тумблера), кнопка "Заблокировать
сейчас" (сбрасывает `currentUser`/`privKeySig`, `navigate("/unlock")` — тот же logout-путь, что уже
где-то есть, если найдётся; иначе — новый маленький вызов `logout()` в `signals/auth.js`).

### Схема БД — `db.version(9)`

```js
uiSettings: "ownerPubkey" // одинblob на аккаунт, голый pubkey — сам по себе owner-scoped
```

### Явное сужение скоупа

Приватность (онлайн-статус/последний визит/поиск) — вне скоупа (решение пользователя, нет
presence-протокола). Светлая/тёмная тема как ручной переключатель — вне скоупа (мокап её не
показывает; `color-scheme: light dark` уже даёт авто-переключение по ОС, ручной оверрайд —
backlog при явном запросе). Финальный AC-чеклист TECH.md §15/бенчмарки bootstrap
1k-5k/self-hosting docs (изначально тоже часть этапа 34 по PLAN.md) — отдельным заходом после
этой функциональной части, по согласованию с пользователем.

### Правки при реализации (относительно черновика контракта выше)

1. **UX применения настроек** — черновик предполагал "превью без сохранения,
   явный сабмит секции". При реализации выбран более простой и согласованный
   с остальным приложением паттерн: каждое изменение (клик по цвету, выбор
   масштаба, тумблер) применяется и сохраняется СРАЗУ, без промежуточной
   кнопки "Сохранить" — тот же принцип, что чекбоксы групп в contacts.jsx.

2. **Найденный пробел, закрытый новым сигналом** — `acceptContactRequestAction`
   (signals/contacts.js) добавляет отправителя ТОЛЬКО в свой contact-list
   (kind 3), ничего не сообщая обратно. `rebuildContactsAndGroups` сканирует
   ТОЛЬКО свои kind-3 события — без отдельного сигнала пункт настроек
   "Запрос принят" технически недостижим. Добавлен `CONTACT_ACCEPTED_KIND =
   3004` (`domain/contacts/requests.js`) — gift-wrap rumor, тот же приём, что
   `CONTACT_REQUEST_KIND`/`CHANNEL_SUBSCRIBE_REQUEST_KIND` (3001/3002),
   отправляется best-effort сразу после успешного добавления в контакты
   (сбой публикации уведомления НЕ должен откатывать уже выполненное
   основное действие — покрыто тестом в contacts-signals.test.js).

3. **Аддитивное поле в `receiveGroupMessageEvent`** (chat.js, этап 24) —
   возвращаемый объект получил `contactPubkey` (нужен transport.js для текста
   уведомления "новое сообщение"). Проверено: существующие тесты сверяют
   ОТДЕЛЬНЫЕ поля (`.text`, `.lamportTs`), не строгий `deepEqual` на весь
   объект — новое поле безопасно, кроме одного теста (devices.test.js),
   который делал строгий `deepEqual` — обновлён явно.

4. **Уведомление на входящее сообщение фильтрует delete/edit-маркеры** —
   `applyIncomingDeletionIfMarker`/`applyIncomingEditIfMarker` уже
   возвращают `true`, если событие было служебным маркером (не обычным
   текстом); `notify(..., "messages", "incoming", ...)` вызывается, только
   если ни один из них не сработал — иначе пользователь получал бы
   уведомление на удаление/правку чужого сообщения как на "новое".
