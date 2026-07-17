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
