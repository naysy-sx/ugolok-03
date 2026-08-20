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

**Правка (этап 54-довесок).** `useEffect` в app.jsx реагирует на
ИЗМЕНЕНИЕ значения `activeChatPubkey.value` (React/Preact
dependency-array семантика) — повторное присваивание ТОГО ЖЕ значения
не триггерит эффект. Найдено живой проверкой: открыл чат с контактом →
ушёл на другую вкладку через сайдбар (не через стрелку "назад" внутри
чата — та вызывает `openChat(null)`) → кликнул на того же контакта
снова → вкладка не переключалась (сигнал не менялся, всё ещё указывал
на тот же pubkey). Тот же класс — у `activeChannelId`
(ui/signals/channel-nav.js). Фикс — `app.jsx`'s `selectNavItem(id)`:
уход на любую вкладку, кроме "messages"/"channels", теперь сбрасывает
`activeChatPubkey`/`activeChannelId` в `null`, гарантируя, что
следующее открытие того же чата/канала — реальное изменение сигнала.

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

### Часть 2 — бенчмарки/self-hosting/аудит (findings, не новый контракт)

`server/strfry/strfry.conf`'s `maxFilterLimit` — было 500 (апстрим-дефолт),
стало 10000. Протокольное/конфигурационное ограничение (НЕ код клиента):
любой REQ-фильтр без явного `limit` (giftWrapSubscriber, bootstrap.js,
channel-подписки — ни один не использует курсор-пагинацию через `until`)
на relay с низким `maxFilterLimit` молча получает только первые N событий
без единой ошибки. На своём relay — увеличено с запасом; на чужом relay
это ограничение всё ещё актуально, курсор-пагинация клиента не
реализована (сознательное сужение скоупа, backlog).

`signals/transport.js` — паттерн "один `bumpMessagingActivity()` на весь
батч `onBatch`", а НЕ на каждое событие батча, обязателен для всех
будущих подписчиков transport.js. Причина: сигнал триггерит `useEffect`
полного перечитывания таблицы в открытых экранах — per-event bump на
батч из N событий даёт O(N²), не O(N). Единственное исключение —
`receiveLamportTick`/`persistLamportValue` (причинный Lamport-порядок,
обязаны быть per-event).

**AC-09 сознательно НЕ закрыт в этапе 34** (пользовательское решение,
AskUserQuestion) — `outbox.js` существует как готовый, протестированный,
но неподключённый модуль. Любой будущий этап, трогающий `sendMessage`
(chat.js) или `relay-pool.js`'s `onStateChange`, должен явно учитывать
этот открытый пробел, а не считать offline-очередь уже работающей
сквозной функциональностью — см. PLAN.md backlog п.3.

## Этап 35 — AC-09: outbox подключён к реальной отправке

### Правка контракта `src/core/store/outbox.js` (было: `enqueue(eventId)`)

**Причина ревизии (обязательна к чтению, не самоочевидна):** к моменту вызова
`requirePublishOk(publish, event)` в `sendMessage` (chat.js) MLS-ратчет УЖЕ
продвинут (`newSessionState` уже записан в `mlsGroups` ДО попытки publish,
см. chat.js:180) и новый эфемерный Nostr-ключ уже одноразово использован
(этап 24 — новый ключ на каждое kind 445, обфускация состава группы). Значит
при сбое publish **нельзя просто повторно вызвать sendMessage с тем же
текстом** — это создаст ВТОРОЙ, отличный от первого, шифртекст/событие,
продвинув ратчет ещё раз. Единственный корректный retry — повторно
отправить БУКВАЛЬНО ТОТ ЖЕ УЖЕ ПОДПИСАННЫЙ event. Значит outbox обязан
хранить не ссылку (`eventId`), а сам объект события целиком.

```js
export async function enqueue(event) {
  // event — уже подписанный, готовый к publish() Nostr-event (id/kind/tags/
  // content/sig/pubkey/created_at). eventId хранится ОТДЕЛЬНО от event тем
  // же полем, что и раньше (event.id) — для обратной совместимости запросов
  // по eventId (diagnostics.jsx, тесты), сам event — новое поле.
  return db.outbox.add({ eventId: event.id, event, status: "pending", retryCount: 0 });
}
```

`listPending()`/`markSent(seq)`/`markFailed(seq)` — без изменений сигнатуры.
`drain(publishFn)` — тоже без изменений сигнатуры (`publishFn(record)`,
record теперь несёt `.event`); вызывающий код (transport.js) обязан делать
`publishFn = (record) => publish(record.event)`, не `publish(record)`
напрямую.

### `chat.js`'s `sendMessage` — публичная правка контракта возврата

Было: при сбое `requirePublishOk` — throw, ничего не сохранено локально.
Стало: сбой publish **не бросает исключение** — сообщение уходит в outbox
(`enqueue(event)`) и сохраняется локально через `upsertMessage` со
`status: "failed"` (тот же словарь состояний, что уже существующий, но
ранее не используемый в реальном пути, `domain/messaging/machine.js`'s
`MESSAGE_TRANSITIONS` и уже готовая метка "не доставлено" в
`message-bubble.jsx`'s `STATUS_LABELS`). Возврат — `{ eventId: event.id,
queued: true }` вместо throw. Исключение по-прежнему бросается для ДРУГИХ
предусловий (чат не установлен, нет опубликованного ключа контакта) —
это невосстановимые ошибки вызова, не сетевые сбои, семантика не меняется.

**UI-следствие (chat.jsx, БЕЗ изменений кода)**: `handleSend`'s `catch`
теперь не срабатывает на сетевой сбой — happy-path (очистка поля ввода,
`reloadWindow()`) выполняется всегда, сообщение появляется в ленте с
меткой "не доставлено" (уже готовый рендер `message-bubble.jsx`). Это
корректное поведение реального мессенджера (сообщение "легло", не потеряно
из UI), а не побочный эффект.

### `transport.js` — auto-drain при (пере)подключении

`connect()`'s `onStateChange` callback дополнен: при переходе в
`"connected"` (это происходит и при первом подключении, и при
авто-reconnect `relay-pool.js` после обрыва — `intentionalClose=false`
ветка) — вызов fire-and-forget `drainOutboxSafely(publisher.publish)`.
Гвард на `publisher` (может быть ещё `null` в момент самого первого
`"connected"`, до строки `publisher = createPublisher(connection)`) —
доп. явный вызов сразу после создания `publisher` покрывает этот случай
(отправка того, что скопилось за время, пока приложение было закрыто).
`drainOutboxSafely` при успешной отправке записи обновляет статус
соответствующей строки `messages` (`where("id").equals(record.eventId)`)
на `"sent"` и, если хоть одна запись реально ушла, вызывает
`bumpMessagingActivity()` — иначе открытый экран чата не узнает, что
статус сообщения изменился. Ошибки самого `drain` (relay снова недоступен
посреди попытки) — проглатываются с `console.warn`, не должны валить
остальной `connect()`/reconnect-flow.

## Этап 36 — отзыв VIEW при выходе из группы (формализация в DESIGN.md)

### Схема БД — `db.version(10)`

```js
channelVisibilityGroups: "[ownerPubkey+channelId+groupId], [ownerPubkey+channelId], [ownerPubkey+groupId]"
```

### `channel.js`'s `createChannel` — аддитивная правка (не меняет сигнатуру)

После существующего цикла раздачи VIEW (строки, добавляющие
`channelReaders`) — новый цикл `for (const groupId of groupIds) await
db.table("channelVisibilityGroups").put({ ownerPubkey, channelId, groupId })`.
Пустой `groupIds` (канал-заметочник) — таблица остаётся пустой для
этого канала, как и раньше ничего не ломает.

### Новый файл `src/domain/content/channel-visibility.js`

```js
export async function findChannelIdsByVisibilityGroup(ownerPubkey, groupId)
// -> string[] (channelId), каналы, чья видимость зависит от этой группы

export async function revokeViewFromMember(ownerPubkey, ownerPrivKey, channelId, targetPubkey, publish)
// СТРОГОЕ ПОДМНОЖЕСТВО moderation.js's banMember: ротация channelKey
// (v_old->v_new), переиздача VIEW оставшимся channelReaders (кроме
// targetPubkey), обновление allowlist новой версии (без targetPubkey,
// если был), удаление строки channelReaders. БЕЗ бан-объявления
// (CHANNEL_BAN_KIND), БЕЗ bannedMembers, БЕЗ скрытия контента —
// это не модерация, человек не нарушил правил.

export async function revokeIfNoLongerVisible(ownerPubkey, ownerPrivKey, pubkey, removedFromGroupId, publish)
// Оркестратор по псевдокоду DESIGN.md, этап 36: для каждого канала из
// findChannelIdsByVisibilityGroup — если pubkey НЕ виден ни через одну
// ДРУГУЮ привязанную группу (isStillVisibleViaOtherGroups, внутренняя,
// не экспортируется) И у него ЕСТЬ строка channelReaders для этого
// канала — revokeViewFromMember. Идемпотентно (нет readerRow -> no-op).
```

### `signals/contacts.js`'s `removeGroupMemberAction` — правка контракта

Добавлен 6-й параметр `ownerPrivKey`... нет, `privKey` уже есть первым
позиционным (сигнатура не меняется: `(ownerPubkey, privKey, groupId,
pubkey, publish)`). В конце функции, ПОСЛЕ существующего
`foldGroup(event, privKey)` (нужен АКТУАЛЬНЫЙ `groupMembers` — foldGroup
удаляет старые строки группы и вставляет новые ДО проверки видимости
через другие группы) — новый вызов: `await revokeIfNoLongerVisible(ownerPubkey,
privKey, pubkey, groupId, publish);`.

## Этап 37 — авто-публикация профиля + аватар через Blossom

Рутина (skill правило 13a — обвязка существующей инфраструктуры,
DESIGN.md не нужен).

### Правка принятого контракта `domain/identity/profile.js`'s `buildProfileEvent`

Было (этап 26, `tests/profile.test.js`): `picture` СОЗНАТЕЛЬНО не
писалась в content — комментарий объяснял, что аватар был "локальный
stand-in до Blossom". Теперь Blossom-загрузка реализована (см. ниже) —
контракт меняется: `buildProfileEvent(privKey, { name, about, picture })`
пишет `picture` в content, если передана (`JSON.stringify` сам
опускает `undefined`-поля — ничего специально проверять не нужно).
Старый тест "НЕ пишет поле picture" — переписан на обратное
утверждение (Claude, не воркер — правка контракта, правило 12).

### Новая функция там же: `ensureProfilePublished(ownerPubkey, login, privKey, publish)`

Тот же идиома, что `chat.js`'s `ensureOwnKeyPackagePublished` (этап 25):
проверка локального флага ДО публикации, флаг персистится ДО попытки
publish (не после) — повторных попыток при неудаче сознательно нет,
как и у прототипа. Флаг — НЕ новая таблица, а необязательное
(неиндексируемое, схему менять не нужно) поле `profileAutoPublished`
на существующей строке `keystore` (`db.table("keystore").update(ownerPubkey,
{ profileAutoPublished: true })`). ОТЛИЧИЕ от прототипа: publish
оборачивается в try/catch внутри самой функции — сбой сети НЕ должен
ронять `connect()`/блокировать вход (имя в профиле — косметика, не
критичный для работы мессенджера примитив, в отличие от MLS
KeyPackage). Публикует ТОЛЬКО `{ name: login }` (без `about`/`picture` —
на момент первого вызова их ещё физически не может быть, echo
`getProfile`'s дефолты пустые).

### `signals/transport.js`'s `connect()` — аддитивная правка

После существующего `await ensureOwnKeyPackagePublished(pubkeyHex, privKey,
publisher.publish);` — новый вызов: `if (currentUser.value?.login) await
ensureProfilePublished(pubkeyHex, currentUser.value.login, privKey,
publisher.publish);`. Гвард на `login` — оборонительный (сценарий,
где он пуст, не ожидается в норме, но `currentUser` — просто сигнал,
явная проверка дешевле домысла). Новый импорт `currentUser` из
`./auth.js` — не создаёт цикла (`auth.js` ничего не импортирует из
`transport.js`).

### Новая функция `domain/attachments/upload.js`'s `uploadAvatarBlob(serverUrl, fileBytes, mime, privateKey, options)`

Параллель `uploadAttachment`, БЕЗ шифрования (публичный профиль — не
сообщение, шифровать нечего и незачем): валидирует mime/size тем же
`validateAttachment` (2 МБ клиентский лимит в profile.jsx — заведомо
меньше 20 МБ лимита картинок, проверка никогда не сработает практически,
переиспользуется ради mime-allowlist, не ради size-лимита), считает
sha256 ОТ ИСХОДНЫХ байт (не от шифротекста — шифрования нет), зовёт уже
существующий `uploadBlob` (сам по себе агностичен к тому, зашифрованы
байты или нет — просто грузит, что дали). Возвращает СТРОКУ — публичный
URL (`response.url`, фолбэк `serverUrl + '/' + sha256Hex`, если сервер
почему-то не вернул `url`) — не полный дескриптор вложения, т.к. avatar
не идёт через `downloadAttachment`'s sha256-проверку (публичный `<img
src>`, а не расшифровка сообщения).

### `profile.jsx`'s `handleAvatarChange` — аддитивная правка

После существующего `await updateProfile(id, { avatar: dataUrl });`
(локальный кэш, НЕ убирается — он же превью/офлайн-фолбэк) — best-effort
попытка (та же философия, что `handleBioSubmit`: локальное сохранение
никогда не зависит от публикации): взять активный Blossom-URL через
`loadUiSettings(id)`, `uploadAvatarBlob`, затем republish kind-0 ЧЕРЕЗ
`buildProfileEvent(privKeySig.value, { name: login, about: savedBio,
picture: url })` — ОБЯЗАТЕЛЬНО с текущим `savedBio` (не пустой строкой),
иначе аплоад аватара молча стёр бы уже опубликованное био. Ошибка сети —
видимый статус (тот же `publishStatus`, что уже использует
`handleBioSubmit`), не throw, не блокирует локальное превью аватара.

## Этап 38 — закрытие частично покрытых AC (TECH.md §15)

Аудит чтением кода (без домысла) четырёх находок предыдущего фонового
аудита. Результат: только AC-06 — реальный функциональный пробел
(аналогичный AC-09 до фикса этапа 35). Остальные три — уже рабочий
код, которому не хватало теста/живой проверки.

### AC-06 (реальный фикс) — `read-status.js`'s `rebuildReadStatus(ownerPubkey, privKey)`

Тот же паттерн, что `rebuildUiSettings` (этап 34): читает уже накопленный
локальный кэш bootstrap'а (`db.table("events")`, широкий REQ
`authors:[me]` без ограничения по kind — см. `bootstrap.js`) по
`[pubkey+kind]`, а не сеть напрямую. До этой функции `foldReadStatus`
вызывалась ТОЛЬКО из `markChatAsRead` на устройстве-публикаторе сразу
после публикации — второе устройство той же identity никогда не читало
чужой (или даже свой же с другого сеанса) kind 30070 обратно.
Группировка по chatId (d-tag) ОБЯЗАТЕЛЬНА — read-status разных чатов
независим, `lww.js`'s `pickLatest` применяется ПОСЛЕ группировки по
chatId, не глобально (глобальный latest стёр бы все чаты, кроме
одного). Вызывается из `transport.js`'s `connect()` сразу после
`rebuildUiSettings`.

### AC-FS-02 (тест, без нового кода) — out-of-order MLS

Живой прогон `mls-session.js`'s API (encrypt 3 сообщения, decrypt в
порядке 2,3,1) подтвердил: ts-mls хранит "пропущенные" ключи и
успешно расшифровывает все три, включая переживание
`serializeState`/`deserializeState` round-trip (критично — `chat.js`
персистит состояние после КАЖДОГО сообщения, а не держит в памяти).
Тесты добавлены на двух уровнях: `mls-session.test.js` (сырое API) и
`chat.test.js` (уровень приложения — реальный `receiveGroupMessageEvent`
с реальными kind 445 событиями, персистируя состояние между вызовами
через `asBob`, как это происходит в реальном приложении между приёмами).

### AC-AT-06 (рефакторинг + тест, без изменения поведения) — вложения через mirror

Логика выбора полей из mirror-payload (`sentAt`/`attachment`) была
инлайн внутри `transport.js`'s `syncMirroredHistory`'s `onBatch` —
непроверяема юнит-тестом отдельно от WebSocket-обвязки. Вынесена в
чистую функцию `mirror.js`'s `buildMirroredMessageRow(ownerPubkey,
payload, eventId)`, `transport.js` теперь просто вызывает её. Поведение
не изменилось (буквальный перенос кода), тесты подтверждают: дескриптор
вложения доходит без потерь, обратная совместимость со старыми
зеркалами (без `attachment`/`sentAt`) сохранена.

### AC-19 (живая проверка, без изменения кода) — lock after 24h idle

Механизм (`auth.js`'s `isIdle`/`touch`/`lock`/`startIdleWatcher`,
`app.jsx`'s реактивный рендер по `currentUser.value`) уже был собран
полностью и корректно на момент проверки — правок не потребовалось.
Живая проверка (Playwright Clock API, `page.clock.fastForward("24:02:00")`
вместо реального 24-часового ожидания): регистрация → вход →
продвижение фейковых часов → `startIdleWatcher`'s `setInterval`
реально сработал → экран переключился на "Разблокировка" реактивно
(без явного `navigate()`, чисто через `currentUser.value === null` в
`app.jsx`) → ввод пароля → снова в приложении.

## Этап 38-довесок — найденный реальным использованием баг: `handleBioSubmit` стирала аватар

Пользователь живьём завёл двух контактов, поставил обоим аватар и био
через реальный UI — био у собеседника отображалось, аватар оставался
кружком-инициалом. Прямой запрос к relay подтвердил: у аккаунтов
реально нет `picture` в последнем kind-0, хотя `about` есть.

**Причина** — асимметрия, внесённая этапом 37: `handleAvatarChange`
(новый код) republish'ит `{name, about: savedBio, picture: url}` —
корректно сохраняет текущее био. Но `handleBioSubmit` (существующий,
не тронутый на этапе 37 код) republish'ил `{name, about: bio}` — БЕЗ
`picture`. Kind 0 — replaceable-событие, отсутствие поля в новой
версии означает "поля больше нет", а не "не менялось". Если
пользователь сначала поставил аватар, а потом сохранил био —
следующий republish (из Bio-формы) стирал уже опубликованный аватар.

**Фикс** — новое поле `avatarUrl` на `keystore`'s строке аккаунта
(`core/crypto/keystore.js`'s `getProfile`/`updateProfile`, без нового
`db.version` — необязательное поле), ОТДЕЛЬНОЕ от `avatar` (dataUrl-
превью, непубликуемо — гигантский base64). `handleAvatarChange`
персистит `avatarUrl` сразу после успешной загрузки на Blossom.
`handleBioSubmit` теперь читает его из state и передаёт как `picture:
avatarUrl || undefined` в свой republish — симметрично тому, как
`handleAvatarChange` уже передавала `about: savedBio`.

Живая проверка (Playwright, реальный Blossom+strfry): загрузка аватара
→ сохранение био → прямой запрос к relay — `picture` И `about`
присутствуют ОБА одновременно, в любом порядке операций.

## Этап 39 (готовится) — шифрование локальной БД, per-table field split

Формализация — DESIGN.md, раздел "Этап 39". Ниже — точный список
полей по каждой таблице (по данным фонового аудита всех `db.table(X)`
вызовов в `src/`, 216 мест). `plaintextFields` — остаются top-level
полями строки (индексы + несекретные enum/флаги/счётчики).
`sensitiveFields` — уходят в один `{nonce, ciphertext}` blob через
`toEncryptedRow`/`fromEncryptedRow`.

### Tier 0 — крипто-состояние (наивысший приоритет)

| Таблица | plaintextFields | sensitiveFields |
|---|---|---|
| `ownKeyPackage` | `ownerPubkey` (PK) | `publicPackage`, `privatePackage`, `wireBytes` |
| `mlsGroups` | `ownerPubkey`, `groupId` | `state`, `contactPubkey` |
| `channelKeys` | `ownerPubkey`, `channelId`, `keyVersion` | `channelKey` |
| `commentAllowlists` | `ownerPubkey`, `channelId`, `keyVersion` | `allowedAuthors` |

### Tier 1 — пользовательский контент (прямая находка пользователя)

| Таблица | plaintextFields | sensitiveFields | Партиал на sensitive-поле |
|---|---|---|---|
| `messages` | `seq`(PK), `ownerPubkey`, `chatId`, `msgId`, `lamportTs`, `senderPubkey`, `id`, `status`, `deleted` | `text`, `sentAt`, `attachment`, `edited`, `editedAt` | ДА — `edits.js`/`deletions.js`, decrypt-merge-encrypt |
| `posts` | `ownerPubkey`, `id`, `channelId`, `createdAt`, `deleted`, `status`, `keyVersion` | `text`, `attachments`, `authorPubkey` | ДА — `post.js:40`, decrypt-merge-encrypt |
| `comments` | `ownerPubkey`, `id`, `postId`, `parentId`, `deleted` | `text` | нет (put всегда полный) |
| `channelMessages` | `ownerPubkey`, `id`, `channelId`, `createdAt`, `deleted`, `authorPubkey` | `text`, `attachment` | нет |
| `channels` | `ownerPubkey`, `id`, `channelTopic`, `role`, `creatorPubkey`, `createdAt`, `allowChatAttachments` | `name`, `description`, `rules`, `avatar` | ДА — `channel.js:159`, decrypt-merge-encrypt |

### Tier 2 — социальный граф (в основном тривиально/структурно)

| Таблица | plaintextFields | sensitiveFields |
|---|---|---|
| `groups` | `owner`, `id` | `name` |
| `groupMembers` | всё (`groupId`, `pubkey`) | — (нет отдельного контента) |
| `contacts` | всё (`owner`, `pubkey`) | — |
| `blockedContacts` | всё (`owner`, `pubkey`) | — |

### Tier 3 — модерация/черновики

| Таблица | plaintextFields | sensitiveFields |
|---|---|---|
| `channelReports` | `ownerPubkey`, `id`, `channelId`, `viewed`, `reporterPubkey`, `targetPubkey`, `contentType`, `contentId`, `reason` | `contentText` |
| `chatSyncState` | `ownerPubkey`, `chatId`, `lastReadLamportTs`, `oldestLoadedSeq` | `draftText`, `draftUpdatedAt` |
| `channelIgnores` | всё | — |
| `bannedMembers` | всё | — |
| `channelVisibilityGroups` | всё | — |
| `channelReaders` | всё | — |
| `contactRequests` | `owner`, `senderPubkey` | `greeting`, `createdAt` |
| `inboxRequests` | `owner`, `senderPubkey`, `createdAt` (индексируется отдельно) | `welcomeWireBytes` |

### Tier 4 — низкий приоритет

| Таблица | Заметка |
|---|---|
| `uiSettings` | URL relay/Blossom — метаданные, не контент |
| `outbox` | `event` УЖЕ готов стать публичным на relay через секунды |
| `channelKeyMeta` | только `currentVersion` — счётчик, нечего шифровать |
| `knownDevices`, `deviceIdentity` | не аудировано детально в этом заходе — вне явного скоупа этапа 39, отдельная проверка при необходимости |

### Пропустить полностью (мёртвый код)

`permissions` — объявлена в схеме, ни одного вызова `db.table` во всём
`src/`. `effectivePerms` — только пишется bulk-rebuild'ом
(`handlers.js`), ни разу не читается никаким доменным кодом —
отдельная находка (недостающее чтение прав?), не в скоупе этого этапа.

### Новый контракт `src/core/store/encrypted-table.js` (правка — было `wrapEncryptedTable`)

```js
export function toEncryptedRow(record, plaintextFields, dbKey);
// -> { ...subset(record, plaintextFields), nonce, ciphertext }
// ciphertext = encryptRow(остальные поля record, dbKey) — одним вызовом,
// не по одному полю.

export function fromEncryptedRow(row, dbKey);
// row === undefined -> undefined.
// -> { ...(row без nonce/ciphertext), ...decryptRow({nonce,ciphertext}, dbKey) }
```

`db-crypto.js`'s `encryptRow`/`decryptRow` — БЕЗ ИЗМЕНЕНИЙ (уже
корректны, `wrapEncryptedTable` был лишь неудачной формой API поверх
них). Старый `wrapEncryptedTable` — удаляется, `diagnostics.jsx`'s
самопроверка переписывается на новую пару функций (не самостоятельная
ценность, просто больше не единственный потребитель модуля).

## Этап 43 — локальный кэш вложений (decrypted, dbKey-encrypted at rest)

Найдено разметкой ролей хранилища (обсуждение с пользователем, вне
кода): `attachments` объявлена в схеме с этапа 1 (`sha256, messageId,
type, mime`), ни разу не использована ни одним доменным файлом —
мёртвая таблица. Переопределяется под реальную задачу: вложения сейчас
скачиваются с Blossom и расшифровываются заново при КАЖДОМ показе
(`attachment-view.jsx`, `URL.revokeObjectURL` при каждом размонтировании
компонента) — повторный просмотр того же вложения тратит и сеть, и
CPU на расшифровку впустую.

### Схема (`database.js`, аддитивно)

```js
db.version(12).stores({
  attachments: "[ownerPubkey+sha256], ownerPubkey, lastAccessedAt"
});
```

Owner-scoped ключ ОБЯЗАТЕЛЕН — тот же класс бага, что Lamport-часы
(этап 42-довесок): два локальных аккаунта в одном браузере не должны
делить кэш по голому `sha256`, иначе строка, записанная под dbKey
аккаунта A, не расшифруется под dbKey аккаунта B (или, ещё хуже,
маскирует чужой контент под тем же content-hash).

### `src/core/store/table-fields.js` (добавить)

```js
export const ATTACHMENT_CACHE_PLAINTEXT_FIELDS = ["ownerPubkey", "sha256", "mime", "size", "lastAccessedAt"];
```

`bytes` (сами расшифрованные байты вложения) — единственное sensitive-поле,
уходит в `ciphertext` через `toEncryptedRow` как есть (Uint8Array
корректно круглотрипается `db-crypto.js`'s replacer/reviver, найдено
этапом 39).

### `src/domain/attachments/cache.js` (новый файл)

```js
export const CACHE_BUDGET_BYTES = 200 * 1024 * 1024; // 200 МБ на владельца
export const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 дней с последнего обращения

export async function getCachedAttachment(ownerPubkey, dbKey, sha256Hex);
// -> Uint8Array | undefined (undefined на промах, НЕ бросает).
// При попадании обновляет lastAccessedAt = Date.now() той же строки (LRU-touch).

export async function putCachedAttachment(ownerPubkey, dbKey, sha256Hex, mime, bytes, options = {});
// put (не add — идемпотентно перезаписывает) toEncryptedRow(
//   { ownerPubkey, sha256: sha256Hex, mime, size: bytes.length, lastAccessedAt: Date.now(), bytes },
//   ATTACHMENT_CACHE_PLAINTEXT_FIELDS, dbKey
// ), затем вызывает evictIfNeeded(ownerPubkey, options).

export async function evictIfNeeded(ownerPubkey, { budgetBytes = CACHE_BUDGET_BYTES, ttlMs = CACHE_TTL_MS } = {});
// Псевдокод и инварианты — DESIGN.md, этап 43. options принимает
// budgetBytes/ttlMs НЕ из констант напрямую, а как параметры с
// дефолтом — тесты подставляют маленькие значения, не ждут гигабайты.

export async function getOrDownloadAttachment(ownerPubkey, dbKey, attachment, options = {});
// attachment — дескриптор F-AT-02 ({sha256, blossomUrl, encryptionKey, mime, ...}).
// hit -> getCachedAttachment(...), сеть НЕ дёргается.
// miss -> downloadAttachment(attachment, options) [upload.js, сигнатура БЕЗ
// изменений] -> putCachedAttachment(...) -> возвращает байты.
```

### Точка вызова — `attachment-view.jsx`

`ImageAttachment`/`AudioAttachment` (только не-`voiceInline` ветка —
она уже не ходит в сеть, F-AT-08)/`VideoAttachment`/`FileAttachment`:
`downloadAttachment(attachment)` → `getOrDownloadAttachment(currentUser.value.id,
dbKeySig.value, attachment)`. `ownerPubkey`/`dbKey` читаются напрямую
из `ui/signals/auth.js` (`currentUser`, `dbKeySig`) — тот же приём, что
уже используют другие компоненты, читающие сессионные сигналы
напрямую; проп-дриллинг через `message-bubble.jsx`/`post-card.jsx`/
`channel-chat.jsx`/`channel.jsx` не нужен, `AttachmentView` не меняет
свой публичный проп-интерфейс.

### Миграция

Та же позиция, что версии 5/6/9/11 — dev-стадия, данных к миграции
нет, `resetLocalDatabase()` уже покрывает этот класс изменений схемы.

### Правка (найдено ревью — Claude Opus, до коммита): честная мотивация + два слоя

Первая версия этой секции обосновывала дисковый кэш "быстрее". Неверно:
`dbKey`-расшифровка стоит РОВНО столько же CPU, сколько расшифровка
контентным ключом в `downloadAttachment` — выигрыша в CPU между "кэш
шифротекста" и "кэш плейнтекста, зашифрованного dbKey" нет вообще.
Хуже того — реализация ЧЕРЕЗ `toEncryptedRow`/`encryptRow`
(`db-crypto.js`) для больших бинарных вложений оказалась НЕ ПРОСТО
медленной, а **сломанной**: `encryptRow` JSON.stringify'ит значение и
кодирует `Uint8Array` в base64 через `btoa(String.fromCharCode.apply(null,
value))` — `.apply()` на массиве в мегабайты бросает `RangeError:
Maximum call stack size exceeded` (проверено эмпирически: 100 КБ ещё
проходит, 2 МБ уже падает — лимиты вложений 20-50 МБ, F-AT-04).

**Честная мотивация дискового слоя:** не скорость, а (а) работает без
сети/после перезагрузки (offline-first для медиа, не только для
текста), (б) AEAD-тег ChaCha20-Poly1305 попутно ловит порчу кэша на
диске (не отдельная фича, а бесплатное следствие того же примитива).

**Реальная причина тормозов** (найдена верно, но не там, где чинили) —
`attachment-view.jsx` вызывает `URL.revokeObjectURL` на КАЖДОМ
размонтировании компонента: пролистали мимо картинки и обратно —
полный цикл сеть+расшифровка заново, хотя байты только что были в
памяти вкладки. Это и есть настоящий CPU/UX-выигрыш, и его даёт только
отдельный слой в памяти, не дисковый кэш.

**Архитектура — два слоя, не один:**

- **Слой 1 (память, новый).** `src/ui/attachment-memory-cache.js` —
  LRU `Map<sha256Hex, {url, size}>` поверх уже созданных
  `Blob`/`ObjectURL`. Обязательное условие (иначе течёт дисциплина "на
  диске всё зашифровано" через оперативку) — очищается в `lock()`
  (`ui/signals/auth.js`) синхронно с обнулением `dbKeySig`/`privKeySig`.
- **Слой 2 (диск, правка существующего).** `src/domain/attachments/cache.js`
  переписывается на ПРЯМОЕ ChaCha20-Poly1305 поверх сырых байт (тот же
  примитив, что `core/crypto/file-crypto.js`, ключ — `dbKey` вместо
  случайного) — БЕЗ `toEncryptedRow`/JSON/base64 для поля с байтами.

#### `src/domain/attachments/cache.js` — новая сигнатура шифрования

```js
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
// db.table('attachments') строка теперь: { ownerPubkey, sha256, mime, size,
// lastAccessedAt, nonce, ciphertext } — nonce/ciphertext сырые Uint8Array,
// Dexie/IndexedDB structured clone хранит их нативно, JSON не нужен.

export async function getCachedAttachment(ownerPubkey, dbKey, sha256Hex);
// get([ownerPubkey, sha256Hex]) -> undefined на промах.
// bytes = chacha20poly1305(dbKey, row.nonce).decrypt(row.ciphertext).
// touch lastAccessedAt, вернуть bytes.

export async function putCachedAttachment(ownerPubkey, dbKey, sha256Hex, mime, bytes, options = {});
// nonce = crypto.getRandomValues(new Uint8Array(12));
// ciphertext = chacha20poly1305(dbKey, nonce).encrypt(bytes);
// put({ownerPubkey, sha256: sha256Hex, mime, size: bytes.length,
//      lastAccessedAt: Date.now(), nonce, ciphertext});
// evictIfNeeded(ownerPubkey, options) — БЕЗ ИЗМЕНЕНИЙ, работает с
// plaintext-полями size/lastAccessedAt, к шифрованию не касается.

// evictIfNeeded, getOrDownloadAttachment — БЕЗ ИЗМЕНЕНИЙ (см. секцию выше).
```

`ATTACHMENT_CACHE_PLAINTEXT_FIELDS`/`toEncryptedRow` для этой таблицы
БОЛЬШЕ НЕ ИСПОЛЬЗУЮТСЯ — вычеркнуть из `table-fields.js`, если были
добавлены. Осознанное исключение из общего "все таблицы через
`toEncryptedRow`" (DESIGN.md, этап 43-правка) — единственная таблица
с крупными бинарными полями, для которой этот путь ломается.

#### `src/ui/attachment-memory-cache.js` (новый файл)

```js
export const MEMORY_CACHE_BUDGET_BYTES = 50 * 1024 * 1024; // 50 МБ, оперативная память вкладки

export function getMemoryCachedUrl(sha256Hex);
// -> string | undefined. При попадании — переставляет запись в конец
// внутреннего Map (MRU), как lastAccessedAt-touch в дисковом слое.

export function putMemoryCachedAttachment(sha256Hex, bytes, mime, options = {});
// Если sha256Hex уже в кэше — вернуть существующий url (не плодить
// повторные Blob на один и тот же файл). Иначе: new Blob([bytes],
// {type: mime}) -> URL.createObjectURL -> сохранить {url, size} ->
// evictMemoryCacheIfNeeded(options) -> вернуть url.

export function evictMemoryCacheIfNeeded(options = {});
// { budgetBytes = MEMORY_CACHE_BUDGET_BYTES } = options. Сумма size по
// всем записям; если > budgetBytes — вытеснять с НАЧАЛА Map (порядок
// вставки = LRU, тот же принцип, что дисковый слой) через
// URL.revokeObjectURL + delete, пока не уложится.

export function clearMemoryCache();
// URL.revokeObjectURL для КАЖДОЙ записи, затем cache.clear(). Вызывается
// из ui/signals/auth.js's lock().
```

**Контракт ключа (этап 54-довесок, обязателен для НОВЫХ потребителей).**
Ключ `Map` — произвольная строка, не обязательно голый `sha256Hex`/
`manifestDigest`: ЛЮБОЙ вызывающий код, кэширующий представление,
которое отличается по БАЙТАМ от оригинала под тем же digest'ом (даунскейл,
обрезка, перекодирование), обязан добавлять СВОЙ префикс к ключу.
Найдено живой проверкой: `files.jsx`'s `FileThumbnail` кэшировала
200px-превью по голому `entry.blob` (=`manifestDigest`) — ДО унификации
digest-схем файлов и вложений чата (7.4) коллизий не было, ПОСЛЕ —
`attachment-view.jsx`'s `ImageAttachment` кэширует ПОЛНОРАЗМЕРНОЕ
вложение под тем же самым `manifestDigest` (особенно после 7.3's
дедупликации — вложение из хранилища ссылается на тот же блоб), и кто
записал первым — тот "выигрывал" слот для всех последующих читателей.
Фикс: `files.jsx` — `const THUMB_CACHE_PREFIX = "thumb:"`, ключ =
`THUMB_CACHE_PREFIX + entry.blob`. `attachment-view.jsx` (обе картинки/
аудио/видео) и `channels.jsx`'s `ChannelAvatarThumb` кэшируют
полноразмерный контент голым digest'ом — остаются совместимы друг с
другом, правки не потребовали.

#### Точка вызова — `attachment-view.jsx`

`ImageAttachment`/`AudioAttachment` (не-`voiceInline`)/`VideoAttachment`:
сначала синхронно `getMemoryCachedUrl(attachment.sha256)` — попадание,
url есть сразу, без единого await. Промах — как раньше,
`getOrDownloadAttachment(...)`, но результат ДОПОЛНИТЕЛЬНО прогоняется
через `putMemoryCachedAttachment(attachment.sha256, bytes, attachment.mime)`
вместо голого `URL.createObjectURL(new Blob(...))` — url теперь владеет
им общий кэш, не компонент. **Убрать** `URL.revokeObjectURL` из
cleanup-функции `useEffect` в этих трёх компонентах — жизненным циклом
url управляет `attachment-memory-cache.js` (вытеснение/`clearMemoryCache`),
повторный revoke компонентом на своём unmount убил бы url, которым в
это время уже владеет кэш и может отдать другому компоненту.
`FileAttachment` — БЕЗ ИЗМЕНЕНИЙ (одноразовое скачивание через `<a
download>`, нет постоянно отображаемого url — слой памяти ему не даёт
ничего, дисковый слой уже подключён).

#### Точка вызова — `ui/signals/auth.js`

`lock()` — добавить `clearMemoryCache()` первой строкой (до/вместе с
обнулением `dbKeySig`/`privKeySig`) — расшифрованное медиа не должно
пережить логическую блокировку сессии в памяти вкладки.

## Этап 44 — повторный показ мнемоники (найдено ревью — Claude Opus)

**Пробел (реальный, подтверждён по коду `unlock.jsx`):** мнемоника
показывается один раз при регистрации и нигде не сохраняется — ни в
"быстрой" регистрации (`handleRegisterSubmit`, мнемоника генерируется
и используется, но НИКОГДА не показывается пользователю вообще — сама
UI честно предупреждает об этом в шаге "done": *"Показать фразу для
резервной копии можно будет позже в настройках"* — но такой функции не
существовало). Не записал/потерял устройство — identity целиком
потеряна безвозвратно, не только история переписки. Чинится дёшево:
хранить мнемонику зашифрованной ТЕМ ЖЕ паролем, что приватный ключ, и
дать способ посмотреть её снова по паролю (как в любом крипто-кошельке).

### `src/core/crypto/keystore.js` — правка контракта

```js
export async function encryptAndStore(privKey, password, id, meta = {}, mnemonic);
// БЕЗ ИЗМЕНЕНИЙ для privKey/meta — новый 5-й параметр, необязательный.
// Если mnemonic передана (непустая строка): дополнительно генерируется
// СВОЙ mnemonicIv (12 байт, НЕ переиспользует iv приватного ключа —
// разные plaintext под одним AES-GCM-ключом обязаны иметь разные nonce),
// шифрует mnemonic ТЕМ ЖЕ encKey (тот же salt+password, что privKey) —
// один пароль отпирает и ключ, и фразу. Пишет в ту же строку keystore:
// { ...как раньше, mnemonicIv, mnemonicCiphertext }.
// Если mnemonic не передана (import-key — импорт готового приватного
// ключа/nsec, фразы не существует в принципе) — mnemonicIv/mnemonicCiphertext
// не пишутся вовсе, не пустые заглушки.

export async function decryptMnemonic(password, id);
// -> string (сама фраза). get(id) -> нет записи или нет mnemonicCiphertext
// -> throw new Error("keystore: ...") (для СТАРЫХ аккаунтов, созданных
// до этого этапа, и для import-key — честная ошибка, не фантомная
// пустая фраза). Неверный пароль -> AES-GCM tag mismatch -> throw (тот
// же паттерн, что decryptPrivateKey).

export async function listAccounts();
// БЕЗ ИЗМЕНЕНИЙ по форме, ОДНО новое поле: { id, login, avatar, hasMnemonic }.
// hasMnemonic = !!record.mnemonicCiphertext — Settings использует это,
// чтобы не рисовать "Показать фразу" там, где показывать нечего.
```

### Точки вызова — `unlock.jsx` (обе ветки регистрации)

- `handleRegisterSubmit` (быстрая регистрация, строка ~128): передать
  `generated` (мнемоника уже генерируется здесь, просто раньше
  отбрасывалась) 5-м аргументом в `encryptAndStore`.
- `handleAdvancedPasswordSubmit` (строка ~169, общая для create/import-mnemonic/
  import-key): передать `mnemonic || undefined`. Требует ДОПОЛНИТЕЛЬНОЙ
  правки — сейчас `mnemonic`-state заполняется ТОЛЬКО веткой `create`
  (`openAdvanced("create")` → `setMnemonic(generateMnemonic())`), для
  `import-mnemonic` фраза вводится в `importInput`, но никогда не
  попадает в `mnemonic`-state (найдено чтением кода — иначе передался
  бы устаревший/пустой mnemonic от предыдущего захода). Правка:
  `openAdvanced(kind)` сбрасывает `setMnemonic("")` для ВСЕХ веток
  (было — только неявно), ветка import-mnemonic перед
  `setStep("advanced-password")` вызывает `setMnemonic(trimmed)`.
  Ветка import-key НИЧЕГО не пишет в mnemonic — остаётся `""` →
  `mnemonic || undefined` корректно ничего не сохраняет.

### Новый UI — `settings.jsx`, секция "Секретная фраза восстановления"

Password-gate: кнопка "Показать фразу" → инлайн-форма (пароль +
"Подтвердить") → `decryptMnemonic(password, ownerPubkey)` → успех:
`<MnemonicDisplay words={phrase.split(" ")} />` + кнопка "Скрыть"
(сбрасывает состояние, фраза не остаётся в DOM/state после скрытия);
неверный пароль → "Неверный пароль." (тот же текст ошибки, что
`handleLoginSubmit` в unlock.jsx). Если `hasMnemonic === false`
(старый аккаунт до этапа 44, или вход по приватному ключу) — вместо
кнопки короткое пояснение, почему функция недоступна для ЭТОГО
аккаунта (честно, не скрывать молча).

## Этап 45 — AC-16 Tier 4 (низкий приоритет) — `uiSettings`/`outbox`/`channelKeyMeta`

Исправление найденной путаницы в нумерации: этап 42 назвал себя в
PLAN.md "Tier 4 (последний)", но по составу таблиц
(`channelReports`/`chatSyncState`/`contactRequests`/`inboxRequests`)
это Tier 3 из исходной таблицы приоритизации (раздел "Этап 39" выше,
`table-fields.js:33` уже правильно называет это Tier 3). Реальный
Tier 4 — три таблицы ниже — не был реализован вовсе. Ценность
шифрования для них сама по себе спорная (см. таблицу "Tier 4" выше:
`uiSettings` — метаданные, не контент; `outbox` — событие и так станет
публичным на relay через секунды; `channelKeyMeta` — только счётчик
`currentVersion`) — пользователь тем не менее выбрал реализовать, ради
полноты AC-16 (100% materialized-view таблиц под `dbKey`, без
исключений по "спорности"). `knownDevices`/`deviceIdentity` — вне
скоупа (как и в исходной таблице Tier 4 — отдельный, не проведённый
аудит).

### `table-fields.js` — новые константы

```js
export const UI_SETTINGS_PLAINTEXT_FIELDS = ["ownerPubkey"];
export const OUTBOX_PLAINTEXT_FIELDS = ["seq", "eventId", "status", "retryCount"];
export const CHANNEL_KEY_META_PLAINTEXT_FIELDS = ["ownerPubkey", "channelId"];
```

### `ui-settings.js` — правка контракта (dbKey — новый параметр сразу после privKey, тот же DI-стиль, что везде)

```js
export function loadUiSettings(ownerPubkey, dbKey);
// db.table("uiSettings").get(ownerPubkey) -> fromEncryptedRow(row, dbKey)
// (fromEncryptedRow сама возвращает undefined на undefined — ветка
// "нет локальной записи, дефолт" не меняется).

export function saveUiSettings(ownerPubkey, privKey, dbKey, settings, publish);
// put(toEncryptedRow({ ownerPubkey, ...settings }, UI_SETTINGS_PLAINTEXT_FIELDS, dbKey))
// publish(buildUiSettingsEvent(...)) — БЕЗ ИЗМЕНЕНИЙ (kind 30072 остаётся
// NIP-44-шифрованным как раньше — это отдельный, уже существующий слой
// для синхронизации между СВОИМИ устройствами через relay; dbKey — только
// для локального кэша на этом устройстве, никогда не путать эти два шифра).

export function rebuildUiSettings(ownerPubkey, privKey, dbKey);
// parseUiSettingsEvent (kind 30072, NIP-44) — БЕЗ ИЗМЕНЕНИЙ; put в конце
// оборачивается toEncryptedRow(..., dbKey), как saveUiSettings.

// addRelayUrl/removeRelayUrl/setActiveRelayUrl/addBlossomUrl/removeBlossomUrl/
// setActiveBlossomUrl — все шесть получают dbKey ТРЕТЬИМ параметром
// (ownerPubkey, privKey, dbKey, url, publish) — тонкие обёртки над
// loadUiSettings/saveUiSettings, просто пробрасывают дальше.
```

Вызывающие места (dbKey уже присутствует в области видимости везде,
двойной проверкой по коду — новых сигналов/пропсов не требуется, кроме
одного): `transport.js`'s `connect(pubkeyHex, privKey, dbKey)` (вызовы
`loadUiSettings`/`rebuildUiSettings` внутри) и `onBatch`-замыкания
`refreshChannelContentSubscription(ownerPubkey, dbKey)`/
`refreshGroupMessageSubscription(ownerPubkey, privKey, dbKey, publish)`
(оба уже принимают `dbKey`); `profile.jsx`'s `handleAvatarChange`
(`dbKeySig.value` уже импортирован) и `RelayBlossomSection` (НОВЫЙ
проп `dbKey`, проброшенный из `<RelayBlossomSection ownerPubkey={id}
privKey={...} dbKey={dbKeySig.value} />`); `settings.jsx` — НОВЫЙ
импорт `dbKeySig` из `auth.js` (сейчас импортирован только
`privKeySig`), `persist()`/начальный `loadUiSettings` получают
`dbKeySig.value`.

### `outbox.js` — правка контракта

```js
export function enqueue(event, dbKey);
// db.outbox.add({ eventId, status:'pending', retryCount:0, ...toEncryptedRow({event}, [], dbKey) })
// ВСЁ содержимое record, кроме eventId/status/retryCount (plaintext,
// индексируемые), уходит в шифр — практически только поле `event`
// (сам подписанный Nostr-event целиком).

export function listPending(dbKey);
// db.outbox.where("status").equals("pending").sortBy("seq")
// -> .map(row => fromEncryptedRow(row, dbKey)) — возвращает СПИСОК
// РАСШИФРОВАННЫХ записей (call sites читают record.event как раньше).

export function markSent(seq);
export function markFailed(seq);
// БЕЗ ИЗМЕНЕНИЙ — партиал .update() трогает ТОЛЬКО status/retryCount,
// оба plaintext-поля вне ciphertext, decrypt-merge-encrypt не нужен
// (иначе, чем messages.text/posts.text на Tier 0/1 — там партиал бил
// по самому зашифрованному полю, здесь нет).

export function drain(publishFn, dbKey);
// listPending(dbKey) вместо listPending() — единственное изменение тела.
```

Вызывающие места: `chat.js`'s `sendMessage` (`enqueue(event)` →
`enqueue(event, dbKey)` — `dbKey` уже параметр функции, строка рядом
уже шифрует `mlsGroups` тем же ключом); `transport.js`'s
`drainOutboxSafely(publish)` → `drainOutboxSafely(publish, dbKey)` (оба
вызова — внутри `connect(pubkeyHex, privKey, dbKey)`, `dbKey` уже в
замыкании); `diagnostics.jsx` self-check (этап 5) — генерирует
собственный throwaway `dbKey` через уже импортированные
`deriveMasterSecret`/`deriveDbKey` (тот же приём, что остальные
self-check тесты, использующие домен, требующий `dbKey`).

### `channelKeyMeta` — правка контракта (7 файлов домена)

Тот же паттерн, что уже применяется в этих же файлах к `channelKeys`
(`toEncryptedRow`/`fromEncryptedRow`, `CHANNEL_KEYS_PLAINTEXT_FIELDS`)
— сигнатуры функций НЕ меняются, `dbKey` уже параметр каждой из них.

- `.get([ownerPubkey, channelId])` → обернуть
  `fromEncryptedRow(await db.table("channelKeyMeta").get([...]), dbKey)`
  (`channel.js` ×3, `channel-access.js` ×1, `post.js` ×2,
  `channel-chat.js` ×2, `channel-visibility.js` ×1, `moderation.js` ×1,
  `comments.js` ×2).
- `.put({ownerPubkey, channelId, currentVersion})` → обернуть
  `toEncryptedRow({...}, CHANNEL_KEY_META_PLAINTEXT_FIELDS, dbKey)`
  (`channel.js` ×2).
- `.update([ownerPubkey, channelId], {currentVersion: vNew})` → ЗАМЕНА
  на `.put(toEncryptedRow({ownerPubkey, channelId, currentVersion: vNew}, CHANNEL_KEY_META_PLAINTEXT_FIELDS, dbKey))`
  — партиал-инвариант: `currentVersion` — ЕДИНСТВЕННОЕ sensitive-поле
  этой таблицы, голый `.update()` писал бы его поверх/рядом с
  `nonce`/`ciphertext` как plaintext (тот же класс бага, что
  `messages.text` на Tier 0/1). Два места: `channel-visibility.js:35`,
  `moderation.js:103`.
- `.delete([ownerPubkey, channelId])` — БЕЗ ИЗМЕНЕНИЙ (`moderation.js:144`).

Тесты, читающие `db.table("channelKeyMeta").get(...).currentVersion`
напрямую (`channel.test.js`, `channel-visibility.test.js`,
`moderation.test.js`) — обернуть чтение в `fromEncryptedRow(row, DB_KEY)`,
тот же приём, что уже применяется в этих файлах к `channelKeys`.

## Backlog — утечка метаданных через kind 30053 (найдено ревью, обсуждение с пользователем после этапа 45)

**Пробел (не баг, осознанно отложено):** приватность контента канала
держится на шифровании (`channelKey` + kind 30053, NIP-44-адресованный
VIEW-грант), НЕ на ACL релея — проверено живым сырым `WebSocket`-запросом
к своему strfry (без какой-либо авторизации relay отдаёт ВСЕ kind
30060-30063 события, содержимое — валидный шифротекст, не парсится).
Это делает канал безопасным на ЛЮБОМ relay, включая публичные — но kind
30053 несёт тег `["p", readerPubkey]` В ОТКРЫТОМ ВИДЕ. Пассивный
наблюдатель relay не прочтёт контент, но видит "этот pubkey получил
грант на канал с таким-то `channelTopic`" — коррелируя гранты во
времени, можно восстановить фрагмент социального графа (кто с кем в
одной приватной группе), не зная названия/содержимого канала.

**Почему отложено:** (1) деплой — локальная сеть, не публичный интернет
(CLAUDE.md) — пул тех, кто способен пассивно наблюдать relay, и так уже
доверенный; (2) риск актуализируется вместе с разделом "Обзор"
(знакомство с чужими людьми через публичную карточку) — до его
появления угроза не растёт; (3) тот же класс компромисса, что уже
принятый L-07 (бывший читатель сохраняет старые эпохи) — известная,
проговорённая граница модели, не скрытая дыра.

**Если когда-нибудь понадобится закрыть:** перевести kind 30053 на
gift-wrap (`nip59Wrap`, тот же паттерн, что уже используется для
`CONTACT_REQUEST_KIND`/`CHANNEL_SUBSCRIBE_REQUEST_KIND`/MLS-welcome) —
инфраструктура уже есть в проекте, это не новая примитив-работа, скорее
перевод точки доставки на уже существующий `giftWrapSubscriber` вместо
отдельной по-pubkey-тегу подписки.

## Этап 46 — раздел "Обзор"

Формализация состояний — DESIGN.md, раздел "Этап 46". Ниже — точный
протокольный и файловый контракт.

### Новые kind'ы

```
DISCOVERY_KIND = 30073   // parameterized-replaceable, d="discovery" (буквально,
                          // тот же приём, что KIND_UI_SETTINGS=30072). ПУБЛИЧНЫЙ,
                          // НЕ зашифрован — весь смысл в том, чтобы кто угодно
                          // прочитал. content = JSON.stringify({ visible: bool,
                          // showChannels: bool, channels: [{id, name, description}] }).
                          // Выключение видимости — НЕ NIP-09 delete (relay не
                          // обязан его уважать), а publish той же replaceable
                          // формы с visible:false — гарантированно вытесняет
                          // предыдущую версию у всех, кто ещё не забрал.

ACQUAINT_CANCELLED_KIND = 3005   // gift-wrap rumor (nip59Wrap), content: "",
                                   // tags: [] — тот же минимальный шаблон, что
                                   // CONTACT_ACCEPTED_KIND. Смысл несёт САМ ФАКТ
                                   // приёма + rumor.pubkey (аутентичный отправитель
                                   // из unwrap, не из тега).
```

### `src/domain/discovery/discovery.js` (новый файл)

```js
export function buildDiscoveryEvent(privKey, { visible, showChannels, channels }, createdAt = Math.floor(Date.now()/1000));
// content = JSON.stringify({visible, showChannels, channels}), tags:[["d","discovery"]].
// channels — [{id, name, description}], ПУСТОЙ массив, если showChannels=false
// (не полагаться на клиента-получателя, чтобы он сам не показал лишнее).

export function parseDiscoveryEvent(event);
// JSON.parse(event.content), defensively: visible/showChannels -> !!x,
// channels -> Array.isArray ? фильтр валидных {id,name,description} : [].
// Контент — от ЛЮБОГО чужого pubkey, НЕ доверенный ввод, парсинг должен
// пережить произвольный мусор (try/catch на JSON.parse на стороне вызывающего,
// тот же принцип, что parseProfileEvent в fetchProfiles).

export async function loadDiscoverySettings(ownerPubkey);
// db.table("discoverySettings").get(ownerPubkey) -> {visible, showChannels,
// channelIds} | дефолт {visible:false, showChannels:false, channelIds:[]}.
// ЛОКАЛЬНОЕ зеркало собственного выбора — тот же бутстрап-принцип, что
// loadUiSettings (не ждать relay round-trip, чтобы открыть свой же тумблер).

export async function publishDiscoverySettings(ownerPubkey, privKey, dbKey, { visible, showChannels, channelIds }, publish);
// 1. db.table("discoverySettings").put({ownerPubkey, visible, showChannels, channelIds})
//    (локально, СРАЗУ, офлайн-first — тот же принцип, что saveUiSettings).
// 2. channels = showChannels ? (await listOwnedChannels(ownerPubkey, dbKey))
//    .filter(c => channelIds.includes(c.id)).map(c => ({id:c.id, name:c.name,
//    description:c.description})) : [].
// 3. await publish(buildDiscoveryEvent(privKey, {visible, showChannels, channels})) —
//    best-effort (try/catch, не бросает наружу — тот же принцип, что saveUiSettings).
```

### `src/domain/contacts/requests.js` — правка контракта (добавить, не менять существующее)

```js
export const ACQUAINT_CANCELLED_KIND = 3005;
export function buildAcquaintCancelledRumor() {
  return { kind: ACQUAINT_CANCELLED_KIND, content: "", tags: [], created_at: Math.floor(Date.now()/1000) };
}
```

### `src/ui/signals/discovery.js` (новый файл — сигналы + действия, тот же паттерн, что `signals/contacts.js`)

```js
export const discoveryProfiles = signal([]); // [{pubkey, visible, showChannels, channels, updatedAt}], уже отфильтровано:
                                               // visible===true И pubkey НЕ в contacts.value (см. refreshDiscoveryProfiles)
export const outgoingRequests = signal([]);   // [{owner, targetPubkey, createdAt}]

export async function refreshDiscoveryProfiles(ownerPubkey);
// Читает db.table("discoveryProfiles").toArray(), фильтрует visible && !contacts
// (contacts.value уже загружен отдельно, contacts.jsx-конвенция), пишет в сигнал.

export async function refreshOutgoingRequests(ownerPubkey);
// db.table("outgoingAcquaintanceRequests").where("owner").equals(ownerPubkey).toArray()
// -> outgoingRequests.value.

export async function sendAcquaintanceRequestAction(ownerPubkey, privKey, targetPubkey, publish);
// НЕ вызывает addContactAction (отличие от sendContactRequestAction — CONTRACTS.md/
// DESIGN.md этапа 46, инвариант). await db.table("outgoingAcquaintanceRequests")
// .put({owner: ownerPubkey, targetPubkey, createdAt: Math.floor(Date.now()/1000)});
// затем await requirePublishOk(publish, nip59Wrap(buildContactRequestRumor(""), privKey, targetPubkey))
// — ТОТ ЖЕ CONTACT_REQUEST_KIND, что форма "Добавить контакт" (получатель не
// различает источник). Локальная запись — ДО publish (офлайн-first, тот же
// принцип, что остальной проект); если publish бросает — запись остаётся,
// поведение как остальные best-effort действия (пользователь может закрыть
// заявку сам, если увидит, что не долетело).

export async function cancelAcquaintanceRequestAction(ownerPubkey, privKey, targetPubkey, publish);
// await db.table("outgoingAcquaintanceRequests").delete([ownerPubkey, targetPubkey])
// СРАЗУ (оптимистично, чекбокс/галочка пропадает немедленно) — затем best-effort
// (try/catch, не бросает) publish(nip59Wrap(buildAcquaintCancelledRumor(), privKey, targetPubkey)).
```

### `transport.js` — правки

```js
export async function fetchDiscoveryProfiles();
// Тот же паттерн, что fetchProfiles/fetchKeyPackage (одноразовый REQ до EOSE,
// НЕ персистентная подписка — раздел "Обзор" не нужно держать в реальном
// времени открытым фоном). Filter: {kinds:[DISCOVERY_KIND]} БЕЗ authors —
// первая широкая (не authors:[конкретные]) подписка в проекте, известное и
// принятое ограничение — не масштабируется без пагинации за пределы
// локальной сети/альфы (см. CONTRACTS.md backlog-заметку рядом, не блокер
// сейчас). На каждое полученное событие — try{parseDiscoveryEvent}, если
// удалось — db.table("discoveryProfiles").put({pubkey: event.pubkey, ...parsed,
// updatedAt: event.created_at}) (put, не add — kind replaceable, но REQ без
// since/until вернёт только последнюю версию каждого автора от relay уже
// по протоколу NIP-01, put лишь синхронизирует локальный кэш).

// giftWrapSubscriber — новая ветка:
} else if (rumor.kind === ACQUAINT_CANCELLED_KIND) {
  await db.table("contactRequests").delete([pubkeyHex, rumor.pubkey]);
  activityChanged = true; // contacts.jsx узнаёт, что входящая заявка исчезла
}
// CONTACT_ACCEPTED_KIND — ДОПОЛНИТЬ существующую ветку (не менять её текущее
// поведение, только добавить строку):
} else if (rumor.kind === CONTACT_ACCEPTED_KIND) {
  await db.table("outgoingAcquaintanceRequests").delete([pubkeyHex, rumor.pubkey]);
  notify(...); // как было
}
```

### `database.js` — `db.version(13)`

```js
db.version(13).stores({
  discoverySettings: "ownerPubkey",
  discoveryProfiles: "pubkey",
  outgoingAcquaintanceRequests: "[owner+targetPubkey], owner",
});
```

Ни одна из трёх таблиц не несёт содержательного текста, требующего
шифрования по AC-16-логике (`discoverySettings`/`outgoingAcquaintanceRequests`
— голые pubkey/флаги, тот же класс, что `groupMembers`/`contacts` на Tier 2;
`discoveryProfiles` — локальный кэш ЧУЖИХ данных, уже публичных на relay по
определению — шифровать локальную копию публичного смысла нет).

### UI — новый экран `src/ui/screens/discovery.jsx` + `nav-items.js`/`app.jsx`

Новый пункт навигации `"discovery"` → `"Обзор"` (между "Контакты" и
"Настройки" — обсуждение с пользователем не уточняло порядок, любое
разумное место подходит).

Сверху — тумблер "Показывать меня в обзоре" (`checked = settings.visible`,
onChange → `publishDiscoverySettings(..., {visible: true/false, showChannels:
settings.showChannels, channelIds: settings.channelIds}, publish)`, при
включении УЖЕ показывает checkbox "Показывать список моих каналов" ниже
(условный рендер по `settings.visible`). Отметка чекбокса раскрывает список
`await listOwnedChannels(ownerPubkey, dbKey)` с чекбоксом на каждый (по
умолчанию НИ ОДИН не отмечен — явный opt-in per DESIGN.md/обсуждению).
Кнопка "OK" вызывает `publishDiscoverySettings` с текущим выбором.

Ниже — сетка карточек по `discoveryProfiles.value` (аватар из
`profiles.value[pubkey]`? — НЕТ: kind 0 отдельно, discovery-событие не несёт
avatar/bio — карточка должна ДОПОЛНИТЕЛЬНО дотянуть kind 0 через уже
существующий `fetchProfiles`/`ensureProfilesFetched`, тот же паттерн, что
`contacts.jsx`). Если `showChannels` — под био список
`channels.map(c => c.name + ": " + c.description)`.

Клик по карточке без исходящей заявки → `sendAcquaintanceRequestAction` →
зелёная галочка (проверка `outgoingRequests.value.some(r => r.targetPubkey
=== pubkey)`). Повторный клик (галочка уже есть) →
`cancelAcquaintanceRequestAction`.

### `contacts.jsx` — новая секция "Отправленные заявки"

Список `outgoingRequests.value` (аватар/имя через `profiles`, тот же
паттерн, что список входящих `contactRequests`) с кнопкой "Отменить" →
`cancelAcquaintanceRequestAction` (тот же вызов, что untoggle карточки в
Обзоре — единственная точка правды, не дублировать логику).

### Найденные живым E2E правки контракта (за пределами первоначального плана)

1. **`CONTACT_ACCEPTED_KIND` обязан вызывать `addContactAction`.**
   `sendAcquaintanceRequestAction` (в отличие от `sendContactRequestAction`)
   намеренно НЕ добавляет адресата в контакты при отправке (инвариант
   DESIGN.md) — но это означало, что после принятия заявки взаимность
   контактов была ОДНОСТОРОННЕЙ: принявший добавлял отправителя (через
   свой `acceptContactRequestAction`), а сам отправитель никогда не получал
   принявшего в СВОИ контакты — "Обзор" продолжал бы показывать его
   карточку бесконечно. Правка: `transport.js`'s ветка `CONTACT_ACCEPTED_KIND`
   теперь ТАКЖЕ вызывает `addContactAction(pubkeyHex, privKey, rumor.pubkey,
   publisher.publish)` — идемпотентно и безопасно для СТАРОГО flow
   (форма "Добавить контакт"), где адресат уже был добавлен ранее.
2. **Порядок в `discovery.jsx`:** `refreshContacts` обязан быть
   `await`-нут ДО `refreshDiscoveryProfiles` в эффекте монтирования —
   иначе фильтр "скрыть уже существующих контактов" читает устаревший
   `contacts.value` (гонка: `ensureConnected` часто резолвится раньше,
   чем параллельный `refreshContacts` успевал прочитать IndexedDB).

### ЗАКРЫТО (этап 46-довесок-2) — `ensureConnected` теперь проверяет реальное состояние соединения

Было в backlog (найдено живым E2E этапа 46, не относилось к самому
разделу "Обзор" — предсуществующий пробел в `transport.js`). Правка:
`ensureConnected(pubkeyHex, privKey, dbKey)` больше не решает по одному
кэш-флагу (`connectPromise` резолвился когда-то), а смотрит на
`connection.getState()` НАПРЯМУЮ:

```js
export async function ensureConnected(pubkeyHex, privKey, dbKey) {
  if (connectedForPubkey === pubkeyHex && connection) {
    if (connection.getState() === "connected") return;
    if (connectPromise) {
      await connectPromise;
      if (connection.getState() === "connected") return;
    }
    await waitForConnState(connection, (s) => s === "connected", 8000);
    return;
  }
  // ...прежний полный teardown()+connect() для новой identity
}
```

Живым тестированием (реальный обрыв TCP — убит и заново поднят процесс
relay, не `context.setOffline()`: у офлайн-режима браузера нет гарантии
мгновенного закрытия уже установленного WebSocket) найдены и закрыты
ДВА разных расхождения старой проверки с реальностью: (а) `connectPromise`
ещё "жив", но соединение прямо сейчас не `"connected"` (реконнект
`relay-pool.js` в процессе, экспоненциальный backoff) — раньше код уходил
на `publish()`/подписку немедленно и падал с "relay-pool: send()
недоступен в состоянии 'disconnected'"; (б) `connectPromise` уже сброшен
в `null` (побочный эффект предыдущей неудачной попытки где-то ещё), а
соединение к этому моменту УЖЕ снова `"connected"` — раньше это ошибочно
уходило в полный `teardown()+connect()`, обрывая рабочее соединение
просто потому, что не совпал один кэш-флаг. Оба случая воспроизведены и
подтверждены закрытыми: клик сразу после поднятия relay (соединение ещё
восстанавливается) и клик через паузу (уже восстановлено, но
`connectPromise` в состоянии из пункта "б") — оба раза без ошибки,
`publish` проходит.

Заодно закрыт смежный, найденный пользователем в реальном использовании
пробел — `fetchDiscoveryProfiles()` (kind 30073, "Обзор") раньше только
добавляла/обновляла записи в `discoveryProfiles`, никогда не убирая те,
что пропали с relay (автор перестал публиковать, событие удалено с
relay и т.п.) — локальный кэш рос монотонно и продолжал рисовать
карточки "призраков". Теперь, раз REQ без `authors` — это ПОЛНЫЙ снимок
сети, функция после `onEose` удаляет из `discoveryProfiles` все строки,
чьи pubkey не встретились в ЭТОМ снимке (`bulkDelete` по разнице
множеств).

## Этап 47 — гибкие уведомления

Обсуждение с пользователем (см. диалог этой сессии) — формализация
состояний/приоритета разрешения уровня — DESIGN.md, раздел "Этап 47".

### `src/domain/notifications/notifier.js` — правка контракта

```js
export const NOTIFICATION_LEVELS = ["off", "badge", "popup", "sound"];
// Упорядоченное множество (DESIGN.md) — НЕ 3 независимых булевых флага.

export function resolveNotificationLevel(settings, category, subcategory, entityId);
// Приоритет (DESIGN.md, ИСПРАВЛЕНО — найдено собственным тестом при
// реализации, порядок в первой версии этого контракта был перепутан):
// (1) category==="moderation" && subcategory!=="reports" -> "sound" ВСЕГДА,
// ДАЖЕ при notifications.enabled===false (бан/предупреждение/удаление —
// принудительно, вне settings ЦЕЛИКОМ, поведение этапа 34 для этих
// подкатегорий НЕ меняется — "moderation игнорирует settings целиком" уже
// означало "включая enabled", не только категориальные тумблеры);
// (2) notifications.enabled===false -> "off" для ВСЕГО ОСТАЛЬНОГО (включая
// moderation.reports); (3) entityId и есть explicit override для него
// (messages.overrides[entityId] ИЛИ channels.overrides[entityId]?.[subcategory])
// -> override ПОБЕЖДАЕТ целиком, даже "off"; (4) иначе — дефолт
// категории/подкатегории; неизвестная
// категория -> "off".

export function notify(settings, category, subcategory, { title, body }, entityId, backend = defaultWebBackend());
// level = resolveNotificationLevel(...). "off" -> return null, ничего не
// делает (даже бейдж не трогает — счётчик непрочитанного считается ОТДЕЛЬНО,
// из фактического unread-состояния в БД, см. ниже; notify() лишь решает,
// показывать ли popup/играть ли звук, он НЕ источник истины для бейджа).
// level∈{popup,sound} -> backend.showPopup(title, body). level==="sound" ->
// ДОПОЛНИТЕЛЬНО backend.playSound(). Возвращает level (тесты проверяют
// побочные эффекты через backend-мок, не строку).
```

### `src/domain/notifications/backend.js` (новый файл) — задел под Tauri/Capacitor

```js
export function createWebNotificationBackend(options = {}) {
  // options.NotificationImpl (DI, как раньше), options.audioSrc (URL звука,
  // bundled asset), options.AudioImpl (DI для тестов, по умолчанию globalThis.Audio).
  return {
    showPopup(title, body) { /* тот же new NotificationImpl(...), что раньше */ },
    playSound() { /* new AudioImpl(audioSrc).play().catch(() => {}) — автоплей
                     может быть заблокирован политикой браузера без прежнего
                     user-gesture, ошибка проглатывается, не критично */ },
    setBadgeCount(n) { /* navigator.setAppBadge?.(n) / navigator.clearAppBadge?.()
                           — Badging API, НЕ во всех браузерах; отсутствие
                           метода — no-op, не throw (feature-detect) */ },
  };
}
// Tauri/Capacitor-порт (ПОЗЖЕ, вне этого этапа): та же форма {showPopup,
// playSound, setBadgeCount}, backend передаётся в notify() явным параметром —
// вызывающий код (transport.js) не меняется вовсе.
```

### `src/domain/settings/ui-settings.js` — правка `DEFAULT_NOTIFICATIONS`

```js
export const DEFAULT_NOTIFICATIONS = {
  enabled: true,
  contacts: { newRequests: "sound", accepted: "popup" },
  messages: { default: "sound", overrides: {} },        // overrides: {[contactPubkey]: level}
  channels: {
    posts: "popup", comments: "popup", chat: "sound",
    overrides: {},                                       // overrides: {[channelId]: {posts?, comments?, chat?}}
  },
  replies: "sound",           // ответ на МОЙ пост/комментарий — глобально, без per-entity (DESIGN.md)
  moderation: { reports: "popup" },  // бан/warn/delete — вне settings, см. resolveNotificationLevel
};
```

Старый булев формат (`enabled`/`newRequests`/`incoming` как `true/false`,
без `overrides`) НЕ мигрируется явно (dev-стадия, `mergeWithDefaults` уже
спреды дефолт+сохранённое — старые булевы поля просто повиснут неиспользуемым
мусором рядом с новыми, `resolveNotificationLevel` их не читает).

### Read-tracking каналов — новый файл `src/domain/content/channel-read-status.js`

Прямая аналогия `messaging/read-status.js` (см. DESIGN.md за отличия):

```js
export const CHANNEL_READ_STATUS_KIND = 30074;

export function buildChannelReadStatusEvent(privKey, { channelId, lastReadAt }, createdAt = Math.floor(Date.now()/1000));
// NIP-44 self-encrypted content (тот же приём, что buildReadStatusEvent),
// tags: [["d", channelId]].

export function parseChannelReadStatusEvent(event, privKey);

export async function foldChannelReadStatus(event, privKey);
// db.table("channelSyncState").get([ownerPubkey, channelId]) -> LWW
// (raw.lastReadAt >= lastReadAt -> return). БЕЗ toEncryptedRow/fromEncryptedRow
// — таблица целиком plaintext (см. ниже), put() голого объекта.

export async function markChannelAsRead(ownerPubkey, privKey, channelId, lastReadAt, publish);
// publish(event) -> throw если !result.ok (тот же паттерн, что markChatAsRead) -> foldChannelReadStatus.

export async function rebuildChannelReadStatus(ownerPubkey, privKey);
// events.where("[pubkey+kind]").equals([ownerPubkey, CHANNEL_READ_STATUS_KIND]),
// группировка по d-tag (channelId), pickLatest на группу — тот же паттерн,
// что rebuildReadStatus. Вызывается из transport.js's connect().

export async function getChannelUnreadCount(ownerPubkey, channelId, dbKey);
// lastReadAt = (channelSyncState.get(...))?.lastReadAt ?? 0.
// 1. channelMessages: .where("[ownerPubkey+channelId]").equals(...) — ВСЕ поля
//    нужные (channelId/authorPubkey/createdAt/deleted) plaintext, фильтр
//    БЕЗ расшифровки: createdAt>lastReadAt && authorPubkey!==ownerPubkey && !deleted.
// 2. posts: .where("[ownerPubkey+channelId]") — channelId/createdAt/deleted
//    plaintext, фильтруем ИМИ первыми; authorPubkey sensitive — fromEncryptedRow
//    ТОЛЬКО кандидатов, прошедших первый фильтр (не всех постов владельца).
// 3. comments: НИ channelId, НИ authorPubkey, НИ createdAt не plaintext (Tier 1)
//    — .where("ownerPubkey").equals(ownerPubkey).toArray(), fromEncryptedRow
//    КАЖДОЙ (тот же паттерн, что moderation.js's deleteChannelLocally), фильтр
//    в памяти.
// Возвращает СУММУ трёх счётчиков (один общий курсор на канал, DESIGN.md).
```

### `table-fields.js` — БЕЗ новой константы

`channelSyncState` не несёт sensitive-полей (только `ownerPubkey`,
`channelId`, `lastReadAt` — все индексируемые/plaintext по смыслу) —
`toEncryptedRow`/`fromEncryptedRow` для этой таблицы не применяются вовсе,
голый `db.table("channelSyncState").put({...})`/`.get(...)`.

### `database.js` — правка схемы (не новая версия таблицы, а её оживление)

```js
// db.version(14) — channelSyncState объявлена с этапа 1, ни разу не
// использована (мёртвый код, класс находки — как attachments до этапа 43),
// была БЕЗ owner-scoping (голый channelId — тот же класс пробела, что
// clock/messages до соответствующих правок).
db.version(14).stores({
  channelSyncState: "[ownerPubkey+channelId]"
});
```

### Badge-счётчики — новый файл `src/ui/signals/notifications.js`

```js
export const unreadMessagesCount = signal(0);   // сумма getUnreadCount по всем contacts
export const unreadChannelsCount = signal(0);    // сумма getChannelUnreadCount по listSubscribedChannels+listOwnedChannels

export async function refreshUnreadMessagesCount(ownerPubkey);
export async function refreshUnreadChannelsCount(ownerPubkey, dbKey);
```

Модерация (жалобы) — БЕЗ отдельного глобального бейджа в навигации: раздел
"Модерация" не отдельный пункт нава (панель внутри экрана конкретного
канала, `channel.jsx`), непрочитанные жалобы уже показываются точечно там
же через существующую `getModerationStats().unviewed` (этап 33) —
расширять до нав-бейджа вне скоупа этого этапа (нет данных, что пользователь
это просил — просил только настраиваемость самого уведомления, не бейдж).

Вызывающий код (`app.jsx`/`MainShell`) читает оба сигнала, дописывает
`" [N]"` к label пункта нава, если `count > 0` — обновляет по тому же
триггеру, что уже использует messagingActivity-подобный бамп (существующий
паттерн, не новый механизм).

### `transport.js` — правки вызовов `notify()`

Все существующие вызовы получают ЧЕТВЁРТЫЙ аргумент `entityId` (там, где
применимо — `senderPubkey`/`channelId`), пятый (backend) не передаётся —
дефолтный `createWebNotificationBackend()`. НОВАЯ ветка для kind 30062
(receiveComment) — сейчас диспетчер этот kind ВООБЩЕ не уведомляет,
добавить `notify(settings, "channels", "comments", {...}, channelId)`
после успешного `receiveComment`. НОВОЕ обнаружение "ответ мне": после
приёма comment/post — проверить, является ли родитель (`parentId`
комментария ИЛИ адресат поста) чем-то, автором чего был Я
(`event.pubkey текущего пользователя`) — при совпадении ДОПОЛНИТЕЛЬНО
`notify(settings, "replies", null, {...})` (не вместо "comments", а
вместе — пользователь может настроить их по-разному: обычно "ответы мне"
громче общего потока).

### UI — `settings.jsx`, секция "Уведомления" (правка, транспонированные таблицы)

Один select (не 3 чекбокса) на строку с опциями `NOTIFICATION_LEVELS`.
Таблица "Каналы": СТРОКА = канал (из `listOwnedChannels`+`listSubscribedChannels`,
объединение, без дублей), КОЛОНКИ = Посты/Комментарии/Общий чат — три
select в одной строке, список каналов пишется РОВНО ОДИН РАЗ (находка
пользователя, не плодить 3 списка). Таблица "Сообщения": строка = контакт
(из `contacts.value`), одна колонка "Уведомление". Обе таблицы — сверху
строка "По умолчанию для новых" (`channels.posts/comments/chat` и
`messages.default`), остальные строки — только те, где `overrides[id]`
задан ЯВНО (пустой override -> "(как по умолчанию)" в UI, реального
пустого объекта в `overrides` не создаётся, пока пользователь не тронет
конкретную строку — не захламлять settings записями-заглушками).

## Этап 47-довесок — найдено живым использованием: три реальных бага

Пользователь после первого прохода этапа 47 сообщил: всплывашки не
появляются, звук не играет, бейдж "Сообщения [N]" не пропадает после
прочтения. Все три — реальные пробелы, не домысел.

### Баг 1 — бейдж не пересчитывался после ЛОКАЛЬНОГО прочтения

`messagingActivity` (сигнал, на который завязан пересчёт бейджей в
`app.jsx`) бампается ТОЛЬКО входящими событиями из `transport.js` —
"я прочитал сообщение" не входящее событие, бамп не срабатывал. Правка:
`chat.jsx` (после `markChatReadAction`) и `channel.jsx`/`channel-chat.jsx`
(после `markChannelAsRead`) теперь ДОПОЛНИТЕЛЬНО напрямую вызывают
`refreshUnreadMessagesCount`/`refreshUnreadChannelsCount` — не полагаются
на общий activity-бамп для этого конкретного случая.

### Баг 2 — разрешение браузера никогда не запрашивалось

`notifications.enabled: true` ПО УМОЛЧАНИЮ означало, что единственное
место, запрашивающее `Notification.requestPermission()` (обработчик
чекбокса "Включить уведомления"), практически никогда не срабатывало —
чекбокс уже включён, переключать нечего. Разрешение оставалось
`"default"` навсегда, `showPopup` молча ничего не показывал (гейтится
`permission === "granted"`). Правка — `settings.jsx`: отдельное состояние
`browserPermission` (не производное от settings) + явная кнопка
"Запросить разрешение", показывается, если `n.enabled && permission
!== "granted" && permission !== "unsupported"`; для `"denied"` — только
пояснение (запрос уже бессмыслен, нужны настройки сайта в браузере).

### Баг 3 — свои тосты вместо нестилизуемого Notification API

Пользователь: "всплывашки должны быть красивыми и плавными" — системный
`Notification` API стилизовать невозможно (чужой UI ОС/браузера).
Решение (обсуждено, выбран гибрид): пока вкладка ВИДНА
(`document.visibilityState === "visible"`) — свой тост с CSS-анимацией
fade+slide (`styles/custom.css`, `.toast`/`@keyframes toast-in/out`);
иначе (вкладка свёрнута/не в фокусе, тост никто не увидит) — fallback на
нативное уведомление ОС, как раньше.

```js
// src/ui/signals/toasts.js
export const toasts = signal([]); // [{id, title, body, leaving}]
export function pushToast({ title, body }); // -> id, авто-dismiss через 4.5с
export function dismissToast(id); // leaving=true -> (200мс) -> реально убрать
```

`src/domain/notifications/backend.js` — `createWebNotificationBackend`
получил `onToast(title, body)` (ПОЗИЦИОННО, тот же стиль, что
`showPopup(title, body)`) и `documentImpl` (DI, по прецеденту остальных
опций). `showPopup`: `isVisible && onToast` -> `onToast(title, body)`,
иначе — прежний путь через `NotificationImpl`.

`src/domain/notifications/notifier.js` — новый `configureDefaultBackend(options)`
(мёрджит опции, сбрасывает закэшированный `defaultBackend`, чтобы
следующий `notify()` без явного backend пересоздал его со свежими
опциями) — вызывается ОДИН раз из `app.jsx`'s `MainShell` со
`onToast`/`audioSrc`.

**НАЙДЕНО ЖИВЫМ E2E:** `backend.js`'s `onToast(title, body)` —
позиционный вызов, но `pushToast({title, body})` ждёт ОДИН объект.
Прямая передача `onToast: pushToast` в `configureDefaultBackend`
(без адаптера) роняла заголовок тоста в `undefined` (деструктуризация
`{title, body}` из строки `title`, пришедшей первым позиционным
аргументом). Правка — `app.jsx`: `onToast: (title, body) =>
pushToast({ title, body })`.

### ЗАКРЫТО — звук встроен

Пользователь предоставил MP3 (~15 КБ decoded, base64 ~20.7 КБ, длительность
~0.9с) через `notification-sound-base64.txt` в корне проекта (временный
транспорт, файл удалён после встраивания — в git не попадает).
`src/domain/notifications/sound-asset.js`'s `NOTIFICATION_SOUND_DATA_URI`
теперь несёт реальный `data:audio/mpeg;base64,...` вместо заглушки `null`
— вызывающий код (`backend.js`/`app.jsx`) не менялся вовсе, ровно то
преимущество, ради которого делалась заглушка отдельной константой.

Живая проверка (Playwright): (1) `new Audio(dataURI)` в реальном браузере
— `loadedmetadata` фактически срабатывает, `duration≈0.9` (не битый
файл, не тишина); (2) 2 живых аккаунта, реальный strfry — `new
Audio(...)` в перехваченном вызове (`addInitScript`, ДО загрузки
страницы — иначе `backend.js` успевает закэшировать `globalThis.Audio`
до подмены) получает ИМЕННО встроенный data-URI при входящем сообщении,
без ошибок в консоли. Найдено (не расследовано в рамках этого
довеска): звук сработал ДВАЖДЫ на одно входящее сообщение — не критично
для функциональности (просто короткий двойной "дзынь"), возможная
причина — дубль-доставка через зеркалирование между устройствами
(DESIGN.md, этап 25); стоит проверить отдельно, если станет заметно
пользователю на практике.

**Бюджет (NF-11, лимит 280 КБ gzip): 271.34 КБ — запас всего ~8.7 КБ.**
Встроенный звук — единственный вклад этого довеска в размер (сам base64
почти не сжимается gzip'ом дальше, аудио уже высокоэнтропийно). Следующим
крупным фичам либо нужно укладываться в оставшийся запас, либо придётся
пересматривать бюджет/выносить звук за пределы singlefile-бандла (напр.
отдельным ассетом, а не data-URI) — решение за пользователем, когда
запас исчерпается.

## Этап 47-довесок-3 — информативный контент, click-нав "к месту события", ещё два бага, новая категория

Пользователь после подтверждения работы звука/тостов запросил шесть вещей
разом: (1) содержательный текст уведомлений вместо родовых заголовков,
(2) клик по уведомлению ведёт именно к месту события (конкретный чат/пост/
комментарий), (3) баг — бейдж "Каналы [N]" не пропадает (в отличие от
"Сообщения [N]"), (4) баг — крестик тоста перекрывает текст, (5) новая
категория/настройка для "мой запрос приняли" (уже существовала —
`contacts.accepted`, требовалось лишь обогатить содержимое) и "новый
запрос от НЕЗНАКОМЦА" (реально новая — раньше `storeInboxRequest`,
kind 444 Welcome от неизвестного отправителя, не уведомлял вовсе).

### Информативный контент — конкретная формулировка по категориям

Заданные пользователем примеры реализованы буквально; для категорий без
явного примера формулировка предложена по аналогии (тот же паттерн:
заголовок называет канал/отправителя, тело — сырой текст без обёртки):

| Категория | Заголовок | Тело |
|---|---|---|
| `messages` | `Новое сообщение от {USERNAME}` | текст сообщения |
| `channels/posts` | `Новый пост в канале «{CHANNELNAME}»` | текст поста |
| `channels/comments` | `Комментарий в канале «{CHANNELNAME}»` | текст комментария |
| `replies` | `{CHANNELNAME}: {USERNAME} вам ответил` | `«текст комментария-ответа»` |
| `channels/chat` | `Сообщение в чате канала «{CHANNELNAME}»` | `{USERNAME}: текст` |
| `moderation/reports` | `Новая жалоба в канале «{CHANNELNAME}»` | текст жалобы |
| `moderation/ban` | `Модерация канала «{CHANNELNAME}»` | (как раньше, без изменений) |
| `contacts.newRequests` | `Новый запрос в контакты от {USERNAME}` | приветствие |
| `contacts.accepted` | `Запрос в контакты принят` | `{USERNAME} принял(а) ваш запрос` |
| `inbox` (новая) | `Новый запрос от незнакомца` | `{USERNAME} хочет написать вам` |

`{USERNAME}` — `profiles.value[pubkey]?.name`, фоллбэк `{pubkey.slice(0,8)}…`
(`usernameFor()`, `transport.js`) — ensureProfilesFetched вызывается ПЕРЕД
формированием текста (профиль автора может быть ещё не закэширован на
момент прихода события; сеть best-effort, фоллбэк не блокирует уведомление).
Тексты обрезаются `truncateForNotification(text, 120)` — многоточие после
120 символов, тот же лимит для всех категорий (пост/комментарий/жалоба).

### Click-нав "к месту события" — архитектура

Новый файл `src/ui/signals/notification-nav.js`:
```js
export const pendingNavTarget = signal(null);
// {screen:"messages", contactPubkey?}
// {screen:"channels", channelId, postId?, commentId?, subTab?}
// {screen:"contacts"}
export function navigateFromNotification(target); // -> pendingNavTarget.value = target
export function applyNavTarget(target); // форвардит contactPubkey/channelId в
  // УЖЕ существующие openChat()/openChannel()/setChannelPostTarget() — не дублирует их роль
```
`app.jsx`'s `MainShell` подписан на `pendingNavTarget`: переключает
`activeId` (вкладку нава) и вызывает `applyNavTarget`, затем гасит сигнал.
Каждый `notify()` в `transport.js` теперь передаёт `onClick`, который
строит нужный `target` и вызывает `navigateFromNotification`.

`src/ui/signals/channel-nav.js` получил `channelPostTarget` (сигнал,
`{postId?, commentId?, subTab?}`) — `channel.jsx`'s `ChannelDetail`
читает его ОДИН раз (эффект на `channelPostTarget.value`), переключает
`tab` при наличии `subTab`, и держит его в собственном state `navTarget`,
который форвардится в `PostWithComments` как `autoExpand`/
`highlightCommentId`. Если целевой пост старше уже загруженного окна
(`loadPostsWindow` грузит по 10) — эффект `[navTarget, posts, hasMore]`
досасывает более старые страницы (`handleLoadMore()`), пока пост не
найдётся или `hasMore` не станет `false` (все посты и так уже локально
в IndexedDB — "hasMore" здесь чисто UI-паджинация, не отсутствие данных).

Найденный комментарий подсвечивается CSS-классом `.is-target-comment`
(`custom.css`, `@keyframes target-flash` — 2с затухающая заливка
`--accent`, `prefers-reduced-motion` — статичная заливка без анимации) и
скроллится в область видимости (`scrollIntoView({block:"center"})`) после
того, как `tree` реально загружен (иначе элемента с нужным `id` ещё нет
в DOM).

### Баг — крестик тоста перекрывал текст

`custom.css`'s `.toast` `padding-inline-end` был меньше ширины
абсолютно спозиционированной кнопки `.toast-close` — увеличен до
`calc(var(--space-l) + var(--space-2xs))`. Дополнительно (эта же правка,
запрошено пользователем п.2): весь тост стал кликабельным
(`role="button"`, `tabIndex`, `Enter`/`Space`), close-кнопка вызывает
`e.stopPropagation()`, чтобы закрытие не триггерило заодно навигацию.

### БАГ (найден живым E2E) — `app.jsx`'s `onToast` терял `onClick`

`configureDefaultBackend({ onToast: (title, body) => pushToast({title,body}) })`
— адаптер из этапа 47-довесок (см. выше) исправлял title/body, но
принимал только ДВА позиционных аргумента, третий (`onClick`, добавленный
этим доеском в `backend.js`'s `showPopup(title, body, onClick)`) молча
терялся. Результат: НИ ОДИН тост не был кликабельным, несмотря на то что
`notify()`/`backend.js`/`toasts.js`/`toast-host.jsx` были полностью верно
связаны — обнаружено ТОЛЬКО через живой Playwright E2E (клик по тосту
зависал в ожидании несуществующего `.is-clickable`, юнит-тесты этот путь
не покрывали, поскольку `configureDefaultBackend` в тестах не вызывается
вовсе). Правка: `onToast: (title, body, onClick) => pushToast({title,body,onClick})`.

### БАГ (найден живым E2E) — бейдж "Каналы [N]" не пропадал после просмотра комментария

Два независимых источника: (а) `PostWithComments`'s `refreshComments()`
никогда не вызывала `markChannelAsRead` вовсе (только посты/чат
продвигали курсор) — добавлено: `Math.max` по `createdAt` всех узлов
дерева комментариев (`flattenCreatedAt`), тот же паттерн, что
`ChannelDetail.refresh()`. (б) Обнаруженный ПРИ ЖИВОМ E2E этой же правки
race на уровне relay: kind 30074 (`channelSyncState`) — replaceable
(NIP-01), а `ChannelDetail.refresh()` (курсор по постам) и
`PostWithComments.refreshComments()` (курсор по комментариям) почти
всегда вызывают `markChannelAsRead` в ОДНУ и ту же wall-clock секунду
(особенно с клика по уведомлению — `autoExpand` триггерит
`refreshComments()` практически одновременно с mount-эффектом
`ChannelDetail.refresh()`). strfry отклоняет второе событие как
`"replaced: have newer event"` (created_at не строго больше уже
принятого), что вызывающий код молча проглатывал (`.catch(()=>{})`) —
локальный курсор навсегда застревал на более старом (по постам)
значении, будто комментарий так и не был "прочитан". Правка —
`channel-read-status.js`'s `markChannelAsRead` теперь держит
module-level `Map<channelId, lastPublishedCreatedAt>` и форсирует
строго возрастающий `created_at` для этой сессии
(`Math.max(now, prev+1)`) — устраняет race независимо от того, сколько
вызовов пришло в одну секунду. Общий вывод: любой будущий вызывающий код
`markChannelAsRead` (например, будущая правка `channel-chat.jsx`) заодно
защищён этой же правкой — баг был протокольным, не специфичным для
конкретного вызывающего места.

### Новая категория — `inbox` (заявка от незнакомца)

`ui-settings.js`'s `DEFAULT_NOTIFICATIONS.inbox = "popup"` (скалярный
уровень, без per-entity — тот же паттерн, что `replies`, обрабатывается
верхнеуровневым spread в `mergeWithDefaults`, отдельной ветки не нужно).
`notifier.js`'s `resolveNotificationLevel` — новая ветка `category ===
"inbox"`. `transport.js` — `notify()` вызывается в ветке `storeInboxRequest`
(kind 444 Welcome от отправителя, который НЕ sibling и НЕ уже известный
контакт), `onClick` ведёт на `{screen:"messages"}` (раздел "Входящие" —
верх списка чатов, `chat.jsx`, где такие заявки уже отображались и
раньше — просто без уведомления). `settings.jsx` — новая секция
"Заявки от незнакомцев" между "Ответы" и "Модерация".

### Живая проверка (Playwright, 2 аккаунта, реальный strfry)

Полный цикл: регистрация → запрос в контакты → приём (тост+клик-нав,
контент с именем) → ЛС (тост "Новое сообщение от {ник}: текст", бейдж
"Сообщения [1]" пропадает после клика-перехода) → группа контактов →
канал, видимый только группе → подписка → пост (тост+клик-нав на
конкретный пост) → комментарий (тост+клик-нав на конкретный
подсвеченный комментарий, БЕЙДЖ "Каналы [N]" КОРРЕКТНО ПРОПАДАЕТ после
просмотра) → ответ на комментарий (ДВА тоста Бобу — обычный
"комментарий" И отдельный "вам ответил", ожидаемо: ответ это одновременно
и то, и другое; клик по "вам ответил" ведёт на тот же подсвеченный
комментарий) → визуальная проверка секции "Заявки от незнакомцев" в
Настройках. `inbox`-уведомление (kind 444 от настоящего незнакомца)
живым E2E не прогонялось отдельно (требует третьей identity без
предварительного контакта) — покрыто юнит-тестами
(`resolveNotificationLevel`/`notify` для категории `"inbox"`) и
структурно идентично уже верифицированным веткам.

Regression: `npm test` 744/744 (было 741, +3 — onClick-проброс в
`notifier.test.js`). `npm run build` 272.43 КБ gzip (было 271.64,
+0.8 КБ — click-нав + обогащение контента).

### Звук заменён (тот же довесок, пользователь передал новый файл)

Пользователь заменил звук уведомления — новый MP3 (voicemail-стиль,
ID3 `TIT2`: "Voicemail notification - new message"), ~78 КБ decoded /
107 КБ base64 (было ~15 КБ / ~20.7 КБ), длительность подтверждена живой
проверкой (`new Audio(dataURI)` в реальном браузере, `loadedmetadata`
срабатывает, `duration≈1.68с`, файл не битый). Передан через `sound.txt`
в корне (тот же временный транспорт, что раньше `notification-sound-base64.txt`
— удалён из рабочего дерева и индекса после встраивания, в git не
попадает). `sound-asset.js`'s `NOTIFICATION_SOUND_DATA_URI` обновлён,
вызывающий код не менялся.

**Бюджет NF-11 (280 КБ) ПРЕВЫШЕН: 332.46 КБ (было 272.43, +60 КБ).**
Пользователь предупреждён заранее и явно принял превышение как
временно некритичное ("бюджет может быть превышен, но это пока не
критично"). Требует решения в будущем: либо укоротить/пережать звук,
либо вынести его из data-URI/singlefile-бандла отдельным ассетом
(нарушит принцип "два файла: index.html + service-worker.js", если
ассет не встраивать) — открытый вопрос, не решён в рамках этого
довеска.

## Этап 47-довесок-4 — бюджет NF-11 повышен, найден и исправлен баг "лавины уведомлений"

Явное решение пользователя: NF-11 повышен с 280 КБ до **1304 КБ**
(+1 МБ, "впереди ещё много доработок") — обновлено в TECH.md/CLAUDE.md.
Формально это отменяет прежний жёсткий бюджет 280 КБ на будущих этапах;
исторические записи в этом файле (замеры ДО этого решения) оставлены
как есть — они верны для СВОЕГО момента времени, не переписываются.

### Баг — "~10 уведомлений и ~10 звуков почти одновременно на ОДНО сообщение"

Пользователь сообщил реальным использованием (тот же класс находки, что
довесок-3's markChannelAsRead race — протокольная, не спецификой одного
места). НЕ требует пересоздания пользователей — баг воспроизводится для
ЛЮБОГО аккаунта, корень в архитектуре, не в данных конкретных тестовых
identity.

**Корень (прочитан код, не домысел):** `refreshGroupMessageSubscription`/
`refreshChannelContentSubscription`/`refreshChannelGrantSubscription` —
ПОСТОЯННЫЕ (singleton) подписчики, но их `subscribe(subId, filters)`
вызывается БЕЗУСЛОВНО на каждый триггер: `chats.js`'s
`sendChatMessageAction` явно документирует это как решение "идемпотентна
— дешевле, чем проверять" (комментарий в коде ДО этого довеска). REQ с
уже занятым `subId` — штатное поведение relay (NIP-01): он ЗАМЕНЯЕТ
подписку и заново отдаёт ВСЮ backlog-историю, матчащую фильтр, — это НЕ
протокольный баг strfry, это ожидаемое поведение, которое клиент обязан
уметь переживать.

Проблема — в диспетчере (`transport.js`): `receivePost`/`receiveComment`/
`receiveChannelMessage`/`receiveGroupMessageEvent` возвращают truthy на
"успешно расшифровано и авторизовано", а НЕ на "это действительно новое,
впервые увиденное содержимое". Redelivery СТАРОГО события проходит ВЕСЬ
конвейер заново (включая для kind 445 — MLS ratchet-расшифровку;
`decryptApplicationMessage`, как и любой Double-Ratchet-подобный
примитив, толерантен к повторной расшифровке в пределах окна пропусков
— иначе не пережил бы обычную сетевую доставку не по порядку, — так что
redelivery успешно расшифровывается СНОВА, не проваливается) —
`notify()` срабатывает повторно на уже виденный контент.

Хуже: `channelGrantSubscriber`'s `onBatch` сам вызывает
`refreshChannelContentSubscription` на КАЖДЫЙ (в т.ч. передоставленный!)
грант — мультипликативный каскад: N грантов (redelivered) × M событий
контента каждого канала = двузначные числа повторных уведомлений легко
объяснимы даже на "одно" реальное сообщение/комментарий, если рядом
случился любой другой resubscribe-триггер (новый подписчик канала,
отправка сообщения в ДРУГОЙ чат и т.п. — совпадение по времени, не по
причине).

**Fix — дедупликация по `event.id` на входе КАЖДОГО `onBatch`** (не патч
в каждой `receiveX` — та же логика в 5 разных местах была бы хрупкой и
её легко забыть добавить в шестое место в будущем):
```js
// transport.js, модульный уровень
const processedEventIds = new Set(); // in-memory, сбрасывается в teardown()
function isNewEvent(eventId) {
	if (processedEventIds.has(eventId)) return false;
	processedEventIds.add(eventId);
	return true;
}
```
Применено как первая строка внутри `for (const event of events)` в:
`giftWrapSubscriber`, `profileSubscriber` (`refreshLiveProfileSubscription`),
`channelGrantSubscriber`, `channelContentSubscriber`, `groupMessageSubscriber`.
НЕ применено к одноразовым REQ+EOSE-паттернам (`fetchProfiles`,
`fetchDiscoveryProfiles`, `fetchOwnKeyPackageAnnounces`,
`syncMirroredHistory`) — у них случайный `subId` на каждый вызов, нет
переиспользуемой подписки, нет multi-redelivery одного и того же события
в рамках сессии (single REQ+EOSE, closes себя же).

Дедуп сбрасывается в `teardown()` — НЕ переживает reload/переподключение
(намеренно: новая сессия начинает с чистого листа, это корректно —
resubscribe СРАЗУ после reload обязан заново доставить backlog, иначе
пропущенные офлайн события потерялись бы).

**НЕ исследовано отдельно** (не в скоупе этого довеска, зафиксировать
для будущего): даже ВНЕ этого бага `decryptApplicationMessage`
расшифровывающий redelivered-событие повторно — лишняя CPU-работа
(не только лишние уведомления). Дедуп на входе `onBatch` устраняет и
это (событие отбрасывается ДО попытки расшифровки), но если в будущем
появится ЕЩЁ один путь доставки того же kind 445 (не через этот
`onBatch`), тот путь НЕ будет защищён этим фиксом — контракт
"дедуп на входе диспетчера" держится ТОЛЬКО этими 5 местами, не
глобальным свойством всей системы.

Regression: `npm test` 744/744 (без изменений в числе — дедуп не тронул
ни одну тестируемую доменную функцию напрямую, только оркестрацию в
transport.js, который не покрыт юнит-тестами — требует живой проверки).

**Живая проверка (Playwright, 2 аккаунта, реальный strfry):** Bob
отправляет Alice 5 сообщений подряд (тот же паттерн, что вызывал баг —
`sendChatMessageAction` на каждое безусловно резервирует
`refreshGroupMessageSubscription`). `new Audio(...).play()` перехвачен
через `addInitScript` (ДО загрузки страницы, тот же приём, что довесок-2
— иначе backend.js кэширует оригинальный `globalThis.Audio` до подмены)
для ТОЧНОГО, независимого от тайминга auto-dismiss тостов подсчёта.
**Результат: ровно 5 срабатываний звука на 5 отправленных сообщений**
(до фикса — предположительно N×M, по заявлению пользователя ~10 на
одно) + ровно 1 вхождение текста каждого сообщения в истории чата (не
задвоилось и в БД). Канальный путь (channelGrantSubscriber → каскад)
отдельным E2E не прогонялся — использует ТОТ ЖЕ `isNewEvent()` на том
же архитектурном уровне, что уже верифицированный путь ЛС; регрессия
744/744 не выявила косвенных поломок.

## Этап 48 — голосовая связь: контракты (Event/Command/State/kind)

Источник — VOICE.md (корень проекта, ТЗ подготовлено пользователем
совместно с Claude Opus: формальный FSM, таблица переходов, инварианты,
тест-спека). Пять развилок закрыты явными решениями пользователя (не
домысел, см. PLAN.md, "Этап 48"): простой ICE-restart (impolite
инициирует), новый эфемерный kind + NIP-44 напрямую для сигналинга,
свой coturn (STUN) + публичный fallback, история звонков отложена,
мультиустройство вне скоупа v1.

### Файлы (Frisby, §3 VOICE.md)

```
src/domain/calls/call-fsm.js         — pure. reduce(state, event) -> {state, commands}.
                                        Ноль I/O, ноль async. Пишет ВОРКЕР.
src/domain/calls/media-controller.js — обёртка RTCPeerConnection: буфер ICE
                                        до setRemoteDescription, glare-rollback.
                                        Пишет Claude (риск-точка, triage 13a).
src/domain/calls/signaling-adapter.js— Nostr in/out для сигналинга (kind ниже).
                                        Пишет Claude.
src/domain/calls/call-runtime.js     — imperative shell: подписан на media+
                                        signaling, кормит reduce(), исполняет
                                        commands. Пишет Claude (оркестрация).
```

### State (§1.2 VOICE.md, буквально)

```js
state = {
  name,          // одно из: IDLE, OUTGOING_RINGING, INCOMING_RINGING,
                 // CONNECTING, CONNECTED, RECONNECTING, ENDED
  role,          // 'caller' | 'callee' | null
  sessionId,     // uuid, генерит caller
  peerPubkey,    // pubkey собеседника
  polite,        // bool = (myPubkey < peerPubkey) — тайбрейкер glare/restart
  restartCount,  // счётчик попыток ICE restart, сброс при возврате в CONNECTED
  reason,        // причина завершения (только в ENDED)
}
```

### Event (Σ_in, §1.3 VOICE.md)

- Пользователь: `USER_PLACE_CALL(peerPubkey)`, `USER_ACCEPT`, `USER_REJECT`, `USER_HANGUP`
- Сигналинг: `REMOTE_OFFER(sdp, sessionId, fromPubkey)`, `REMOTE_ANSWER(sdp)`, `REMOTE_ICE(candidate)`, `REMOTE_HANGUP`
- Медиа (колбэки RTCPeerConnection): `LOCAL_OFFER_READY(sdp)`, `LOCAL_ANSWER_READY(sdp)`, `LOCAL_ICE(candidate)`, `ICE_CONNECTED`, `ICE_DISCONNECTED`, `ICE_FAILED`
- Таймеры: `RING_TIMEOUT`, `CONNECT_TIMEOUT`, `GRACE_EXPIRED`, `BACKOFF_EXPIRED`

Каждое событие несёт `sessionId`, кроме `USER_PLACE_CALL` и `REMOTE_OFFER`
(они сессию создают/приносят). **I1**: событие с `sessionId ≠
state.sessionId` — игнорируется (защита от дублей/устаревших событий).

### Command (Σ_out, §1.4 VOICE.md)

- Сигналинг наружу: `SEND_OFFER(sdp)`, `SEND_ANSWER(sdp)`, `SEND_ICE(candidate)`, `SEND_HANGUP`
- Медиа: `ACQUIRE_MIC`, `CREATE_OFFER`, `CREATE_ANSWER`, `SET_REMOTE(sdp)`, `ADD_ICE(candidate)`, `DO_ICE_RESTART`, `CLOSE_PC`
- Таймеры: `START_TIMER(name, ms)`, `CANCEL_TIMER(name)`
- UI: `EMIT(stateName, reason?)`

Таблица переходов δ, инварианты I1-I5, разрешение glare (§2.1) и ICE
restart (§2.2) — см. VOICE.md буквально, переносить в CONTRACTS.md не
дублирую (ТЗ уже заморожено, воркер получит его через `--ctx VOICE.md`).

Константы (Erickson, §3 VOICE.md):
```
RING_TIMEOUT     = 30000
CONNECT_TIMEOUT  = 15000
DISCONNECT_GRACE = 4000
MAX_RESTARTS     = 4
backoff(n)       = min(1000 * 2**(n-1), 8000)
```

### Kind сигналинга (закрывает развилку №2)

```js
// src/domain/calls/signaling-adapter.js
export const CALL_SIGNAL_KIND = 20075; // эфемерный диапазон NIP-01 (20000-29999)
```

Один kind на ВСЕ типы сигнальных сообщений (offer/answer/ice/hangup) —
тип различается полем `type` внутри NIP-44-зашифрованного JSON, тот же
приём, что d-tag-паттерны/маркеры уже применяются в проекте (delete/edit
маркеры в kind 445, subtype в d-tag комментариев) — не плодим kind на
каждый вариант. Тег `#p: [peerPubkey]` — адресация получателю (тот же
принцип, что contact-request rumors). Шифрование — NIP-44 НАПРЯМУЮ (без
gift-wrap, см. обоснование в PLAN.md "Этап 48"): дёшево на каждый
ICE-кандидат, relay эфемерного диапазона не обязан хранить события
вовсе — практическое следствие: сигналингу нечему передоставляться при
resubscribe (тот же класс проблемы, что чинили в довеске-4, здесь не
возникает по конструкции).

Payload (JSON, после NIP-44-расшифровки):
```js
{ type: "offer" | "answer" | "ice" | "hangup", sessionId, sdp?, candidate? }
```

### ICE-серверы (закрывает развилку №3)

```js
// config.js — тот же паттерн, что BUILD_DEFAULT_RELAYS/BUILD_DEFAULT_BLOSSOM_SERVERS
export const BUILD_DEFAULT_ICE_SERVERS = [
  { urls: "stun:<свой-coturn-host>:3478" }, // свой — первым
  { urls: "stun:stun.l.google.com:19302" }, // публичный — fallback
];
```

Настройка списка — по паттерну `addRelayUrl`/`removeRelayUrl`/
`setActiveRelayUrl` в ui-settings.js, НО без понятия "активного" (ICE
пробует ВСЕ переданные серверы параллельно, не переключается на один) —
проще: `iceServerUrls: string[]`, `addIceServerUrl`/`removeIceServerUrl`,
без `activeIceServerUrl`. TURN — не подключаем в v1 (см. PLAN.md).

### Интеграция с уведомлениями (этап 47)

Новая категория `"calls"` в `DEFAULT_NOTIFICATIONS` — по аналогии с
`moderation` (принудительный уровень, не в `notifications.enabled`
общем рубильнике): пропущенный звонок не должен быть заглушаем
настройками. `resolveNotificationLevel(settings, "calls", null)` →
всегда `"sound"`, без ветки на `enabled`. `onClick` — через уже
существующий `navigateFromNotification` (новый target
`{screen: "messages", contactPubkey}` — уже поддержан).

### UI (контракт, реализация — п.6 плана)

Persistent-компонент на уровне `app.jsx` (рядом с `ToastHost`, НЕ внутри
`chat.jsx`) — подписан на `callState` (новый сигнал, аналог
`toasts`/`pendingNavTarget`). Кнопка "Позвонить" — `contacts.jsx` (рядом
с `ContactIdentity`) и `chat.jsx` (шапка). Визуальные состояния — см.
PLAN.md "Этап 48" (полноэкранный оверлей для \*_RINGING, компактная
плашка для CONNECTED/RECONNECTING с волновой визуализацией через
`AnalyserNode` и индикатором качества через `RTCPeerConnection.getStats()`).

### Найденный и закрытый пробел контракта — откуда `reduce` берёт `myPubkey`

VOICE.md §1.2 не включает `myPubkey` в state payload, но `polite =
(myPubkey < peerPubkey)` вычисляется именно в `reduce` при переходе из
`IDLE` (§2, ветки `USER_PLACE_CALL`/`REMOTE_OFFER`). Раз `reduce` чистая
и не хранит внешний конфиг помимо `state`/`event`, решение (закрыто ДО
вызова воркера, не домысел воркера): **события, создающие сессию, несут
`myPubkey` дополнительным полем** — `call-runtime.js` его знает всегда
(это identity текущего владельца) и подставляет при диспетчеризации.
```
USER_PLACE_CALL(peerPubkey, myPubkey)
REMOTE_OFFER(sdp, sessionId, fromPubkey, myPubkey)
```
Поле нужно ТОЛЬКО для вычисления `polite` в момент этого перехода — в
`state` не оседает сверх уже описанных в §1.2 полей (`state.polite`
хранит УЖЕ вычисленный булев результат, не сами pubkey для сравнения).

## Этап 48, п.3 — `media-controller.js` (обёртка RTCPeerConnection)

Пишет Claude напрямую (не воркер) — риск-точка glare-rollback (§2.1
VOICE.md), завязанная на живой `signalingState`.

```js
export function createMediaController(options = {}) -> { execute(command) }
```

`options`: `RTCPeerConnectionImpl` (DI, по умолчанию `globalThis.RTCPeerConnection`),
`getUserMediaImpl` (DI, тот же приём, что `voice.js`), `iceServers` (массив,
см. `BUILD_DEFAULT_ICE_SERVERS`), `onEvent(event)` (обратный канал в
`call-runtime.js` — эмитит Σ_in-события §1.3-C VOICE.md: `LOCAL_OFFER_READY`,
`LOCAL_ANSWER_READY`, `LOCAL_ICE`, `ICE_CONNECTED`, `ICE_DISCONNECTED`,
`ICE_FAILED`), `onLocalStream(stream)`/`onRemoteStream(stream)` (опционально,
для будущего UI — волновая визуализация, контроллер сам их не использует).

`execute(command)` — async, исполняет ОДНУ команду Σ_out, адресованную
медиа-слою (`ACQUIRE_MIC`, `CREATE_OFFER`, `CREATE_ANSWER`, `SET_REMOTE`,
`ADD_ICE`, `DO_ICE_RESTART`, `CLOSE_PC`) — остальные команды (`SEND_*`,
`START_TIMER`, `CANCEL_TIMER`, `EMIT`) сюда не приходят, `call-runtime.js`
их не пересылает.

Внутреннее устройство:
- `pc` — singleton `RTCPeerConnection` на звонок, создаётся лениво первой
  командой, которой он нужен (`ACQUIRE_MIC` ИЛИ `SET_REMOTE` — у callee
  offer приходит ДО `USER_ACCEPT`, значит ДО `ACQUIRE_MIC`). Пересоздаётся
  заново после `CLOSE_PC` (новый звонок — чистый `pc`).
- Буфер `pendingRemoteIce` — `ADD_ICE` до `setRemoteDescription` копится в
  массиве, сливается ОДИН раз сразу после `SET_REMOTE`, в порядке
  поступления. После первого `SET_REMOTE` (и всегда, пока `remoteDescription`
  установлен) — `ADD_ICE` добавляется немедленно, без буферизации.
- **Glare-rollback (риск-точка):** `SET_REMOTE` проверяет
  `sdp.type === "offer" && pc.signalingState === "have-local-offer"` — если
  да, СНАЧАЛА `setLocalDescription({type:"rollback"})`, потом
  `setRemoteDescription`. `answer` никогда не откатывает (это нормальный
  ответ на наш собственный offer).
- `oniceconnectionstatechange`: `connected`/`completed` → `ICE_CONNECTED`,
  `disconnected` → `ICE_DISCONNECTED`, `failed` → `ICE_FAILED`, остальные
  (`checking`/`new` и т.п.) — не эмитятся вовсе.
- `onicecandidate`: `candidate !== null` → `LOCAL_ICE(candidate)`; `null`
  (конец сбора кандидатов) — не эмитится.

Тесты — `tests/media-controller.test.js` (19), `RTCPeerConnectionImpl`
застаблен (`FakeRTCPeerConnection`, тот же приём, что `FakeMediaRecorder`
в `voice.test.js`) — реальное согласование ICE проверяется живым
Playwright (`--use-fake-device-for-media-stream`), не юнит-тестами.

## Этап 48, п.4 — `signaling-adapter.js` (Nostr I/O для сигналинга)

Написан Claude напрямую (короткий, тесно завязан на уже принятое решение
по шифрованию — не отправлен воркеру после сегодняшних неудачных
попыток на более сложном call-fsm.js).

```js
export const CALL_SIGNAL_KIND = 20075;
export function buildCallSignalEvent(privKey, peerPubkey, payload, createdAt?) -> event
export function parseCallSignalEvent(event, privKey) -> payload
export async function execute(command, {privKey, peerPubkey, sessionId, publish}) -> publish() result | undefined
export function toFsmEvent(payload, senderPubkey, myPubkey) -> Σ_in-событие | null
```

`payload` (после NIP-44-расшифровки) — `{type: "offer"|"answer"|"ice"|"hangup",
sessionId, sdp?, candidate?}`. `execute()` обрабатывает ТОЛЬКО `SEND_OFFER`/
`SEND_ANSWER`/`SEND_ICE`/`SEND_HANGUP` — остальные команды (медиа/таймеры/EMIT)
сюда не приходят. `toFsmEvent()` — чистая функция, маппит payload обратно в
Σ_in-событие (`REMOTE_OFFER`/`REMOTE_ANSWER`/`REMOTE_ICE`/`REMOTE_HANGUP`) для
`reduce()`; неизвестный `payload.type` → `null` (вызывающий код должен сам
решить, что делать — обычно просто не диспетчеризовать).

Тег `["p", peerPubkey]` — адресация получателю (тот же принцип, что
contact-request rumors). Подписка на входящие kind 20075 (REQ-фильтр
`{"#p":[myPubkey], kinds:[20075]}`) — забота `call-runtime.js` (п.5), не
этого модуля: `signaling-adapter.js` только строит/парсит события и
маппит команды/payload, само подключение к транспорту (transport.js) —
на следующем шаге.

Тесты — `tests/signaling-adapter.test.js` (15): kind в эфемерном
диапазоне, полный round-trip шифрования (Alice→Bob, реальные
secp256k1-ключи), содержимое реально нечитаемо как есть, чужой ключ не
расшифровывает (бросает), все 4 SEND_*-команды, все 4 toFsmEvent-маппинга,
неизвестный тип, сквозной цикл execute→parse→toFsmEvent.

## Этап 48, п.5 — `call-runtime.js` (imperative shell, склейка)

Написан Claude напрямую (оркестрация — §5 VOICE.md).

```js
export function createCallRuntime(options) -> { placeCall(peerPubkey), accept(), reject(), hangup(), handleIncomingSignal(event), getState() }
```

`options`: `myPubkey`, `privKey`, `publish`, `onStateChange(stateName, reason)`
(UI-колбэк — EMIT), `createMediaController`/`signalingAdapter` (DI, по умолчанию
реальные модули — тесты подставляют фейки), `setTimeoutImpl`/`clearTimeoutImpl`
(DI для детерминированных тестов таймеров), остальные поля прокидываются в
`createMediaController` (`iceServers`, `getUserMediaImpl`, `RTCPeerConnectionImpl`,
`onLocalStream`, `onRemoteStream`).

Держит ЕДИНСТВЕННЫЙ источник truth — `state` (замыкание), продвигается через
`dispatch(event) = reduce(state, event)` + исполнение всех `commands`.
Маршрутизация команд: `ACQUIRE_MIC`/`CREATE_OFFER`/`CREATE_ANSWER`/`SET_REMOTE`/
`ADD_ICE`/`DO_ICE_RESTART`/`CLOSE_PC` → `mediaController.execute`; `SEND_*` →
`signalingAdapter.execute` (с `peerPubkey`/`sessionId` из ТЕКУЩЕГО `state`);
`START_TIMER`/`CANCEL_TIMER` → собственные именованные таймеры
(`ring`→`RING_TIMEOUT`, `connect`→`CONNECT_TIMEOUT`, `grace`→`GRACE_EXPIRED`,
`backoff`→`BACKOFF_EXPIRED`); `EMIT` → `onStateChange`.

**Найденная защита сверх VOICE.md:** `CLOSE_PC` дополнительно чистит ВСЕ
таймеры (`clearAllTimers()`), не только те, что явно упомянуты в конкретном
переходе §2 — иначе осиротевший `grace`/`backoff`-таймер от предыдущего звонка
мог бы выстрелить в разгар СЛЕДУЮЩЕГО (`sessionId` при этом другой — I1 его
отфильтрует, но лишний cycle дешевле предотвратить, чем полагаться только на
фильтр).

**Известное ограничение (не решено, задокументировано, не блокирует v1):**
события медиа-слоя (`LOCAL_*`, `ICE_*`) НЕ несут `sessionId` — они привязаны
к конкретному `RTCPeerConnection`, а не к сессии напрямую; I1 их поэтому не
проверяет вовсе (`needsSessionCheck` в `call-fsm.js` пропускает события без
`sessionId`). Теоретическая гонка: асинхронная медиа-команда (напр.
`CREATE_OFFER`) всё ещё летит, а звонок уже завершился и НАЧАЛСЯ новый — её
результат может прийти "в разгар" нового звонка. На практике `CLOSE_PC`
закрывает `pc` синхронно, что естественным образом валит любую операцию,
ещё летящую на СТАРОМ `pc` (WebRTC не позволяет успешно завершить операцию
на закрытом соединении) — считаем это достаточным для v1 без выделенного
трекинга "к какому именно звонку относится этот asinc-результат".

Тесты — `tests/call-runtime.test.js` (10): реальный `call-fsm.js` +
реальный `signaling-adapter.js` (round-trip шифрования настоящими ключами,
только `publish` застаблен) + фейковый `mediaController` + фейковые таймеры
(детерминированные, без реального ожидания). Полный happy path caller и
callee, ring-timeout, hangup/reject, ICE-restart (impolite-ветка), I1 на
входящем сигналинге, устойчивость к событию не для нас (чужой получатель).

## Этап 48, п.6-7 — UI звонка, уведомления, найденный и исправленный протокольный баг

### UI (persistent-оверлей + кнопки)

`src/ui/signals/call.js` — реактивный мост call-runtime.js↔Preact:
`callState` (полный снимок FSM-состояния), `localMediaStream`/
`remoteMediaStream` (для волновой визуализации), `configureCallRuntime`
(вызывается ОДИН раз из `transport.js`'s `connect()`, тот же принцип, что
`configureDefaultBackend` в app.jsx, этап 47), `placeCall`/`acceptCall`/
`rejectCall`/`hangupCall`, `handleIncomingCallSignal` (вызывается
transport.js на каждое kind 20075).

`src/ui/components/call-overlay.jsx` — persistent-компонент в `app.jsx`
(рядом с `ToastHost`, ВНЕ `.app-layout` — см. ниже про layout). Четыре
визуальных режима по `callState.value.name`:
- `OUTGOING_RINGING`/`INCOMING_RINGING` — полноэкранный modal
  (`position:fixed`, намеренно поверх ВСЕГО включая сайдбар — решение
  требует внимания пользователя), аватар с пульсирующей CSS-обводкой,
  Принять/Отклонить или Отменить.
- `CONNECTING` — краткий статус "Соединение…".
- `CONNECTED`/`RECONNECTING` — компактная плашка `.call-bar` (обычный
  block-элемент, НЕ fixed — см. layout ниже), зелёная/жёлтая обводка
  аватара, тикающий таймер длительности (локальный `useRef`/`setInterval`
  в компоненте — `callState` не несёт временных меток, §1.2 VOICE.md
  заморожен, не трогаем), волновая визуализация (`AnalyserNode`, Web
  Audio API, нативный — без библиотек), кнопка завершения.
- `ENDED` — краткая надпись с причиной (`callEndReasonRu`), самоисчезает
  вместе с сигналом при возврате в IDLE.

Кнопка "Позвонить" — `contacts.jsx` (рядом с `ContactIdentity`) и
`chat.jsx` (шапка, `Screen`'s `actions`).

**Layout-находка (живой E2E, не домысел):** изначально `.call-bar` был
`position:fixed` поверх ВСЕГО, включая сайдбар — реально перекрывал верх
`SidebarProfileCard`. Исправлено: `app.jsx` обёрнут в новый `.app-shell`
(несёт `height:100dvh; overflow:hidden`, раньше — на `.app-layout`),
`CallOverlay` — ПЕРВЫЙ ребёнок `.app-shell`, ВНЕ `.app-layout`;
`.app-layout` теперь `flex:1 1 auto; min-height:0` — компактная плашка
звонка сжимает его по высоте (block-элемент в потоке), а не перекрывает.
Полноэкранные состояния (`.call-overlay`) остаются `position:fixed` —
это intentional modal, перекрытие сайдбара там корректно.

### Уведомления (категория "calls")

`notifier.js`'s `resolveNotificationLevel` — `category === "calls"` →
всегда `"sound"`, ПЕРЕД проверкой `notifications.enabled` (тот же
принцип, что `moderation`/не-`reports`: пропущенный звонок нельзя
заглушить настройками). Без отдельного поля в `DEFAULT_NOTIFICATIONS`
(как и `moderation.ban`/`warn` — принудительные категории не нуждаются в
UI-тумблере). `call.js`'s `notifyIncomingCall` вызывается из
`onStateChange` при переходе в `INCOMING_RINGING`, `onClick` — через уже
существующий `navigateFromNotification({screen:"messages", contactPubkey})`.

### ICE-серверы (конфигурация)

`vite.config.js`'s `buildDefaultIceServers()` — тот же паттерн, что
relay/Blossom; дефолт (dev И прод) — публичный STUN
(`stun:stun.l.google.com:19302`), т.к. локального coturn в dev-окружении
нет (в отличие от strfry/blossom); прод обязана переопределить через
`BUILD_DEFAULT_ICE_SERVERS` env, добавив свой coturn ПЕРВЫМ. Экспортирован
как `BUILD_DEFAULT_ICE_SERVERS` в `config.js`, потребляется
`call.js`'s `configureCallRuntime`.

### НАЙДЕННЫЙ И ИСПРАВЛЕННЫЙ ПРОТОКОЛЬНЫЙ БАГ (живой E2E, критично)

Первый живой прогон (2 реальных браузера, `--use-fake-device-for-media-stream`)
показал: оверлеи входящего/исходящего звонка и уведомления работали
корректно, но `CONNECTED` НИКОГДА не достигался — звонок всегда
"тикал" до `CONNECT_TIMEOUT` (15с) и автоматически завершался. Диагностика
(добавлены временные `console.log` в `media-controller.js`/`call-runtime.js`,
затем убраны) показала: `onicecandidate`/`oniceconnectionstatechange`
НИ РАЗУ не срабатывали — ICE-кандидаты вообще не собирались. Отдельный
sanity-тест голого `RTCPeerConnection` в той же Playwright-песочнице
подтвердил, что ICE-gathering в среде исполнения работает нормально —
проблема была не в окружении.

**Корень:** `call-runtime.js`'s `dispatch()` исполнял команды ОДНОГО
перехода параллельно ("запустить и забыть", `executeCommand(command)`
без `await` в цикле) — `ACQUIRE_MIC` (добавляет трек в `RTCPeerConnection`
после `await getUserMedia`) и `CREATE_OFFER` (вызывает `createOffer()`
СРАЗУ, синхронно до первого `await`) гонялись между собой: `CREATE_OFFER`
почти всегда "выигрывал" и создавал SDP-оффер ДО того, как трек
микрофона был добавлен — получался offer без media-секций, ICE не
собирался вовсе (WebRTC не гатерит кандидаты без media/data-каналов).

**Fix:** `dispatch()` стал `async`, цикл по `commands` теперь
`for (...) { await executeCommand(command); }` — команды ОДНОГО
перехода исполняются строго последовательно, в порядке, заданном
`reduce()` (`call-fsm.js`). Публичный API (`placeCall`/`accept`/
`reject`/`hangup`/`handleIncomingSignal`) остался синхронным по
сигнатуре (не await'ит `dispatch` сам) — `state` обновляется
СИНХРОННО в начале `dispatch()`, до первого `await`, так что
`getState()` сразу после вызова любого из этих методов по-прежнему
отражает новое состояние немедленно; только ИСПОЛНЕНИЕ команд
(медиа/сигналинг) теперь растянуто по микрозадачам в правильном
порядке. Тесты `call-runtime.test.js` обновлены — добавлен `flush()`
после каждого действия перед проверкой `media.calls`/`published`
(раньше проверялись синхронно сразу после вызова, что маскировало бы
эту гонку, а не ловило её).

Живая E2E-проверка (2 браузера, fake media, реальный strfry) ПОСЛЕ
фикса: полный цикл звонка (исходящий→входящий с уведомлением→приём→
`CONNECTED` с корректными именами на обеих сторонах и волновой
визуализацией→завершение с корректной причиной на обеих сторонах)
пройден полностью, включая скриншот компактной плашки без наложения на
сайдбар.

### Побочная находка — сломанный `vite.config.js`

В процессе работы обнаружено (не моя правка): сторонний
инструмент/автоимпорт добавил в `vite.config.js` нерабочие импорты
(`nostr-tools/lib/types/nip30` — несуществующий путь экспорта, плюс
`node:assert`/`node:os`/`node:process`/`node:querystring` наивно
подобранные по совпадению имени локальных идентификаторов) — билд падал
полностью. Восстановлен из HEAD + применены только легитимные правки
(ICE-серверы), табы вместо 4-пробельного форматирования вернулись к
исходной конвенции проекта.

Regression: `npm test` 825/825. `npm run build` 337.74 КБ gzip (бюджет
1304 КБ, запас ~966 КБ).

## Этап 48-довесок — найдены живым использованием: нет звука, зависшая плашка

Пользователь протестировал вживую после п.6-9 и сообщил два реальных бага.

### Баг 1 — звука не было вообще

Полученный от собеседника `MediaStreamTrack` приходил через `pc.ontrack`
(`media-controller.js`), сохранялся в `remoteMediaStream` (`call.js`), но
использовался ТОЛЬКО для волновой визуализации — `AnalyserNode` анализирует
поток (амплитуды для рисования столбиков), а НЕ воспроизводит его. Нигде
не было `<audio>`-элемента с `srcObject`. Разрешения браузера тут ни при
чём — трек честно доходил, просто пел в пустоту.

Fix — `call-overlay.jsx`: новый компонент `RemoteAudio` — скрытый
`<audio autoPlay>`, `srcObject = remoteMediaStream.value`, вмонтирован в
`.call-bar` (CONNECTED/RECONNECTING). `el.play().catch(()=>{})` — autoplay
может потребовать жеста пользователя, но клик "Принять"/"Позвонить" его
уже дал, так что это подстраховка, не основной путь.

### Баг 2 — плашка "Звонок завершён" висела бесконечно (без крестика)

Корень ГЛУБЖЕ, чем просто UI: `ENDED` — терминальное состояние в чистом
`call-fsm.js` (I5 — игнорирует ВСЕ события). VOICE.md §1.1 буквально:
"ENDED после очистки ресурсов переходит в IDLE (новый звонок начинается
из IDLE)" — но эта ответственность runtime (не reduce()) НЕ была
реализована вовсе. Практическое следствие — не только "плашка висит":
**следующий звонок (исходящий ИЛИ входящий) молча игнорировался бы**,
раз FSM застревал в ENDED навсегда.

Fix — `call-runtime.js`: `EMIT` с `stateName==="ENDED"` планирует
`ENDED_AUTO_RESET_MS=3000` таймер (`setTimeoutImpl`, тот же DI-канал, что
FSM-таймеры) → `resetToIdle()` → `state = idleState()` +
`onStateChange("IDLE")`. Новый публичный метод `dismissEnded()` — тот же
`resetToIdle()`, вызывается немедленно (крестик в UI), отменяя
запланированный таймер. `resetToIdle()` идемпотентен (проверяет
`state.name === "ENDED"` перед сбросом — повторный вызов таймером ПОСЛЕ
ручного dismiss — no-op).

`call-overlay.jsx` — крестик `.call-overlay-ended-close` →
`dismissEndedCall()` (новый экспорт `call.js`).

Тесты — `call-runtime.test.js`: +3 (существующий ring-timeout тест
скорректирован — теперь после ENDED остаётся РОВНО один таймер,
ended-auto-reset; новый тест на сам автовозврат + успешный повторный
звонок ПОСЛЕ него; тест на `dismissEnded()` — немедленный сброс +
отмена таймера; тест на `dismissEnded()` вне ENDED — no-op).

### Живая проверка (Playwright, 2 браузера, fake media, реальный strfry)

Оба бага подтверждены исправленными: `<audio>` реально проигрывает
(`srcObject` задан, не на паузе, есть аудиотрек) на ОБЕИХ сторонах;
крестик закрывает плашку немедленно; звонок СРАЗУ после закрытия
проходит нормально (FSM не застревает в ENDED).

**ICE-restart (обрыв связи) — живым сетевым обрывом НЕ подтверждён,
задокументировано честно, не домысел:** попытка через CDP
`Network.emulateNetworkConditions(offline:true)` и через Playwright
`context.setOffline(true)` — эмпирически ни один не влияет на
`RTCPeerConnection.iceConnectionState` голого peer connection (проверено
отдельным sanity-тестом без единой строчки кода проекта: состояние
осталось `connected` весь 8-секундный оффлайн-период). Это известное
ограничение инструментов автоматизации браузера (WebRTC UDP-трафик идёт
мимо перехватываемого CDP Network domain), не пробел в реализации.
Настоящий обрыв потребовал бы блокировки пакетов на уровне ОС (`pfctl`,
sudo) — не выполнено без явного согласия пользователя (риск для
сетевых настроек хоста). Логика ICE-restart при этом покрыта: table-driven
юнит-тестами `call-fsm.js` (glare, polite/impolite-тайбрейкер, backoff,
исчерпание попыток) и `call-runtime.test.js` (полный цикл impolite-
инициатора с фейковым медиа-контроллером), плюс реальный E2E уже
подтвердил, что `oniceconnectionstatechange → dispatch` работает
(поймал `connected` в успешном сценарии — тот же код поймает и
`disconnected`/`failed`).

Regression: `npm test` 828/828. `npm run build` 337.93 КБ gzip.

## Этап 49 — контакты: контракты (Event/Command/State + единая таблица)

Источник — CONTACTS-FSM.md (корень проекта, все три роли — Claude, в
этой же сессии, без похода к Opus — пользователь явно попросил). 3
развилки закрыты явными решениями пользователя (полная унификация
таблиц; bootstrap resolvedAt = момент миграции; чистый старт для
outgoingAcquaintanceRequests без переноса данных).

### Файлы (Frisby, §3 CONTACTS-FSM.md)

```
src/domain/contacts/contact-fsm.js     — pure. reduce(peerState, event) -> {state, commands}
                                          И reconcileList(relationships, listKind, pubkeySet, createdAt)
                                          -> {relationships, commands}. Ноль I/O/async. Пишет ВОРКЕР.
src/domain/contacts/contact-runtime.js — imperative shell: Map<peerPubkey, peerState>
                                          для ВСЕХ peer'ов владельца, маршрутизация rumor'ов
                                          + kind-3/kind-10000 reconciliation, исполнение команд.
                                          Пишет Claude.
```

### State (peerState, §1.2 CONTACTS-FSM.md)

```js
peerState = {
  name,          // "OUTGOING_PENDING"|"INCOMING_PENDING"|"CONTACT"|"REJECTED_BY_ME"|"BLOCKED"|"NONE"
  peerPubkey,
  resolvedAt,    // created_at последнего "решения" — НЕ обновляется на переходах в *_PENDING
  greeting,      // только INCOMING_PENDING
}
```

### Event (Σ_in, §1.3)

Пользователь: `USER_SEND_REQUEST(peer,greeting)`, `USER_ACCEPT(peer)`,
`USER_REJECT(peer)`, `USER_CANCEL(peer)`, `USER_BLOCK(peer)`,
`USER_UNBLOCK(peer)`, `USER_REMOVE_CONTACT(peer)`.
Сигналинг: `REMOTE_REQUEST(peer,greeting,createdAt)`, `REMOTE_ACCEPT(peer,createdAt)`,
`REMOTE_REJECT(peer,createdAt)`, `REMOTE_CANCEL(peer,createdAt)`.

### Command (Σ_out, §1.4)

`PUBLISH_REQUEST/ACCEPT/REJECT/CANCEL(peer,...)`, `UPDATE_CONTACTS_LIST(peer,add|remove)`
(republish kind-3), `UPDATE_MUTE_LIST(peer,add|remove)` (republish kind-10000),
`UPSERT(peer,fields)`/`DELETE(peer)` (единая таблица, см. ниже), `EMIT(peerPubkey,stateName)`,
`LOG_JOURNAL(entry)` (мост к фиче "Журнал", CONTACTS-FSM.md §7).

Полная таблица переходов δ, инварианты I1-I6, kind-3/kind-10000
reconciliation (§1.6) — см. CONTACTS-FSM.md буквально, не дублирую
(ТЗ уже заморожено, воркер получит его через `--ctx CONTACTS-FSM.md`).

### Единая таблица (замена contacts/contactRequests/blockedContacts/outgoingAcquaintanceRequests)

```js
// src/core/store/database.js — новая таблица
contactRelationships: "[owner+peer], [owner+state]"
// {owner, peer, state, resolvedAt, greeting?, sentAt?}
```

### Новый kind

```js
export const CONTACT_REJECTED_KIND = 3006; // следующий свободный в кластере 3001-3005
```

### UI (контракт, реализация — задача 4 §5 CONTACTS-FSM.md)

`contacts.jsx` читает `contactRelationships` через 5 фильтров по `state`
вместо 4 отдельных таблиц: "Отправленные заявки" (OUTGOING_PENDING),
"Входящие заявки" (INCOMING_PENDING, было "Запросы"), "Контакты"
(CONTACT), "Отклонённые" (REJECTED_BY_ME, НОВЫЙ раздел), "Заблокированные"
(BLOCKED).

### `contact-runtime.js` — публичный API (задача 2, реализация Claude)

Фабрика, тот же DI-паттерн, что `createCallRuntime` (call-runtime.js,
этап 48): `publish`/`privKey`/`ownerPubkey` инъецируются, `db` —
прямой импорт (как в handlers.js/contacts.js — не звонок, тут
персистентность неотъемлема от домена).

```js
createContactRuntime({ ownerPubkey, privKey, publish, onStateChange, onJournal })
  -> {
    load,                              // async () -> void: СНАЧАЛА одноразовая миграция
                                        // legacy-таблиц (contacts/blockedContacts/contactRequests
                                        // -> contactRelationships, отложена до unlock — dbKey
                                        // недоступен в Dexie upgrade-транзакции, developer
                                        // decision этапа 49), ПОТОМ читает contactRelationships в Map.
                                        // Идемпотентна: миграция очищает исходные таблицы после
                                        // успешного переноса, повторный вызов — no-op.
    sendRequest(peer, greeting),       // USER_SEND_REQUEST
    accept(peer), reject(peer), cancel(peer),
    block(peer), unblock(peer), removeContact(peer),
    handleIncomingRumor(rumor),        // kind 3001/3004/3006/3005 -> REMOTE_* (rumor.pubkey, rumor.created_at)
    reconcileContactList(pubkeySet, createdAt),  // reconcileList(..., "contacts", ...) + исполнение команд
    reconcileMuteList(pubkeySet, createdAt),     // reconcileList(..., "mute", ...)
    getPeerState(peer),                // peerState | null
    listPeersByState(stateName),       // peerState[]
  }
```

`onStateChange(peerPubkey, stateName)` — EMIT. `onJournal(entry)` —
LOG_JOURNAL (entry = `{peer, message}`), runtime транслирует в
`notify()`+запись в "Журнал" (этап 49, Приложение Б) — сам runtime
про UI/notifier ничего не знает, только зовёт колбэк.

`UPSERT`/`DELETE` персистятся ОДИНАКОВО: runtime пишет ПОЛНОЕ текущее
`peerState` (уже пересчитанное `reduce`/`reconcileList`) в
`contactRelationships` — `fields` в самой команде не используется для
персистентности напрямую (он лишь документирует, что именно
изменилось), избегая рассинхрона между Map и БД.

`UPDATE_CONTACTS_LIST`/`UPDATE_MUTE_LIST` republish-ят kind-3/kind-10000
из ТЕКУЩЕГО состава `listPeersByState("CONTACT"|"BLOCKED")` (Map уже
обновлена к моменту исполнения команды) — локальный `contactRelationships`
уже актуален через сопутствующий `UPSERT`/`DELETE` в той же транзакции
δ, поэтому publish не блокирует локальную консистентность (тот же
принцип, что `foldContactList` раньше — локально-оптимистично,
kind-3-событие лишь транслирует изменение на другие устройства).

## Этап 50 — N1 (read-cursor gating) + фича "Журнал"

Источник — CONTACTS-FSM.md §6 (Приложение А, N1) и §7 (Приложение Б,
"Журнал"), написанные на этапе 49. Не FSM, не требует design-записки
(13a — рутина: недостающий guard + одна новая таблица + одна точка
записи). Повод: два отдельных найденных пользователем пробела —
(1) лавина уведомлений при релогине для ЧАТОВ/КАНАЛОВ (для контактов
уже решено на этапе 49 инвариантом I1); (2) уведомления/тосты исчезают
без следа — негде посмотреть, что произошло, пока не открыл нужный экран.

### N1 — read-cursor gating (домен: `read-status.js`/`channel-read-status.js`)

Курсоры прочтения УЖЕ существуют (`chatSyncState.lastReadLamportTs`,
`channelSyncState.lastReadAt`) и уже надёжно продвигаются при просмотре
экрана (`markChatAsRead`/`markChannelAsRead`, вызываются из
`chat.jsx`/`channel.jsx`/`channel-chat.jsx` на каждый рендер окна) — и
синхронизируются между устройствами ДО того, как могут сработать
уведомления redelivery-потока (`rebuildReadStatus`/`rebuildChannelReadStatus`
вызываются в начале `connect()`, до подписок на контент). Новых структур
не нужно — только предикат-гейт перед уведомлением:

```js
// src/domain/messaging/read-status.js
export async function isChatContentRead(ownerPubkey, contactPubkey, lamportTs) {
  const row = await db.table("chatSyncState").get([ownerPubkey, contactPubkey]);
  return lamportTs <= (row?.lastReadLamportTs ?? 0);
}

// src/domain/content/channel-read-status.js
export async function isChannelContentRead(ownerPubkey, channelId, createdAt) {
  const row = await db.table("channelSyncState").get([ownerPubkey, channelId]);
  return createdAt <= (row?.lastReadAt ?? 0);
}
```

Точки применения (`transport.js`, ПЕРЕД вызовом `notifyAndLog`, см. ниже):
1:1-сообщение (`receivedResult.lamportTs`/`receivedResult.contactPubkey`),
канал-пост/комментарий/чат канала (`event.created_at`/`channelId`) — если
предикат вернул `true`, `notifyAndLog` не вызывается вовсе (ни тоста, ни
записи в Журнал — контент уже был прочитан, включая "на другом устройстве"
и "в прошлой сессии до релогина"). Контакты этого гейта НЕ требуют — I1
(этап 49) уже полностью решает тот же класс проблемы для них.

### "Журнал" — персистентный лог уведомлений

```js
// src/core/store/database.js — новая таблица (db.version(16))
journalEntries: "id, owner, [owner+createdAt]"
// {id (uuid), owner, createdAt, category, title, body, navTarget, read}
```
`title`/`body`/`navTarget` зашифрованы (`JOURNAL_ENTRIES_PLAINTEXT_FIELDS =
["id","owner","createdAt","category","read"]`) — тот же Tier-принцип, что
`contactRequests.greeting`/`contactRelationships.greeting`. `navTarget` —
ТОТ ЖЕ plain-объект, что уже кладётся в `pendingNavTarget`
(`{screen,contactPubkey}`/`{screen,channelId,postId?,commentId?,subTab?}`/
`{screen}`) — не изобретаем новую форму, переиспользуем.

```js
// src/domain/notifications/journal.js — persistence + мост к notify()
writeJournalEntry(ownerPubkey, dbKey, {category, title, body, navTarget}) -> Promise<entry>
listJournalEntries(ownerPubkey, dbKey) -> Promise<entry[]>   // сортировка createdAt desc
markJournalEntryRead(id) -> Promise<void>                    // read — plaintext поле,
                                                               // update() не трогает ciphertext
notifyAndLog(ownerPubkey, dbKey, settings, category, subcategory, {title, body, onClick, navTarget}, entityId, backend)
  -> level   // зовёт notify() (notifier.js, НЕ меняется — остаётся чистым,
             // backend-инъекция сохраняется, существующие тесты не трогаются),
             // и, если level !== "off", best-effort пишет journalEntries.
             // notify() держит собственный onClick (клик по тосту/native) —
             // navTarget передаётся ОТДЕЛЬНЫМ полем (небольшое дублирование
             // с телом onClick на каждом call site — механическое, не
             // концептуальный риск, см. также I2-подобные ловушки).
```

Все текущие вызовы `notify(...)` (transport.js — 8 мест: inbox,
moderation/reports, канал-пост/комментарий/comment-reply/чат канала,
ban, 1:1-сообщение; `call.js` — входящий звонок; `contacts.js` —
`notifyContactJournalEntry`, ранее было "мост-заглушка, no-op" — теперь
реально пишет) заменяются на `notifyAndLog(...)` с добавлением
`navTarget` (тот же объект, что уже строится для `onClick`).

### UI (реализация — задача 4, не формализуется отдельно)

`src/ui/signals/journal.js` — сигнал `journalEntries` + `refreshJournal`
(тот же триггер `messagingActivity`, что уже используют contacts.jsx/
channels.jsx) + `openJournalEntry` (помечает read, зовёт
`navigateFromNotification(entry.navTarget)`). `src/ui/screens/journal.jsx`
— новый экран, список recent-first, непрочитанные выделены. `nav-items.js`:
новый пункт `{id:"journal", label:"Журнал"}`, `DEFAULT_ACTIVE` меняется
с `"messages"` на `"journal"` — не ломает существующие тосты/бейджи
(остаются как есть, Журнал — дополнительный персистентный слой поверх
той же точки диспетчеризации, `notifyAndLog`).

## Этап 50-довесок-2 — редактирование и удаление каналов

Источник — пользователь (живая проверка). Рутина (13a): kind 30060
(метаданные канала) уже parameterized-replaceable (NIP-01, d-tag=channelId),
`buildAddressableDeletionEvent`/kind-5-адресуемое удаление уже есть и
используется для постов (kind 30061) и групп (kind 30050) — здесь тот же
приём, применённый к каналу целиком. Единственная новая часть —
каскадная локальная очистка на СТОРОНЕ ПОЛУЧАТЕЛЯ (уже существует как
`deleteChannelLocally`, moderation.js — раньше вызывалась только при
самобане, теперь экспортирована и переиспользуется для второго сценария).

### `editChannel` (src/domain/content/channel.js)

```js
editChannel(ownerPubkey, ownerPrivKey, dbKey, channelId, { name, description, rules, avatarDescriptor, allowChatAttachments }, publish)
```
Частичное обновление — необязательные поля (`undefined`) сохраняют текущее
значение, не затираются. Только `role==="owner"` (иначе throw). Локальная
строка `channels` обновляется СРАЗУ (decrypt-merge-encrypt, тот же приём,
что `receiveChannelMetadata` на приёмной стороне) — не ждёт relay-эхо для
собственного UI; republish kind-30060 с ТЕМ ЖЕ d-tag (channelId) лишь
транслирует изменение подписчикам — `channelContentSubscriber` (transport.js)
уже подписан на этот topic+kind для ВСЕХ локальных каналов независимо от
role (включая собственные), плюс уже вызывает `receiveChannelMetadata`
(existing pipeline, без изменений) — новой подписки/фильтра не требуется.

### `deleteChannel` (src/domain/content/channel.js)

```js
deleteChannel(ownerPubkey, ownerPrivKey, dbKey, channelId, publish)
```
Только `role==="owner"`. Публикует `buildAddressableDeletionEvent(privKey,
30060, channelId)` (kind 5, тег `a: "30060:{ownerPubkey}:{channelId}"`),
затем `deleteChannelLocally` (владелец не ждёт собственное эхо — тот же
принцип, что `deletePost`).

### Приём kind 5 на стороне подписчика (transport.js)

`channelContentSubscriber`'s фильтр: `kinds: [30060, 30054, 30061, 30062,
30063, CHANNEL_BAN_KIND, 5]` (добавлен `5`). Новая ветка: парсит `a`-тег,
если префикс `"30060:"` — сверяет `event.pubkey` с ДВУМЯ вещами (защита от
подделки, тот же принцип, что `validateDeletion`/`receiveBanAnnouncement`):
(1) частью тега (`{pubkey}` в `30060:{pubkey}:{channelId}` совпадает с
`event.pubkey` — подписант события — тот, кто его СФОРМИРОВАЛ, тег может
солгать) и (2) `channelRow.creatorPubkey` (сверка с уже известным локально
владельцем канала — тот же принцип, что `receivePost`/`receiveBanAnnouncement`
не доверяют тегам напрямую). Совпадение обоих → `deleteChannelLocally` +
`notifyAndLog` ("Канал «X» удалён владельцем", категория `channels`,
navTarget `{screen:"channels"}` — открытого канала уже не существует, есть
смысл лишь вернуться к списку). Название канала читается ДО удаления (тот
же порядок, что `receiveBanAnnouncement`'s самобан-ветка не имела нужды
удержать — здесь имя нужно для текста уведомления).

**Осознанно вне охвата** (не запрошено пользователем, отдельный найденный,
но НЕ исправляемый сейчас пробел): аналогичное kind-5-удаление ПОСТА
(kind 30061, `deletePost`) публикуется, но `channelContentSubscriber` кind-5
ветка обрабатывает ТОЛЬКО префикс `"30060:"` — удаление отдельного поста
по-прежнему не долетает до подписчиков живьём (тот же класс пробела, что
был у канала целиком, просто не тот, о котором просил пользователь).

### UI (`src/ui/screens/channel.jsx`)

Новая вкладка (только `isOwner`, тот же паттерн, что "Модерация"), подпись
буквально по формулировке пользователя: `Редактировать канал «{name}»`.
Внутри — форма с текущими значениями (name/description/rules/avatar/
allowChatAttachments, те же лимиты длины, что `CreateChannelForm`,
channels.jsx: `NAME_MAX_LENGTH=100/DESCRIPTION_MAX_LENGTH=500/
RULES_MAX_LENGTH=1000`), кнопки "Сохранить"/"Отмена", и отдельно —
"Удалить канал" (`window.confirm`, тот же паттерн, что `deletePost` в этом
же файле) → после успеха `openChannel(null)` (канал больше не существует,
возврат к списку).

---

## Этап 53 — раздел «Файлы»: И0 + заморозка §5 (FILES-DOCS/TASK.md)

Источники: `FILES-DOCS/TASK.md` (ред. 2), `FILES-DOCS/MATH.md` (ред. 2),
`FILES-DOCS/ALGO.MD`. И0 (§10 TASK.md, 8 проверок) выполнено ДО первой
строки кода живым чтением семи существующих подсистем + одним реальным
запросом к развёрнутому Blossom-серверу. Три из восьми (П-1/П-3/П-4)
номинально способны отменить принятые решения — ни одна не отменила,
но П-1/П-2 потребовали уточнения контрактов §5 TASK.md ниже.

### Находки И0, повлиявшие на контракты

**П-1 (`core/sync/lamport.js`).** `createLamportClock().tick()/receive()`
возвращают голое число (`value = max(local, remote) + 1` на `receive` —
семантика корректна), БЕЗ `deviceId` внутри метки. Тотальная метка
`(counter, deviceId)`, которую требует L-TOTAL (MATH.md §5.1), нигде в
проекте не собрана как пара — ближайший прецедент, `domain/auth/engine.js`
`compareRecords`, использует `(lamportTs, eventId)`, не `deviceId`.
**Решение пользователя:** для дерева файлов tie-break — честный
`deviceId` (`domain/identity/device.js`, `getOrCreateDeviceId()` —
случайный 128-бит, персистентный), не `eventId`, несмотря на лишнюю
прошивку через каждую операцию.

**Следствие для §5.1/5.2 TASK.md.** `tree.js`/`ops.js` обязаны оставаться
чистыми (§3.3 TASK.md — без I/O), а получение `deviceId`/тика счётчика —
эффект (чтение IndexedDB). Поэтому метка **не генерируется внутри**
конструкторов операций, а передаётся вызывающей стороной готовой парой.
Уточнённые сигнатуры (§5.2 TASK.md дополнен, не изменён):

```js
// domain/files/tree.js
type Label = { counter: number, deviceId: string };   // deviceId = getOrCreateDeviceId()
type LWW<T> = { value: T, label: Label };

compareLabels(a: Label, b: Label) -> -1 | 0 | 1;
// a.counter - b.counter, при равенстве — лексикографически по deviceId (строка).
// Строгий тотальный порядок ⟺ deviceId уникален (даётся getOrCreateDeviceId).

applyOp(S, op)   -> S'
merge(S, delta)  -> S'
project(S)       -> ProjectedTree   // R, см. §5.1 TASK.md — без изменений

// domain/files/ops.js — конструкторы ПРИНИМАЮТ готовую метку, не создают её.
// createFolder/copy ТАКЖЕ принимают готовый NodeId новых узлов (§4.2:
// "создан пользователем — случайный идентификатор" — источник случайности
// снаружи, tree.js/ops.js остаются детерминированными при фиксированных
// входах, это и есть "чистая" в терминах §3.3, и это же нужно property-
// тестам §11 (1.5): сценарий воспроизводится по номеру, включая id).
createFolder(S, parentId, name, newId, label) -> Op | PreconditionError
rename(S, id, name, label)                    -> Op | PreconditionError
move(S, id, newParentId, label)               -> Op | PreconditionError
copy(S, id, destId, newIds, label)            -> Op[]   // newIds: Map<NodeId,NodeId> старый->новый по всему поддереву
remove(S, id, label)                          -> Op                  // = move в /trash
purge(S, id, label)                           -> Op
```

Тик счётчика (`core/sync/lamport.js`, уже существует, per-owner
персистентность) и `deviceId` (`domain/identity/device.js`, уже
существует) читаются ОДИН раз в нечистом слое (`domain/files/index.js`
или `ui/`), передаются в `ops.js` готовой парой. `tree-crdt.test.js`
обязан включать сценарий с равными `counter` у разных `deviceId`
(П-1: "есть ли тест с равными счётчиками у разных устройств" — сейчас
такого теста нет нигде в проекте, будет первым).

**П-2 (`core/sync/lww.js`).** `lwwWinner`/`pickLatest` сравнивают
`event.created_at` (wall-clock на момент подписи — не `Date.now()` в
момент сравнения, детерминизм формально не нарушен) + tie-break по
`event.id`. Это НЕ Lamport-метка и **не переиспользуется** для полей
`par`/`name`/`origin` узла — они используют `compareLabels` выше,
единообразно по всем трём полям (смешение двух баз времени на одном
узле — источник неотлаживаемого поведения, ровно то, от чего
предостерегает П-2). Примитив `core/sync/lamport.js` (счётчик) —
переиспользуется как есть; примитив `core/sync/lww.js` (компаратор) —
НЕ переиспользуется, пишется свой на базе `compareLabels`.

**П-3 (`core/crypto/file-crypto.js`).** Шифрует файл ОДНИМ блоком
(один nonce, один тег ChaCha20-Poly1305 на весь файл) — буквально
стоп-сценарий П-3. Не пересмотр: TASK.md уже закладывал ровно это
(решение №11, §5.4, задачи 2.1/2.4/2.5) — `domain/files/crypto.js` с
независимым шифрованием чанков пишется заново, `file-crypto.js` не
трогается (нужен фасаду `attachments` до И7).

**П-4 (Blossom `Range`).** Живой запрос к развёрнутому серверу
(`server/blossom/`, `sebdeveloper6952/blossom-server`, Go) —
`Range: bytes=10-50` → `206 Partial Content`, корректные
`Content-Range`/`Accept-Ranges`. Вариант с ограничительным ACL не
тестировался живым запросом (в этой реализации нет компонента с
названием "whitelist-plugin", есть `access_control_rules`; сервер
использовался активной сессией — перезапуск ради второстепенного
варианта не оправдан). Базовый случай, единственный реально
блокирующий (R-1), подтверждён.

**П-7 (`domain/events/kinds.js`).** Файл НЕ является полным реестром —
трекает только 7 кинд. Первый проход grep'а (по паттерну `KIND_*`) тоже
оказался неполон — часть констант названы `*_KIND` (суффикс, не
префикс: `CALL_SIGNAL_KIND`, `CONTACT_REQUEST_KIND` и т.д.), нашлись
вторым проходом. Итоговый список — оба паттерна (`kind:\s*\d+` И
`[A-Z_]*KIND[A-Z_]*\s*=\s*\d+`) по всему `src/`, объединено и
дедуплицировано:

`0` (профиль), `3` (контакты), `5` (удаление), `14` (DM rumor),
`443/444/445/446` (MLS), `3001` (заявка в контакты), `3002` (подписка
на канал), `3003` (`CHANNEL_REPORT_KIND` — жалоба, ЗАНЯТ), `3004`
(принята), `3005` (отменена), `3006` (отклонена), `5051` (moderation/
fold, обычный — не replaceable), `10000` (mute), `10002` (relay list),
`10051` (MLS key package relays), `20075` (сигналинг звонка, эфемерный),
`22242` (NIP-42 auth), `24242` (Blossom auth), `30050` (группа),
`30051` (permission-fold, только в synthetic-fixtures — зарезервирован),
`30053` (channel access/VIEW), `30054` (comment allowlist), `30060`
(канал), `30061` (пост), `30062` (комментарий), `30063` (chat канала),
`30064` (`CHANNEL_BAN_KIND`, ЗАНЯТ), `30070` (read-status), `30071`
(draft), `30072` (ui-settings), `30073` (discovery), `30074`
(`CHANNEL_READ_STATUS_KIND`, ЗАНЯТ — этот кинд НЕ в `kinds.js`, найден
только вторым проходом).

Свободные диапазоны для И5: parameterized-replaceable **`30075+`** (не
`30074+` — первая версия этой находки ошиблась ровно на одну позицию,
исправлено до фиксации в коде), эфемерный `20076+`, заявки `3007+`.
Задача 5.1 (И5) обязана сверяться с этим списком, не только с
`kinds.js`, и повторить grep обоими паттернами на момент начала И5 —
список мог измениться.

**П-8 (`service-worker.js`).** Есть в `dist/` (подтверждено сборкой),
есть `fetch`-обработчик, но строка `if (url.origin !==
self.location.origin) return;` явно пропускает Blossom (другой origin)
мимо перехвата. Следствие для И4 (задача 4.1): плеер обращается к
СВОЕМУ same-origin виртуальному пути (например
`/files-content/<digest>?...`), который получает новую ветку в
`fetch`-обработчике ДО этой строки; cross-origin запросы к Blossom
внутри неё делает сам обработчик (`fetch()` из кода SW, не из
исходного запроса страницы) — не требует перехвата чужого origin.

### Размещение и таблицы — без изменений от TASK.md §3.3/§4.4

`src/domain/files/{tree,ops,manifest,blob,crypto,content,share,mount,sync,store,index}.js`,
`src/ui/screens/files/`, `src/ui/components/file-picker/`,
`src/ui/components/media-player/`. Таблицы: `files_nodes`,
`files_mounts`, `files_manifests`, `files_blobs`, `files_thumbs`
(ключ — дайджест, не `NodeId`, П-5 подтвердил тот же приём уже
используется в `attachment-memory-cache.js`/`domain/attachments/cache.js`).

**Правка по итогам И3 3.8 (миниатюры):** `files_thumbs` в итоге НЕ
используется — декодированная миниатюра живёт только в оперативном
кэше (`attachment-memory-cache.js`, тот же модуль, что вложения чатов),
пересчитывается заново каждую сессию через `content.getManifest`/
`getRange` по видимости строки (IntersectionObserver). Персист
декодированной миниатюры на диск не был целью прохода — не исключает
`files_thumbs` на будущее (например, для И4/плеера), просто пока не
заполняется.

Добавлена НЕ объявленная в TASK.md таблица `files_keys` (`db.version(18)`,
аддитивно): `[ownerPubkey+digest], ownerPubkey`, значение —
`fileKey` (из `content.putStream`), зашифрован `dbKey` (ChaCha20-Poly1305,
тот же приём, что `attachments/cache.js`). Найдено реализацией, не
предусмотрено спецификацией: `putStream` отдаёt `fileKey` отдельным
полем и явно снимает с себя ответственность за его персистентность —
без отдельного хранилища файл становится нерасшифровываем после
перезагрузки страницы. НЕ путать с обёртками ключа ДЛЯ КОНТАКТОВ
(`share.js`, И6) — это ключ владельца на своё же содержимое.
`store.js`: `saveFileKey(ownerPubkey, dbKey, digest, fileKey)` /
`getFileKey(ownerPubkey, dbKey, digest) -> Uint8Array | undefined`.

### Явное сужение скоупа

И1 (эта сессия начинает с него) — `tree.js`/`ops.js`, целиком `[C]`,
без воркера, ноль I/O, ноль сети, ноль UI. Остальные этапы (И2-И7) —
по декомпозиции §11 TASK.md без изменений, контракты каждого
замораживаются перед его началом отдельно.

### Решение пользователя (найдено при разборе И2) — фасад `attachments` НЕ меняет формат в И2

Существующие тесты вложений (`attachments-upload.test.js`) фиксируют
**одноблобный** протокол: `uploadAttachment` — один `PUT` (файл шифруется
целиком, `encryptionKey` — 32 байта одного ключа), `downloadAttachment` —
один `GET` по одному `sha256`. Новый `content.putStream` по конструкции
режет файл на манифест + N блобов чанков — другой протокол на проводе,
не "то же поведение другим кодом". Прогнать типичное вложение (≤20 МБ)
через `putStream` дало бы МИНИМУМ 2 сетевых вызова вместо одного —
несовместимо с жёстким критерием 2.3 буквально.

**Уточнение форм-фактора (найдено при реализации 2.4/2.5, решение №11
TASK.md прочитано буквально ПОСЛЕ первого черновика):** чанки — НЕ
отдельные Blossom-блобы. Один блоб на файл (весь шифротекст целиком,
один PUT), чанки — внутреннее деление ЭТОГО блоба, чтение отдельного
чанка — HTTP `Range` по нему же (offset считается по чанкам, П-4
подтвердил живым запросом, что офлайн-сервер отвечает `206`). Манифест
— ОТДЕЛЬНЫЙ маленький блоб (§3.6 MATH.md: "манифест сам адресуется
дайджестом"), итого 2 PUT/2 GET на файл (фиксированные, не `O(чанков)`)
— всё равно другое поведение, чем 1 PUT/1 GET вложений, решение выше
не отменяется.

Важный нюанс, не указанный явно ни в TASK.md, ни в MATH.md/ALGO.MD:
ChaCha20-Poly1305 добавляет тег аутентификации (16 байт) К КАЖДОМУ
чанку — offset чанка `i` В ШИФРОТЕКСТЕ равен `i × (chunkSize + 16)`,
НЕ `i × chunkSize`. Промах здесь тихо возвращал бы байты не того чанка,
начиная со второго. Пойман до тестов, зафиксирован адверсарной мутацией
(`tests/files-content.test.js`).

`Manifest.keyId` — намеренно НЕ сырой `fileKey` (утечка ключа через
общедоступный по дайджесту манифест), а непрозрачная случайная метка;
сырой ключ `content.putStream` возвращает ОТДЕЛЬНЫМ полем, его
персистентность/обёртка (`share.js`, И6) — вне ответственности
`content.js`.

**Решение:** `domain/attachments/*` в И2 **не меняет поведения вообще**
(в лучшем случае — косметический re-export пути импорта, не логики).
Продолжает whole-file шифрование (`core/crypto/file-crypto.js`, не
трогается) и один PUT/GET (свой существующий путь, не обязательно даже
через `domain/files/blob.js`). `content.putStream`/`getRange` в И2
обслуживают ТОЛЬКО новые загрузки через раздел «Файлы». Смена формата
вложений на чанкованный — предмет И7 ("messaging переходит на узлы,
фасад удаляется"), где это отдельный, осознанный шаг миграции, а не
побочный эффект И2.

### Правка контракта `tree.js` (найдено И3, задача 3.9 — бенчмарк) — `applyOp`/`merge` МУТИРУЮТ

**Находка.** Бенчмарк (`scripts/files-tree-bench.mjs`, задача 3.9)
обнаружил Θ(n²) на последовательной вставке: `ops.js`'s `nameFree`
сканировал ВСЕ n узлов на каждый `createFolder` (ALGO.MD §14, первая
строка таблицы — ровно предсказанная там ловушка), И ОТДЕЛЬНО от этого
`applyOp` клонировал ВЕСЬ `S.nodes` (`new Map(S.nodes)`) на каждый
вызов — тоже Θ(n) за вызов. На n=10⁴ последовательных `createFolder`
это давало 5.7 секунды вместо единиц миллисекунд.

**Решение (два независимых исправления):**
1. Добавлены индексы `S.children`/`S.namesInDir` (`Map`, ключ —
   `parentId`), поддерживаются инкрементально в `applyOp` — `ops.js`'s
   `nameFree`/`liveChildren` теперь O(1)/O(k) через них
   (`liveChildrenOf`/`nameOwnerInDir`, tree.js), не скан `S.nodes`.
2. **`applyOp`/`merge` теперь МУТИРУЮТ** `nodes`/`children`/`namesInDir`/
   `pending` ВНУТРИ переданного `S` (не клонируют их полностью на каждый
   вызов) и возвращают НОВУЮ обёртку верхнего уровня (другая ссылка —
   нужно `@preact/signals`, сравнивающим по ссылке в `ui/signals/
   files.js`), но внутренние `Map` — ТЕ ЖЕ объекты. **Старая ссылка на
   `S` после вызова `applyOp`/`merge` — это алиас на уже изменившееся
   состояние, не замороженный снимок.** Кому нужен настоящий независимый
   снимок (несколько "реплик" от одной точки, property-тесты) —
   `cloneState(S)` явно, `O(n)`, редко.

**Проверено:** все 52 существующих теста `domain/files` прошли БЕЗ
единой правки логики (только один тест, `tree-crdt.test.js`'s
`generateScenario`, требовал `cloneState(S0)` вместо голого
`localS = S0` — единственное место, полагавшееся на старую иммутабельность
для смоделированной офлайн-конкурентности между "репликами"). Живая
проверка (Playwright) подтвердила реактивность UI не пострадала
(сигнал видит новую ссылку на каждый `merge()`, несмотря на мутацию).

Замер после фикса: n=10⁴ последовательных `createFolder` — 4.5мс (было
5736мс, ×1275 ускорение). `project()` при n=10⁴ — 11.7мс (бюджет §8
TASK.md — 16мс). n=10⁵ — 832мс, БЕЗ хард-бюджета (ALGO.MD §2/§20:
"потолок", требует ленивую загрузку состояния, другую стратегию, не
"тот же project() быстрее" — вне скоупа v0.1, задокументировано, не
молчаливый пробел).

---

## Этап 53, И4 — плеер: заморозка контрактов (13, до кода)

Источники: §5.4/§7/§11 (И4)/§13 (R-1..R-4, П-3/П-4/П-8) TASK.md, ALGO.MD
§9 (чанки/шифрование/перемотка). И0 для этих находок уже выполнено в
рамках заморозки И0 выше — П-3 (шифрование чанков независимое) и П-4
(Blossom возвращает 206 на `Range`) сняли оба блокирующих риска (R-1/R-2)
ещё до этого этапа; П-8 (`service-worker.js` есть в `dist/`, обработчик
`fetch` есть) снимает R-4.

### Архитектурное решение — где живёт расшифровка

`service-worker.js` — единственный файл БЕЗ сборки Vite: `emitServiceWorker`
(`vite.config.js`) просто копирует его текстом с подстановкой
`__BUILD_HASH__`, `import` из `node_modules`/`src/` в нём не резолвится
(нет модульного графа). Это исключает вариант "SW сам качает с Blossom и
расшифровывает чанки" без отдельного бандла для SW (дублирование веса
`@noble/ciphers` во ВТОРОЙ бандл, новая инфраструктура сборки — конфликт
с CLAUDE.md "Два файла: index.html + service-worker.js", простота
которого — явное решение проекта, не случайность). Дополнительный довод:
`fileKey` для расшифровки в любом случае доступен только на СТРАНИЦЕ (в
памяти, после `getFileKeyFor`/`dbKeySig`) — SW не имеет `dbKey` и никогда
не должен его получать, значит передача секрета через `postMessage`
неизбежна ДАЖЕ если бы SW сам расшифровывал.

**Решение:** SW — тонкий протокольный адаптер. Он перехватывает `Range`-
запрос к своему virtual-пути, пересылает его КОНКРЕТНОЙ вкладке
(`event.clientId` — не broadcast всем клиентам: у разных вкладок могут
быть разные разблокированные аккаунты) через `postMessage`, получает
уже РАСШИФРОВАННЫЕ байты обратно и оборачивает их в `Response` с кодом
206. Вся сеть (Blossom) и вся крипто-логика остаются на странице, в уже
существующем модульном графе (`content.js`/`crypto.js`/`manifest.js`,
И2, уже забюджетированы).

### Virtual-путь

`/files-content/<manifestDigest>` (same-origin, без query-параметров —
только идентификатор манифеста; ключ по URL никогда не передаётся).
Ветка добавляется в `fetch`-обработчик ДО строки `if (url.origin !== ...)
return;` (не потому что путь кросс-origin — он свой же, — а чтобы не
затеряться среди веток кэша статики).

### Протокол сообщений SW ↔ страница

Запрос (SW → конкретный `client`, через `client.postMessage`):

```js
{
  type: "files-content:range-request",
  requestId: string,       // crypto.randomUUID() — корреляция конкурентных запросов
  manifestDigest: string,
  start: number,           // байт, включительно, В ИСХОДНОМ файле
  end: number,             // байт, включительно (HTTP Range семантика)
}
```

Ответ (страница → SW, через `navigator.serviceWorker.controller.postMessage`,
хотя фактически летит через `MessageChannel`/`event.source`, см. DESIGN.md):

```js
{
  type: "files-content:range-response",
  requestId: string,
  ok: boolean,
  bytes: Uint8Array | null,   // ok=true: ровно [start, end] включительно
  mime: string | null,
  size: number | null,        // manifest.size — нужен для Content-Range/Length при открытых диапазонах
  error: string | null,       // ok=false: "unknown-digest" | "range-out-of-bounds" | "decrypt-failed" | иное
}
```

Страница отвечает НА ТОТ ЖЕ канал, которым пришёл запрос (`event.source`
в обработчике `message` на странице — вкладка отвечает СВОЕЙ SW-цели, а
не широковещательно). SW сопоставляет ответ с ожидающим `Promise` по
`requestId` (`Map<requestId, {resolve, reject}>`), таймаут 15с — если
вкладка не ответила (закрыта посреди запроса, гонка регистрации) — SW
отвечает `504` браузеру, не подвешивает `fetch` навсегда.

### Реестр открытых файлов на странице (`player-bridge.js`)

```js
registerPlayerFile(manifestDigest, { manifest, fileKey, serverUrl }) -> void
unregisterPlayerFile(manifestDigest) -> void
```

Компонент плеера (4.4) обязан вызвать `registerPlayerFile` ДО того, как
установит `src` у `<video>`/`<audio>` (иначе первый же запрос браузера
придёт раньше регистрации — гонка, закрыта порядком вызовов, не
таймером). `unregisterPlayerFile` — при размонтировании; если файл не
зарегистрирован на момент запроса — страница отвечает `ok:false,
error:"unknown-digest"`, SW отдаёт `404`.

### `content.js` — аддитивное расширение (частично меняет "точку чтения")

```js
// НОВОЕ, аддитивно — по образцу getRange, но на гранулярности ОДНОГО чанка
// целиком (не произвольного диапазона) — единица кэширования 4.3.
getChunk(manifest, fileKey, chunkIndex, {serverUrl, fetchImpl}) -> Uint8Array  // расшифрован, чанк целиком
```

`getRange` **остаётся публично неизменным** (сигнатура/поведение/тесты
И2 без правок) — рефакторинг ВНУТРЕННЕЙ реализации поверх `getChunk`
(DRY по правилу проекта: арифметика `cipherChunkOffset` — "ошибка на
единицу даёт битое видео", ALGO.MD §0 — не дублировать в трёх местах).
Полная регрессия `files-content.test.js` обязательна после рефакторинга
(правило 13 skill — явное решение + немедленная полная регрессия).

### `chunk-cache.js` — LRU по объёму (13b, см. DESIGN.md)

```js
createChunkCache(budgetBytes) -> {
  get(key) -> Uint8Array | undefined,
  put(key, bytes) -> void,   // budgetBytes по умолчанию — см. DESIGN.md
}
```

Ключ — `` `${manifestDigest}:${chunkIndex}` ``, НЕ голый `chunkIndex`
(тот же класс бага, что owner-scoping файловых ключей, этап 53 И3 3.8 —
разные файлы не должны делить кэш по совпавшему индексу). Тот же паттерн
MRU через порядок вставки `Map`, что `attachment-memory-cache.js`
(этап 43-довесок) — `delete`+`set` двигает запись в MRU-конец без
отдельного поля `lastAccessedAt`.

### `player-session.js` — конвейер 4.2 + упреждающая подкачка 4.3

```js
createPlayerSession({manifest, fileKey, serverUrl, cache}) -> {
  readRange(start, end) -> Promise<Uint8Array>,   // включает upreждающую подкачку следующего чанка
}
```

### Область НЕ входящая в этот довесок

`FilePicker` (7.1), интеграция плеера с `attachments`/чатом (это И7) —
вне скоупа. Видео-миниатюра кадра (thumbnails.js уже отметил этот
пробел на этапе 3.8) — естественное расширение ПОСЛЕ этого довеска, не
включено сейчас (не запрошено, отдельная фича).

---

## Этап 53, И5 — синхронизация своих устройств: заморозка контрактов

Источники: §6/§11 (И5)/§4.2 (`NodeId = H(event_id‖digest)`) TASK.md.

### Найденный конфликт (решение пользователя) — задачи 5.4/5.5 отложены в И7

TASK.md относит "узлы из вложений чата" (`NodeId = H(event_id‖digest)`,
папки `/Из чатов/<контакт>`) к И5. Проверкой найдено: вложения чата
(`core/crypto/file-crypto.js`, этапы 10/28/29) шифруются ОДНИМ блоком
(случайный nonce ПРИПИСАН к шифротексту) — байт-формат несовместим с
чанковым форматом `domain/files/crypto.js` (этап 53 И2: nonce
детерминирован из индекса чанка, ничего не хранится в блобе).
"Обернуть" старое вложение манифестом с одним чанком невозможно без
переshifrования — не вопрос метаданных. Это ровно тот переход,
который log.md (закрытие И2, этап 53) уже отнёс к И7 ("переход
messaging на узлы читаемого чанками формата остаётся задачей И7").
**Решение пользователя:** 5.4/5.5 переносятся в И7, целиком вместе со
снятием фасада `attachments` — не отдельная миграция поверх
несовместимого формата. И5 в этой сессии — только 5.1/5.2/5.3
(синхронизация узлов, СОЗДАННЫХ пользователем внутри "Файлов").

### 5.1 Схема события

```
KIND_FILES_OP = 3007  // regular kind (не replaceable/ephemeral —
                       // журнал операций накапливается, а не заменяется;
                       // 3007+ свободен, см. И0-находку П-7 выше)
content = nip44Encrypt(JSON.stringify(Op[]), privKey, ownPubHex)  // "себе"
tags = []              // без d-тега — не replaceable, различать нечем
```

Один `Op` — РОВНО объект, который уже конструирует `ops.js`
(`{type, id, kind, blob, parentId, name, origin, label}` для `create`;
аналогично для `setName`/`setPar`/`purge`, `purge` — БЕЗ `label`,
монотонный флаг). JSON-совместимо буквально (примитивы + один плоский
объект `label`), лишней сериализации не требуется.

Приём НЕ нуждается в отдельной идемпотентности сверх уже имеющейся:
дедуп сырых событий делает G-Set (`core/sync/g-set.js`, этап 4, уже
используется бутстрапом), а повторное применение ОДНОГО И ТОГО ЖЕ `Op`
через `merge()` — идемпотентно по построению (`I-IDEMPOTENT`, этап
53 И1). Двойная защита уже существует, третья не нужна.

```js
// domain/files/sync.js — по образцу ui-settings.js's build/parse,
// чистая логика (крипто, без I/O), тестируется в node --test.
buildFilesLogEvent(privKey, ops: Op[], createdAt?) -> SignedEvent
parseFilesLogEvent(event, privKey) -> Op[]
```

### 5.2 Публикация с дребезгом (200–500мс, середина — 300мс)

Единственная точка входа для ВСЕХ локальных мутаций дерева —
`applyAndPersist(ops)` (`ui/signals/files.js`, уже существует, этап
53 И3) — туда же добавляется постановка `ops` в очередь на публикацию.
Таймер сбрасывается на каждый новый `applyAndPersist` (тот же приём,
что дебаунс фильтра/черновиков) — серия быстрых правок одного узла
даёт ОДНО сетевое событие, не одно на правку.

`publish` НЕ импортируется в `ui/signals/files.js` напрямую (иначе
модуль не тестируется без реальной сети) — передаётся явно, по
прецеденту `configureContactRuntime({ownerPubkey, privKey, dbKey,
publish})` (`ui/signals/contacts.js`). Расширяется существующая
сигнатура `initFiles`:

```js
// было:      initFiles(ownerPubkey)
// становится: initFiles(ownerPubkey, privKey, publish)
```

Вызывающая сторона (`files.jsx`) передаёт `privKeySig.value` и `publish`
из `transport.js` — правка контракта, регрессия `files-signals.test.js`
обязательна (мутирует существующий публичный API, правило 13 skill).

### 5.3 Подписка + пакетное применение

Отдельной REQ-подписки не требуется — `authors:[я]` из bootstrap/
`incremental-sync.js` уже kind-агностична (широкий фильтр, без списка
kind, найдено исследованием), новый kind долетает бесплатно. Нужно
только ФОЛДИТЬ уже осевшие в `db.events` строки:

```js
// ui/signals/files.js — по образцу rebuildUiSettings/rebuildGroups
// (тот же вызывающий паттерн, transport.js's connect()/onEvent).
rebuildFilesLog(ownerPubkey, privKey) -> Promise<void>
```

**Ленивая активация — осознанное отличие от rebuildUiSettings/
rebuildGroups (не пробел).** Те рутинно вызываются из ГЛОБАЛЬНОЙ
цепочки bootstrap `connect()` независимо от того, какой экран открыт
(профиль/контакты видны сразу, повсюду). Дерево файлов не отображается
нигде, кроме самого экрана "Файлы" — `rebuildFilesLog` вызывается (а)
из `initFiles()` (при первом открытии экрана в сессии — подтягивает
всю историю сразу) и (б) из `onEvent`-хука `transport.js` (та же точка,
что уже вызывает `reconcileContactsFromEventLog`/`rebuildGroups`/
`rebuildEffectivePermissions` при `addedCount > 0`) — для живых
обновлений, ПОКА экран уже открывался в этой сессии. Если `initFiles`
ещё не вызывался (`cachedOwnerPubkey === null`), `rebuildFilesLog`
безопасно не делает ничего — НЕ добавляется в саму цепочку bootstrap,
чтобы не тратить цикл на 100% no-op для пользователей, ни разу не
открывавших "Файлы" в этой сессии (тот же принцип экономии, что
ленивая загрузка миниатюр по видимости, задача 3.8).

Полный пересчёт `R` — ОДИН раз на вызов `rebuildFilesLog` (все `Op` из
ВСЕХ найденных событий кидаются в ОДИН `merge()`, `treeState`
обновляется и персистируется ОДИН раз), не по одному на событие —
`I-BATCH`, тот же инвариант, что 2.7/3.9. Полное пересканирование
`[ownerPubkey+kind]`-индекса при каждом вызове (а не инкрементальный
курсор по последнему увиденному `seq`) — сознательно, по прецеденту
`rebuildGroups`/`rebuildUiSettings` (та же простота), оправдано
измерением 3.9 (`merge()` на n=10⁴ — 4.5мс, при реалистичных объёмах
личного файлового дерева пересканирование остаётся дёшево).

**Lamport-гигиена при приёме.** После фолда — `lamportClock.receive
(maxCounter)` по максимальному `counter` среди принятых `Op` (только
те, что несут `label` — `purge` пропускается), затем
`saveFilesClockValue`. Без этого будущая ЛОКАЛЬНАЯ операция могла бы
получить метку МЕНЬШЕ уже виденной от другого устройства — не ломает
сходимость (`compareLabels` — всё ещё тотальный порядок), но нарушает
интуитивно ожидаемое "новее = позже" при сравнении с чужими правками.

---

## Этап 53, И6 — шаринг и монтирование: заморозка контрактов

Источники: §5.5/§5.6/§11 (И6) TASK.md, §6 (Доступ) MATH.md, §4.3/§11/§12
ALGO.MD. Прямой архитектурный прецедент — механизм ключей каналов
(этап 30/32/33, `core/crypto/channel-key.js`/`domain/content/
channel-access.js`/`moderation.js`'s `banMember`): та же схема "ключ на
поддерево + k попарных NIP-44-обёрток", включая уже один раз найденный
и исправленный живым E2E класс бага (см. ниже, П-А). Решение — НЕ
обобщать `channel-key.js` под оба домена (каналы vs файлы — разные
данные в payload, разный жизненный цикл; преждевременная абстракция
поперёк доменов хуже трёх похожих строк), а завести параллельный,
структурно идентичный модуль для файлов, сознательно копируя уже
проверенный на реальных багах паттерн, а не изобретая заново.

### П-А (перенесённый урок, не новая находка — предотвращение регрессии)

Этап 32 живым E2E нашёл: `sendViewGrant` без явного `d`-тега на
parameterized-replaceable кинде — второй читатель канала замещал грант
первого на relay (NIP-01: отсутствующий `d` трактуется как `d=""`,
не уникален). Здесь тот же риск теми же средствами закрывается СРАЗУ,
не постфактум: `d = opaqueDTag(masterSecret, KIND, `${nodeId}:
${readerPubkey}:${version}`)` (буквально та же функция,
`core/crypto/derivation.js`, уже существует) для КАЖДОГО грант-события.

### Kind-аллокация (сверено с kinds.js + свободными диапазонами И0)

```
FILE_SHARE_GRANT_KIND = 30075   // parameterized-replaceable, per-recipient
                                 // грант ключа поддерева (аналог 30053)
FILE_SUBTREE_OP_KIND  = 3008    // regular, broadcast-журнал операций
                                 // расшаренного поддерева (аналог kind 3007
                                 // этапа И5, но channelKey-подобным ключом,
                                 // не NIP-44-себе)
```

### 6.1 Ключ на поддерево + k обёрток

```js
// core/crypto/share-key.js — структурно идентичен channel-key.js
generateSubtreeKey() -> Uint8Array(32)
encryptShareGrant(nodeId, subtreeKeyHex, version, ownerPrivKey, readerPubkey) -> content
decryptShareGrant(content, readerPrivKey, ownerPubkey) -> {nodeId, subtreeKey, version}
encryptSubtreeOp(opJson, subtreeKeyHex, version) -> base64  // uint32BE(version)‖nonce‖ct, буквально формат channel-key.js
decryptSubtreeOp(base64Content, subtreeKeysByVersion) -> string | null
```

`m + k`, не `m·k`: операция шифруется ОДИН раз ключом поддерева
(`encryptSubtreeOp`), публикуется ОДНИМ событием (`FILE_SUBTREE_OP_KIND`,
routing-тег `#h` = `rootId` самой доли — однобуквенный тег, NIP-12,
урок этапа 30 про `#channel`); ключ раздаётся `k` попарными обёртками
(`FILE_SHARE_GRANT_KIND`, по одной на читателя) ТОЛЬКО при `share()`/
`revoke()`, не на каждую операцию.

`share(nodeId, pubkeys[])`: если у `nodeId` ещё нет записи в
`files_shares` — генерирует НОВЫЙ `subtreeKey`, версия 1; если уже
расшарен — переиспользует ТЕКУЩИЙ ключ и версию (добавление читателя
не требует ротации, только новую обёртку для НЕГО). Публикует грант
каждому НОВОМУ pubkey из списка (не всем — уже имеющие грант этой
версии это не переспрашивают, идемпотентно). **Плюс** — по прямому
прецеденту этапа 30/31 ("видимость по группе — снимок ОДИН РАЗ в
момент создания канала, не ретроактивна"): публикует ТЕКУЩЕЕ
спроецированное состояние поддерева КАК ПАЧКУ синтетических `create`
(свежие метки, НЕ историческая переигровка сырых операций — история
может включать давно `purged`/суффиксированные промежуточные состояния,
которые новому читателю знать не нужно и не нужно тратить трафик).
Дальнейшие изменения расходятся уже обычным потоком `FILE_SUBTREE_OP_KIND`.

### 6.2 `effectivePerm` — решётка, урезанная до v0.1

Полная решётка `none ⊏ read ⊏ write ⊏ own` (MATH.md §6.1) реализуется
буквально (сравнение/join — 4 строки, дёшево), но `share()` в v0.1
производит ТОЛЬКО `read`-гранты (TASK.md §5.5: "только read в v0.1") —
`write`/`own` синтаксически существуют в типе `Perm` ради будущего
расширения (И7+/vNext), но ни один путь кода сегодня их не производит
для ЧУЖИХ узлов (`own` — вырожденный случай "это МОЙ узел", не грант).

```js
// domain/files/permissions.js
effectivePerm(grantsIndex, treeState, userId, nodeId) -> 'none'|'read'|'write'|'own'
```

`eff(child) = eff(parent) ⊔ localGrant(child)` — ОДИН подъём по цепи
предков до корня/до первого узла с explicit-грантом, `O(D)` на узел,
`O(D+k)` на листинг папки из `k` детей (общий подъём один раз для
папки, дети — одно объединение каждый, ALGO.MD §11). `grantsIndex` —
предвычисленная `Map<nodeId, Map<userId, Perm>>` (прямые гранты,
БЕЗ наследования) — строится ОДИН раз из `files_shares`, передаётся
вызывающей стороной (та же дисциплина "случайность/эффекты — не внутри
чистой функции", что `tree.js`/`ops.js`, этап 53 И1).

### 6.3 Монтирование — отдельное CRDT-состояние (ALGO.MD §4.3/§12)

```
Mount = {
  nodeId     : NodeId,   // узел-ссылка в ДЕРЕВЕ ПОЛУЧАТЕЛЯ (обычный dir-узел,
                          // его самого можно двигать/переименовывать/удалять
                          // как любой другой узел получателя, решение §4.3)
  ownerPubkey: Pubkey,
  rootId     : NodeId,   // корень доли В СОСТОЯНИИ ВЛАДЕЛЬЦА
  subtreeKey : hex,
  version    : number,
}
```

Состояние доли (`Mount.state`, ОТДЕЛЬНОЕ `TreeState`, тот же тип, что
`domain/files/tree.js`, но с виртуальным корнем = `rootId`) хранится
`files_mount_nodes` (schema как `files_nodes`, но ключ
`[recipientOwnerPubkey+mountId+id]`, не путать с `files_nodes` —
получатель НИКОГДА не смешивает эти два состояния, `R` считается над
каждым независимо, ALGO.MD §4.3: "исчезает как класс" открытая задача
§6.5 матдока про частичную видимость). Узел-ссылка `nodeId` в
собственном дереве получателя — САМ создаётся ОБЫЧНЫМ `createFolder`-
подобным путём (`ops.js` не меняется), `mounts`-таблица — единственное,
что помечает его как ссылку (домен/UI решают по НАЛИЧИЮ записи в
`mounts`, не по полю в самом узле — `Node`-тип `tree.js` НЕ меняется
вовсе, контракт И1 остаётся замороженным буквально).

`mount(grant)`: расшифровывает грант (`decryptShareGrant`), заводит
запись `mounts` + создаёт узел-ссылку в СВОЁМ дереве (обычная локальная
операция, публикуется/синхронизируется как любая другая — этап 53 И5),
инициализирует `Mount.state` из снимка (первая пачка `create`,
см. 6.1) + подписывается на `FILE_SUBTREE_OP_KIND` с `#h=rootId`.
`unmount(mountId)`: удаляет узел-ссылку (обычный `purge`, как любой
узел) + запись `mounts` + `Mount.state` целиком.

### 6.4 Маршрутизация при `move` через границу доли

**Урезание скоупа (решение, не пробел — TASK.md §7/MATH.md §6.5
формулируют ограничение явно):** перемещение узла ЧЕРЕЗ границу
шаринга — ОТДЕЛЬНОЕ событие, не обычный `setPar`, потому что состояния
получателей НЕ смешиваются (6.3) — переслать получателю `setPar` на
`parentId`, которого нет в ЕГО `Mount.state`, оставило бы висячую
ссылку. Владелец, применяя `move`, сравнивает множество долей,
покрывающих СТАРОГО и НОВОГО родителя (`coveringShares(parentId) ->
Set<nodeId-корень-доли>`, тот же подъём, что 6.2):

- Доли, покрывавшие старого родителя, но не нового (узел ПОКИДАЕТ их
  видимость) — этим получателям уходит `{type:"purge", id}` через ИХ
  `FILE_SUBTREE_OP_KIND` (та же семантика, что "исчезновение", но
  ЯВНОЕ, не молчаливое — ALGO.MD §12 прямо предостерегает от немаркированного
  исчезновения).
- Доли, покрывающие нового родителя, но не старого (узел ВХОДИТ) —
  этим получателям уходит СВЕЖИЙ `{type:"create", ...}` (та же
  синтетика, что снимок при `share()`, не переигровка старой метки —
  получатель не видел этот узел раньше, его история для него не
  начинается посреди операции).
- Доли, покрывающие ОБОИХ родителей (перемещение ВНУТРИ одной доли) —
  обычный `setPar`, без изменений, как любая другая операция поддерева.

### 6.5 Отзыв — ротация + переиздача (буквально `banMember`, этап 33)

```js
revoke(nodeId, pubkey) -> void
```

Генерирует `subtreeKey[v_new]`, версия += 1, переиздаёт
`FILE_SHARE_GRANT_KIND` ВСЕМ читателям доли КРОМЕ `pubkey`
(`files_shares`' список читателей минус отозванный — та же структура,
что `channelReaders`, этап 33-находка: раньше список читателей вообще
нигде не хранился). Новые операции публикуются `subtreeKey[v_new]`.
**Жёсткий инвариант (MATH.md §6.4, недостижимый математически, только
формулировкой в UI): отозванный, уже скачавший версии `≤ v_old`,
сохраняет к ним доступ** — старые версии ключа НЕ удаляются локально
у него, только перестают приходить новые гранты.

### 6.6 `saveToOwn` — честно долгая операция

**Находка при реализации (не пробел в понимании, реальный разрыв в
коде): `subtreeKey`-производный `fileKey` файла — текст ниже описывает
ЖЕЛАЕМОЕ свойство, но НИЧТО в `content.js`/`share.js` сегодня не
шифрует блоб ЭТИМ производным ключом при заливке — `putStream` всегда
генерирует случайный `fileKey` (`crypto.js`'s `generateFileKey`),
никак не связанный с `subtreeKey`.** Спрошено у пользователя явно
(этап 53 И6, задача 6.6) — решение: **только оркестрация**.
`saveToOwn` принимает ключ чтения ПАРАМЕТРОМ (`resolveFileKey(node,
manifest) -> fileKey`), не решает сама, откуда он берётся.
Запись-сторона (`putStream` при заливке файла в уже расшаренную папку;
переливка файла, попавшего в долю через `move`, — `share.js`/
`move-routing.js` сегодня этого НЕ делают, отправляют только
метаданные снимка) — вне скоупа этого довеска, тот же класс отложенного
пункта, что 6.7 ниже. Честно зафиксировано, не скрыто.

```js
saveToOwn(recipientPubkey, dbKey, mountState, sourceNodeId, destTreeState, destParentId, newIds, resolveFileKey, label, opts) -> Promise<Op[]>
```

Отличие от буквального `saveToOwn(mountId, nodeId, destId)` из TASK.md
§5.5: `mountState` — уже загруженный `Mount.state` (не `mountId` —
загрузка/выбор состояния вызывающей стороной, тот же принцип, что
`share.js`/`move-routing.js` принимают `treeState`, а не грузят его
сами), `newIds`/`label` — случайность/метка СНАРУЖИ (тот же принцип,
что `ops.js`'s `copy`). НЕ мгновенный `copy` (который создал бы узел,
ссылающийся на `blob`-дайджест ВЛАДЕЛЬЦА — при отзыве/чистке чужого
хранилища файл молча превратился бы в битую ссылку, TASK.md §5.5).
Настоящая копия: для каждого файла в поддереве — `content.getManifest`
+ `content.getRange` (И2/И4, весь файл) под ключом ИЗ `resolveFileKey`
→ `content.putStream` ЗАНОВО (новый `fileKey`, ГЕНЕРИРУЕТСЯ, не
переиспользуется — результат владеет получатель целиком, новый
`fileKey` персистируется `store.js`'s `saveFileKey`) → возвращает `Op[]`
(`create` на каждый узел поддерева, включая пустые папки) — применяет
и персистирует ВЫЗЫВАЮЩАЯ сторона (тот же принцип, что `copy()`).
Коллизия имени — только у КОРНЯ копии (буквально `ops.js`'s `copy`,
суффикс " (копия)"), потомки коллизий не имеют (новый родитель — свежий
узел). Прогресс/отмена — тот же UX-паттерн, что загрузка (§7 TASK.md,
"прогресс и отмена для загрузки... без индикатора это выглядит как
зависание") — здесь: `opts.onProgress({ filesDone, filesTotal })`.

### 6.6b Файловый ключ доли — запись-сторона (закрытие находки 6.6)

Решение пользователя (явно спрошено): закрыть находку 6.6 ДО 6.7, честной
перезаливкой файла в момент попадания в долю — не мгновенной ссылкой на
блоб владельца.

**Циркулярность и её разрыв.** "Ключ, производный от `subtreeKey` +
`digest`" не может использовать `digest` = дайджест ШИФРОТЕКСТА
(`manifest.blobSha256`) — тот появляется ТОЛЬКО после шифрования, а
шифрование требует ключ ДО того. Разрыв: производится от `digest`
ОТКРЫТОГО текста (`sha256(plaintext)`, известен ДО шифрования). Открытый
дайджест — не секрет сам по себе (это разрешено: он не даёт доступа без
`subtreeKey`), но получателю его всё равно неоткуда взять самостоятельно
(он не видел исходные байты) — поэтому он едет ВНУТРИ `create`-операции
(`plaintextDigest`, новое поле, см. ниже), под тем же шифрованием
конверта (`encryptSubtreeOp`), что и остальной `Op[]`.

```js
// core/crypto/share-key.js
deriveShareFileKey(subtreeKeyHex, plaintextDigestHex) -> Uint8Array(32)
  // hkdf(sha256, subtreeKey, salt="Ugolok/v1/share-file", info=plaintextDigestHex, 32)
  // — тот же паттерн салта/инфо, что derivation.js, plaintextDigest в info
  // (контекстная привязка), не в salt (домен-разделитель, тот же для всех).
peekSubtreeOpVersion(base64Content) -> number
  // читает ТОЛЬКО uint32BE-заголовок конверта, без расшифровки — нужен
  // mount.js, чтобы узнать, КАКАЯ версия subtreeKey расшифровала данное
  // событие (decryptSubtreeOp это не возвращает, сигнатуру не меняем).
```

`content.js`'s `putStream` получает необязательный `fileKey`-оверрайд
(`{..., fileKey: overrideKey}`) — если передан, используется ВМЕСТО
`generateFileKey()`. Обратная совместимость: существующие вызовы без
этого поля не меняют поведение.

`share.js`'s `snapshotSubtree` и `move-routing.js`'s `subtreeOpsRootedAt`
для узлов `kind:"file"` теперь делают ЧЕСТНУЮ перезаливку (не мгновенная
ссылка): `getManifest`+`getRange` под ключом ВЛАДЕЛЬЦА (`files_keys`,
как обычно) → `plaintextDigest = sha256(plaintext)` → `derivedKey =
deriveShareFileKey(subtreeKeyHex, plaintextDigest)` → `putStream(plaintext,
{fileKey: derivedKey})` → НОВЫЙ `manifestDigest` в поле `blob` op'а
(ЗАМЕНЯЕТ дайджест владельца, не совпадает с ним) + `plaintextDigest` —
новое поле op'а (присутствует только для `kind:"file"`, `tree.js`'s
`applyOp`/`mkNode` его игнорируют — Node-тип И1 НЕ меняется, поле не
персистируется в `nodes`, только транзитно в самом событии). Оба места
(снимок при `share()`, снимок узла при `move`-entering) стали `async` и
принимают `ownerPubkey`/`dbKey`/`subtreeKeyHex`/`version`/сетевые `opts` —
раньше были чистой логикой без I/O, теперь честно связаны с сетью (тот
же компромисс, что весь `saveToOwn`, ALGO.MD "перезаливка не бывает
дешёвой").

Получатель (`mount.js`'s `applyMountSubtreeEvent`) после расшифровки
события ДОПОЛНИТЕЛЬНО зовёт `peekSubtreeOpVersion` (та же версия, что
расшифровала событие) и для каждого `create`-опа с `plaintextDigest`
сохраняет сайдкар (`files_mount_file_meta`, НЕ зашифрована — тот же
принцип, что уже незашифрованный `files_mount_nodes`, структурные
метаданные дерева доли в этой сессии не шифруются целиком, отдельный
пре-существующий пробел вне скоупа этого довеска). Новый
`mount.js`'s `resolveMountFileKey(recipientPubkey, dbKey, mountId,
nodeId)` — читает сайдкар, берёт `subtreeKey[версия]` из
`files_mountKeys`, возвращает `deriveShareFileKey(...)` — готовый
`resolveFileKey`-резолвер для `saveToOwn` (6.6) И для будущего
просмотра/плеера/миниатюр внутри доли (6.7, дальше по плану).

## 6.7 UI долей (`[W]`) — сужение MVP этого прохода

Решение пользователя (явно спрошено — 6.6b закрывать раньше или UI
раньше): 6.6b закрыт первым, поэтому этот UI уже опирается на РЕАЛЬНЫЙ
доступ к содержимому (`resolveMountFileKey`), не только на структуру.

**Сужение объёма (решение Claude, не молчаливый пробел).** Полная
встройка Mount.state в ЕДИНЫЙ breadcrumb/currentEntries основного
дерева (`ui/signals/files.js`) потребовала бы, чтобы КАЖДАЯ точка,
работающая с `treeState`/`projected`, научилась различать "своё дерево"
и "чужое Mount.state" — по объёму сопоставимо с целым отдельным
экраном (тот же класс работы, что И3 целиком). В этом проходе:
- узел-ссылка на смонтированную долю — ОБЫЧНАЯ папка в дереве
  получателя (создаётся `mount()`, `createFolder` — контракт И1 не
  меняется), помечена только НАЛИЧИЕМ записи в `files_mounts` (те же
  правила, что 6.3);
- просмотр СОДЕРЖИМОГО доли — ОТДЕЛЬНЫЙ, простой раздел экрана
  «Файлы» ("Полученные доли"), СВОЯ локальная навигация ВНУТРИ одной
  доли (Mount.state — `TreeState`, `project()` уже даёт дерево),
  БЕЗ смешения с основным деревом/буфером обмена/undo — read-only с
  точки зрения UI (`share()` в v0.1 производит только `read`-гранты,
  CONTRACTS.md 6.2 — нечего и разрешать редактировать);
- получение содержимого — ТОЛЬКО через `saveToOwn` ("Сохранить себе").
  Прямой просмотр/плеер/миниатюры файла ВНУТРИ доли БЕЗ копирования
  (интеграция `resolveMountFileKey` в `player-bridge.js`/миниатюры) —
  НЕ входит в этот проход, честно вне скоупа (тот же прецедент, что
  6.7-заметка предыдущей ревизии контракта, просто здесь явно
  подтверждена, а не отложена автоматически);
- автомонтирование ВХОДЯЩИХ грантов без диалога подтверждения —
  входящая доля не создаёт для получателя необратимых последствий
  (`unmount()` в любой момент), в отличие от исходящего шаринга
  (TASK.md §7 требует предупреждение — то ДРУГОЕ направление, здесь не
  применяется).

### `ui/signals/shares.js` (сторона владельца)

```js
shareFolder(nodeId, pubkeys) -> Promise<{nodeId, version} | PreconditionError-подобная ошибка>
revokeAccess(nodeId, pubkey) -> Promise<void>
listGrantees(nodeId) -> Promise<Pubkey[]>
isShared(nodeId) -> boolean   // computed по кэшу, для бейджа в списке
```

`shareFolder`/`revokeAccess` — тонкие обёртки `domain/files/share.js`'s
`share`/`revoke`, параметры (`ownerPubkey`/`ownerPrivKey`/`dbKey`/
`treeState`/`label`/`publish`/сетевые `opts`) берутся из уже
существующих сигналов (`auth.js`'s `currentUser`/`privKeySig`/
`dbKeySig`, `transport.js`'s `publish`, `config.js`'s
`BUILD_DEFAULT_BLOSSOM_SERVERS[0]`) — тот же принцип, что
`files.jsx`'s текущая работа с `content.js` напрямую в компоненте, не
через `files.js`. Локальный кэш "какие nodeId расшарены" (`Set`,
сигнал) — обновляется после `shareFolder`/`revokeAccess`, читается
`loadGrantsIndex` при инициализации экрана (не пересчитывается на
каждый рендер списка).

### `ui/signals/mounts.js` (сторона получателя)

```js
activeMounts        : Signal<Array<{mountId, ownerPubkey, rootId, currentVersion}>>
mountProjections    : Signal<Map<mountId, ReturnType<project>>>  // для рендера
initMounts(ownerPubkey, privKey, dbKey) -> Promise<void>
rebuildIncomingMounts(ownerPubkey, privKey, dbKey, opts) -> Promise<void>
rebuildMountSubtrees(ownerPubkey, dbKey) -> Promise<void>
saveMountedItemToOwn(mountId, nodeId, destParentId, opts) -> Promise<void>
unmountShare(mountId) -> Promise<void>
```

`rebuildIncomingMounts` — фолд `db.events` по `kind=FILE_SHARE_GRANT_KIND,
#p=ownerPubkey` (тот же паттерн, что `rebuildFilesLog`), для КАЖДОГО
ещё не смонтированного грант-события (проверка — по `[ownerPubkey+rootId]`
среди уже смонтированных, НЕ по `d`-тегу события — тот уникален
на читателя+версию, не на "уже обработано") вызывает `mount()` с
`parentId=ROOT_ID`, именем по умолчанию (короткий `pubkey` владельца
доли — человекочитаемое имя из контактов, если контакт уже есть,
иначе усечённый hex). `rebuildMountSubtrees` — для КАЖДОЙ записи
`activeMounts`, фолд `db.events` по `kind=FILE_SUBTREE_OP_KIND, #h=rootId`,
применяет ЧЕРЕЗ `applyMountSubtreeEvent` каждое (порядок не важен —
CRDT). Обе вызываются из `initFiles()` (бутстрап) И из `onEvent`-хука
`transport.js` (рядом с `rebuildFilesLog` — тот же узел, та же ленивая
активация: no-op, если экран «Файлы» не открывался).

`mountProjections` пересчитывается (не сигнал `computed` от
IndexedDB — та не реактивна сама по себе) вручную после
`rebuildMountSubtrees`/`initMounts`/просмотра доли (`loadMountState` +
`project()`, дёшево — доли маленькие по конструкции, ALGO.MD).

**Находка живым тестированием (два реальных аккаунта, локальный
relay+Blossom):** `Mount.state` — `createInitialState()` (6.3), которая
безусловно создаёт `$trash`/`$lost+found` — те же ДВА системных узла,
что у любого `TreeState`. Но для смонтированной доли это ЧИСТО
технические узлы получателя, никогда не наполняемые владельцем
(`snapshotSubtree`/`subtreeOpsRootedAt` пишут только под `ROOT_ID`
реального содержимого) — раздел "Полученные доли" показывал пустую
("Общая папка", ничего внутри) долю как содержащую "Корзину"/
"lost+found", вводя в заблуждение. Исправлено фильтрацией
`TRASH_ID`/`LOST_FOUND_ID` из списка entries в `MountsView`
(`files.jsx`) — UI-слой, не `domain/files/*`: `Mount.state` сам по
себе корректен (это и есть его настоящее начальное состояние), просто
эти два узла не должны попадать в отображение чужой доли.

**Живая проверка (два аккаунта, реальный relay `ws://127.0.0.1:7777` +
Blossom `http://127.0.0.1:8080`, без моков):** папка расшарена → грант
долетел до УЖЕ ОТКРЫТОЙ вкладки получателя БЕЗ ПЕРЕЗАГРУЗКИ (постоянный
`fileShareGrantSubscriber`, не ленивый db.events-фолд, как в И5, —
надёжность подтверждена, в отличие от найденного там же пробела) →
`activeMounts` пережил `location.reload()` (`initMounts` в `connect()`)
→ "Управление доступом"/"Отозвать" отработал, бейдж корректно исчез.
`unmountShare`'s `window.confirm()` не удалось проверить через
браузерную автоматизацию (нативный modal блокирует CDP целиком) —
логика подтверждена unit-тестом + адверсарной мутацией отдельно.
Честно не проверено вживую (нет UI загрузки файла с диска в этом
экране — часть будущего И7): честная перезаливка реального файла и
"Сохранить себе" — оба подтверждены только тестами (`files-mounts-
signals.test.js`, реальный Blossom-фейк, реальная расшифровка).

## И7 довесок — загрузка файла с диска: прогресс и отмена (§7 TASK.md)

Закрывает пробел, честно отложенный в 6.7: раздел "Файлы" не имел
способа залить файл с диска, только структуру (папки/переименование/
перемещение). §7 TASK.md требует индикатор и отмену ("хеширование
нескольких гигабайт — десятки секунд; без индикатора это выглядит как
зависание") — оба добавлены до кода, не постфактум.

`content.js`'s `putStream` получил необязательный `signal`
(`AbortSignal`) — проверяется МЕЖДУ чанками шифрования (не насильно
посреди одного чанка — дешёвая точка прерывания) и пробрасывается в
`uploadBlob`/`blossom-client.js`'s `fetch` (сетевая фаза отменяется тем
же `AbortError`, что и стандартный `fetch`, без отдельной обработки).
`onProgress({chunksDone, chunksTotal})` — уже было в контракте (И4/И6,
использовалось `saveToOwn`), здесь впервые подключено к реальному
UI-индикатору, а не только к внутренней логике.

`files.jsx` — кнопка "Загрузить файл" (скрытый `<input type="file"
multiple>`, клик по кнопке триггерит его программно — нативный пикер
не даёт снять скриншот/автоматизировать, тот же класс ограничения, что
`window.confirm()` в 6.7). Несколько файлов — ПОСЛЕДОВАТЕЛЬНАЯ очередь
(`fileIndex`/`filesTotal` в состоянии прогресса), не параллельно: не
перегружать шифрование/сеть, прогресс остаётся понятным ("файл N из
M"). Один `AbortController` на ТЕКУЩИЙ файл (`uploadAbortRef`) —
отмена останавливает и его, и всю оставшуюся очередь (не переходит к
следующему файлу молча). Ошибка сети/неудача создания узла — сообщение
пользователю, очередь останавливается (не продолжает молча с
оставшимися файлами после сбоя).

Живая проверка (реальный Blossom `http://127.0.0.1:8080` + strfry
`ws://127.0.0.1:7777`, свежий тестовый аккаунт, без моков): одиночная
загрузка (49 КБ и 4 МБ) — файл появляется в списке, узел создаётся
корректно; загрузка ДВУХ файлов разом — оба обработаны очередью
последовательно, оба видны как отдельные записи. Консоль браузера — ни
одной ошибки за всю сессию проверки.

Честно не проверено вживую (ограничение браузерной автоматизации, тот
же класс, что `window.confirm()` в 6.7): визуальное появление
прогресс-бара и клик по "Отменить" В ПРОЦЕССЕ загрузки — локальный
Blossom отвечает быстрее, чем успевает дойти следующий шаг
автоматизации (даже 4 МБ шифруются и заливаются меньше чем за секунду
на localhost), поймать промежуточный кадр не удалось. Логика отмены
(проверка `signal.aborted` МЕЖДУ чанками, `onProgress` вызывается
только до точки отмены) подтверждена unit-тестами `tests/files-
content.test.js` + адверсарной мутацией (удаление проверки
`signal?.aborted` — оба теста отмены ловят регрессию).

## И7 довесок — три находки живой проверки пользователем (превью, ярлык, drag-and-drop)

Пользователь вживую опробовал загрузку файлов (предыдущий довесок) и
нашёл три проблемы.

**1. Картинки/видео "не открываются" в `FilePlayer`.** Разбор живой
проверкой (Chrome DevTools Protocol, реальный `vite preview` + `vite
dev` раздельно) дал два РАЗНЫХ диагноза:
- видео на самом деле работало — баг был в среде проверки, не в коде:
  `main.jsx` регистрирует service worker ТОЛЬКО при `!import.meta.env.DEV`
  (намеренное решение, комментарий на месте: "в dev SW не эмитится
  вовсе"), поэтому в `npm run dev` `/files-content/*` не перехватывался
  и падал на SPA-фолбэк (`index.html` вместо видео, без явной ошибки в
  консоли — `<video>` тихо зависал на `0:00`). В `vite preview`
  (реальный SW активен) видео проигрывается корректно — подтверждено
  живьём (readyState 4, duration совпадает, "0:02 / 0:02" после
  проигрывания). Вывод: FilePlayer для video/audio уже был рабочим,
  чинить было нечего — только сам факт диагностики стоит записи, чтобы
  не наступить повторно (тестировать SW-зависимые пути ТОЛЬКО через
  `vite preview` — прецедент этапа 45, "Живая проверка... реальный
  vite preview").
- картинки — РЕАЛЬНЫЙ пробел: `FilePlayer` никогда не имел ветки
  `image/*`, только video/audio, всегда падал на "Нет предпросмотра".
  Исправлено: `getRange(manifest, fileKey, 0, size)` целиком в память
  (тот же приём, что `thumbnails.js` — "изображения малы, getRange(0,
  size) целиком — оправдано", но БЕЗ downscale, полное качество) →
  `Blob` → `URL.createObjectURL` → `<img>`; `URL.revokeObjectURL` при
  размонтировании/смене digest. Картинки НЕ идут через SW virtual-путь
  (тот приём — только для video/audio, где нужна перемотка по Range) —
  меньше кода, тот же принцип, что миниатюры. Живая проверка (`vite
  preview`, реальный Blossom): изображение отрендерилось корректно.

**2. "Полученные доли" — жаргон, непонятный обычному пользователю.**
Переименовано в "Полученные папки" (`files.jsx`, кнопка раздела) —
слово "доли" (техническое, из share-терминологии) заменено на "папки"
(что это буквально и есть с точки зрения пользователя), направление
"Полученные" сохранено. Только видимый текст кнопки — внутренние
имена (`shares.js`/`mounts.js`/CONTRACTS.md-история) не переименованы,
это исторические записи, не пользовательский текст.

**3. Drag-and-drop — честно отложенная находка ещё этапа 53 И3**
(PLAN.md: "перетаскивание мышью... drag — нет", "следующая волна").
§7 TASK.md требует; п.211 — валидация `d∉subtree(n)` ОБЯЗАНА
выполняться "на каждый кадр наведения" восхождением, не спуском.
`targetInsideSubtree` (`ops.js`, было приватным предусловием `move()`)
экспортирована аддитивно (чистое добавление экспорта, поведение
`move()` не меняется) — переиспользована UI НАПРЯМУЮ для живой
подсветки цели ДО drop, не только для отлова `PreconditionError`
постфактум. `files.jsx`: `<li class="file-row">` — `draggable` (кроме
Корзины и строки в режиме переименования); `draggedIds` — весь
`selected`, если тащим элемент ИЗ выделения размером >1, иначе только
сам элемент; drop-цель — только `entry.kind === "dir"`; `moveNode`
(уже протестирован, 6.1) вызывается на каждый id, ошибка (имя занято/
цикл) — в `error`, без частичного отката уже перемещённых. CSS-класс
`.file-row--drag-over` — подсветка ТОЛЬКО валидной цели.

Юнит-тестов не добавлено (компоненты `files.jsx` традиционно не
покрываются node-тестами в этом проекте — прецедент: у `FilePlayer`
нет своего test-файла; проверка обоих путей — живая). Regression:
1125/1125 (без изменений количества — новых доменных тестов нет,
только аддитивный экспорт из уже покрытого `ops.js`).

Живая проверка (`vite preview`, реальный Blossom+strfry, свежий
тестовый аккаунт): превью картинки — отрендерилось; drag-and-drop —
`left_click_drag` (синтетические mousedown/mousemove/mouseup) НЕ
триггерит нативный HTML5 Drag-and-Drop API в Chrome (тот же класс
ограничения, что `window.confirm()`, 6.7) — обойдено прямой
диспетчеризацией `dragstart`/`dragover`/`drop` событий через
`dispatchEvent` с задержкой между кадрами (даёт Preact время
перерендерить `draggedIds` в замыкании обработчика соседней строки —
без задержки `dragover` видит ещё не закоммиченное `null`). Проверено
живьём: файл → в папку (перемещён, подтверждено открытием папки);
папка → сама в себя (`PreconditionError`-путь) — `dragover` НЕ
вызвал `preventDefault()`, класс подсветки не проставлен, элемент не
переместился — UI-валидация отработала ДО обращения к `moveNode`.

## Этап 53, И7, задача 7.1 — `FilePicker` (§5.7 TASK.md)

`ui/components/file-picker.jsx` — ЕДИНАЯ реализация, сигнатура буквально
по TASK.md: `<FilePicker predicate multiple onSelect onCancel />`.

Собственный курсор навигации (`folderId`, локальный `useState`), НЕ общий
`currentFolderId` из `files.js` — открытие пикера поверх другого экрана
(профиль, чат) не должно переставлять текущую папку экрана "Файлы" при
следующем заходе туда. Оба курсора читают ОДИН `projected` (computed от
`treeState`) — дерево одно, независимы только "где я сейчас смотрю".
`initFiles()` вызывается при монтировании пикера (идемпотентный
бутстрап, тот же приём, что `files.jsx`) — пикер работает, даже если
пользователь ни разу не открывал "Файлы" в этой сессии.

`predicate(node)` — СИНХРОННА, судит по полям `Node` (kind/blob/origin/
displayName из проекции) — манифест (mime) недоступен без сетевого
запроса на каждую строку списка, оставлять предикат синхронным дороже,
чем провести проверку mime ПОСТФАКТУМ, после `onSelect` (тот же приём,
что уже был у прежнего `<input type="file">`: сообщение об ошибке, не
скрытие строки). Папки ВСЕГДА навигируемы независимо от `predicate` —
тот применяется только к файлам (иначе выбор "только изображения" не
давал бы зайти внутрь папки без единой картинки).

Корзина (`TRASH_ID`) скрыта из списка пикера (выбор удалённого файла
бессмысленен), `lost+found` — виден (живое, не удалённое содержимое).

Живая проверка (`vite preview`, реальный Blossom+strfry): пикер
открылся поверх экрана профиля, навигация по папкам работает, Корзина
не показана, `lost+found` показан.

## Этап 53, И7, задача 7.2 — аватар из хранилища (решение №8 TASK.md)

`profile.jsx`: кнопка "Выбрать из хранилища" рядом с уже существующей
"Заменить" (файл с диска — не трогается, никогда не был приватным).
Общий хвост (загрузка публичной копии + republish kind 0) вынесен в
`publishAvatarBytes(bytes, mime)` — переиспользован ОБОИМИ источниками,
не задублирован.

Путь из хранилища: `FilePicker(predicate: node => node.kind === "file")`
→ `onSelect([nodeId])` → `getManifest` (нужен mime/size ДО решения) →
если не `image/*` или больше `MAX_AVATAR_BYTES` — ошибка, `window.confirm()`
НЕ вызывается (предупреждать не о чем, если действие и так не
состоится) → `getFileKeyFor` → **`window.confirm()`** ("Изображение
станет общедоступным и больше не будет зашифровано. Продолжить?") —
ТОЛЬКО здесь, после всех проверок, тот же принцип, что необратимые
действия в `files.jsx` (Удалить/`unmountShare`, этап 53 И3/И6): простой
нативный диалог, не кастомная модалка ради одного предупреждения. После
подтверждения — `getRange` целиком в память → `Blob`/`dataUrl` (превью)
+ `publishAvatarBytes` (та же публикация, что путь с диска).

Живая проверка (`vite preview`, реальный Blossom+strfry, `window.confirm`
подменён на `() => true` ПЕРЕД кликом — тот же класс ограничения
автоматизации, что везде в проекте, где встречается нативный `confirm`/
`alert`): картинка из "Файлы" → подтверждение (текст диалога проверен
через перехват вызова) → аватар обновился и в превью, и в сайдбаре;
`PUT /upload` на реальный Blossom — 200. Адверсарная проверка живьём:
попытка выбрать `test-video.mp4` (не изображение) — отклонено с "Выберите
файл изображения.", `confirm()` не вызван вовсе (проверка mime раньше
предупреждения), аватар не изменился.

Regression: 1125/1125 (без новых unit-тестов — экраны традиционно не
покрываются node-тестами в этом проекте). Сборка: 552.30 КБ gzip.

## Этап 53, И7, задача 7.3 — вложение в чат из хранилища (решение №9 TASK.md)

`chat.jsx`: вторая кнопка в тулбаре composer'а (иконка папки, рядом со
скрепкой) открывает тот же `FilePicker`, `predicate={() => true}` —
вложение в чат допускает ЛЮБОЙ тип файла (в отличие от аватара),
реальная mime/size-валидация — уже существующий `validateAttachment`
внутри `AttachmentPreview`/`buildOutgoingAttachment`, без изменений.

Общий хвост обоих источников вложения (с диска/из хранилища) вынесен в
`applySelectedFile(file)` — принимает готовый `File`/`Blob`-подобный
объект (`.name`/`.type`/`.size`/`.arrayBuffer()`), происхождение ниже
по стеку не важно: `uploadAttachment` шифрует переданные байты
СОБСТВЕННЫМ свежим ключом (`encryptFile` внутри), поэтому путь из
хранилища НЕ требует отдельной "честной перезаливки" (в отличие от
6.6b/share.js) — просто передаёт РАСШИФРОВАННЫЕ байты туда, куда
disk-путь передаёт байты `File.arrayBuffer()`. Путь из хранилища:
`FilePicker` → `onSelect([nodeId])` → **`window.confirm()`** ("Файл
будет отправлен как вложение — после отправки ключ уйдёт получателю,
отменить нельзя. Продолжить?") — ДО расшифровки (в отличие от аватара,
где confirm идёт ПОСЛЕ mime/size-проверки: здесь любой тип допустим,
предупреждать не о чем раньше момента "продолжать или нет") → `getManifest`
+ `getFileKeyFor` + `getRange` целиком в память → `new File([bytes],
node.displayName, {type: manifest.mime})` → `applySelectedFile`.
`File` — прямая drop-in замена браузерного `File` из `<input
type="file">`: `AttachmentPreview`'s `URL.createObjectURL(file)` и вся
цепочка отправки работают БЕЗ единого изменения.

Живая проверка — ПОЛНЫЙ E2E с двумя реальными аккаунтами (`vite
preview`, реальный Blossom+strfry, `window.confirm` подменён на `()
=> true` перед кликом): `chat-test-2` загрузил картинку в СВОЁ
хранилище → открыл чат с `preview-test-1` (контакт добавлен и принят
по-настоящему, не мок) → "Прикрепить файл из хранилища" → выбор
картинки → confirm (текст проверен перехватом) →
`AttachmentPreview` отрендерился с превью/именем/размером → отправлено
→ получатель (`preview-test-1`, другая вкладка) увидел РЕАЛЬНОЕ
сообщение с картинкой, декодированной корректно. Консоль браузера
чистая на ОБЕИХ сторонах.

Regression: 1125/1125 (без новых unit-тестов). Сборка: 552.65 КБ gzip.

## Этап 53, И7, задача 7.4 — messaging переходит на узлы, фасад attachments удалён

Полное содержание решения — DESIGN.md "Этап 53, И7, задача 7.4" (два
открытых вопроса TASK.md §15/MATH.md §7, закрытых явным решением
пользователя, не додуманы). Кратко здесь — что изменилось физически.

**Открытые вопросы закрыты пользователем:** (1) вложение из хранилища
ссылается на ТОТ ЖЕ `manifestDigest`/`fileKey`, без повторной заливки
(MATH.md §7 — дедупликация; закрывает находку 7.3, которая по ошибке
создавала дубликат блоба под новым ключом); (2) НИ ОДНО вложение
чата/канала не становится автоматически видимым узлом в "Файлы"
(TASK.md §15, открытый вопрос №1 — авторы сами не выбрали критерий,
"нужно смотреть на реальную переписку", реальной с историей нет,
альфа). `pinned` (§5.6) сознательно НЕ реализован — единственный
читатель (GC) не существует нигде в проекте, писать в непрочитанное
множество без персистентности — неиспользуемая инфраструктура.

**`domain/attachments/` удалён целиком.** Роль распределена:
- `domain/messaging/attachments.js` (новый) — `uploadMessageAttachment`
  (putStream внутри, чанкованное шифрование вместо целофайлового
  encryptFile), `referenceStoredFile` (без сети — дедупликация),
  `downloadMessageAttachment` (getManifest+getRange).
- `domain/files/attachment-validation.js` — перенесённая без изменений
  `validateAttachment`/`ALLOWED_MIME_TYPES` (общая для messaging И
  identity, оба уже зависят от files по §3.4).
- `domain/files/content-cache.js` — перенесённый `cache.js`, тот же
  алгоритм LRU+TTL, ключ — `manifestDigest`, та же IndexedDB-таблица
  `attachments` (схема НЕ меняется, версия БД не бампуется).
- `domain/identity/profile.js` получил `uploadAvatarBlob` (без
  изменений — публичный, нешифрованный путь, никогда не был частью
  facade-шифрования).
- `domain/messaging/voice.js`/`transfer-machine.js` — перенесены без
  изменений (не часть facade, messaging-специфичная логика).

**UI-потребители:** `attachment-view.jsx` (общий для чата/каналов) —
единственная точка чтения, `getOrDownloadAttachment` → `getOrDownloadMessageAttachment`.
`chat.jsx`/`channel.jsx`/`channels.jsx`/`pending-attachment.js` — точки
записи. `chat.jsx`'s `handleAttachmentFromStorage` (7.3) переделан:
вместо `getRange`+`new File`+повторной заливки — `attachmentSourceRef`
(отдельное состояние, `{manifestDigest, fileKey, manifest}`) хранит
ссылку на уже существующий блоб, `buildOutgoingAttachment` при её
наличии собирает дескриптор через `referenceStoredFile` (без сети).

**Реальный баг, найденный ТОЛЬКО живой проверкой** (не поймать unit-
тестами — `attachment-view.jsx` не покрыт ими): новый дескриптор не
несёт `blossomUrl` (в отличие от старого `{sha256,blossomUrl,
encryptionKey}` — URL шёл В дескрипторе), но `attachment-view.jsx`
вызывало `getOrDownloadMessageAttachment` БЕЗ `{serverUrl}` в опциях —
`downloadMessageAttachment` внутри падал на `stripTrailingSlash(undefined)`
("Cannot read properties of undefined (reading 'endsWith')"). Исправлено:
`attachment-view.jsx`/`channels.jsx` передают `{serverUrl: BLOSSOM_URL}`
явно (тот же сконфигурированный сервер, что везде в "Файлы" — единый
источник, не per-вложение URL, как раньше).

**Тесты переписаны осознанно** (правило И7, DESIGN.md): `attachments-
upload.test.js` → `messaging-attachments.test.js` (новое поведение,
+ адверсарная мутация на дедупликацию — `referenceStoredFile` с
подменённым digest ловится немедленно). `attachment-cache.test.js` →
`files-content-cache.test.js` (тот же алгоритм, новый ключ/источник).
`attachments-validation.test.js` → `files-attachment-validation.test.js`
(только путь модуля). `uploadAvatarBlob`-тесты перенесены в
`profile.test.js`. `voice.test.js`/`transfer-machine.test.js` — путь
обновлён, логика не менялась. `attachment-memory-cache.test.js`/
`blossom-client.test.js`/`file-crypto.test.js` — БЕЗ изменений
(тестируемые модули не удалены и не меняют поведение).

**Живая проверка — ПОЛНЫЙ E2E, два реальных аккаунта** (`vite preview`,
реальный Blossom+strfry, свежий contact request принят по-настоящему):
(1) вложение ИЗ хранилища (дедупликация) — отправлено, СЕТЕВОЙ ЛОГ
подтвердил НОЛЬ `PUT`-запросов (только `GET`/`206` — манифест+чанк),
получатель увидел картинку корректно, отправитель тоже (тот самый баг
serverUrl пойман и исправлен именно на этом шаге); (2) вложение С ДИСКА
(`uploadMessageAttachment`, честная новая заливка) — видео отправлено
и воспроизведено на обеих сторонах; (3) канал с аватаром — создан,
превью аватара отрендерилось в списке каналов (та же миграция
`getOrDownloadMessageAttachment`+`serverUrl`, что чат). Консоль браузера
чистая на всех участниках сценария. Честно НЕ проверено обратной
совместимостью: сообщение, отправленное ДО этой миграции (старый
формат `{sha256,blossomUrl,encryptionKey}`), падает с понятной ошибкой
("Не удалось загрузить картинку: ..."), не крашит экран — ожидаемое,
осознанно принятое пользователем следствие (TASK.md §3.1: "данных нет,
мигрировать нечего", альфа).

Regression: 1126/1126 (`incremental-sync.test.js` — одна ЗАМЕЧЕННАЯ
нестабильность таймингов на полном прогоне, не воспроизводится в
изоляции и на повторном прогоне, не связана с этим проходом — не
трогается). Сборка: 552.72 КБ gzip.

## Этап 54 — Удаление аккаунта

Пользователь: "должно быть максимально подчищено, насколько это вообще
позволяет текущая архитектура". Два явных решения (не додуманы,
разведка кодовой базы + вопрос пользователю): (1) сетевая очистка —
BEST-EFFORT, локальный вайп доводится до конца ВСЕГДА, даже офлайн;
(2) подтверждение — повторный ввод логина+пароля (тот же принцип, что
GitHub у удаления репозитория), не простой `window.confirm()` (этот
проход необратимее любого предыдущего — не "переместить в корзину",
а полное локальное стирание идентичности).

### Архитектурные пределы (описаны честно пользователю в самом UI)

- Уже ДОСТАВЛЕННЫЕ контактам сообщения/вложения не исчезают у них —
  тот же принцип "нет отзыва после отправки", действующий в проекте
  everywhere (ключ вложения уехал вместе с сообщением).
- Если тот же npub залогинен на ДРУГОМ устройстве — там ничего не
  меняется (в keystore нет cross-device sync, удаление строго локальное).
- Подписчики каналов, уже скачавшие себе посты/вложения, сохранят
  локальную копию — kind-5 удаление (уже существующий `deleteChannel()`)
  чистит структуру у них при получении, не то, что уже утекло на диск.
- Вложения ВНУТРИ уже отправленных сообщений/постов (не файлы из
  личного дерева "Файлы" и не аватар канала) НЕ удаляются с Blossom —
  потребовало бы расшифровать каждое отправленное сообщение/пост ради
  digest'а, сознательно вне периметра.
- **Найденный при живой проверке пограничный случай, не баг**: если
  файл из "Файлы" был отправлен как вложение чата ЧЕРЕЗ дедупликацию
  (И7 7.4 — `referenceStoredFile`, тот же `manifestDigest`, не копия),
  то удаление аккаунта удалит блоб ЭТОГО файла с Blossom (он же —
  собственный файл в дереве владельца) — получатель, ранее получивший
  такое сообщение, потеряет доступ к вложению, если ещё не успел его
  скачать/закэшировать. Это прямое следствие дедупликации (один блоб,
  не два) — сознательный компромисс, принятый вместе с решением 7.4,
  не новая находка, требующая отдельного фикса.

### Реализация

`domain/identity/account-deletion.js` (новый) — `deleteAccountEverywhere
(ownerPubkey, privKey, dbKey, login, publish, serverUrl, opts)`:
1. best-effort — republish kind 0 c именем `"{login} (удалённый аккаунт)"`.
   Профиль НЕ кэшируется в IndexedDB у контактов (только in-memory signal
   + живая подписка, `ui/signals/contacts.js`) — обновление приходит
   само тем, у кого открыт чат, БЕЗ отдельного протокола.
2. best-effort — для каждого владельческого канала: удалить блобы
   аватара (если был) + вызвать уже существующий `deleteChannel()`
   (kind-5 адресуемое удаление, подписчики почистят структуру у себя).
3. best-effort — для каждого файла в собственном дереве "Файлы": удалить
   ОБА блоба (манифест + содержимое, `content.js`'s двухблобная схема)
   с Blossom через новый `deleteBlob()`.
4. ЛОКАЛЬНЫЙ ВАЙП (без сети, всегда доводится до конца) — проход по
   ВСЕМ owner-scoped таблицам Dexie (два имени поля — `ownerPubkey` и
   легаси `owner`, см. полный список в самом модуле), плюс особые
   случаи: `groupMembers` (нет owner напрямую — сначала свои `groups`),
   `events` (по совпадению `pubkey` автора, не составной индекс),
   `deletions` (по `deleterPubkey`). НЕ трогаются намеренно:
   `deviceIdentity` (метка физического устройства), `discoveryProfiles`
   (чужие профили), `syncState`/`outbox` (не owner-scoped, безвредные
   остатки). `keystore`-запись стирается последней.

`core/transport/blossom-client.js` получил `deleteBlob(serverUrl,
sha256Hex, privateKey, options)` — BUD-02, тот же auth-конверт
(`buildAuthEvent`), что `uploadBlob`, просто `action='delete'` +
`method: 'DELETE'`. Blossom-сервер проекта уже поддерживает `DELETE
/:sha256` (видно в логах при запуске).

UI — `ui/components/delete-account-panel.jsx`, кнопка "Удалить аккаунт"
в новом разделе "Опасная зона" (`settings.jsx`). Форма требует ТОЧНОГО
совпадения логина (case-sensitive) + пароль, проверяемый через
`decryptPrivateKey(password, ownerPubkey)` (бросает на неверном пароле)
— пароль здесь ТОЛЬКО гейт личности, сама операция использует уже
расшифрованные `privKey`/`dbKey` активной сессии (из пропсов), не
выводит их заново из пароля. После успеха — `lock()` (тот же сигнал,
что обычный выход), экран сам переключается на выбор аккаунта.

### Тесты

`tests/account-deletion.test.js` — 5 тестов: полная изоляция между
владельцами (мультиаккаунтная гарантия, которую проект отлаживал
этапами 25-53 — самый важный тест здесь), `deviceIdentity`/
`discoveryProfiles`/`syncState` НЕ трогаются, сеть недоступна — локальный
вайп всё равно завершается и функция не бросает, сеть доступна —
tombstone-профиль/kind-5/удаление блобов реально происходят (фейковый
Blossom с DELETE, тот же приём, что `files-content.test.js`),
адверсарная проверка (владелец без единой строки не должен зацепить
чужие данные). Адверсарная мутация (`OWNER_PUBKEY_TABLES`-проход
заменён на `.clear()` без фильтра по владельцу) — поймана обоими
релевантными тестами немедленно. `tests/blossom-client.test.js` — 2
новых теста на `deleteBlob` (auth-конверт с `t=delete`, обработка
ошибки сервера).

Живая проверка (`vite preview`, реальный Blossom+strfry, два реальных
аккаунта): неверный логин → отклонено; верный логин+неверный пароль →
"Неверный пароль"; верные данные → аккаунт удалён, разлогинен
автоматически, исчез из списка аккаунтов на экране входа. Прямая
проверка IndexedDB (`indexedDB.open` из консоли) подтвердила: ни одна
запись удалённого владельца не осталась ни в одной таблице (полный
скан всех object store на вхождение его pubkey), `keystore`-строка
удалена, данные ВТОРОГО локального аккаунта не затронуты. У контакта
(другой реальный аккаунт, открытая вкладка) — история переписки и уже
полученные вложения (картинка, видео) остались полностью рабочими,
чат в списке живо обновился на "{login} (удалённый аккаунт)" БЕЗ
перезагрузки страницы (живая профильная подписка сработала как
задумано).

Regression: 1133/1133. Сборка: 553.96 КБ gzip.

## Этап 55 — мультиустройственный баг каналов + пофазовый лог синхронизации

Пользователь живьём проверил вход на "втором устройстве" (мнемоника →
логин/пароль на чистом браузере): аватар/био/контакты/файлы/переписка
подтянулись сразу, каналы — нет, и индикатор "Синхронизация данных с
сетью…" висел 5-10 минут. Просьба: показать РЕАЛЬНЫЙ пофазовый лог
синхронизации вместо одной надписи.

**Диагностика (не домысел — живое воспроизведение).** Создал тестовый
аккаунт, канал с 2 постами, затем хирургически стёр ТОЛЬКО его
локальный кэш (`indexedDB` cursor-проход по всем object store,
удаление записей с `ownerPubkey`/`owner`/составным ключом = этому
pubkey, плюс `events` по полю `pubkey`) — не трогая остальные локальные
тестовые аккаунты в том же браузере, имитация "чистого устройства" без
разрушения остального окружения. Вошёл заново по мнемонике: `synced`
стал `true` за ~7 секунд (маленький объём), но "Мои каналы" осталось
(0) НАВСЕГДА — не "медленно", а вообще никогда. Прямой дамп
`db.events` подтвердил: kind 30060 (метаданные канала) и оба kind
30061 (посты) реально долетели с relay и лежат в локальном логе — relay
и транспорт ни при чём.

**Корень:** симметричный `channelKey` канала создаётся и остаётся
ТОЛЬКО на устройстве-создателе (`createChannel`, channel.js) — владелец
никогда не выдаёт грант (kind 30053) САМОМУ СЕБЕ, только читателям из
`groupIds`. Второе устройство той же личности (тот же privKey, вход по
той же мнемонике) получает зашифрованное kind 30060, но расшифровать
нечем — `channelKeys`/`channelKeyMeta` для этого канала на новом
устройстве попросту нет и взяться неоткуда. Архитектурный пробел, не
баг транспорта: сравнимо с MLS-паттерном "sibling-устройство" (этап 25,
`syncDeviceMembership`), но для каналов такого механизма никогда не
было.

**Фикс — переиспользование существующего механизма, без новых
примитивов.** Владелец теперь всегда фигурирует как ОДИН ИЗ ЧИТАТЕЛЕЙ
собственного канала:

- `createChannel()` (channel.js): `readerPubkeys` (Set, ранее строился
  только из `groupIds`) теперь ВСЕГДА включает `ownerPubkey` —
  независимо от `groupIds` (даже канал-"заметочник" без единой группы
  получает self-грант). Самому себе шлётся `sendViewGrant` (тот же
  kind 30053, `encryptChannelKeyGrant` через NIP-44 к СОБСТВЕННОМУ
  pubkey — ECDH(priv, ownPub) математически валиден, тот же приём, что
  практика "заметка себе" в других nostr-клиентах, никакого нового
  крипто-примитива). `channelReaders` получает строку с
  `readerPubkey === ownerPubkey` наравне с обычными читателями — это
  ПРЕДНАМЕРЕННО: `banMember`/`revokeViewFromMember` (moderation.js/
  channel-visibility.js) уже перевыдают ключ ВСЕМ строкам
  `channelReaders` при ротации — self-строка автоматически получает
  каждый новый ключ на ВСЕ устройства владельца без отдельного кода.
- `receiveChannelKeyGrant()`: ветка создания НОВОЙ строки `channels`
  теперь проверяет `channelOwnerPubkey === ownerPubkey` (это грант САМ
  СЕБЕ, канал МОЙ) → `role: "owner"` (не `"available"`, как для чужих
  грантов) — иначе второе устройство увидело бы собственный канал в
  "Доступные", а не в "Мои каналы".
- `backfillOwnChannelGrants(ownerPubkey, ownerPrivKey, dbKey, publish)`
  (новая функция, channel.js) — для КАЖДОГО канала из
  `listOwnedChannels` проверяет наличие строки `channelReaders` с
  `readerPubkey === ownerPubkey`; если нет (канал создан ДО этого
  фикса, включая уже существующие реальные каналы пользователя) —
  добавляет строку + шлёт self-грант ТЕКУЩЕЙ версией ключа
  (`channelKeyMeta.currentVersion` + соответствующая строка
  `channelKeys`). Идемпотентно, best-effort (сбой публикации одного
  канала не должен ронять остальные — try/catch на канал). Возвращает
  число реально дозаполненных каналов (для строки лога). Вызывается из
  `transport.js`'s `connect()` при каждом подключении (дёшево — ранний
  выход при отсутствии владельческих каналов, единственный лишний
  network round-trip — на канал, где грант РЕАЛЬНО отсутствовал).

**Пофазовый лог синхронизации (решение пользователя — "автоматически +
видимый лог" и "детальный лог, да").**

`ui/signals/sync-log.js` (новый файл):
```js
export const syncLog = signal([]); // [{ts: number, text: string}, ...]
export function resetSyncLog();    // вызывается в начале connect()
export function logSync(text);     // добавляет {ts: Date.now(), text}
```

`transport.js`'s `connect()` — вокруг каждого смыслового шага (уже
существующего в коде, без изменения порядка/логики) добавлена пара
`logSync("Фаза…")` / `logSync("Фаза — готово")`: подключение к серверу,
загрузка истории (`runBootstrap`, с числом событий в готовой строке —
самый тяжёлый шаг для больших аккаунтов, первый кандидат "куда уходит
время" для реального аккаунта пользователя), контакты, права доступа,
настройки, отметки прочтения, профиль, устройства, история переписки
(mirror), каналы (включает вызов `backfillOwnChannelGrants` — строка
лога называет число дозаполненных каналов явно, напр. "Каналы: ключ
разослан для 1 канала" или "Каналы — без изменений"), файлы; финальная
строка "Синхронизация завершена" — внутри существующего `onCaughtUp`,
рядом с `synced.value = true`.

UI: `sync-progress-bar.jsx` (существующий компонент, порог видимости
3 сек и правило "не мешать" — БЕЗ ИЗМЕНЕНИЙ) теперь рендерит последнюю
строку `syncLog` вместо статичного текста, плюс разворачиваемый список
всех строк лога с таймстампами (тот самый "лог: профиль загружается,
профиль загружен…", о котором просил пользователь).

Это НЕ чинит саму по себе гипотетическую "медленную" фазу для
реального (гораздо большего) аккаунта пользователя — на синтетических
7 событиях "долгого" шага не воспроизвелось. Лог — диагностический
инструмент для СЛЕДУЮЩЕГО реального захода: конкретная фаза, на
которой строка "…" провисит непропорционально долго, укажет на
проблему без повторной живой сессии отладки.

### Тесты

6 новых в `channel.test.js` (self-грант всегда публикуется, self-грант
даёт `role: "owner"`, `backfillOwnChannelGrants` — довыдача/
идемпотентность/пустой владелец/частичная довыдача/best-effort при
сбое одного канала), 5 новых в `sync-log.test.js`. Обновлены (контракт
целенаправленно изменён — владелец теперь ВСЕГДА в `channelReaders` —
полная регрессия зелёная): 2 теста в `channel.test.js`, 1 в
`moderation.test.js`, 5 в `channel-visibility.test.js`.

Живая проверка (`vite preview`, реальный relay+Blossom, тестовый
аккаунт sync-test-A): создал канал с постом → хирургически стёр
локальный кэш только этой личности → вошёл заново по мнемонике →
"Мои каналы (1)" сразу же, канал открылся с ролью владельца (доступны
"Написать пост"/"Модерация"/"Редактировать"), имя/описание
расшифрованы верно. Консоль чистая.

Regression: 1144/1144. Сборка: 554.68 КБ gzip.

## Этап 56 — два бага, найденные живой проверкой (реальный аккаунт, Safari)

Пользователь проверил реальный аккаунт в Safari (второе устройство той
же личности) после этапа 55: (1) список чатов "Сообщения" пуст, хотя
через "Контакты" открывается рабочая переписка с полной историей; (2)
бейдж "Каналы [N]" не пропадает, хотя всё прочитано и прокликано.

Live-диагностика (свой тестовый аккаунт на том же локальном relay, не
трогая аккаунт/браузер пользователя): вошёл под реальным npub,
воспроизвёл оба бага напрямую.

### Баг 1 — чат с полной историей невидим в списке "Сообщения"

Прямой дамп IndexedDB подтвердил: `messages` — 6 строк для этого
владельца (реальная переписка, полностью рендерится при открытии через
"Контакты" — фото, голосовое, вся история), `mlsGroups` — 0 строк для
этого владельца. `listChatPartners()` (`ui/signals/chats.js`) строит
список ИСКЛЮЧИТЕЛЬНО из `mlsGroups` — а история сюда попала через
зеркалирование с другого устройства (`syncMirroredHistory`, этап 25),
которое пишет НАПРЯМУЮ в `messages`, не создавая живую MLS-сессию
(`mlsGroups`) на этом устройстве — та появляется только при первой
ОТПРАВКЕ (`ensureChatEstablished` внутри `sendChatMessageAction`).
Итог: пассивно прочитанная зеркалом переписка невидима в списке, пока
пользователь не напишет в неё первым.

**Фикс:** `listChatPartners(ownerPubkey, dbKey)` объединяет
`contactPubkey` из `mlsGroups` (как раньше) с `chatId` из `messages`
(поле `chatId` — plaintext, `MESSAGES_PLAINTEXT_FIELDS`, `chatId ===
contactPubkey` по построению `sendMessage`/`receiveGroupMessageEvent`)
— один `Set`, дедуп. Без сетевых вызовов, дешёвый локальный union двух
уже читаемых таблиц.

### Баг 2 — "осиротевший" ответ на комментарий навсегда виснет в счётчике непрочитанного

Прямой дамп: у владельца ровно 1 строка в `comments` — ответ
(`parentId` указывает на комментарий, которого в таблице НЕТ ВООБЩЕ).
Открытие соответствующего поста в "Посты" показало "Комментарии (0)"
— `buildTree(comments, parentId)` (comments.js) рекурсивно ищет цепочку
`parentId`, и комментарий, чей родитель отсутствует локально (не
получен / отброшен `receiveComment`'s крипто-барьером на устаревшей
версии ключа — F-EV-06, корректное поведение безопасности, не баг),
никогда не попадает ни в какую ветку дерева — не рендерится НИГДЕ.
Но `countCommentsByPost`/`getChannelUnreadCount` (getChannelUnreadCount
— channel-read-status.js) считают ЛЮБОЙ `!deleted` комментарий,
подходящий по `postId`/`channelId`, не проверяя достижимость в дереве
— недостижимый комментарий засчитывается как непрочитанный НАВСЕГДА
(его нельзя "открыть", чтобы продвинуть курсор `markChannelAsRead`).

**Фикс:** новая экспортируемая функция `computeReachableCommentIds
(nonDeletedComments)` (`comments.js`, где `nonDeletedComments` — массив
`{id, postId, parentId}`, поля уже plaintext — `COMMENTS_PLAINTEXT_
FIELDS`) — строит `Map(id -> comment)`, для каждого комментария идёт
по цепочке `parentId` (через ДРУГИЕ известные неудалённые комментарии
ТОГО ЖЕ поста — `postId` одинаков на всех уровнях вложенности по
построению `addComment`, глубина не имеет значения), пока не упрётся
ровно в `postId` (достижим — цепочка дошла до настоящего
верхнеуровневого комментария) либо в отсутствующего/недостижимого
родителя (недостижим). Guard от цикла — предел шагов
`nonDeletedComments.length + 1`. `countCommentsByPost` (comments.js) и
`getChannelUnreadCount` (channel-read-status.js, импортирует функцию из
comments.js) фильтруют по этому множеству ДО подсчёта — недостижимые
комментарии больше не засчитываются. `getCommentsTree`/`buildTree` не
менялись — они и так корректно не показывают недостижимые узлы, фикс
только выравнивает СЧЁТЧИК с уже верным поведением дерева.

## Этап 57 — ключи файлов не синхронизируются между устройствами + защита профиля от затирания

Пользователь смотрел живьём (в том же Chrome, где шла отладка этапа
56): аватар/био/аватары контактов не подтянулись, при открытии
картинки в "Файлы" — "Ключ файла не найден — возможно, файл ещё не
полностью синхронизирован."

### Баг 1 (главный) — файловые ключи вообще никогда не покидают устройство-создатель

Живой дамп IndexedDB подтвердил: у kukusya `files_keys` — 0 строк на
этом устройстве, при этом дерево папок ("Видосики", "Фоточки"…)
отображается корректно — структура УЖЕ синхронизируется через журнал
операций (`KIND_FILES_OP`, `sync.js`, этап 53 И5), самозашифрованный
NIP-44 "себе". Причина: `generateFileKey()` (crypto.js) — чисто
случайные 32 байта, НЕ выводятся из `dbKey`/digest; ни `ops.js`'s
`createFile`, ни ручной `{type:"create",...}` в `save-to-own.js`
(сохранение чужой доли себе) не включают fileKey в операцию журнала —
несут только публичный digest. Второе устройство получает Op честно
(видит имя/папку/digest), но расшифровать содержимое НЕЧЕМ — тот же
класс архитектурного пробела, что каналы (этап 55), только без
"чужого читателя" вовсе: файлы приватны ДАЖЕ владельцу на другом
устройстве.

**Фикс — тот же приём, что каналы: провезти секрет ВНУТРИ уже
самозашифрованного канала, без нового примитива.** Журнал `KIND_FILES_OP`
и так NIP-44-шифруется владельцем самому себе (`buildFilesLogEvent`) —
значит добавить `fileKey` (hex) прямо в поле create-операции безопасно
(тот же секрет, что уже отдельно локально хранится в `files_keys`,
просто теперь ещё и путешествует внутри уже приватного канала).

- `ops.js`'s `createFile(S, parentId, name, newId, blob, label, origin, fileKeyHex)`
  — новый необязательный последний параметр; попадает в возвращаемый
  op как `fileKey` ТОЛЬКО если передан (`tree.js`'s `applyOp` читает из
  op только известные поля — лишнее свойство безвредно, схема CRDT не
  меняется).
- `save-to-own.js` — ручной `{type:"create", kind:"file", ...}` (копия
  чужой доли в своё дерево, новый `fileKey` генерируется заново при
  `putStream`) теперь тоже включает `fileKey: bytesToHex(newFileKey)`.
- `store.js`'s `saveFileKey(ownerPubkey, dbKey, digest, fileKey, announced = false)`
  — новый необязательный параметр `announced` (plaintext-поле в строке
  `files_keys`, без миграции схемы — Dexie не ограничивает поля вне
  индексов). `true` значит "этот ключ уже путешествует внутри
  какого-то опубликованного create-Op, довыдавать не нужно".
- `store.js` — новые `listUnannouncedFileKeys(ownerPubkey, dbKey)`
  (строки `files_keys` этого владельца с `announced` не `true`,
  расшифрованные) и `markFileKeyAnnounced(ownerPubkey, digest)`.
- `files.js`'s `rebuildFilesLog(ownerPubkey, privKey)` (dbKey берётся
  из уже импортированного модульного `dbKeySig.value`, как и
  `createFileEntry`/`getFileKeyFor` — сигнатуру менять не пришлось):
  для каждой распарсенной "create"-операции с `kind==="file"` и
  непустым `op.fileKey`, если `files_keys` ещё не знает этот digest у
  этого владельца — сохраняет ключ (`announced: true`, мы его только
  что узнали из уже раздутого события, повторно раздавать не нужно).
- Новая `backfillOwnFileKeys(ownerPubkey, privKey, publish)`
  (`files.js`) — задним числом довыдаёт ключ файлам, чей create-Op был
  опубликован ДО этого фикса: для каждого `{digest, fileKey}` из
  `listUnannouncedFileKeys` ищет ЛЮБОЙ живой узел с этим `blob` в
  `treeState`, republish-ит ТОТ ЖЕ create-Op (тот же id/kind/
  parentId/name/origin, свежий `label()`) с добавленным `fileKey` —
  `applyOp` уже идемпотентен на повторный `create` с существующим id
  ("идемпотентный повтор", tree.js) — дереву на этом устройстве ничего
  не грозит, но relay получает копию с ключом для ДРУГИХ устройств.
  Помечает `markFileKeyAnnounced` после публикации — не переопубликовывает
  один и тот же ключ на каждом коннекте. Вызывается из `initFiles()`
  сразу после `rebuildFilesLog` — та же "ленивая активация", что и весь
  раздел "Файлы" (не часть глобального bootstrap, лишь бы пользователь
  хоть раз открыл "Файлы" на устройстве, где ключ уже есть).

### Баг 2 — синхронизированный профиль может затереть более свежие локальные аватар/био

Найдено при подготовке к диагностике бага 1: `hydrateOwnProfile`
(profile.js, этап 37, обязательный шаг КАЖДОГО `connect()`) безусловно
перезаписывала локальные `bio`/`avatarUrl` содержимым ПОСЛЕДНЕГО kind-0
события — включая пустые поля. Собственная тестовая методология этой
сессии это разоблачила: повторные "чистые устройства" стирали
`keystore.profileAutoPublished`, из-за чего `ensureProfilePublished`
переиздавал ГОЛЫЙ `{name}` (kind 0 replaceable — новый пустой
перекрывает старый содержательный) — не баг синхронизации сам по
себе, но `hydrateOwnProfile` усугубляет ЛЮБОЙ такой инцидент,
безусловно затирая локально-хорошие данные пустыми синхронизированными.

**Фикс** — `hydrateOwnProfile` больше не даёт входящему пустому полю
победить непустое локальное: `bio: parsed.about || current.bio || ""`,
`avatarUrl: parsed.picture || current.avatarUrl || ""` (`current` —
`getProfile(ownerPubkey)`, новый импорт из `core/crypto/keystore.js`).
Настоящее обновление (непустое входящее значение) по-прежнему
побеждает — асимметрия сознательная: единственный сценарий, который
теряется — намеренная ОЧИСТКА поля с другого устройства, что
несравнимо дешевле катастрофы "зашёл с нового устройства — потерял
всё" (сама заявленная пользователем планка "синхронизация должна
работать безупречно").

### Тесты

`ops.js`/`files-sync.test.js` — `createFile` с/без `fileKeyHex`,
`rebuildFilesLog` персистирует `fileKey` из удалённого create-Op
(включая: уже известный локально digest не перезаписывается),
`backfillOwnFileKeys` — довыдача только НЕ-announced ключей,
идемпотентность (повторный вызов не публикует дважды), пусто/нет
файлов -> 0, поиск подходящего узла по `blob` при нескольких узлах на
один digest. `files-save-to-own.test.js` — `saveToOwn`'s create-Op
несёт `fileKey`. `files-store.test.js` — `saveFileKey` с `announced`,
`listUnannouncedFileKeys`/`markFileKeyAnnounced` (owner-scoping,
идемпотентность пометки). `profile.test.js` (или где лежат текущие
тесты `hydrateOwnProfile`) — пустое входящее не затирает непустое
локальное, непустое входящее побеждает, оба пустых -> пусто.

## Этап 58 — Мультирелейный транспорт (запись+чтение)

Формализация (агрегатное состояние, дедуп EVENT, EOSE-агрегация) —
DESIGN.md, раздел "Этап 58". Здесь — сигнатуры и правки принятых
контрактов.

### `src/core/transport/relay-pool.js` — новая функция (`createRelayConnection` не меняется)

```js
export function createRelayPool(entries, options = {});
// entries: {url: string, read: boolean, write: boolean}[] — непустой (throw на пустом массиве)
// options: те же поля, что createRelayConnection (WebSocketImpl, backoff, autoReconnect, onStateChange) —
//   применяются одинаково к каждому внутреннему createRelayConnection(entry.url, ...)
// -> РОВНО ТОТ ЖЕ интерфейс, что createRelayConnection (протокольно неотличим для publisher.js/subscriber.js):
//   {
//     getState(): string,      // max по порядку disconnected<connecting<authenticating<connected<subscribed среди всех членов (DESIGN.md П1)
//     getUrl(): string,        // урлы всех write-entries через запятую — только для логов/диагностики, не для протокольной логики
//     addMessageHandler(handler): void,  // регистрируется НА ПУЛЕ, а не на членах — получает уже дедуплицированный/агрегированный поток (см. ниже)
//     connect(): void,         // connect() на КАЖДОМ члене
//     send(msgArray): void,    // fan-out по роли (read: REQ/CLOSE, write: остальное), пропускает неготовые соединения, throw если НИ ОДНО не готово (DESIGN.md П2)
//     close(): void,           // close() на КАЖДОМ члене
//   }
// Дедупликация EVENT по (subId, event.id) и EOSE "первый — финальный" — DESIGN.md П3/П4,
// реализуются ВНУТРИ пула перед вызовом зарегистрированных addMessageHandler-обработчиков.
// AUTH-обработчики (relay-auth.js) НЕ регистрируются на пуле — они per-relay по своей природе
// (challenge одного relay не имеет смысла для другого) и остаются вне скоупа этого этапа
// (createAuthHandler сегодня не подключён нигде в реальном connect(), см. лог этапа).
```

### `src/domain/settings/ui-settings.js` — правка принятого контракта (этап 34)

**Было:** `relayUrls: string[]` + `activeRelayUrl: string|null` (одно
"активное" соединение). **Стало:** `relayUrls: {url, read, write}[]`,
поле `activeRelayUrl` УДАЛЕНО (сама идея "одно активное" не имеет
смысла при одновременной работе с несколькими). `blossomUrls`/
`activeBlossomUrl` НЕ ТРОГАЮТСЯ — Blossom остаётся single-active,
это отдельный, более поздний вопрос (этап 62/63), не путать.
Правка принята явно (Claude, п.13 skill), немедленная полная регрессия
обязательна (см. DoD). Без обратной совместимости со старой формой —
dev-стадия, нет прод-данных (прецедент — этапы 36/42).

```js
export function addRelayUrl(ownerPubkey, privKey, dbKey, url, publish);
// добавляет {url, read: true, write: true} — идемпотентно (url уже есть по .url — no-op)

export function removeRelayUrl(ownerPubkey, privKey, dbKey, url, publish);
// throw, если это ПОСЛЕДНИЙ relay в списке (нельзя остаться вовсе без транспорта) — было "нельзя удалить активный"

export function setRelayRole(ownerPubkey, privKey, dbKey, url, { read, write }, publish);
// заменяет setActiveRelayUrl. throw, если url отсутствует в списке (как раньше).
// throw, если применение оставило бы список БЕЗ единого read:true (нечего будет читать)
// ИЛИ БЕЗ единого write:true (нечего будет публиковать) — эти два предусловия
// защищают от полностью нерабочей конфигурации, не протокольная необходимость,
// решение Claude по аналогии с духом старого "нельзя удалить активный".
```

`setActiveRelayUrl` — УДАЛЕНА (заменена `setRelayRole`).

### `src/ui/signals/transport.js` — единственная точка переключения на пул

`connect()`: `connection = createRelayConnection(relayUrl, {...})` →
`connection = createRelayPool(localSettings.relayUrls, {...})` (fallback
на первый запуск — `BUILD_DEFAULT_RELAYS.map(url => ({url, read:true, write:true}))`,
тот же принцип, что `loadUiSettings`'s собственный fallback).
`reconnectWithNewSettings` — поведение не меняется (полный
teardown+`ensureConnected`, `connect()` сам перечитает актуальный
`relayUrls` из настроек — тот же приём, что уже был для смены
`activeRelayUrl`).
Все ~15 подписчиков ниже по файлу (`giftWrapSubscriber`,
`channelGrantSubscriber`, `fetchProfiles` и т.д.) — БЕЗ ИЗМЕНЕНИЙ,
они обращаются к `connection`, который теперь ссылается на пул, но
не знают и не обязаны знать об этом (DESIGN.md, "ключевое
архитектурное решение").

### `src/core/transport/transport.js` — удалено (мёртвый код)

`createEndpointList` не имел ни одного реального вызывающего кода вне
собственного теста с этапа 16 (контракт прямо предполагал "первого
реального потребителя" — им стал этап 58, но решением другим путём:
пул заменяет саму идею "один активный + переключение на следующий"
на "несколько одновременно активных"). Файл и `tests/transport.test.js`
удалены целиком, не оставлены как мёртвый код.

### `src/ui/screens/profile.jsx` — новый `RelayListEditor` (Blossom-часть не меняется)

`ServerListEditor` (общий компонент "список + один активный") остаётся
БЕЗ ИЗМЕНЕНИЙ, теперь используется только Blossom-секцией. Relay-секция
переходит на новый `RelayListEditor` (тот же файл): список
`{url, read, write}`, чекбоксы read/write на каждой строке вместо
кнопки "Сделать активным"; изменение любого чекбокса вызывает
`setRelayRole` + `reconnectWithNewSettings` (тот же порядок вызовов,
что раньше был у `setActiveRelayUrl`).

## Этап 59 — NIP-65 в деле: реальная публикация/чтение kind:10002

Триаж (п.13a): **рутинная** — отображение уже принятой доменной формы
(`{url,read,write}[]`, этап 58) в протокольные теги NIP-65 и обратно,
плюс проводка вызова `publish` в уже существующие точки мутации
настроек. Никакого нового пространства состояний — DESIGN.md не
дополняется.

**Уточнение скоупа относительно PLAN.md-формулировки этапа** (записано
явно, чтобы не переспрашивать в будущей сессии): PLAN.md для этапа 59
среди прочего упоминало "bootstrap.js — расширить... при входе уметь
запросить kind:10002 по pubkey у bootstrap-relay и подключиться к
найденным" — при реализации это оказалось ПРЕЖДЕВРЕМЕННЫМ и
фактически дублирующим этап 61: чтение СВОЕГО же kind:10002 в рамках
уже существующего `runBootstrap`'s `authors:[pubkey]`-фильтра ничего
не даёт сверх того, что уже даёт kind 30072 (`ui-settings.js`,
приватная синхронизация между СВОИМИ устройствами, тот же фильтр, тот
же relay) — оба события лежат на ОДНОМ И ТОМ ЖЕ relay, к которому
клиент и так уже подключился. Настоящая польза kind:10002 —
ВНЕШНЯЯ: чтобы ДРУГИЕ участники (не сам владелец) или bootstrap-
координатор могли найти relay-список ПО pubkey, не имея приватного
ключа для расшифровки kind 30072. Это ровно то, что нужно этапу 61
(вход по мнемонике С ДРУГОГО relay, до которого клиент ещё не
подключён — там chicken-and-egg, здесь его нет) и этапу 60
(обнаружение ЧУЖОГО inbox-relay). Поэтому этап 59 ограничен ЗАПИСЬЮ:
kind:10002 становится реальным и точным; чтение чужого/бутстрап-
координатора — соответственно этапы 60/61, без спекулятивного
"на будущее" ридера сейчас (YAGNI — нет вызывающего кода).

### `src/domain/identity/relay-list.js` — правка принятого контракта (этап 16/34)

**Было:** `buildRelayListEvent(privKey, relayUrls: string[])` — один
тег `['r', url]` на URL, без read/write. `parseRelayListEvent(event)`
-> `string[]`. **Стало:** отражает форму `{url,read,write}[]`
(этап 58), с NIP-65 read/write маркерами.

```js
export function buildRelayListEvent(privKey, relayEntries);
// relayEntries: {url, read, write}[]
// Записи с read:false И write:false ОДНОВРЕМЕННО — пропускаются целиком
// (NIP-65 не имеет маркера "отключено", публиковать такую запись было бы
// неверно интерпретировано читателем как "и read и write").
// Тег на запись: read&&write -> ['r', url] (маркер опущен = оба, по NIP-65);
//                read&&!write -> ['r', url, 'read'];
//                !read&&write -> ['r', url, 'write'].
// -> подписанное kind:10002 событие (content: '', как и раньше).

export function parseRelayListEvent(event);
// -> {url, read, write}[] — обратное отображение: тег без 3-го элемента
// или с посторонним 3-м элементом -> {read:true,write:true} (NIP-65:
// отсутствие маркера = оба); маркер 'read' -> {read:true,write:false};
// маркер 'write' -> {read:false,write:true}. Игнорирует теги, отличные от 'r'
// (не меняется относительно старого поведения).
```

### `src/domain/settings/ui-settings.js` — довесок к принятому контракту (этап 58)

`addRelayUrl`/`removeRelayUrl`/`setRelayRole` — после успешного
`saveUiSettings` дополнительно публикуют РЕАЛЬНЫЙ `kind:10002`
(`buildRelayListEvent(privKey, nextRelayUrls)`) через тот же `publish`,
best-effort (try/catch, не бросает наружу — тот же принцип, что
`saveUiSettings`'s собственная best-effort публикация kind 30072:
локальное состояние не зависит от сети). Публикуется именно
`nextRelayUrls` (список ПОСЛЕ применения мутации), не старый.

### `src/ui/signals/transport.js` — backfill на каждый connect()

После `rebuildUiSettings` (свежий `localSettings.relayUrls` уже
восстановлен, в том числе на новом устройстве через kind 30072) —
best-effort публикация `buildRelayListEvent(privKey, localSettings.relayUrls)`.
БЕЗ флага "announced" (в отличие от этапа 57's file-key backfill) —
kind:10002 replaceable (NIP-01) и дешёвый, republish на каждый вход
безопасен и идемпотентен по своей протокольной природе, отдельный
трекинг избыточен.

### `src/ui/screens/diagnostics.jsx` — правка вызова (не контракта)

`buildRelayListEvent(privKey, [relayUrl])` -> `buildRelayListEvent(privKey, [{url: relayUrl, read: true, write: true}])`
— единственное место, зависевшее от старой сигнатуры (self-check,
этап 20), само поведение самопроверки не меняется.

## Этап 60 — Inbox-релеи для входящих (доставка на relay ПОЛУЧАТЕЛЯ)

Триаж (п.13a): пограничная, в основном рутинная (переиспользование
уже принятых примитивов — `createRelayConnection`/`createPublisher`,
паттерн `fetchProfiles`), но с одним настоящим архитектурным решением
(где перехватывать доставку, не трогая ~10 доменных модулей) —
обоснование ниже, без отдельного DESIGN.md-раздела (решение
однострочно проверяемо, не требует формализации пространства
состояний).

**Настоящая причина "переписка не доходит" между relay** (см. память
продукта, обсуждение с Claude 5): входящее событие подписано
ОТПРАВИТЕЛЕМ и попадает на relay ПОЛУЧАТЕЛЯ, только если отправитель
явно туда его положил. До этого этапа `publish()`/`publisher.publish`
кладут событие ИСКЛЮЧИТЕЛЬНО на СВОИ (отправителя) write-relay —
если у собеседника нет ни одного общего relay с отправителем, событие
физически не долетает, и это не редкий edge case, а ожидаемое
следствие self-hosting (этапы 62-63).

**Kind, номер сверен по спеке (NIP-17, не угадан):** `10050` — "DM
Relay List", тег `["relay", url]` (НЕ `"r"`, как у NIP-65 kind:10002 —
разные NIP, разное имя тега). Без read/write маркеров (сам смысл
события — "сюда мне присылайте", т.е. read-сторона получателя).

### `src/domain/identity/dm-relay-list.js` — новый файл

```js
export function buildDmRelayListEvent(privKey, relayUrls);
// relayUrls: string[] (URLs, НЕ {url,read,write} — этот kind проще kind:10002,
// маркеров ролей не несёт). -> подписанное kind:10050 событие, content: ''.

export function parseDmRelayListEvent(event);
// -> string[] — тег 'relay' -> url. Игнорирует прочие теги.
```

### `src/core/transport/relay-pool.js` — новый примитив (существующие не меняются)

```js
export function publishToRelay(url, event, options = {});
// Эфемерное one-shot соединение: connect() -> дождаться "connected" (реактивно
// через onStateChange, БЕЗ поллинга) -> createPublisher(...).publish(event) ->
// close() сразу после ответа (успех ИЛИ ошибка). options.timeoutMs (default 8000) —
// таймаут ожидания "connected"; истёк -> connection.close() + reject.
// options.WebSocketImpl — та же инъекция для тестов, что у createRelayConnection.
// -> Promise<{ok, reason}> (та же форма, что publisher.js's publish()).
// НЕ использует createRelayPool — это ВСЕГДА ровно один относительный к событию
// URL, множественности здесь не требуется (в отличие от этапа 58's своих relay).
```

### `src/domain/settings/ui-settings.js` — довесок к этапу 59

`addRelayUrl`/`removeRelayUrl`/`setRelayRole` — ДОПОЛНИТЕЛЬНО (рядом с
уже существующей публикацией kind:10002) best-effort публикуют
kind:10050 со списком URL тех entries, где `read === true` (это и есть
"куда мне присылайте" — read-сторона). Тот же принцип best-effort,
что и kind:10002.

### `src/ui/signals/transport.js` — доставка получателю + backfill

- `connect()`: рядом с backfill kind:10002 (этап 59) — та же backfill-
  публикация kind:10050 (read-relays), без флага announced (те же
  причины, что этап 59).
- Новый `fetchInboxRelays(pubkeyHex)` — one-shot REQ+EOSE по
  `{authors:[pubkeyHex], kinds:[10050]}` (тот же паттерн, что
  `fetchProfiles`), с `pickLatest` (`core/sync/lww.js`, replaceable
  событие — берём ОДНУ, самую свежую версию, не мёрджим теги из
  нескольких копий с разных relay пула). In-memory кэш
  `Map<pubkeyHex,{relays,fetchedAt}>`, TTL 5 минут (константа
  `INBOX_RELAY_CACHE_TTL_MS`) — иначе КАЖДОЕ сообщение в чате делало
  бы новый REQ+EOSE round-trip перед попыткой доставки. Сбрасывается
  в `teardown()`.
- Новая внутренняя (не экспортируется) `deliverToInboxRelays(recipientPubkeyHex, event)` —
  `fetchInboxRelays` + `Promise.allSettled(relays.map(url => publishToRelay(url, event)))`,
  целиком в try/catch (получатель не объявил kind:10050 или сеть
  недоступна — не критично, событие уже доставлено на СВОИ relay).
  Не фильтрует relay, уже входящие в собственный `relayUrls`
  отправителя (известная, сознательно принятая неоптимальность —
  изредка избыточный повторный publish на relay, где событие УЖЕ есть;
  relay дедуплицирует по id, вреда нет, а фильтрация потребовала бы
  протаскивать `dbKey`/`ownerPubkey` в module-level состояние ради
  экономии одного лишнего WS-коннекта — не оправдано в этом этапе).
- Правка контракта `publish(event)`: после обычной публикации на СВОИ
  relay (поведение не изменилось) — если у `event.tags` есть тег `#p`,
  fire-and-forget (не await, не блокирует возврат/AC-09 outbox-путь)
  `deliverToInboxRelays(pTag[1], event)`. Покрывает ВСЕ существующие
  gift-wrap отправки (Welcome/contact-request/channel-subscribe-request/
  report — все kind:1059, все несут `#p` по протоколу NIP-59) И
  kind:30053 (channel VIEW-грант, `channel-access.js`, уже несёт
  открытый `#p`-тег — см. backlog "утечка метаданных через kind 30053",
  этот баг НЕ решается здесь, но ровно то же поле теперь используется и
  для доставки).

  **НАЙДЕНО ЖИВОЙ ПРОВЕРКОЙ (не домысел, реальный баг в первой версии
  этого этапа):** предположение "contacts.jsx/channels.jsx/moderation-panel.jsx
  и т.д. продолжают вызывать `publish(event)` буквально как раньше, ничего
  менять не нужно" — оказалось ЛОЖНЫМ. `configureContactRuntime`/
  `configureCallRuntime`/`ensureOwnKeyPackagePublished`/`ensureProfilePublished`/
  `syncDeviceMembership`/`refreshGroupMessageSubscription`/
  `handleIncomingSubscribeRequest`/`backfillOwnChannelGrants` (все — `connect()`,
  этот же файл) получали `publisher.publish` НАПРЯМУЮ (сырой примитив
  публикации на свои relay), а НЕ обогащённый модульный `publish` — то
  есть ни один из этих путей НЕ проходил через новую логику доставки
  вовсе. Обнаружено живым E2E (два реальных изолированных strfry-relay,
  два аккаунта БЕЗ единого общего relay): заявка в контакты не долетала
  ни до своего же relay отправителя, ни тем более до relay получателя;
  временный `console.log` внутри `publish()` подтвердил — функция вообще
  не вызывалась для этого пути. Исправлено: все восемь мест инъекции в
  `connect()` заменены с `publisher.publish` на модульный `publish`
  (кроме двух заведомо намеренных исключений — базовый вызов внутри
  самой `publish()` и внутри `publishToContact()`, где `publisher.publish`
  вызывается напрямую по конструкции). Два backfill-вызова (kind:10002/
  kind:10050 self-announce) сознательно оставлены на `publisher.publish` —
  эти события не несут `#p`, разница в поведении отсутствует.
- Новый экспорт `publishToContact(event, contactPubkeyHex)` — для
  kind:445 (MLS group message), у которого НЕТ `#p` тега (адресация по
  `#h` группы, эфемерный отправитель — сознательное решение этапа 24,
  не регрессия). Вызывает `publisher.publish(event)` НАПРЯМУЮ (не
  through `publish()`, чтобы не задвоить доставку, если событие
  случайно имеет и `#p`) + безусловный `deliverToInboxRelays(contactPubkeyHex, event)`.

### `src/ui/screens/chat.jsx` — правка вызывающего кода (найдено при реализации: три места, не одно)

`ChatWindow`: локальная обёртка `publishToChatPartner = (event) => publishToContact(event, contactPubkey)`,
объявлена один раз в компоненте. Заменяет `publish` в ТРЁХ местах —
`sendChatMessageAction` (сам kind:445 и Welcome через `ensureChatEstablished`,
тот же параметр прокидывается неизменным), `deleteChatMessageAction` и
`editChatMessageAction` — `deletions.js`/`edits.js` переиспользуют `chat.js`'s
`sendMessage` под капотом (delete/edit-маркер — тоже kind:445 без `#p`, не
отдельный тип события, см. DESIGN.md, "Этап 25"/"Этап 27-довесок-6"), поэтому
нуждаются в той же явной доставке, что и обычное сообщение. Остальные
вызовы `publish` в этом же файле (`markChatReadAction`/`saveChatDraftAction`/
`acceptInboxRequestAction`) НЕ заменены — kind:30070/kind:30071 приватные,
для СВОИХ устройств, без адресации собеседнику; `acceptInboxRequestAction`
отправляет Welcome через `publish` напрямую (kind:1059, `#p` есть) — уже
покрыт автоопределением в `publish()`, менять не нужно.
Остальные экраны (`contacts.jsx`/`channels.jsx`/`moderation-panel.jsx`/
`permission-editor.jsx` и т.д.) не трогаются вовсе — `publish()` уже
покрывает их через `#p`-автоопределение.

## Этап 61 — Bootstrap-вход по мнемонике (координатор-индекс)

Триаж (п.13a): рутинная — переиспользование уже принятых примитивов
(`fetchFromRelay` симметричен `publishToRelay`, этап 60; `pickLatest`,
`parseRelayListEvent`). Не требует DESIGN.md.

**Уточнение скоупа при реализации:** исходная формулировка PLAN.md для
этого этапа предполагала ещё и "убрать селектор relay с экрана
логина" — при реализации выяснилось, что такого селектора на экране
логина (`unlock.jsx`, единый экран онбординга+входа) НЕТ И НИКОГДА НЕ
БЫЛО (проверено grep — ни одного упоминания "relay" в файле). Похоже,
эта часть формулировки была основана на предположении из обсуждения
архитектуры (claude.ai), не на реальном коде — убирать нечего, UI-часть
этапа отсутствует. Настоящая, необходимая работа — только
обнаружение relay-списка при входе, когда ЛОКАЛЬНОЙ истории для этого
pubkey ещё нет вовсе (первый вход на устройстве по мнемонике).

**Явно не в скоупе:** обнаружение kind:0 (профиль) через bootstrap —
уже приходит естественно через `runBootstrap`'s `authors:[pubkey]`
после подключения к РЕАЛЬНОМУ найденному relay, отдельно фетчить не
нужно. kind:10063 (BUD-03, список Blossom-серверов) — в проекте
сегодня НЕТ ни одного места, публикующего/читающего этот kind
(`blossomUrls` только локальные, не синхронизируются публично) —
строить bootstrap-обнаружение для несуществующей инфраструктуры было
бы преждевременно (YAGNI), отложено до появления реального
consumer'а.

### `vite.config.js` / `src/config.js` — новый build-time дефолт

```js
// vite.config.js, по образцу buildDefaultRelays
function buildBootstrapRelays(command);
// env BUILD_BOOTSTRAP_RELAYS (JSON-массив) -> если задан, используется;
// иначе — ТЕ ЖЕ значения, что buildDefaultRelays(command) (сегодня свой
// relay и bootstrap-relay физически один и тот же сервер — отдельная
// ручка нужна на будущее, когда ugolok.tech-координатор разойдётся с
// собственными relay пользователей, см. память проекта, staged rollout).
```

`src/config.js`: `export const BUILD_BOOTSTRAP_RELAYS` — тот же паттерн
инъекции через `__BUILD_BOOTSTRAP_RELAYS__`, что `BUILD_DEFAULT_RELAYS`.

### `src/core/transport/relay-pool.js` — новый примитив (симметричен `publishToRelay`)

```js
export function fetchFromRelay(url, filters, options = {});
// Эфемерное one-shot соединение: connect() -> "connected" (реактивно) ->
// REQ со случайным subId -> собрать EVENT до EOSE -> close().
// -> Promise<NostrEvent[]> (пустой массив — валидный ответ "ничего не нашлось").
// options.timeoutMs (default 8000), options.WebSocketImpl — та же инъекция.
// Таймаут -> reject (в отличие от publishToRelay: здесь "не подключились"
// и "подключились, но нашли 0 событий" — РАЗНЫЕ исходы, вызывающая сторона
// должна их различать через try/catch, а не получить одинаковый []).
```

### `src/domain/settings/ui-settings.js` — новый экспорт

```js
export async function hasLocalUiSettings(ownerPubkey);
// -> boolean: есть ли локальная запись kind:30072 НА ЭТОМ устройстве
// (не через loadUiSettings — та всегда возвращает смёрженные с дефолтом
// настройки, фолбэк неотличим снаружи от настоящей записи из одного
// relay). Прямая проверка db.table("uiSettings").get(ownerPubkey) —
// БЕЗ dbKey: существование не требует расшифровки содержимого.
```

### `src/ui/signals/transport.js` — обнаружение при первом входе

Новый (не экспортируемый наружу за пределы модуля, если не понадобится
иначе) `discoverOwnRelaysViaBootstrap(pubkeyHex)`:
- Запрашивает `{authors:[pubkeyHex], kinds:[10002]}` параллельно
  (`Promise.allSettled`) у ВСЕХ `BUILD_BOOTSTRAP_RELAYS` через
  `fetchFromRelay` — один недоступный bootstrap-relay не должен
  блокировать остальных (тот же принцип устойчивости, что этап 58).
  `pickLatest` (`core/sync/lww.js`) по всем собранным событиям —
  kind:10002 replaceable, берём ОДНУ самую свежую версию.
- -> `{url,read,write}[]` (через `parseRelayListEvent`) или `[]`, если
  ни один bootstrap-relay ничего не вернул (валидный исход — либо
  свежий аккаунт без опубликованного kind:10002, либо bootstrap-relay
  недоступны).

Правка `connect()`: ДО вычисления `relayEntries` — если
`!(await hasLocalUiSettings(pubkeyHex))` (первый вход НА ЭТОМ
устройстве для этого pubkey — не отличить "новый аккаунт" от "мнемоника
на чистом устройстве" иначе, чем по факту отсутствия локальной записи)
— вызвать `discoverOwnRelaysViaBootstrap`. Если найден непустой
список — использовать ЕГО вместо `BUILD_DEFAULT_RELAYS` И сразу
сохранить его локально (`saveUiSettings` с заведомо падающим `publish`
— `publisher` на этот момент ещё не создан, локальное сохранение не
зависит от результата публикации, тот же принцип, что и everywhere
в этом файле), чтобы повторный вход НЕ делал bootstrap-запрос заново.
Если бутстрап ничего не нашёл (или локальная запись уже была) —
поведение НЕ меняется относительно этапов 58-60.

## Этап 62 — Экономика Blossom (лимиты, TTL, гибкость для self-hoster'ов)

Дизайн согласован с пользователем 2026-08-01. **Реализация ещё не
начата** — раздел фиксирует контракт заранее, отдельно от старта
работы (явное решение пользователя разделить эти два момента).

Триаж (п.13a): рутинная в части клиента (замена локальной константы
на сетевой запрос уже существующего протокольного эндпоинта) и в
части сервера ugolok.tech (добавление per-MIME-type веток в уже
существующую проверку размера) — новой алгоритмики/CRDT/инвариантов
не появляется, DESIGN.md не дополняется.

### Контекст решения (почему именно так, не по чужому шаблону)

ugolok.tech разворачивается на арендованном VPS (не объектное
хранилище формата "плати за переданный трафик") с БЕЗЛИМИТНЫМ по
трафику тарифом и ~250-300 ГБ NVMe — см. память проекта,
`product_vision_ugolok.md`. Значит настоящий ограничитель —
не деньги за раздачу байт, а место на диске, накапливающееся со
временем. Из этого следует ключевой принцип: **потолок на размер
одного файла — это заслон от явно неадекватной одиночной загрузки
("это точно не фото"), а не рычаг управления диском; рычаг управления
диском — TTL** (объём на диске в устойчивом состоянии ≈ поток загрузок
в день × TTL, а не сумма всего, что когда-либо загружено).

Первоначальные 10-20 МБ (из раннего обсуждения архитектуры) пользователь
отверг как нереалистичные — WhatsApp/Signal позволяют 16-100 МБ,
Telegram — гигабайты; более щедрые числа ниже — не уступка, а осознанный
пересчёт от факта безлимитного трафика на конкретном железе.

### Принятые значения — ТОЛЬКО для ugolok.tech, не универсальное правило клиента

- Фото: 50 МБ.
- Аудио (голосовые И музыкальные файлы — один бакет, как и в текущем
  коде): 100 МБ.
- Видео: 300 МБ (~3-5 минут при типичном мобильном битрейте — под
  "смешные видосики", не под фильмы).
- **Документы (PDF/docx/xlsx/pptx/text/markdown/csv/json) — НОВЫЙ,
  ОТДЕЛЬНЫЙ бакет, 100 МБ.** Найденный по ходу обсуждения пробел:
  сегодняшний `attachment-validation.js` молча кладёт документы в тот
  же бакет, что фото (через `else`-ветку `validateAttachment`) — не
  осознанное решение, просто так исторически сложилось; отсканированный
  документ/подробный отчёт законно может весить больше настоящего фото.
- TTL на вложения — **90 дней от последнего РЕАЛЬНОГО обращения**
  (просмотр/скачивание кем угодно сбрасывает счётчик), не от момента
  загрузки. Это устраняет саму задачу "чистить неактивные аккаунты"
  как ОТДЕЛЬНЫЙ механизм — см. следующий пункт.
- **Явно НЕ вводится:** чистка по активности АККАУНТА (владельца).
  Файл, который получатель продолжает открывать, не удаляется, даже
  если отправитель давно пропал; файл, который никому не нужен,
  истекает сам — привязка к чьей-либо "активности" не нужна вообще,
  last-accessed TTL решает исходную задачу пользователя точнее и
  безопаснее. Переписка/профиль/контакты/ключи (текст, килобайты) НЕ
  подлежат НИКАКОЙ чистке по активности ни при каком дизайне — иначе
  ломается восстановление по мнемонике для человека, просто давно не
  заходившего, что прямо противоречит цели надёжности всего блока
  этапов 58-61.
- Каналы — по-прежнему исключение (свой Blossom автора, TTL не
  применяется, решение не пересматривается).

### Найденный архитектурный факт, определивший разделение труда

`server/blossom/blossom-src` (Go, `sebdeveloper6952/blossom-server/v2`)
уже реализует **BUD-06** (проверено чтением исходников, не предположено):

```
HEAD /upload
  X-SHA-256: <hex>
  X-Content-Type: <mime>
  X-Content-Length: <bytes>
  Authorization: Nostr <base64 kind:24242, тот же конверт, что PUT /upload>

-> 200 OK — сервер готов принять именно этот файл
-> 401/403 — не прошла nostr-авторизация (тот же nostrAuthMiddleware, что и PUT)
-> 415 — MIME не разрешён (ErrMimeTypeNotAllowed)
-> 413 — превышен ЕГО собственный max_upload_size_bytes (ErrFileSizeLimit)
-> 400 — некорректный запрос (например, отсутствует X-Content-Length)
   заголовок X-Reason (если прислан) — человеко-читаемая причина
```

Та же проверка размера (`SettingService.ValidateFileSizeMaxBytes`,
`internal/service/setting_service.go`) реально применяется НЕ ТОЛЬКО в
BUD-06, но и в самой загрузке (BUD-02, `internal/bud02/upload.go`) и в
зеркалировании (BUD-04, `internal/bud04/mirror.go`) — то есть сервер
уже является полноценным, самодостаточным источником истины о
СОБСТВЕННОМ лимите, настраиваемым через `max_upload_size_bytes` в его
`config.yml`. **Из этого прямо следует: self-hoster'ская гибкость лимитов
не требует НИКАКИХ изменений в коде self-hoster'а** — она уже есть,
просто через конфиг-файл его же собственного сервера.

**Настоящий пробел — в клиенте.** `domain/files/attachment-validation.js`'s
`validateAttachment({mime,size})` проверяет размер ЛОКАЛЬНО, синхронно,
ДО какого-либо сетевого запроса, по зашитым в JS-сборку константам
(`MAX_IMAGE_FILE_SIZE`/`MAX_VIDEO_SIZE`/`MAX_VOICE_SIZE`). Поскольку
клиент — один и тот же для ВСЕХ (собирается и раздаётся с ugolok.tech,
self-hoster не обязан пересобирать свой копию), эта локальная константа
отбраковывает файл СВОИМ мнением прежде, чем запрос вообще коснётся
чужого, возможно куда более щедро настроенного, сервера. Именно это —
а не отсутствие серверной гибкости — реально отбирает у self-hoster'ов
свободу задавать свои лимиты, о которой попросил пользователь.

### Разделение труда (принятое решение)

**1. Клиент — переход с константы на BUD-06-дискавери.**

```js
// src/core/transport/blossom-client.js — новый экспорт
export async function checkUploadRequirements(serverUrl, { sha256Hex, mime, size }, privateKey, options = {});
// HEAD /upload с заголовками X-SHA-256/X-Content-Type/X-Content-Length +
// Authorization (тот же buildAuthEvent('upload', sha256Hex)/encodeAuthHeader,
// что уже использует uploadBlob — переиспользовать буквально, не дублировать).
// -> { ok: true } — сервер готов принять
// -> { ok: false, status, reason } — сервер явно отказал (401/403/415/413/400),
//    reason — из заголовка X-Reason, если прислан, иначе null
// -> { ok: true, unknown: true } — сервер НЕ поддерживает BUD-06 (404/405/
//    сетевая ошибка HEAD) — ПРОГРЕССИВНОЕ УЛУЧШЕНИЕ, не хардстоп: старые/
//    чужие Blossom-серверы без BUD-06 не должны блокировать загрузку целиком,
//    просто теряется ранний фидбек. PUT /upload остаётся конечным источником
//    истины в любом случае — эта функция только экономит round-trip на
//    заведомо обречённую загрузку, не заменяет реальную проверку сервера.
```

`domain/files/attachment-validation.js`'s `validateAttachment` — правка
принятого контракта: локальные MIME/size-константы (`MAX_IMAGE_FILE_SIZE`
и т.д.) остаются как БЫСТРЫЙ клиентский санити-чек с щедрым потолком
(верхняя граница "разумного вообще", не мнение конкретного сервера —
например что-то вроде 1 ГБ на всё, просто чтобы UI не пытался годами
шифровать/грузить полностью неадекватный файл), а РЕШАЮЩая проверка —
`checkUploadRequirements` перед реальной загрузкой, её результат и
показывается пользователю при отказе. Микротаск при реализации: найти
и обновить все 6 вызывающих мест `validateAttachment` (`chat.jsx`,
`channel.jsx`, `channels.jsx`, `pending-attachment.js`, `profile.js`,
`domain/messaging/attachments.js`) — уже сегодня known call sites,
перечислены явно, чтобы не искать заново при старте этапа.

**2. Сервер ugolok.tech — единственное место, где патчится САМ Go-бинарник.**

`internal/pkg/config/config.go`'s `MaxUploadSizeBytes int` — заменить/
дополнить per-MIME-type веткой (например, `MaxUploadSizeBytesByCategory
map[string]int` с ключами `image`/`audio`/`video`/`document`, дефолт на
`MaxUploadSizeBytes` для нераспознанной категории) в `config.yml`;
`SettingService.ValidateFileSizeMaxBytes` — принимает MIME/категорию,
выбирает соответствующий потолок. Это ЛОКАЛЬНЫЙ форк/патч КОНКРЕТНО
деплоя ugolok.tech — апстримный `sebdeveloper6952/blossom-server`
самим self-hoster'ам можно оставить как есть (простое единое число),
без обязательного форка для всех.

**3. TTL/last-accessed-очистка — тоже сторона сервера, не клиент.**

Новый конфиг-параметр (например `blob_ttl_days`, 0/отсутствие = не
чистить) + фоновый job (cron/systemd-timer, вне HTTP-обработчика),
удаляющий блобы, чьё время последнего ОТДАЧИ (GET) старше TTL. Требует
поля "последний доступ" в текущей схеме БД `blossom-db/database.sqlite3`
(проверить при реализации, есть ли уже такое поле у записи блоба, или
нужна отдельная миграция) — задача для дизайн-фазы самого этапа, не
решается здесь заранее. У ugolok.tech — 90 дней; self-hoster настраивает
своё значение в своём конфиге (или отключает вовсе), как и с размером.

### Явно НЕ в скоупе

Общий "container" self-hosting-экран (Этап 63) — этот этап только
экономика уже существующего Blossom, не разворачивание. Единая
per-MIME-типа схема для АПСТРИМНОГО Go-бинарника (чтобы каждый
self-hoster получил тонкую настройку "из коробки") — не запрошено,
можно рассмотреть отдельно, если появится реальный спрос от self-
hoster'ов; сегодня достаточно, что простое единое число уже даёт им
полную свободу.

### Финализация клиентского контракта (перед реализацией, по факту чтения кода)

Проверено чтением реального кода на момент старта реализации:
`putStream` (content.js) и `uploadAvatarBlob` (identity/profile.js) — ЕДИНСТВЕННЫЕ
два места, где реально идёт `PUT /upload` содержательного (не manifest) блоба;
оба используют `uploadBlob`, реэкспортированный через `domain/files/blob.js`
(тонкая обёртка над `core/transport/blossom-client.js` — CONTRACTS.md, этап 53).
"6 вызывающих мест `validateAttachment`" (chat.jsx×2, channel.jsx, channels.jsx,
pending-attachment.js, profile.js, messaging/attachments.js) — НЕ требуют правки
сигнатур вызова: это ранний UI-санити-чек ДО сети (превью, `attachmentError`),
он остаётся как есть, меняются только константы, которые он использует.
Решающая BUD-06-проверка добавляется НЕ на уровне этих 6 мест, а В ДВУХ точках,
где реально идёт сеть: `content.js:putStream` и `identity/profile.js:uploadAvatarBlob`
(рядом с уже существующим `uploadBlob`).

**`checkUploadRequirements`** (`core/transport/blossom-client.js`, экспорт,
реэкспортируется через `domain/files/blob.js` как и остальные примитивы):

```js
export async function checkUploadRequirements(serverUrl, { sha256Hex, mime, size }, privateKey, options = {})
// HEAD {serverUrl}/upload, заголовки:
//   Authorization: Nostr <base64 kind:24242, buildAuthEvent('upload', sha256Hex) — ТОТ ЖЕ конверт, что uploadBlob>
//   X-SHA-256: sha256Hex
//   X-Content-Type: mime
//   X-Content-Length: String(size)
// (имена заголовков — буквально internal/httpapi/headers.go blossom-src, не придуманы)
// -> { ok: true }                                — response.ok (200)
// -> { ok: true, unknown: true }                  — 404/405 (BUD-06 не поддержан) ИЛИ fetch бросил
//                                                    (сетевая недоступность) — прогрессивное улучшение,
//                                                    НЕ хардстоп
// -> { ok: false, status, reason }                — иной не-ok статус (401/403/413/415/400),
//                                                    reason — response.headers.get('X-Reason') ?? null
```

**`attachment-validation.js`** — правка контракта (заменяет три раздельные
константы одной): `MAX_IMAGE_FILE_SIZE`/`MAX_VIDEO_SIZE`/`MAX_VOICE_SIZE`
удаляются, вместо них `MAX_SANITY_FILE_SIZE = 1 * 1024 * 1024 * 1024` (1 ГБ) —
единый щедрый потолок для ВСЕХ MIME без разделения по типу (санити-чек "файл
вообще неадекватен", не мнение о лимите конкретного сервера — тот теперь
проверяется `checkUploadRequirements`). `validateAttachment` — тот же MIME-чек
(`ALLOWED_MIME_TYPES`, не меняется) + один size-чек против `MAX_SANITY_FILE_SIZE`.

**Проводка `checkUploadRequirements` в реальный путь загрузки:**
- `content.js:putStream` — вызов ПЕРЕД `uploadBlob(serverUrl, fullCiphertext, blobSha256Local, ...)`,
  аргументы `{ sha256Hex: blobSha256Local, mime, size: fullCiphertext.length }`
  (размер и digest — ШИФРОТЕКСТА, реально идущего по сети, не исходного файла).
  `!ok` -> `throw new Error` с `status`/`reason`, если есть — до реальной загрузки,
  экономит round-trip на заведомо обречённый файл.
- `identity/profile.js:uploadAvatarBlob` — тот же приём, аргументы
  `{ sha256Hex, mime, size: fileBytes.length }` (avatar не шифруется, байты как есть).

Разделы 2/3 (серверный патч ugolok.tech per-MIME-лимитов, TTL/last-accessed job)
— в ОТДЕЛЬНОМ репозитории (`server/blossom/blossom-src` — сторонний upstream
`sebdeveloper6952/blossom-server`, свой `.git`/`origin`, НЕ отслеживается родительским
репозиторием, `git ls-files` подтверждает отсутствие). Другой язык (Go), нет
`node --test`/`worker.sh`-конвейера для него — эта работа откладывается до
реального деплоя ugolok.tech (self-hoster'ы уже сегодня полностью свободны через
`config.yml` апстрима, ничего не блокирует их прямо сейчас). Этой сессией
реализуется ТОЛЬКО клиентская часть (п.1 разделения труда выше).

### Реализация клиентской части (после дизайна выше) — DoD

Клиентская часть Этапа 62 реализована и закоммичена: `checkUploadRequirements`
(blossom-client.js) + реэкспорт (blob.js) + `attachment-validation.js` (три
раздельных константы -> один `MAX_SANITY_FILE_SIZE`) + проводка в
`content.js:putStream` и `identity/profile.js:uploadAvatarBlob`. Полная
регрессия: 1208/1208 (npm test).

**Адверсарная фаза — находки, не блокирующие, записаны:**
- Загрузка МАНИФЕСТА (`content.js`, вторая `uploadBlob` в `putStream`) НЕ
  проходит `checkUploadRequirements` — сознательно: манифест — единицы-
  десятки КБ (ALGO.MD §9.4), риск отказа по размеру пренебрежимо мал; реальный
  `uploadBlob` всё равно остаётся источником истины и бросит понятную ошибку,
  если сервер всё-таки откажет.
- `options.signal`, уже отменённый (aborted) ДО вызова `checkUploadRequirements`,
  даёт `{ok:true, unknown:true}` (fetch бросает AbortError -> перехвачено тем
  же catch, что и сетевая недоступность) — НЕ баг: реальный `uploadBlob` сразу
  следом получает тот же отменённый `signal` и корректно бросает `AbortError`
  сам — отмена загрузки по-прежнему срабатывает, просто через один лишний (не
  вредный) обходной классификационный шаг.
- Серверный патч ugolok.tech (per-MIME лимиты, TTL/last-accessed job) —
  сознательно ОТЛОЖЕН, не реализуется в этой сессии (другой репозиторий/язык —
  см. выше). Self-hoster'ская гибкость уже полностью достигнута текущей
  клиентской частью (BUD-06-дискавери уважает ЛЮБОЙ `max_upload_size_bytes`
  чужого сервера) — откладываемая часть нужна ТОЛЬКО для собственного деплоя
  ugolok.tech с его специфичным разделением по MIME-категориям, не для общей
  корректности клиента.

## Этап 63 — Контейнер и агент управления self-hosted инстансом

Разбит на итерации (по образцу этапа 53, И1..). Новый Go-модуль
`agent/` (repo root, module `ugolok.tech/agent`) — ОТДЕЛЬНО от `server/`
(тот — явно "не часть клиентского продукта", dev/test-инфра); `agent/` —
настоящий продакшен-компонент, разворачивается на VPS self-hoster'а
bootstrap-скриптом (сам скрипт — И4, не в скоупе И1). Дизайн авторизации/
TLS — DESIGN.md, "Этап 63, И1".

### И1 — агент: авторизация, TLS, /status (заглушка)

**`agent/internal/auth`**
```go
func GenerateToken() ([]byte, error)              // 32 случайных байта, crypto/rand
func EncodeToken(token []byte) string             // hex, 64 символа
func DecodeToken(s string) ([]byte, error)        // hex-decode; ошибка при len(decoded)!=32
func ConstantTimeEqual(a, b []byte) bool          // len-check + subtle.ConstantTimeCompare
func LoadOrCreateToken(path string) ([]byte, error) // читает path; при отсутствии — генерирует
                                                     // и пишет hex-строку, perm 0600
func RequireBearerToken(expected []byte, next http.Handler) http.Handler
    // парсит "Authorization: Bearer <hex>", DecodeToken, ConstantTimeEqual;
    // 401 при отсутствии заголовка/неверном формате/несовпадении
```

**`agent/internal/tlscert`**
```go
func LoadOrGenerate(certPath, keyPath string) (tls.Certificate, error)
    // читает существующую PEM-пару; при отсутствии — ECDSA P-256,
    // самоподписанный, срок 10 лет, пишет PEM (0600 оба файла)
func Fingerprint(cert tls.Certificate) (string, error)
    // sha256(cert.Certificate[0]) (DER, первый сертификат в цепочке), hex, 64 символа
```

**`agent/internal/pairing`**
```go
type Code struct {
    Host        string `json:"host"`
    Port        int    `json:"port"`
    Token       string `json:"token"`       // hex, из EncodeToken
    Fingerprint string `json:"fingerprint"` // hex, из tlscert.Fingerprint
}
func Encode(c Code) (string, error)  // JSON -> base64.RawURLEncoding
func Decode(s string) (Code, error)  // обратное; ошибка на битом base64/JSON
```

**`agent/internal/httpapi`**
```go
type Status struct {
    Version       string `json:"version"`
    UptimeSeconds int64  `json:"uptimeSeconds"`
}
func NewServer(token []byte, statusFn func() Status) *http.ServeMux
    // GET /status (защищён RequireBearerToken) -> 200 JSON Status
    // всё остальное -> 404 (реальная docker-оркестрация — И2)
```

**`agent/cmd/agent/main.go`** — склейка (рутинная, микротаск воркеру не
нужен — Claude пишет сам, как во всех предыдущих этапах "точка входа"):
на старте `LoadOrCreateToken`/`tlscert.LoadOrGenerate` по фиксированным
путям (`state/token.hex`, `state/cert.pem`, `state/key.pem` относительно
рабочей директории — тот же принцип, что `strfry.conf`'s `db`), при
ПЕРВОМ создании (файлов не было) печатает пейринг-код в stdout,
поднимает `http.ListenAndServeTLS` на порту из флага (дефолт 8443).

### Явно НЕ в скоупе И1

Реальная оркестрация `docker compose` (И2) — `statusFn` в И1 передаётся
как заглушка (например возвращающая фиксированную `Status{Version:"dev"}`)
из `main.go`, не читает реальные контейнеры. Docker Compose/TURN/Caddy-
конфиги — И2. Веб-экран сопряжения (Preact, парсинг `pairing.Code`,
TOFU-проверка отпечатка) — И3. Bootstrap-скрипт (`install.sh`,
устанавливает Docker + сам бинарник агента) — И4.

### И1 — реализация: DoD и живая проверка

Все 4 пакета (`auth`, `tlscert`, `pairing`, `httpapi`) + `cmd/agent/main.go`
реализованы, `go vet ./...` чист, `go test ./...` зелёный (27 тестов).
Живая проверка реальным бинарником (не только юнит-тесты): первый запуск
печатает пейринг-код РОВНО один раз, `state/` создаётся с правами 0700/0600;
`GET /status` без токена -> 401, с верным токеном -> 200 + корректный JSON,
с неверным токеном -> 401, неизвестный путь -> 404; отпечаток из пейринг-кода
СОВПАДАЕТ с `openssl x509 -fingerprint -sha256` реального сертификата;
перезапуск агента переиспользует ТОТ ЖЕ токен (не печатает пейринг-код
повторно) — персистентность подтверждена, не только логикой кода.

**Адверсарная фаза — находка, записана, не блокирует И1:** если
`cert.pem`/`key.pem` исчезнут (ручное вмешательство/повреждение диска), а
`token.hex` уцелеет — `main.go`'s `firstRun` считается ТОЛЬКО по
`token.hex` (пейринг-код печатается ровно один раз в жизни токена), а
`tlscert.LoadOrGenerate` независимо перевыпустит сертификат с НОВЫМ
отпечатком МОЛЧА (без нового пейринг-кода). Уже сопряжённый веб-клиент
(TOFU-pinning, И3) корректно ОТКАЖЕТ такому соединению (fail-closed, не
дыра безопасности) — но пользователю потребуется вручную повторить
сопряжение, без явной диагностики "почему". Backlog: либо привязать
firstRun-детекцию к обоим наборам файлов сразу, либо явно логировать
"сертификат пересоздан — реквизиты пейринга неактуальны" при таком
рассинхроне. Не реализовано сейчас — редкий edge case (случайная потеря
части state, не штатный сценарий), не стоит эксплуатации в момент, когда
веб-сторона пейринга (И3) ещё не существует и проверять нечем.

DoD И1: [x] тесты зелёные [x] `go vet` чист [x] живая проверка бинарником
[x] адверсарная находка записана [x] полная регрессия (JS 1208/1208
не затронута + Go 27/27) [x] PLAN.md обновлён [ ] коммит.

### И2 — реальная docker compose оркестрация (relay+Blossom+TURN+Caddy)

**Артефакты бандла (`agent/compose/`, версионируются):**
- `docker-compose.yml` — 4 сервиса: `relay` (свой `relay.Dockerfile` — upstream
  `strfry-src/Dockerfile` падает на линковке uWebSockets на Alpine/musl, см.
  "живая проверка" ниже), `blossom` (свой `blossom.Dockerfile` — upstream
  ссылается на приватный registry `dhi.io`, недоступный без платной подписки),
  `coturn` (официальный образ `coturn/coturn`), `caddy` (официальный образ).
- `*.conf.tmpl`/`*-config.yml.tmpl`/Caddyfile — Caddyfile использует РОДНУЮ
  подстановку переменных окружения Caddy (`{$VAR}`), остальные — Go
  `text/template` (`{{.Field}}`), рендерятся агентом в `./rendered/` (gitignore,
  НЕ версионируется — содержит секреты/домены конкретного деплоя) ПЕРЕД
  `docker compose up`.
- Контексты сборки `relay-src`/`blossom-src` — placeholder-имена директорий,
  которые склонирует bootstrap-скрипт (И4); для локальной проверки этой
  итерации созданы вручную (`ln -s`/`cp -r` от `server/*/​*-src`).

**`agent/internal/render`**
```go
type Config struct {
    RelayDomain, RelayName, BlossomDomain string
    TurnSecret, TurnRealm, TurnExternalIP string
}
func RenderAll(templatesDir, outputDir string, cfg Config) error
    // Для каждого *.tmpl файла в templatesDir — text/template.Parse + Execute(cfg),
    // пишет результат в outputDir/<имя без .tmpl>, создаёт outputDir (MkdirAll 0700).
```

**`agent/internal/orchestrator`**
```go
type ServiceStatus struct {
    Service string `json:"Service"`
    State   string `json:"State"`
    Health  string `json:"Health"`
}
type Runner func(dir string, args ...string) ([]byte, error)
    // Реальная реализация — exec.Command("docker", args...), cmd.Dir = dir,
    // CombinedOutput(). Внедряется параметром (DI) — тот же принцип, что
    // fetchImpl в JS-части проекта, для тестируемости без реального docker.

func ComposeUp(run Runner, composeDir string) error
    // run(composeDir, "compose", "up", "-d"); ошибка — обёрнута с телом вывода
func ComposeDown(run Runner, composeDir string) error
    // run(composeDir, "compose", "down")
func ComposeStatus(run Runner, composeDir string) ([]ServiceStatus, error)
    // run(composeDir, "compose", "ps", "--format", "json") — вывод ЭТО NDJSON
    // (один JSON-объект на строку, ПОДТВЕРЖДЕНО живым запуском docker compose
    // v2.39.4, НЕ единый JSON-массив), разбить по '\n', пропустить пустые
    // строки, json.Unmarshal каждую в ServiceStatus.
```

`httpapi.NewServer`'s `statusFn` (было — заглушка `Status{Version:"dev"}`,
И1) заменяется на реальный вызов `orchestrator.ComposeStatus` — `Status`
получает новое поле `Services []orchestrator.ServiceStatus`.

**Явно НЕ в скоупе И2:**
- Минтинг TURN credentials (HMAC-SHA1 короткоживущих username/password по
  `TURN_SECRET`, use-auth-secret) — сервер (coturn.conf.tmpl) уже настроен
  на этот механизм, но Go-функция генерации и HTTP-эндпоинт для клиента —
  отдельная задача (следующая итерация или часть И3, когда появится реальный
  потребитель — voice-звонки на клиенте).
- SNI-passthrough на 443 для TURNS (`caddy-l4`/nginx `stream {}`) — coturn
  слушает свои порты 3478/5349 напрямую, не через Caddy.
- Домен vs самоподписанный/IP-режим для Caddy (`tls internal`) — Caddyfile
  сейчас предполагает РЕАЛЬНЫЙ домен (автоматический Let's Encrypt); ветка
  "только IP" — решение bootstrap-скрипта (И4), не Caddyfile.
- Per-MIME-category лимиты Blossom (Этап 62, серверный патч) — `blossom-
  config.yml.tmpl` временно использует ОДНО значение (300 МБ, наибольшая
  категория) вместо честного разделения — записано как известное сужение,
  не тихий пробел.

### Найденный блокер (И2, не решён, зафиксирован) — сборка relay (strfry) из исходника

Vendored `server/strfry/strfry-src` (сторонний форк, атрибуция "Akito" в
шапке его же `Dockerfile`) НЕ линкуется в Docker НИ на Alpine (упомянутый
upstream `Dockerfile`), НИ на Ubuntu 22.04 (собственная попытка этой сессии,
`relay-build-test.Dockerfile`) — ОДНА И ТА ЖЕ ошибка линковки
(`undefined reference to uWS::Group<...>::Group`, `uWS::Hub::...`,
`uS::Node::~Node()`) на ОБЕИХ базовых системах. Значит проблема НЕ в
Alpine/musl (первоначальная гипотеза отвергнута экспериментом), а в самом
vendored дереве — похоже, `golpe/external/uWebSockets` (git submodule)
рассинхронизирован с остальным кодом ЛИБО его сборка (`make setup-golpe`)
не производит нужный `.a`/`.o` в контейнерном окружении по причине, не
установленной за время этой итерации. `server/strfry/setup.sh` СОБИРАЕТ
рабочий бинарник НАТИВНО на macOS (arm64, Homebrew) — это единственный
ПРОВЕРЕННЫЙ работающий путь на сегодня, но он даёт `Mach-O arm64`
бинарник, непригодный для Linux-контейнера/VPS.

**Решение по скоупу И2:** не тратить дальнейшее время этой итерации на
отладку чужого C++-билда (не относится к Go-агенту, который и есть предмет
Этапа 63). Живая проверка `orchestrator`/`render` пакетов проведена на 3 из
4 сервисов бандла (`blossom`, `coturn`, `caddy` — все либо собираются,
либо тянутся официальным образом без проблем); `relay` — известный
незакрытый блокер, требует отдельного расследования (возможно: правильный
Linux-хост вместо Docker Desktop for Mac's QEMU-эмуляции, актуализация
`golpe`-сабмодуля, или сборка НАТИВНО на реальном Ubuntu/Debian VPS через
`setup.sh`-эквивалент — на боевом железе, не в эмуляции — что и будет
делать bootstrap-скрипт, И4, по факту это даже совпадает с изначальным
планом "клонировать+собрать на VPS", а не "собрать образ на dev-машине").
Не блокирует приёмку И2 (Go-код), но ОБЯЗАТЕЛЬНО к решению до И4
(bootstrap-скрипт не может ставить сервис, который не собирается).

### И2 — реализация: DoD и живая проверка

Пакеты `render` (5 тестов) и `orchestrator` (9 тестов) реализованы,
`httpapi.Status` получил поле `Services []orchestrator.ServiceStatus`,
`main.go` — флаг `--compose-dir` (пусто = поведение И1 без docker,
обратная совместимость сохранена). `go vet ./...` чист, `go test ./...`
зелёный (41 тест). JS-регрессия не затронута (1208/1208).

**Живая проверка реальным Docker (не только юнит-тесты с фейковым Runner):**
полный жизненный цикл — `render.RenderAll` -> `tlscert.LoadOrGenerate`
(TURN-сертификат) -> `orchestrator.ComposeUp` -> `orchestrator.ComposeStatus`
-> `orchestrator.ComposeDown`, через РЕАЛЬНЫЙ `RealRunner` (`os/exec`,
не фейк) против реального `docker compose`, на 3 из 4 сервисов бандла
(`blossom` — собран собственным `Dockerfile`, `coturn` — официальный образ,
`caddy` — официальный образ; `relay` исключён — см. ниже, известный блокер).
Подтверждена РЕАЛЬНАЯ связность, не только "статус running": `HEAD /upload`
через Caddy (TLS-терминация + reverse_proxy) до Blossom -> `401` (тот же
код, что и напрямую к Blossom, минуя Caddy, — доказывает, что запрос
реально дошёл через весь путь); порт TURN (3478/tcp) реально принимает
соединения. `ComposeDown` подтверждён — `docker ps` пуст после.

**Адверсарная находка, ИСПРАВЛЕНА (не просто записана):** `render.RenderAll`
создавала выходные файлы с правами по умолчанию (`os.Create`, ~0644) внутри
директории с секретами (`TURN_SECRET` и т.п. попадают в отрендеренный
`coturn.conf`) — несогласованно с уже принятым паттерном 0600 для
`state/token.hex` (И1). Исправлено на `os.OpenFile(..., 0600)`, добавлен
тест `TestRenderAll_OutputFilePermissions`.

**Известный блокер (не исправлен, требует отдельной задачи до И4)** —
сборка `relay` (strfry) из vendored исходника падает НА ЛЮБОЙ базовой
системе (Alpine И Ubuntu — эксперимент этой сессии, не гипотеза) с одной
и той же ошибкой линковки `uWebSockets`. Подробности — раздел "Найденный
блокер" выше. `docker-compose.yml`/`relay.Dockerfile`/`strfry.conf.tmpl`
УЖЕ зафиксированы как контракт (пути, имена сервисов) для когда блокер
будет решён — переписывать их не потребуется, только чинить сборку.

DoD И2: [x] тесты зелёные (41/41 Go + 1208/1208 JS) [x] `go vet` чист
[x] живая проверка реальным docker (3/4 сервисов, relay — известный блокер)
[x] адверсарная находка исправлена [x] PLAN.md обновлён [ ] коммит.

### Найденный блокер (И2) — РЕШЁН (2026-08-02)

Причина установлена экспериментально, не предположением — две НЕЗАВИСИМЫЕ
проблемы одновременно маскировали друг друга при первой попытке:

**Причина 1 (главная, всегда актуальна) — расхождение стандарта C++.**
`golpe/external/uWebSockets/Makefile` жёстко фиксирует `STD = -std=c++17`
(простое присваивание, не `?=`), тогда как сам strfry собирается с
`-std=c++20` (`golpe/rules.mk`). Между ревизиями C++ меняется правило
implicit-`noexcept` на конструкторах/деструкторах (P0012, Itanium C++ ABI
кодирует `noexcept` в мангле имени) — из-за чего `uS::Node::Node`/`~Node`,
`uWS::Group<true/false>::Group`, `uWS::Hub::allocateDefaultCompressor`,
`uWS::WebSocket<false>::send/close` компилируются под ОДНИМ манглом в
`libuWS.a` (c++17) и ожидаются под ДРУГИМ манглом в объектах strfry
(c++20) — линковщик получает "undefined reference" для символов, которые
РЕАЛЬНО есть в архиве, просто под другим именем. Подтверждено экспериментом:
пересборка `libuWS.a` с явным `STD=-std=c++20` (то же `make`, тот же код,
только флаг) убирает ВСЕ "undefined reference" при финальной линковке.
**Фикс — `agent/compose/relay.Dockerfile`:** `RUN cd golpe/external/
uWebSockets && make -j$(nproc) STD=-std=c++20 libuWS.a` ДО основного
`make -j4` (правило `golpe/external/uWebSockets/libuWS.a:` в `golpe/
rules.mk` не имеет прочих предпосылок — переиспользует уже собранный файл,
не пересобирая его дефолтным c++17).

**Причина 2 (второстепенная, локальная для ЭТОЙ dev-машины) — `.dockerignore`
не рекурсивен без `**/`.** В отличие от `.gitignore`, паттерн `*.o` в
Docker's `.dockerignore` матчит ТОЛЬКО файлы в КОРНЕ контекста сборки, не
во вложенных директориях (подтверждено изолированным экспериментом:
`root.o` исключался, `sub/nested.o` — нет). Локальный чекаут `server/
strfry/strfry-src` на этой машине уже содержал СОБСТВЕННЫЕ нативно
собранные (macOS arm64, через `setup.sh`) артефакты — `.o`/`.a` в
`src/`, `golpe/`, `golpe/external/uWebSockets/` — которые `COPY . .`
утаскивал в Linux-контейнер несмотря на исходный `.dockerignore` с `*.o`/
`*.a`/`*.d` (без `**/`), что и маскировало причину 1 при первых нескольких
попытках (линковщик использовал СТАРЫЙ ЧУЖОЙ АРХИТЕКТУРЫ `libuWS.a`,
давая ТЕ ЖЕ "undefined reference", но по другой причине — Mach-O объекты
в ELF-линковке). **Важно: на ДЕЙСТВИТЕЛЬНО чистом `git clone` (реальный
путь bootstrap-скрипта И4 на VPS) эта причина 2 НЕ проявилась бы вовсе** —
`.gitignore` уже исключает `.o`/`.a`/`build`/`strfry` из коммитов, чистому
клону просто неоткуда взять стейл-артефакты. Фикс (`**/*.o`/`**/*.a`/
`**/*.d` добавлены в `server/strfry/strfry-src/.dockerignore`) оставлен
как локальная defense-in-depth правка ЭТОЙ dev-машины (НЕ закоммичена в
вендорный форк — это чужой upstream-репозиторий, не наш), не переносится
автоматически на VPS и не обязана переноситься — И4 в любом случае клонирует
чистый апстрим заново.

**Живая проверка (не только компиляция):** контейнер запущен реальным
`docker run`, смонтирован реальный `strfry.conf` + пустая `strfry-db/`,
лог показал `"Started websocket server on 0.0.0.0:7777"`, TCP-порт открыт,
и — решающая проверка — РЕАЛЬНЫЙ WebSocket-хендшейк (`curl` с `Upgrade:
websocket`) получил `HTTP/1.1 101 Switching Protocols` с заголовком
`WebSocket-Server: uWebSockets`, подтверждая, что собранный бинарник не
просто существует, а полноценно обслуживает протокол.

DoD блокера: [x] причина установлена экспериментально (не гипотеза)
[x] фикс применён в `agent/compose/relay.Dockerfile` [x] чистая пересборка
(`--no-cache`) подтвердила успех [x] живая проверка реальным контейнером
(запуск + WS-хендшейк) [x] находки записаны, включая ПОЧЕМУ причина 2 не
актуальна для реального VPS-деплоя.

### Завершение проводки И2 (перед И4) — main.go реально рендерит и запускает

При подготовке к И4 обнаружен и закрыт пробел, оставшийся от И2:
`main.go` вызывал `orchestrator.ComposeUp`, но НИКОГДА не вызывал
`render.RenderAll` — рендеринг шаблонов проверялся только во временном
тестовом коде (`live-verify-tmp`), не в реальной точке входа. Закрыто:

- Новые флаги `main.go`: `--relay-domain`, `--relay-name` (дефолт
  `ugolok-relay`), `--blossom-domain`, `--turn-realm` (дефолт
  `ugolok.local`), `--turn-external-ip` — обязательны при указанном
  `--compose-dir` (иначе `log.Fatal` с понятным сообщением).
- TURN-секрет — персистентный (`state/turn-secret.hex`, тот же
  `auth.LoadOrCreateToken`, что и agent-токен — переиспользование
  примитива, не новый механизм).
- Перед `ComposeUp`: `render.RenderAll(composeDir, composeDir/rendered,
  cfg)` — рендерит `*.tmpl` в реальные конфиги; `tlscert.LoadOrGenerate`
  для TURN-сертификата (`rendered/turn-certs/{cert,key}.pem`).

**Найдены и исправлены живой проверкой (не гипотезой) ДВЕ РЕАЛЬНЫЕ ошибки:**

1. **`docker-compose.yml`'s `${RELAY_DOMAIN}`/`${BLOSSOM_DOMAIN}` — это
   ОТДЕЛЬНЫЙ механизм от Go `text/template`.** Compose сам подставляет
   переменные ИЗ ОКРУЖЕНИЯ ПРОЦЕССА (или `.env`-файла), не из
   отрендеренных `*.tmpl`-файлов. `main.go` их нигде не устанавливал —
   `docker compose up` падал на интерполяции `caddy.environment`.
   Фикс: `os.Setenv("RELAY_DOMAIN", ...)`/`os.Setenv("BLOSSOM_DOMAIN", ...)`
   перед вызовом `orchestrator.ComposeUp`/`ComposeStatus` — `RealRunner`
   (`exec.Command`, `cmd.Env == nil`) наследует окружение процесса
   автоматически, отдельный `.env`-файл не нужен.

2. **Именованный docker-том создаётся с правами root, непривилегированный
   `strfry` не может открыть LMDB.** `relay-data:/app/strfry-db` —
   Docker создаёт volume `root:root` при первом использовании; строка
   `USER strfry` (было в Dockerfile) не даёт процессу прав на chown
   ПОСЛЕ монтирования volume в рантайме. Живой запуск дал `strfry error:
   mdb_env_open: Permission denied`, контейнер уходил в `Restarting`.
   Фикс (`agent/compose/relay.Dockerfile`): `su-exec` вместо `USER
   strfry`, entrypoint-скрипт (вписан прямо в Dockerfile через `RUN
   printf ... > /entrypoint.sh`, без внешнего файла — build context это
   `./relay-src`, чужой файл туда не подложить обычным `COPY`) делает
   `chown -R strfry:strfry /app/strfry-db && exec su-exec strfry
   /app/strfry "$@"` — root ТОЛЬКО для chown, реальный процесс — всё
   ещё непривилегированный.

**Живая проверка ПОЛНОГО цикла реальным бинарником агента (не тестовым
кодом):** `render.RenderAll` → `tlscert.LoadOrGenerate` (TURN-сертификат)
→ `orchestrator.ComposeUp` → все 4 сервиса (`relay`/`blossom`/`coturn`/
`caddy`) реально поднялись; `GET /status` (реальный HTTPS-запрос с
Bearer-токеном) отдал `{"services":[{"Service":"relay","State":"running"},
...]}` для ВСЕХ четырёх; сквозная связность подтверждена — Caddy→relay
(WS-хендшейк через TLS-прокси, `101 Switching Protocols`), Caddy→Blossom
(HTTPS-прокси, `401` — тот же код, что и напрямую), relay напрямую (WS-
хендшейк), Blossom напрямую (`401`), coturn (порт 3478 принимает
соединения). Регрессия: `go test ./...` — 41/41 не затронуты.

## Этап 63, И4 — bootstrap-скрипт (install.sh)

**Найденный пробел перед началом (п.9a — знание, не гипотеза):**
у репозитория ЕСТЬ remote (`git@github.com:naysy-sx/ugolok-03.git`, SSH,
приватный — 148 коммитов не запушено), но это НЕ финальный публичный
канал распространения (память проекта: отдельная псевдонимная личность/
репозиторий для OpenSats ещё не созданы, см. product_vision_ugolok.md).
Значит `install.sh` НЕ может (пока) быть "curl https://ugolok.tech/
install.sh | bash", который сам скачивает код откуда-то — этого "откуда-
то" ещё не существует. **Решение (по аналогии с уже существующими
`server/strfry/setup.sh`/`server/blossom/setup.sh`):** `agent/install.sh`
рассчитан на запуск ИЗ УЖЕ ПОЛУЧЕННОГО чекаута репозитория (тем же
способом, что оба уже существующих `setup.sh` — не решают "как код попал
на VPS", это отдельная задача дистрибуции, не bootstrap-скрипта). Когда
появится публичный репозиторий/релиз-механизм, "одна команда в терминале"
из более раннего обсуждения с пользователем станет `curl .../install.sh |
bash`, который СНАЧАЛА клонирует репозиторий, ПОТОМ запускает этот же
скрипт — внутренняя логика самого `install.sh` не меняется.

**Скоуп: Ubuntu/Debian (apt) — ЕДИНСТВЕННАЯ поддерживаемая цель.**
Реальный VPS пользователя (play2go NL-5, AMD Ryzen) — Linux/x86_64;
локальная macOS-разработка (`setup.sh`×2) — отдельный, уже решённый
сценарий, `install.sh` его не касается. Другие Linux-дистрибутивы (не
apt) — явный отказ с понятным сообщением, не молчаливая попытка.

**Шаги `agent/install.sh` (идемпотентен, как оба существующих
`setup.sh` — повторный запуск ничего не ломает):**
1. Проверка ОС (apt-based) — иначе понятная ошибка и выход.
2. Docker: если `docker compose version` не работает — официальный
   convenience-скрипт (`get.docker.com`), уже ставит и `compose` plugin.
3. Go: если `go version` < требуемой (`agent/go.mod`) — официальный
   tarball с go.dev (не `apt`, версия в репозиториях Ubuntu/Debian часто
   отстаёт).
4. Сборка агента: `cd agent && go build -o /usr/local/bin/ugolok-agent
   ./cmd/agent`.
5. Клонирование relay-src/blossom-src (если директорий ещё нет) —
   `github.com/hoytech/strfry` (+ `git submodule update --init`) и
   `github.com/sebdeveloper6952/blossom-server` — ТЕ ЖЕ upstream URL,
   что уже используют `server/*/setup.sh`.
6. Сбор конфигурации: `RELAY_DOMAIN`/`BLOSSOM_DOMAIN` — интерактивный
   ввод (или переменные окружения для неинтерактивного запуска); публичный
   IP — автоопределение (`curl -s ifconfig.me`) с фолбэком на ручной ввод,
   если автоопределение не сработало (нет молчаливой прописи 127.0.0.1
   или похожего — публичный IP обязателен для TURN/пейринга).
7. systemd unit (`/etc/systemd/system/ugolok-agent.service`) — агент
   переживает перезагрузку/падение; `systemctl enable --now`.
8. Пейринг-код печатается ПЕРВЫЕ РАЗ — `journalctl -u ugolok-agent`
   (агент печатает его в свой stdout при первом запуске, И1) — install.sh
   выводит его пользователю в конце явно, а не полагается на то, что
   человек будет читать логи systemd сам.

**Явно НЕ в скоупе И4:** сам публичный канал распространения (репозиторий/
релиз/CDN — отдельная, не техническая задача, решается позже пользователем
лично, не Claude). Домен vs самоподписанный/только-IP режим Caddy (решение
уже отложено в И2, здесь тоже не решается — `install.sh` требует РЕАЛЬНЫЙ
домен для `RELAY_DOMAIN`/`BLOSSOM_DOMAIN`, ветка "только IP" — backlog).

### И4 — живая проверка `install.sh`

**Проверено по частям заранее (все успешно):** установка Go (тарбол
с go.dev) + сборка агента + `git clone` `relay-src`/`blossom-src` — в
чистом (не вложенном) Ubuntu 22.04 контейнере, с нуля, включая `git
submodule update --init`; синтаксис/семантика systemd unit-файла —
`systemd-analyze verify` реально прошёл, `systemctl enable/start`
корректно распарсил ВСЕ 7 флагов агента в одну команду (multi-line
`\`-продолжение в `ExecStart` работает).

**Полный сквозной прогон РЕАЛЬНОГО `install.sh`** (не симуляция шагов
по отдельности) — в privileged systemd-контейнере (`jrei/systemd-ubuntu`,
cgroup real mount): УСПЕШНО пройдены ВСЕ шаги 1-8 — проверка ОС/архитектуры,
установка Docker (`get.docker.com`, реальный демон поднялся), установка Go,
сборка агента, клонирование `relay-src` (с сабмодулями `negentropy`/
`golpe`) и `blossom-src`, создание+запуск systemd-сервиса, печать
пейринг-кода (`journalctl` подтвердил). **Единственный шаг, упавший в
ЭТОМ конкретном тесте** — сама сборка Docker-образов `relay`/`blossom`
ВНУТРИ агента (`docker compose up -d`, вызванный агентом), с ошибкой
`overlay: invalid argument` при монтировании — это **ограничение
ВЛОЖЕННОГО Docker-in-Docker** (Docker Desktop for Mac VM → privileged
тестовый контейнер → ЕЩЁ ОДИН dockerd внутри него → overlayfs поверх
overlayfs), НЕ баг `install.sh`/Dockerfile'ов: ТЕ ЖЕ САМЫЕ
`relay.Dockerfile`/`blossom.Dockerfile` уже неоднократно успешно
собирались и ЗАПУСКАЛИСЬ (полная связность, WS-хендшейк, `/status`
"running") на ОБЫЧНОМ (не вложенном) Docker этой же сессией (см. выше,
"Завершение проводки И2"). На реальном VPS (настоящее ядро, Docker НЕ
вложен ни во что) это ограничение не воспроизведётся.

**Итог: все 8 шагов `install.sh` подтверждены работающими** — 7 живьём
в одном сквозном прогоне, 8-й (сборка/запуск docker-образов) отдельно
на не-вложенном Docker (что и есть реальный сценарий VPS). Полный
end-to-end прогон БЕЗ вложенности не тестировался (нет доступа к
реальному VPS в этой сессии) — честно зафиксировано как остаточный риск,
не молчаливое допущение.

## Этап 63, И3 — TURN credentials (агент) + экран сопряжения (клиент)

### Часть 1 — минтинг TURN credentials на агенте (отложено из И2)

coturn уже настроен на `use-auth-secret` (`coturn.conf.tmpl`,
`static-auth-secret={{.TurnSecret}}`) — это стандартная "REST API for
TURN Server" конвенция (draft-uberti-behave-turn-rest): `username` —
unix-timestamp истечения (опционально `<timestamp>:<userid>`), `password`
— `base64(HMAC-SHA1(secret, username))`. Агент уже хранит `TURN_SECRET`
персистентно (`state/turn-secret.hex`, И2) — не хватало только функции
генерации и HTTP-эндпоинта.

**`agent/internal/turncreds`**
```go
type Credentials struct {
    Username string   `json:"username"`
    Password string   `json:"password"`
    TTL      int64    `json:"ttl"`  // секунды
    URIs     []string `json:"uris"`
}
func Mint(secret []byte, ttl time.Duration, now time.Time, uris []string) Credentials
    // username = strconv.FormatInt(now.Add(ttl).Unix(), 10)
    // password = base64.StdEncoding(hmac.New(sha1.New, secret).Sum(username))
    // TTL = int64(ttl.Seconds()), URIs — переданы вызывающей стороной как есть
```

`httpapi.NewServer` получает новый параметр `turnSecret []byte` (или
отдельный `turnCredsFn func() turncreds.Credentials` — решение: ПЕРЕДАЁМ
уже собранную функцию из `main.go`, httpapi не знает про `TURN_EXTERNAL_IP`/
`TurnRealm` сам, тот же принцип, что `statusFn`) — новый маршрут `GET
/turn-credentials`, защищён тем же `auth.RequireBearerToken`, TTL = 12
часов (достаточно для одного звонка с запасом, не заготовка на будущее —
если звонок длится дольше, клиент просто перезапросит новые credentials,
это дёшево). `main.go` строит `uris` из `--turn-external-ip`:
`["turn:" + turnExternalIP + ":3478", "turns:" + turnExternalIP + ":5349"]`.

### Часть 2 — экран сопряжения (Preact)

**Найденное ограничение (реальный факт, не гипотеза, разрешает более
ранний вопрос "как проверить отпечаток из JS"): браузер НЕ даёт JavaScript
доступа к TLS-сертификату пира** (ни через fetch, ни через XHR) —
криптографическая проверка отпечатка "на лету" из кода невозможна в вебе.
Единственный реальный способ довериться самоподписанному сертификату —
штатный browser-flow: пользователь ОДИН РАЗ открывает `https://host:port/`
в новой вкладке, принимает предупреждение (браузер запоминает исключение
ИМЕННО для ЭТОГО сертификата — если сертификат сменится, исключение не
сработает, `fetch()` начнёт падать сетевой ошибкой, что и есть реальная
защита от подмены постфактум, не JS-код). Отпечаток из пейринг-кода
используется НЕ для крипто-проверки в момент подключения, а как:
(а) app-level TOFU — сохраняется вместе с host:port при первом успешном
сопряжении, при ПОВТОРНОМ сопряжении с тем же host:port другим кодом
(другой отпечаток) — явное предупреждение "это похоже на другой сервер";
(б) человеко-читаемая строка для ручной сверки с тем, что показал
`install.sh` на VPS (SSH-host-key-подобная практика).

**`src/domain/selfhost/pairing.js`** (новый модуль)
```js
export function decodePairingCode(code)
    // base64 (URL-safe, без padding — encoding/base64.RawURLEncoding на
    // стороне Go) -> JSON.parse -> { host, port, token, fingerprint }.
    // Бросает понятную ошибку на битом base64/JSON/отсутствующих полях.

export async function fetchAgentStatus(pairing, options = {})
    // GET https://{host}:{port}/status, Authorization: Bearer {token}.
    // options.fetchImpl — DI, тот же принцип, что blossom-client.js.
    // Сетевая ошибка (сертификат не принят и т.п.) -> понятное сообщение,
    // не глотает исключение молча.

export async function fetchTurnCredentials(pairing, options = {})
    // GET https://{host}:{port}/turn-credentials, тот же Bearer-токен.
```

**Хранение сопряжения** — переиспользует существующий паттерн
`ui-settings.js`/keystore (шифрованная запись в Dexie, НЕ localStorage
в открытом виде — токен агента даёт полный контроль над сервером
пользователя, чувствительность как минимум как у mnemonic). Новое поле
в `DEFAULT_SETTINGS`: `selfHostedServer: null | {host, port, token,
fingerprint, pairedAt}`.

**Экран** (`src/ui/screens/pairing.jsx` или секция в `profile.jsx` —
решить при реализации, естественнее отдельным экраном, доступным из
настроек) — textarea для вставки кода, кнопка "Подключиться", после
успеха — статус (список сервисов из `/status`), кнопка "Отсоединить".

**Явно НЕ в скоупе И3:** сканирование QR камерой (только вставка текста
пока — QR-код печатается install.sh'ом уже сейчас как base64-строка,
сканирование — отдельная, не критичная для MVP задача, camera-permission
UX). Реальное потребление TURN credentials в `media-controller.js`/
звонках — если останется время в этой итерации, иначе backlog (VOICE.md
уже сознательно ограничивал скоуп "STUN-only... coturn — отдельным
конфигом, вне этого ТЗ" — теперь этот "отдельный конфиг" появляется, но
интеграция со звонками может остаться отдельным довеском).

### Этап 63, И3 — реализация: DoD и живая проверка

**Go (агент):** `agent/internal/turncreds` (6 тестов) + `GET /turn-credentials`
в `httpapi` (защищён тем же Bearer-токеном, 501 если TURN не сконфигурирован
— агент без `--compose-dir`). `main.go` минтит credentials по требованию
через уже персистентный `TURN_SECRET`, TTL 12 часов, `uris` строятся из
`--turn-external-ip`. Регрессия: 41/41.

**JS (клиент):** `src/domain/selfhost/pairing.js` (`decodePairingCode`,
`fetchAgentStatus`, `fetchTurnCredentials`, 11 тестов) + сопряжение/TOFU в
`ui-settings.js` (`pairSelfHostedServer`/`unpairSelfHostedServer`/
`SelfHostedFingerprintMismatchError`, 8 тестов) + секция «Свой сервер» в
`profile.jsx` (`SelfHostedSection`). Регрессия: 1227/1227. `npm run build`
проходит чисто (без новых предупреждений/ошибок от нового кода).

**Живая проверка в браузере (реальный dev-сервер + реальный собранный
агент, не только юнит-тесты):** создан тестовый аккаунт, экран «Профиль» ->
секция «Свой сервер» отрендерилась корректно с инструкцией и полем ввода.
Реальный пейринг-код от РЕАЛЬНОГО запущенного агента (`agent/install.sh`-
эквивалент, `--host=127.0.0.1 --port=19443`, без `--compose-dir`) успешно
ДЕКОДИРОВАН клиентским `decodePairingCode` — подтверждает побайтовую
совместимость `base64.RawURLEncoding` (Go) с ручной URL-safe заменой
символов на клиенте (JS). Попытка подключения ДО принятия самоподписанного
сертификата в браузере дала ожидаемую, понятную ошибку "не удалось
связаться с сервером: Failed to fetch" — форма не потеряла введённые
данные, приложение не упало — это САМЫЙ ЧАСТЫЙ реальный сценарий для
нового пользователя (типичная последовательность: вставил код раньше, чем
открыл https://host:port/ в отдельной вкладке).

**Найденное ограничение инструментария (не проекта):** Chrome DevTools
Protocol (через который работают браузерные инструменты этой сессии)
СОЗНАТЕЛЬНО не даёт автоматизации взаимодействовать со страницей
предупреждения о недоверенном сертификате ("Cannot attach to this
target.") — это защита самого Chrome от автоматического обхода
security-предупреждений, а не баг. Значит сценарий "сертификат уже
принят пользователем" не проверен ЖИВЬЁМ в этой сессии (только через
юнит-тесты с моком `fetchImpl`, где `fetch()` УСПЕШНО возвращает `/status`)
— честно записано как остаточный пробел, не молчаливое допущение;
механизм после установления доверия — стандартное поведение браузерного
`fetch()` к уже доверенному origin, не специфичный для этого проекта код.

**Явно НЕ реализовано в И3 (сознательно, backlog):** сканирование QR
камерой (только вставка текста); реальное потребление TURN credentials в
`media-controller.js`/звонках (VOICE.md уже сознательно ограничивал скоуп
"STUN-only... coturn — отдельным конфигом, вне этого ТЗ" — Go-эндпоинт и
клиентская функция `fetchTurnCredentials` теперь ГОТОВЫ, но фактическая
интеграция в поток звонка — отдельная, не критичная для MVP self-hosting
задача, требует своего адверсарного прохода по FSM звонков).

DoD И3: [x] тесты зелёные (Go 41/41, JS 1227/1227) [x] `go vet`/`npm run
build` чисты [x] живая проверка в реальном браузере (создание аккаунта,
рендер секции, реальный пейринг-код от реального агента, обработка
сетевой ошибки) [x] находки/ограничения записаны честно [x] PLAN.md
обновлён [ ] коммит.

## Раздел «Справка» — markdown-контент без внешних библиотек

Триаж (п.13a): пограничный случай — построчный парсер с реальным
состоянием (внутри код-блока? продолжается ли список?) — блочный уровень
относится к алгоритмической части (13b, псевдокод ниже), инлайн-уровень
(инлайн-форматирование внутри строки) — рутинный regex-разбор.

### Формализация блочного парсера (13b)

**Вход:** строка markdown (собственный текст проекта, НЕ произвольный
пользовательский ввод — не нужна защита от XSS/произвольного HTML,
поскольку рендерится НЕ через innerHTML, а через дерево Preact-нод, см.
ниже — инъекция markdown-контента невозможна структурно, не только
"мы доверяем себе").

**Инвариант состояния**: на каждой строке парсер находится РОВНО в одном
из состояний `{NORMAL, IN_CODE_FENCE, IN_LIST}` — переходы:
- `NORMAL --(строка начинается с \`\`\`)--> IN_CODE_FENCE` (запоминает lang)
- `IN_CODE_FENCE --(строка === \`\`\`)--> NORMAL` (закрывает блок кода,
  ВСЕ строки между открытием и закрытием — буквальный текст, инлайн-
  парсинг НЕ применяется, признак кода как раз "здесь форматирование не
  работает")
- `NORMAL --(строка начинается с '- '/'* '/число+'. ')--> IN_LIST`
  (запоминает ordered: bool)
- `IN_LIST --(следующая строка ТОЖЕ элемент списка того же типа)-->
  IN_LIST` (накопление элементов в текущий список)
- `IN_LIST --(строка НЕ элемент списка)--> NORMAL` (список закрывается,
  текущая строка обрабатывается заново в состоянии NORMAL)
- пустая строка — разделитель абзацев в NORMAL, ЧАСТЬ содержимого в
  IN_CODE_FENCE (код может содержать пустые строки).

**Выходная структура** — плоский массив блоков (не дерево — вложенные
списки/цитаты не нужны для этого контента, сознательное сужение):
```js
{ type: 'heading', level: 1|2|3, text: string }
{ type: 'paragraph', text: string }
{ type: 'list', ordered: boolean, items: string[] }
{ type: 'code', lang: string, code: string }
{ type: 'blockquote', text: string }
{ type: 'hr' }
```
`text`/`items[i]` — СЫРАЯ markdown-строка одной единицы контента, инлайн-
разбор (bold/italic/code/link) происходит ОТДЕЛЬНО, на этапе рендера, не
здесь — разделение ответственности блочный/инлайн уровень.

### `src/domain/help/markdown.js`
```js
export function parseMarkdown(source)
    // -> Block[] (форма выше). Пустой источник -> [].
export function parseInline(text)
    // -> InlineNode[]: {type:'text', value} | {type:'bold', children: InlineNode[]}
    // | {type:'italic', children} | {type:'code', value} | {type:'link', href, children}
    // Разбор ЛЕВО-НАПРАВО, самый левый маркер выигрывает (не пытается угадывать
    // приоритет вложенности сверх очевидного: **bold _italic_** — italic ВНУТРИ bold
    // поддерживается через рекурсивный вызов parseInline на содержимом bold-фрагмента).
```

### `src/ui/components/markdown-view.jsx`
```js
export default function MarkdownView({ source })
    // parseMarkdown(source) -> map каждый блок в Preact-элемент, parseInline
    // для text/items[i] -> map в <strong>/<em>/<code>/<a>. НЕ dangerouslySetInnerHTML
    // нигде — структурная невозможность инъекции произвольного HTML, не
    // ручная санитизация.
```

### Контент — `src/content/help/*.md` (импорт `?raw`)
Список тем и порядок рубрикатора — `src/ui/screens/help.jsx`'s собственный
массив `{id, title, file}` (та же простота, что `NAV_ITEMS` — чистые
данные, не вычисляется динамически из файловой системы, Vite не даёт
директорию импортировать одним `import`).

### Экран `src/ui/screens/help.jsx`
Рубрикатор (список тем слева/сверху) + `MarkdownView` для выбранной темы
справа. Доступен и НЕ залогиненным (гостям — по формулировке пользователя
"должно заинтересовать и гостей") — ВАЖНО: этот этап добавляет ТОЛЬКО
пункт в `NAV_ITEMS`/`app.jsx` (доступен залогиненным пользователям внутри
`MainShell`) — публичная доступность ДО логина (с лендинга/онбординга)
явно НЕ в скоупе этого прохода, отдельная задача при необходимости.

### Явно в скоупе первого прохода
Инфраструктура (парсер+рендер+экран+навигация) + 2-3 содержательных
темы для проверки живьём. Полный охват всех тем, перечисленных
пользователем — по мере написания, не обязательно все сразу одним
проходом.

### Раздел «Справка» — реализация: DoD и живая проверка

Реализовано: `src/domain/help/markdown.js` (`parseMarkdown`/`parseInline`,
23 теста), `src/ui/components/markdown-view.jsx` (рендер в Preact-ноды, без
`dangerouslySetInnerHTML`), `src/ui/screens/help.jsx` (рубрикатор + контент),
5 тем в `src/content/help/*.md` (о проекте, контакты/каналы, приватность,
стек, исходный код — с плейсхолдером `git.ugolok.tech`, до появления
реального Forgejo, см. память проекта), новый пункт навигации `help`
(`nav-items.js`/`app.jsx`), иконка `help-circle.jsx` (Feather, тот же
источник, что остальные иконки проекта), CSS в `custom.css` (design-токены
проекта, без новых переменных). Регрессия: 1250/1250. `npm run build`
чист, итоговый бандл 562 КБ gzip (лимит 1304 КБ — с большим запасом).

**Живая проверка в реальном браузере:** создан тестовый аккаунт, раздел
«Справка» открылся, рубрикатор переключает темы, разметка (заголовки,
списки нумерованные/маркированные, **жирный**, инлайн-код, вложенные
конструкции) рендерится корректно на всех проверенных темах, активная
тема подсвечивается. Консоль без ошибок. Тестовый аккаунт удалён сразу
после проверки (не оставлен, по установленному ранее правилу).

**Явно НЕ реализовано в этом проходе:** доступность раздела ДО логина
(с лендинга/онбординга) — сейчас виден только залогиненным пользователям
внутри `MainShell`, тот же охват, что у остальных пунктов навигации;
дальнейшие темы справки — по мере необходимости, инфраструктура уже
готова принять любое число новых `.md`-файлов без изменений в коде.

### Раздел «Справка» — доступность ДО логина (стартовая страница)

Пользователь запросил перевести меню стартовой страницы (`unlock.jsx`,
раньше — мёртвые ссылки "Главная/Возможности/Скачать APK") на
"Главная/Временный чат/Справка". Реализовано:

- Рубрикатор+рендер вынесены из `screens/help.jsx` в переиспользуемый
  `components/help-content.jsx` (без обёртки `Screen` — та актуальна
  только для залогиненного `MainShell`) — используется И на стартовой
  странице, И в залогиненном разделе, без дублирования списка тем.
- Пункты меню — настоящие `<button>`, не `<a href="#">` (переключают
  состояние `<main>` этой же страницы, не реальная навигация).
- "Временный чат" — только заглушка с описанием будущей функции (гостевые
  комнаты, текст+голос, авто-удаление через час простоя/без пользователей) —
  сама функция сознательно НЕ реализуется этим проходом (отдельная
  масштабная задача, отложена, см. ранее обсуждённый список 8 пунктов).
- CSS для `.help-*`/`.md-*` расширен на оба корневых класса layout'а
  (`.app-layout` и `.auth-layout`) — контент общий, окружение разное.

Живая проверка в браузере: переключение всех трёх пунктов меню работает,
разметка справки рендерится идентично залогиненной версии, консоль
чиста. Регрессия: 1250/1250, `npm run build` чист.

## Этап 64 — мультиязычность (i18n)

Пользователь запросил полную мультиязычность: 12 языков (по убыванию
распространённости — en, es, de, ja, fr, pt, ru, it, nl, pl, tr, zh),
автоопределение языка хостовой системы при первом запуске, расширение
существующего (пока русского-only, `disabled`) переключателя языка в
Настройках на все 12, перевод содержимого справки, и правило: строка
"Уголок" (логотип/бренд) отображается латиницей "Ugolok" на ВСЕХ
нерусских языках (буквально пользовательская формулировка).

Полный охват (~450-500 уникальных строк по всему UI + 130 строк
markdown справки × 12 языков) — это МНОГО этапов/итераций, не один
присест. Этап 64 закладывает инфраструктуру + переводит первый срез
(навигация, лого, стартовая страница, сам переключатель языка).
Остальные экраны — последующими итерациями/этапами.

**Перевод строк — НЕ делегируется воркеру** (отступление от обычной
дисциплины "воркер пишет код"): это NLP-задача, не кодогенерация,
7B-модель, заточенная под код, не подходит для качественного перевода,
особенно на языки с иной письменностью (ja/zh/tr), которые сам Claude
тоже не может проверить на 100%, но заведомо лучше воркера. Переводы
пишет Claude напрямую; приёмка — структурный тест (все 12 файлов
локализации имеют ИДЕНТИЧНЫЙ набор ключей, ни один язык не отстаёт) +
визуальная проверка в браузере на паре языков.

### `src/ui/i18n/locales/{ru,en,es,de,ja,fr,pt,it,nl,pl,tr,zh}.json`

Вложенный JSON, ключи — dot-path сегменты (`unlock.main.hero.title`).
`app.name` — единственный ключ со СМЫСЛОВЫМ различием, не просто
переводом: `"Уголок"` только в `ru.json`, `"Ugolok"` (латиницей) во
ВСЕХ остальных 11 файлах — буквальное правило пользователя.
Интерполяция — `{{var}}` синтаксис (`t("unlock.main.loginForm.submitButton", {appName: t("app.name")})`).

### `src/ui/signals/i18n.js`

```js
export const SUPPORTED_LOCALES = [
  { code: "en", nativeName: "English" },
  { code: "es", nativeName: "Español" },
  { code: "de", nativeName: "Deutsch" },
  { code: "ja", nativeName: "日本語" },
  { code: "fr", nativeName: "Français" },
  { code: "pt", nativeName: "Português" },
  { code: "ru", nativeName: "Русский" },
  { code: "it", nativeName: "Italiano" },
  { code: "nl", nativeName: "Nederlands" },
  { code: "pl", nativeName: "Polski" },
  { code: "tr", nativeName: "Türkçe" },
  { code: "zh", nativeName: "中文" },
];
export const DEFAULT_LOCALE = "en"; // самый распространённый — честный фолбэк
                                     // для НЕподдерживаемого системного языка
export const currentLocale; // @preact/signals signal(code), реактивный
export function detectSystemLocale(languages = navigator.languages || [navigator.language]) {}
// Берёт primary subtag (до "-") каждого languages[i] по порядку,
// первое совпадение с SUPPORTED_LOCALES.code — возврат; ни одного
// совпадения — DEFAULT_LOCALE.
export function setLocale(code) {} // мутирует currentLocale.value, ничего не персистит
                                    // (персистенция — забота вызывающей стороны, тот же
                                    // паттерн, что applyThemeMode/saveUiSettings в app.jsx)
export function t(key, vars) {}
// Ищет key (dot-path) в locales[currentLocale.value]; нет — fallback
// в locales[DEFAULT_LOCALE]; нет нигде — возврат самого key (плюс
// console.warn, не бросает исключение — отсутствующий перевод не должен
// ронять экран). vars — {{name}} интерполяция в найденной строке.
```

Определение системного языка при первом запуске — ДВЕ точки (симметрично
теме до/после логина):
- До логина (unlock.jsx, ownerPubkey ещё не известен) — `currentLocale`
  инициализируется `detectSystemLocale()` при первой загрузке модуля
  (нет персистентного состояния без owner — каждый холодный старт
  браузера ДО логина заново определяет язык системы, это ожидаемо:
  нет ownerPubkey — негде хранить постоянный выбор).
- После логина — `loadUiSettings`'s fallback-ветка (первый запуск ДЛЯ
  ЭТОГО pubkey на этом устройстве, ui-settings.js:82-90) использует
  `detectSystemLocale()` вместо жёстко зашитого `DEFAULT_SETTINGS.language
  = "ru"` — тот же принцип, что relayUrls/blossomUrls уже получают
  build-time дефолт именно в этой ветке, не в самом DEFAULT_SETTINGS.
  Уже СУЩЕСТВУЮЩИЙ явный выбор пользователя (сохранённая запись) НИКОГДА
  не перезаписывается автоопределением — детект работает только когда
  локальной записи ещё нет вовсе.

### `settings.jsx` — переключатель языка

Прежний `disabled`-select с одной опцией ("Русский") заменён на рабочий:
опции — `SUPPORTED_LOCALES` (nativeName), `onChange` вызывает
`setLocale(code)` (мгновенный локальный эффект, тот же паттерн, что
`applyAccentColor`/`applyThemeMode`) + `saveUiSettings(..., {language: code}, publish)`
best-effort (сеть недоступна — локальный выбор уже применён, тот же
принцип, что остальные переключатели в этом экране).

### Раздел «Справка» — перевод содержимого (md-контент, не UI-строки)

`src/content/help/{locale}/{topic-id}.md` — вложенная по языку структура
(было плоско `src/content/help/*.md`, только русский; перенесено в
`ru/`). Все 12×5=60 файлов бандлятся статически (`?raw`, тот же приём,
что раньше) — единый html-файл всё равно включает всё, лениво грузить
markdown по языку нечем (нет отдельного chunk-splitting в singlefile-
сборке), а суммарный вес (~130 строк ru × 12 языков, задача не растёт
пропорционально байтам кода) далеко не подходит к лимиту NF-11.

`help-content.jsx`: `TOPIC_DEFS` — чистые данные `{id, titleKey}` (не
готовый текст title — тот же приём, что `NAV_ITEMS`/`CATEGORY_META`,
этап 64), заголовок темы переведён через `t(titleKey)`. `HELP_CONTENT`
— вложенный объект `{locale: {topicId: rawMarkdownString}}`, источник
для `<MarkdownView>`. Выбор реагирует на `currentLocale.value` (та же
подписка через сигнал, что везде в i18n этого этапа) — переключение
языка в Настройках сразу перерисовывает содержимое Справки, без
перезахода в раздел.

Перевод содержимого (не заголовков разделов — те уже ключи t()) делает
Claude напрямую, тем же обоснованием, что UI-строки (этап 64): NLP-
задача, не кодогенерация, и для качества требуется человеческая/AI-
проверка смысла, а не механическая подстановка.

## Этап 64, часть 4 — i18n генерируемого контента

Разбито на 4 подзадачи по возрастанию сложности (пользователь
подтвердил план и явно разрешил старым записям Журнала остаться
на русском без миграции, "по пункту 4 - да нормально, пусть
остаются на русском"). Домен-исключения (`Error`/`PreconditionError`,
~40 строк, ~15+ файлов, часть тестов проверяет `error.message` дословно)
сознательно ОТЛОЖЕНЫ отдельной будущей задачей — не входят в этот этап.

### 15/16 — sync-log и имя общей папки

`logSync()` (transport.js) и дефолтное имя принятой доли
(`files.sharedFolderDefaultName`) — простое оборачивание в `t()`,
эфемерно/локально, без схемы.

### 17 — имя голосового вложения

`attachment.name` для голосовых — это ЧУЖОЙ текст, пришедший
зашифрованным внутри сообщения от отправителя буквально на ЕГО языке
(chat.jsx's `buildOutgoingAttachment`) — получатель не может
"перевести" данные другого устройства через свой `t()`. Решение —
`attachmentDisplayName()` (attachment-view.jsx) игнорирует
`attachment.name` для голосовых целиком, показывает
`t("chat.voiceMessageName")` на языке ПРОСМАТРИВАЮЩЕГО, различая
голосовые через уже существующий флаг `attachment.voice` (булево,
не текст, не зависит от языка отправителя).

### 18 — Журнал/уведомления (`notifyAndLog`)

Персистентная запись Журнала (`journalEntries`, journal.js) раньше
хранила ГОТОВЫЙ текст (title/body) как ciphertext — нет пути
перерендерить на другом языке при чтении. Схема расширена
(`writeJournalEntry`): опциональные `titleKey`/`titleParams`/
`bodyKey`/`bodyParams` хранятся РЯДОМ с title/body (не вместо) —
`journal.jsx` предпочитает `*Key` (рендер через `t()` в ТЕКУЩЕЙ
локали читателя), используя `title`/`body` как резерв для записей
БЕЗ ключа (старый формат, до этого этапа — остаются на русском
навсегда, миграция не делается, см. выше).

`notify()` (notifier.js) НЕ тронут — как и требует его собственный
контракт, продолжает получать уже отрендеренные `title`/`body`
через `options`, ту же форму, что раньше.

Все 11 вызовов `notifyAndLog` (contacts.js:1, call.js:1,
transport.js:9) теперь вычисляют `t(key, params)` ДВАЖДЫ на разных
уровнях по смыслу: один раз для немедленного тоста/попапа (текущая
локаль автора события), и передают сырые `titleKey`/`titleParams`/
`bodyKey`/`bodyParams` для персистентности — то, что реально
перечитывается в чужой локали позже.

Разделение title/body по переводимости:
- **title** — ВСЕГДА шаблон с параметрами (имя канала/юзернейм) —
  переводим целиком через `journal.*Title` ключи.
- **body** — переводим ТОЛЬКО когда это UI-обвязка (статичная фраза
  вроде "Изменения в канале — см. вкладку Модерация", или
  типографские кавычки вокруг цитаты — `journal.quotedText`,
  `journal.userPrefixedText`). Когда body — это ЧУЖОЙ контент
  (текст поста/жалобы/комментария/сообщения) — остаётся как есть,
  НЕ переводим (это данные, не UI, аналогично находке 17 про
  голосовые).

`contact-fsm.js` НЕ тронут (его `entry.message` — часть формы команд
FSM с собственным тестом, `assert.equal(typeof entry.message,
"string")"), титул для contacts.js строится по `entry.category`
напрямую (`newRequest`/`accepted`/`rejected`/`crossed` — уже
однозначно определяют один из 4 вариантов), не по `entry.message`.

18 новых ключей × 12 языков в неймспейсе `journal.*`, кавычки —
по уже установленной для проекта конвенции на локаль (« » en/es/pt/
it/tr, « {{x}} » с пробелами fr, „ " de/pl, 「」 ja, ‘’ nl, "" zh).

Живая проверка: два throwaway-аккаунта (j18testa на японской
локали, j18testb на русской), реальная заявка в контакты через
локальный relay — j18testa увидел "j18testbさんから新しい連絡先リクエスト"
(titleKey-путь, японский), j18testb увидел "j18testa принял(а) вашу
заявку" (тот же путь, русский) — оба конца схемы titleKey+titleParams
подтверждены живым end-to-end потоком через реальный relay, не только
юнит-тестами. Оба аккаунта удалены после проверки.

Regression: 1272/1272. Сборка: 697.88 КБ gzip (было 691, лимит 1304).

## Этап 65 — i18n доменных ошибок

Пользователь выбрал охват: только user-facing (не внутренние
протокольные/FSM-инварианты вроде relay-pool.js/mls-session.js/
keystore.js/machine.js/nip44.js — они уже частично на английском и в
норме не долетают до пользователя, сигнализируют баг, а не
ожидаемый UX-сценарий).

### `src/domain/errors.js` (новый файл)

`class DomainError extends Error { constructor(message, key, params) }`
— message НЕ меняется (существующие тесты матчат его regex'ом на
фрагмент через `assert.throws(fn, /паттерн/)`, factual-проверка
показала: НИ ОДНОГО `assert.equal(error.message, "точный текст")` во
всей кодовой базе нет — риск оказался ниже, чем предполагалось на
момент планирования, но подход "message не трогать" сохранён как
самый безопасный). key/params — ДОПОЛНИТЕЛЬНЫЕ поля для UI.

Тот же приём применён к уже существующим кастомным классам:
`PreconditionError` (files/ops.js — `return new PreconditionError(code,
message, key, params)`, НЕ throw, см. этап 53 §5.2) и
`SelfHostedFingerprintMismatchError` (settings/ui-settings.js — key
фиксирован в конструкторе, у неё message не параметризуется извне).

### `errorMessage(err)` (src/ui/signals/i18n.js)

`err?.key ? t(err.key, err.params) : err?.message || String(err)` —
единая точка вместо разбросанного по ~15 файлам UI (`screens/*.jsx` +
`components/*.jsx` + `hooks/pending-attachment.js`) паттерна
`err?.message || String(err)`. `diagnostics.jsx` НЕ тронут — пользователь
ранее (этап 64ч2) явно исключил его из i18n ("не трогай, потом
переделаем"), решение распространено и на доменные ошибки в этом файле.

`files.jsx` уже имел одноимённую локальную функцию `errorMessage(result)`
(PreconditionError-специфичную) — переименована внутренняя логика на
вызов импортированного хелпера под алиасом `translateErrorMessage`, имя
`errorMessage` в файле сохранено (сигнатура/вызовы снаружи не менялись).

### Разделение "переводимо целиком" / "чужой контент внутри"

Общий паттерн `requirePublishOk` (буквально продублирован в 10 файлах:
channel.js, moderation.js, channel-chat.js, channel-access.js,
channel-visibility.js, comments.js, post.js, devices.js, chat.js,
share.js + 2 инлайн-версии — drafts.js, read-status.js) — `result.reason`
(текст ОТ relay, недоверенный/непереводимый) остаётся сырым `throw new
Error(result.reason)`, а статичный fallback "relay отклонил публикацию"
стал `DomainError` с ключом `errors.relayRejected`:
```js
if (result.reason) throw new Error(result.reason);
throw new DomainError("relay отклонил публикацию", "errors.relayRejected");
```
Тот же принцип — `identity/profile.js`/`files/content.js` (Blossom
`status`/`reason` от сервера — параметр `detail`, сам текст не
переводится, только каркас "Blossom-сервер отклонил файл{{detail}}"),
`selfhost/pairing.js` (`err.message` вложенного network-исключения —
параметр `message`, статус-код ответа — параметр `status`).

### Сознательно НЕ переведено (в т.ч. внутри "user-facing" файлов)

- `messaging/chat.js:159,183` — developer-hint тексты ("вызовите
  ensureOwnKeyPackagePublished() раньше") — сигнал программисту о
  неверном порядке вызовов, не user-facing по смыслу, несмотря на файл.
- `files/blob.js` (Range/206/sha256 — HTTP-протокольный debug-текст).
- `files/content.js`'s `DOMException("Загрузка отменена", "AbortError")`
  — проверено: `files.jsx:252` перехватывает по `err.name==="AbortError"`
  и тихо гасит (`break`), пользователь текст никогда не видит.
- `diagnostics.jsx` целиком (решение пользователя, этап 64ч2).

### Ключи

30 уникальных ключей в неймспейсе `errors.*` × 12 языков (кавычки —
по установленной ранее конвенции на локаль, этап 64: « » en/es/pt/it/tr,
« {{x}} » с пробелами fr, „ " de/pl, 「」 ja, ‘’ nl, "" zh, «» ru).

Живая проверка: throwaway-аккаунт на японской локали, две реальные
доменные ошибки спровоцированы вручную в браузере через локальный
relay — удаление единственного relay в Настройках
(`errors.lastRelayCannotBeRemoved`, статичная фраза) и создание папки
с уже занятым именем в Файлах (`errors.nameTakenInFolder`, с
параметром `{{name}}`) — обе отрендерились корректно на японском
("最後のrelayは削除できません…", "名前「lost+found」はこのフォルダで既に
使用されています"). Аккаунт удалён после проверки.

Regression: 1272/1272 (message ни у одной ошибки не изменился —
предсказуемо, ни один тест не потребовал правки). Сборка: 705.73 КБ
gzip (было 697.88, лимит 1304).

## Этап 66 — REGLAMENT.md обязателен для всей новой/переверстываемой разметки

`PROCESS-DOCS/REGLAMENT.md` — обязательный контракт композиционного
слоя вёрстки (три уровня: композиция/токены/оформление, см. документ
целиком). Реализация — `src/styles/minimal.css`, слой `@layer
composition` (после `utilities` в списке `@layer reset, tokens, base,
elements, utilities, composition;`).

**Одно отличие реализации от буквального текста REGLAMENT.md — не
ошибка регламента, а проектная поправка:**

1. `.ratio` использует **`--aspect`**, не `--ratio` — в Уголке
   `--ratio` уже глобальный токен модульной шкалы шрифта (`tokens`,
   `--step-*`), совпадение имени наследовалось бы в любой голый
   `.ratio` вместо фолбэка `16/9`. Это проектная поправка (другой
   проект без такого токена может использовать `--ratio` как в
   документе) — исправлено и в самом REGLAMENT.md с пояснением.

Обе поправки найдены ДО того, как стали багом — сверкой имён
классов/переменных REGLAMENT.md с уже существующими токенами/классами
проекта перед первым использованием, не постфактум.

Стратегия миграции (утверждена пользователем, вариант "держать старое
рабочим") и полный список файлов — PLAN.md, "Этап 66". Этап В (удаление
`.flow`/`.cluster`/`.grid-auto`/старого `.center` из `utilities`,
переименование `.measure`→`.center`) закрыт — весь `src/ui` теперь на
слое `composition`, временной коллизии имён `.center`/`.measure` больше
не существует.

## Этап 70 — генератор палитры (`src/ui/theme/palette-generator.js`)

Формализация и обоснование решений — DESIGN.md, "Этап 70". Здесь —
только публичный контракт для дальнейших этапов (UI/применение).

```js
/**
 * @typedef {{
 *   dir: -1 | 1,        // -1 светлая, 1 тёмная
 *   lBg: number,        // dir=1: [0.12,0.24]; dir=-1: [0.93,0.995]
 *   cNeutral: number,   // [0, 0.035]
 *   accentHue: number,  // [0, 360), вне запретных зон (см. ACCENT_FORBIDDEN_ZONES)
 * }} PaletteConfig
 */

/** Throws PaletteConfigError, если accentHue в запретной зоне или любое
 *  поле вне диапазона (валидация — часть контракта, не best-effort). */
export function generatePalette(config: PaletteConfig): Record<string, string>

/** [{ hue: number, halfWidth: number }] — центры и полуширина запретных
 *  зон вокруг служебных тонов (25/85/145/235 ± 20°), экспортируется для
 *  UI-слайдера (чтобы визуально исключить недоступные секторы круга). */
export const ACCENT_FORBIDDEN_ZONES: { hue: number, halfWidth: number }[]

export class PaletteConfigError extends Error {}
```

**Возвращаемый объект** — плоская карта `--имя-токена → готовая CSS-
строка цвета` (`oklch(L C H)`, абсолютный синтаксис, НЕ `oklch(from
...)` — см. DESIGN.md почему). Полный список ключей: `--bg`,
`--surface`, `--surface-raised`, `--border`, `--muted`, `--fg`,
`--accent`, `--accent-contrast`, `--accent-2`, `--accent-2-hue`,
`--bad`, `--bad-surface`, `--bad-edge`, `--warn`, `--warn-surface`,
`--warn-edge`, `--good`, `--good-surface`, `--good-edge`, `--info`,
`--info-surface`, `--info-edge`. `--accent-hover`/`--accent-2-hover`
НЕ входят (остаются `color-mix()`-выражениями в CSS, зависят только от
`--accent`/`--accent-2`, не от `config` напрямую).

**Применение — РЕШЕНО (спросил пользователя, не угадано, см. диалог):**
слайдер крутит `cNeutral`/`accentHue` СРАЗУ для обеих полярностей темы
(общие — как сейчас единый `--accent-hue` в `light-dark()`); `lBg`
пользователю НЕ выдаётся — это два build-time зафиксированных значения,
по одному на полярность (`BUILD_LBG_LIGHT`, `BUILD_LBG_DARK`, оба —
проверенные И1 отдельные точки внутри уже верифицированных диапазонов
`generatePalette`, не новый параметр). Значит `customPalette`, который
реально хранится в `uiSettings`, — НЕ `PaletteConfig` целиком, а его
подмножество:
```js
/** @typedef {{ cNeutral: number, accentHue: number }} CustomPaletteConfig */
```
Применение — генерирует ОБЕ ветки сразу и раскладывает их в
раздельные custom-properties с суффиксом полярности, а не в одно плоское
имя (потому что CSS уже переключает ветки сам через `light-dark()`,
основываясь на `prefers-color-scheme`/`data-theme` — JS не обязан
знать текущую активную полярность и не должен пересчитывать палитру
при переключении темы, только при изменении cNeutral/accentHue):
```js
export function applyCustomPalette({ cNeutral, accentHue }) {
  const light = generatePalette({ dir: -1, lBg: BUILD_LBG_LIGHT, cNeutral, accentHue });
  const dark = generatePalette({ dir: 1, lBg: BUILD_LBG_DARK, cNeutral, accentHue });
  const root = document.documentElement.style;
  for (const [name, value] of Object.entries(light)) {
    if (name.endsWith("-hue")) { root.setProperty(name, value); continue; } // --accent-2-hue общий, не раздваивается
    root.setProperty(name + "-light", value);
  }
  for (const [name, value] of Object.entries(dark)) {
    if (name.endsWith("-hue")) continue;
    root.setProperty(name + "-dark", value);
  }
}
```
`src/styles/minimal.css` должен для каждого генерируемого токена (`--bg`,
`--surface`, `--surface-raised`, `--border`, `--muted`, `--fg`,
`--accent`, `--accent-contrast`, `--accent-2`, `--bad(-surface/-edge)`,
`--warn(...)`, `--good(...)`, `--info(...)`) определить его как
`light-dark(var(--ИМЯ-light), var(--ИМЯ-dark))` — правка CSS-архитектуры,
не только JS-подэтап (см. отдельную задачу очистки минимал.css).

**Build-time дефолт (спросил пользователя — применяется ВСЕГДА, даже
без единого явного действия пользователя, а не только после первого
сохранения):**
```js
export const BUILD_LBG_LIGHT = 0.99; // = текущий --bg light-ветка (минимал.css)
export const BUILD_LBG_DARK = 0.17;  // = текущий --bg dark-ветка
export const DEFAULT_CUSTOM_PALETTE = { cNeutral: 0.01, accentHue: 265 };
// 265 = текущий --accent-hue. cNeutral СНАЧАЛА был 0.022 (=старый
// --chroma-ui) — на дефолтных значениях applyCustomPalette воспроизводил
// СЕГОДНЯШНИЙ --bg побитово; расхождение с сегодняшним видом было только в
// одном месте — старый --hue:55 (тёплый янтарь) у нейтралей был НЕЗАВИСИМ
// от --accent-hue, новый генератор всегда красит нейтрали в тон accentHue
// (единый узел вместо двух) — пользователь осознанно принял этот компромисс
// ("сразу build-дефолт генератора", не "null = старый CSS как есть").
// ПЕРЕСМОТРЕНО (этап 70-довесок-2, найдено пользователем живьём): та же
// числовая chroma 0.022 на холодном hue (indigo/violet, 265) читается
// заметно "цветнее", чем читалась на старом тёплом --hue:55 — человеческий
// глаз воспринимает одинаковую OKLCH-chroma у синих/фиолетовых hue как
// более насыщенную, чем у жёлтых/оранжевых (тот же эффект, что уже привёл
// к понижению cAccent в palette-generator.js). .card/.surface-raised
// выглядели заметно тонированными, не нейтрально-серыми. Понижено до 0.01 —
// ближе к общей рекомендации дизайн-систем "chroma≈0 для нейтралей", но не
// плоский серый. Диапазон слайдера (0-0.035) не сужен.
```
`applyCustomPalette` вызывается ВСЕГДА при загрузке настроек (boot),
включая случай `customPalette === null` — тогда аргумент —
`DEFAULT_CUSTOM_PALETTE`, не no-op. `--hue` (используется `--shadow` и,
возможно, другими некрашенными по токенам местами) — становится
алиасом `var(--accent-hue)`, не отдельной константой 55, чтобы тень и
подобные тёплые акценты оставались в тон общей палитре, а не жили в
устаревшем захардкоженном hue.

**Пересмотрено при реализации (нашёл коллизию, не гипотеза, затем
пользователь подтвердил решение):** 5 из 14 существующих
`ACCENT_COLORS` (`sky`=230, `terracotta`=35, `amber`=75, `saffron`=85,
`moss`=140 — проверено скриптом) попадают в запретные зоны нового
генератора (25/85/145/235 ±20°) — легаси-пресеты не могли бы
маршрутизироваться через `generatePalette` без потерь. Пользователь
решил проще: **старый механизм убирается целиком**
(`accent-palette.js`/`ACCENT_COLORS`/свотч-кнопки в settings.jsx —
подэтап UI), не сохраняется параллельно.

`uiSettings.accentColorId` (старое строковое поле) остаётся в
`DEFAULT_SETTINGS`/`mergeWithDefaults` только для ЧТЕНИЯ уже
сохранённых у пользователей kind:30072-событий (одноразовая миграция
при первой загрузке после апдейта: если `customPalette` не задан, а
`accentColorId` есть — построить `CustomPaletteConfig` из
build-дефолтного `cNeutral` и hue старого пресета (нужна МИНИМАЛЬНАЯ
id→hue таблица для миграции — те же 14 значений, что были в
`ACCENT_COLORS`, но без `label`/UI-полей, живёт рядом с миграцией, не
экспортируется публично), при коллизии hue с запретной зоной — сдвинуть
к ближайшему разрешённому краю зоны, не отказывать пользователю в
переезде). Новое единственное поле конфигурации —
`customPalette: CustomPaletteConfig | null`, `null` только для
АБСОЛЮТНО нового аккаунта без сохранённого `accentColorId` (тогда —
build-дефолт `CustomPaletteConfig`, не "нет цвета"). Миграция —
один раз при `loadUiSettings`/`mergeWithDefaults`, не откладывается в
фоновую сосуществующую систему.

**Тестовый контракт** — `tests/palette-generator.test.js` проверяет
И1 (DESIGN.md) через `tests/helpers/oklch-contrast.js` (OKLCH→
относительная яркость WCAG, без внешних зависимостей в рантайм-бандле).
Любое изменение таблицы дельт/служебных тонов обязано пройти этот файл
без снижения порога контраста — регресс здесь равносилен регрессу
любого другого протокольного инварианта проекта.

## Этап 71 — фикс гонки публикации профиля (multi-device перетирает avatar/picture)

Найдено пользователем живьём (несколько окон/браузеров одной identity):
первый вход на НОВОМ устройстве публикует "голый" `kind:0` только с
`name` — `kind:0` replaceable (NIP-01), эта версия свежее по
`created_at` и стирает на relay уже существующую версию с `about`/
`picture`, причём НЕ ТОЛЬКО для этого устройства — для ВСЕХ, кто
запрашивает профиль этой identity.

**Правка контракта `ensureProfilePublished`** (`src/domain/identity/
profile.js`, сигнатура НЕ меняется —
`ensureProfilePublished(ownerPubkey, login, privKey, publish)`):
раньше строила событие как `buildProfileEvent(privKey, { name: login
})`, теперь — читает `getProfile(ownerPubkey)` (keystore) и передаёт
`about`/`picture` из уже известных локально `bio`/`avatarUrl`, если
они непустые:

```
const current = await getProfile(ownerPubkey);
const event = buildProfileEvent(privKey, {
  name: login,
  about: current.bio || undefined,
  picture: current.avatarUrl || undefined,
});
```

Работает только если к моменту вызова keystore уже содержит
актуальные `bio`/`avatarUrl` — для этого **порядок вызовов в
`connect()` (`transport.js`) правится**: `hydrateOwnProfile(pubkeyHex)`
(подтягивает уже опубликованный на relay `kind:0` в keystore — тот же
`bootstrap`-поток, что и раньше, просто читается РАНЬШЕ) теперь
вызывается ДО `ensureOwnKeyPackagePublished`/`ensureProfilePublished`,
не после них. `bumpProfileActivity()`/`bumpMessagingActivity()`
остаются на прежнем месте (в конце `connect()`, после
`syncMirroredHistory`) — отражают полностью досинхронизированное
состояние, не только пост-гидратацию.

Остаточный риск (принят, не в скоупе этого этапа): два устройства,
ОБА публикующие впервые практически одновременно (до того как любое
успело получить обратно чужую версию через relay), всё ещё могут
разойтись на один цикл `connect()` — обычная eventual-consistency
граница replaceable-событий без блокировок, самоисцеляется на
следующем connect() любого из устройств. Отличие от бага ДО фикса:
раньше публикация была БЕЗУСЛОВНО голой (гонка гарантированно стирала
контент), теперь голая публикация происходит, только если ЛОКАЛЬНО
тоже пусто — не системная порча, а honest race с симметричным шансом
у обеих версий быть содержательными.

## Этап 72 — MLS multi-device: детерминированное членство + реактивная досинхронизация

Полная формализация, инварианты И1/И2 и обоснование — DESIGN.md,
"Этап 72". Здесь — только интерфейсный контракт.

**`src/core/crypto/mls-session.js`** — НОВАЯ функция, `addMember`
существующий НЕ трогается:
```
addMembers(sessionState, theirKeyPackagesWireBytesArray: Uint8Array[])
  -> { newSessionState, welcomeWireBytes: Uint8Array, commitWireBytes: Uint8Array }
```
Один `createCommit` с `extraProposals` = массив `add`-proposals (по
одному на элемент входного массива). Бросает, если массив пуст
(нечего добавлять — вызывающий код обязан проверить `theirDevices`
непустым ДО вызова, симметрично старому `addMember`, которому тоже
недопустимо передать пустой/невалидный wireBytes).

**`src/ui/signals/transport.js`** — `fetchKeyPackage(pubkeyHex)`
ЗАМЕНЯЕТСЯ на:
```
fetchDeviceKeyPackages(pubkeyHex: string)
  -> Promise<Map<deviceId: string, { wireBytes: Uint8Array, createdAt: number }>>
```
Дедуп по `deviceId` — при повторе берётся максимальный `createdAt`.
События без тега `device` пропускаются (не участвуют в дедупе, не
попадают в результат). Бросает `"у контакта нет опубликованного
ключа для сообщений"`, если результат пуст (тот же текст ошибки, что
у старого `fetchKeyPackage` — не менять формулировку, на неё, возможно,
уже завязан UI/тесты). Единственный вызывающий — `ensureChatEstablished`
(`chat.js`) — сигнатуру и переменную там переименовать вслед за функцией.

**`src/core/store/database.js`** — новая таблица, `db.version(21)`:
```
knownContactDevices: "[ownerPubkey+contactPubkey+deviceId], [ownerPubkey+contactPubkey]"
```
Строка: `{ ownerPubkey, contactPubkey, deviceId, wireBytes }` — БЕЗ
`toEncryptedRow` (тот же прецедент, что `knownDevices`, этап 25:
KeyPackage и так публичен на relay, шифровать локальную копию нечем
защищать).

**`src/domain/messaging/devices.js`** — новая функция, СИММЕТРИЧНАЯ
`addSiblingToGroup` (та НЕ меняется):
```
addContactDeviceToGroup(ownerPubkey, privKey, dbKey, publish, contactPubkey, deviceId, wireBytes, group)
```
Commit — kind:445 `#h`-каналом (как у `addSiblingToGroup`). Welcome —
`nip59.wrap(..., privKey, contactPubkey)` (НЕ `ownerPubkey` — это
устройство контакта, не моё). После успешной публикации Welcome —
`knownContactDevices.put({ownerPubkey, contactPubkey, deviceId, wireBytes})`.

Новая функция-диспетчер (единая точка входа и для живой подписки, и
для замены пакетного прохода при `connect()`):
```
handleDeviceAnnounce(ownerPubkey, privKey, dbKey, publish, announcerPubkey, deviceId, wireBytes)
```
Ветвление `announcerPubkey === ownerPubkey` (свой sibling, существующая
логика `syncDeviceMembership`/`addSiblingToGroup`) vs иначе (устройство
контакта, `addContactDeviceToGroup`, только если `mlsGroups` для этой
пары УЖЕ существует — иначе no-op, реальное первое установление идёт
через `ensureChatEstablished`).

**`src/ui/signals/transport.js`** — `refreshGroupMessageSubscription`
получает ВТОРОЙ постоянный подписчик внутри той же функции (см. явную
причину в DESIGN.md — переиспользование существующих точек вызова, не
новые). Фильтр: `{authors: [ownerPubkey, ...distinct(contactPubkey из
mlsGroups.where(ownerPubkey))], kinds: [443]}`, тот же `subId` на
каждый вызов (resubscribe). `onBatch` → `handleDeviceAnnounce` на
каждое НОВОЕ (`isNewEvent`) событие. Существующий `catch {}` при
разборе `kind:445` (строка с комментарием "не удалось расшифровать...
не ронять батч") правится на `catch (e) { console.warn(...) }`.

`syncMirroredHistory` — per-event тело (`decryptMirrorPayload` →
`upsertMessage` → `receiveLamportTick`) выносится в приватный хелпер,
переиспользуется НОВЫМ постоянным подписчиком
`{authors:[ownerPubkey], kinds:[KIND_MESSAGE_MIRROR]}`, заводится один
раз при `connect()` сразу после одноразового catch-up (тот же паттерн
жизненного цикла, что `giftWrapSubscriber`).

**Найдено адверсарным тестом при реализации (не домысел, не в исходном
дизайне):** два конкурентных вызова `handleDeviceAnnounce` с одинаковым
`(ownerPubkey, announcerPubkey, deviceId)` независимо читают одно и то же
пред-коммитное состояние группы и оба публикуют `welcome` — потерянное
обновление (ts-mls не ловит это как "уже участник", т.к. с точки зрения
каждого вызова участника ещё нет). Это ВНУТРИПРОЦЕССНАЯ гонка (тот же JS
event loop), отличная от И2 в DESIGN.md (истинно межпроцессная, между
разными вкладками/устройствами — неразрешима без координирующего
сервиса, принята как остаточный риск). Внутрипроцессная гонка полностью
разрешима без координирующего сервиса — добавлен `handleDeviceAnnounceInFlight:
Map<key, Promise>` (`devices.js`), коалесцирующий одновременные вызовы с
одинаковым ключом в одно реальное выполнение.

## Этап 73.2 — харнесс multi-device (fake-relay.js)

Первый файл харнесса. Триаж 13a/13b: логика фильтрации по NIP-01
(`kinds`/`authors`/`#h`/`#p`) НЕ формализуется заново — переиспользуется
`matchFilters` из уже зависимого `nostr-tools` (`nostr-tools/lib/esm/filter.js`,
реэкспортируется из корня пакета), это готовый вычисленный примитив, не
собственная конструкция. Собственный, специально спроектированный кусок —
ТОЛЬКО очередь доставки с ручным управлением (см. ниже), поэтому контракт
фиксируется здесь явно перед вызовом воркера.

**Зачем очередь, а не мгновенная доставка на publish():** реальный relay
не гарантирует ни порядок, ни синхронность доставки между независимыми
соединениями — тесты 73.3+ должны уметь: (а) заставить два "устройства"
попытаться писать первыми ДО того, как любое из них увидело события
другого (М1/М2), (б) доставить событие, зависящее от продвижения эпохи,
РАНЬШЕ самого продвигающего commit'а (М3). Оба сценария требуют
контролируемой, а не автоматической доставки.

**Файл:** `tests/harness/fake-relay.js`

```js
import { matchFilters } from "nostr-tools";

export function createFakeRelay({ onDeliver }) { ... }
```

`onDeliver(connId, msgArray)` — вызывается ТОЛЬКО из `flushNext`/`flushAll`,
никогда синхронно из `publish`/`subscribe`. `msgArray` — один из:
`["EVENT", subId, event]`, `["EOSE", subId]`, `["OK", eventId, true, ""]`.

Возвращаемый объект — методы:

- `publish(connId, event) -> { ok: true }` — синхронно добавляет `event` в
  append-only лог (без валидации подписи — её создаёт продакшн-код
  `sign()`, харнесс ей не должен противоречить, но и не обязан
  перепроверять). Синхронно ставит в очередь: `["OK", event.id, true, ""]`
  → `connId` (публикующему), и `["EVENT", subId, event]` → КАЖДОЙ активной
  подписке (включая подписки самого `connId`, если фильтр совпал —
  реальный relay не отличает "своё" от "чужого"). Replaceable/addressable
  kind-семантика (kind 0/3/10000-19999/30000-39999 — держать только
  последнее по `created_at` на пару `(pubkey,kind[,#d])`) СОЗНАТЕЛЬНО НЕ
  реализована — не нужна для сценариев 73.2 (kind 443/444/445/446 —
  обычные). Если понадобится позже — отдельная задача, не тихо
  пропущенный кусок.
- `subscribe(connId, subId, filters)` — `filters` — МАССИВ фильтров (OR
  между элементами, ровно семантика `matchFilters`). Перезаписывает
  прошлую подписку с тем же `(connId,subId)`, если была (resubscribe).
  Синхронно ставит в очередь: `["EVENT", subId, event]` для КАЖДОГО уже
  сохранённого в логе события, совпавшего с фильтром, В ПОРЯДКЕ лога, ЗАТЕМ
  `["EOSE", subId]`.
- `unsubscribe(connId, subId)` — снимает подписку немедленно. Не влияет
  на уже стоящие в очереди доставки (см. ws-bridge — его забота не
  доставлять в закрытый сокет).
- `disconnect(connId)` — снимает ВСЕ подписки этого `connId` (обрыв сети).
- `pending() -> Array<{connId, subId, msg}>` — снимок текущей очереди,
  только для чтения/ассертов в тестах, не мутирует.
- `flushNext() -> boolean` — доставляет (вызывает `onDeliver`) ГОЛОВУ
  очереди (FIFO), удаляет её из очереди. `false`, если очередь пуста.
- `flushAll()` — `flushNext()` в цикле до опустошения (обычный путь для
  тестов, которым порядок безразличен — "сеть без искусственных
  сюрпризов").
- `reorder(compareFn)` — `Array.prototype.sort(compareFn)` НАД ТЕКУЩИМ
  снимком очереди (стабильная сортировка, не над будущими доставками) —
  прямой инструмент для адверсарных тестов на переупорядочивание (М3).

Тесты этапа — `tests/harness/fake-relay.test.js`, пишутся ДО реализации
(п.14 skill'а), из инвариантов выше: publish→OK доставляется
публикующему; publish уведомляет совпавшие подписки, не совпавшие — нет;
subscribe отдаёт историю в порядке лога + EOSE; unsubscribe/disconnect
гасят будущие доставки, но не влияют на уже поставленные в очередь;
`reorder`/`flushNext` дают точный контроль порядка; несколько фильтров
в одном `subscribe` — OR; несколько независимых `connId` не видят чужие
подписки друг друга при `pending()`/`disconnect`.

Реализовано, коммит `5e3f1d9`. 16/16 тестов, регрессия 1316/1316.

## Этап 73.2 — харнесс multi-device (ws-bridge.js)

Триаж: 13a (рутина — склейка `fake-relay.js` с реальным `ws`-сервером,
без нового нетривиального инварианта; протокол уже формализован выше).
`ws` добавлен как devDependency (не влияет на бюджет бандла — только
`tests/`, не импортируется прикладным кодом).

**Зачем реальный сокет, а не ещё один фейк:** устройства харнесса —
ОТДЕЛЬНЫЕ `child_process` (см. `device.js` ниже), между процессами нет
общей памяти — только реальный IPC/сеть. `createRelayConnection`
(`src/core/transport/relay-pool.js`) по умолчанию берёт
`globalThis.WebSocket` — в Node 24 это реальный нативный клиент, ничего
подменять в продакшн-коде НЕ требуется, только поднять реальный сервер
для него на loopback.

**Файл:** `tests/harness/ws-bridge.js`

```js
import { WebSocketServer } from "ws";

export function createWsBridge(relay, { port = 0 } = {}) { ... }
```

`relay` — уже сконструированный `createFakeRelay(...)`. Порядок
конструирования (chicken-and-egg с `onDeliver`, фиксирован здесь, чтобы
не путать воркера/сценарии): `onDeliver` фейк-relay'я — стрелочная
функция, замыкающая ПЕРЕМЕННУЮ `bridge`, объявленную через `let` ДО
создания relay и присвоенную ПОСЛЕ:

```js
let bridge;
const relay = createFakeRelay({ onDeliver: (connId, msg) => bridge.deliver(connId, msg) });
bridge = createWsBridge(relay, { port: 0 });
const { port } = await bridge.start();
```

Возвращаемый объект:

- `start() -> Promise<{ port }>` — поднимает `WebSocketServer`, резолвится
  после `"listening"` с РЕАЛЬНЫМ занятым портом (важно при `port:0` —
  эфемерный, ОС выбирает сама). На каждое новое соединение — свой
  `connId` (`"conn" + порядковый номер`, монотонный счётчик, НЕ
  переиспользуется после разрыва). Входящие сообщения (`JSON.parse`)
  диспетчеризуются буквально по типу первого элемента: `["EVENT",
  event]` → `relay.publish(connId, event)`; `["REQ", subId,
  ...filters]` → `relay.subscribe(connId, subId, filters)`; `["CLOSE",
  subId]` → `relay.unsubscribe(connId, subId)`. На разрыв сокета
  (`"close"`) → `relay.disconnect(connId)`.
- `stop() -> Promise<void>` — закрывает сервер, резолвится после
  фактического закрытия (колбэк `wss.close(cb)`, не мгновенно).
- `deliver(connId, msg)` — это и есть функция, которую снаружи
  оборачивают в `relay`'s `onDeliver` (см. пример выше). Ищет сокет по
  `connId`; если сокета уже нет ИЛИ он не в состоянии `OPEN` — тихо
  игнорирует (тот же best-effort принцип, что у продакшн-подписчиков:
  устройство отключилось между постановкой в очередь и flush — не
  ошибка харнесса). Иначе `ws.send(JSON.stringify(msg))`.

Автофлаша `relay` НЕТ — `ws-bridge.js` только маршрутизирует, НЕ решает
когда флашить очередь `relay`; это обязанность вызывающего сценария
(`scenario.js`, следующий файл) — вызывать `relay.flushAll()`/
`flushNext()`/`reorder()` в нужный момент теста. Сознательное решение:
если бы бридж автофлашил на каждый publish, адверсарные сценарии 73.3
(M1/M2 — нужно ЗАДЕРЖАТЬ доставку) стали бы невозможны без обхода
самого бриджа.

Тесты этапа — `tests/harness/ws-bridge.test.js`, ЧЕРЕЗ РЕАЛЬНЫЙ сокет
(глобальный `WebSocket`-клиент из Node 24, не мок): поднять
`bridge+relay` на `port:0`, подключиться реальным клиентом, отправить
`REQ`/`EVENT`/`CLOSE`, вызвать `relay.flushAll()`, проверить, что клиент
РЕАЛЬНО получил байты по сети (`ws.onmessage`). Разрыв соединения
клиентом → `relay`-подписки этого `connId` пропадают (проверяется
косвенно: следующий `publish` не порождает для него `pending`-записи).

Реализовано, коммит `7ec03f7`. 7/7 тестов, регрессия 1323/1323.
Найден и закрыт реальный баг устойчивости: `wss.close()` не завершает
уже открытые клиентские сокеты сам по себе (задокументированное
поведение `ws`) — без явного `ws.terminate()` перед `close()` один
незакрытый сокет вешал бы `stop()` навсегда.

## Этап 73.5 — детект расхождения (М6)

Полная формализация — DESIGN.md "М6"/"Реализация (73.5)". Расширяет
73.4 (буфер), новый протокольный инвариант не вводится.

**`src/core/store/table-fields.js`** — `MLS_GROUPS_PLAINTEXT_FIELDS`
дополняется (структурные метаданные диагностики, не содержание):
```js
export const MLS_GROUPS_PLAINTEXT_FIELDS = ["ownerPubkey", "groupId", "consecutiveDecryptFailures", "desynced"];
```
Db-версия НЕ бампается — оба поля НЕ индексируются, Dexie не требует
объявления схемы для неиндексируемых полей.

**`src/domain/messaging/chat.js`** — новая константа + 3 новых
экспорта (рядом с `getChatHistory`/`hasAnyMessagesFor`):
```js
const DESYNC_THRESHOLD = 3;

export async function recordGroupDecryptFailure(ownerPubkey, groupIdHex, dbKey) {
  const raw = await db.table("mlsGroups").get([ownerPubkey, groupIdHex]);
  if (!raw) return;
  const row = fromEncryptedRow(raw, dbKey);
  const consecutiveDecryptFailures = (row.consecutiveDecryptFailures ?? 0) + 1;
  await db.table("mlsGroups").put(
    toEncryptedRow({ ownerPubkey, groupId: groupIdHex, contactPubkey: row.contactPubkey, state: row.state, consecutiveDecryptFailures, desynced: consecutiveDecryptFailures >= DESYNC_THRESHOLD }, MLS_GROUPS_PLAINTEXT_FIELDS, dbKey),
  );
}

export async function listDesyncedChats(ownerPubkey, dbKey) {
  const rows = (await db.table("mlsGroups").where("ownerPubkey").equals(ownerPubkey).toArray()).map((r) => fromEncryptedRow(r, dbKey));
  return rows.filter((r) => r.desynced).map((r) => ({ contactPubkey: r.contactPubkey, groupId: r.groupId, consecutiveDecryptFailures: r.consecutiveDecryptFailures }));
}

export async function recreateChatConversation(ownerPubkey, contactPubkey, dbKey) {
  const groupIdHex = bytesToHex(computeGroupId(ownerPubkey, contactPubkey));
  await db.table("mlsGroups").delete([ownerPubkey, groupIdHex]);
  await db.table("knownContactDevices").where("[ownerPubkey+contactPubkey]").equals([ownerPubkey, contactPubkey]).delete();
}
```

`receiveGroupMessageEvent`'s существующий `put` (успешный приём —
единственная точка сброса) дополняется:
```js
toEncryptedRow({ ownerPubkey, groupId: groupIdHex, contactPubkey, state: serializeState(result.newSessionState), consecutiveDecryptFailures: 0, desynced: false }, MLS_GROUPS_PLAINTEXT_FIELDS, dbKey)
```

`sendMessage`'s существующий `put` — ПЕРЕНОСИТ (не сбрасывает, не
роняет) уже прочитанные значения из `row`:
```js
toEncryptedRow({ ownerPubkey, groupId: groupIdHex, contactPubkey: row.contactPubkey, state: serializeState(newSessionState), consecutiveDecryptFailures: row.consecutiveDecryptFailures ?? 0, desynced: row.desynced ?? false }, MLS_GROUPS_PLAINTEXT_FIELDS, dbKey)
```

**`src/domain/messaging/devices.js`** — `addSiblingToGroup` и
`addContactDeviceToGroup`'s `put`-вызовы, ТА ЖЕ логика переноса из уже
доступного параметра `group`:
```js
consecutiveDecryptFailures: group.consecutiveDecryptFailures ?? 0, desynced: group.desynced ?? false
```
(добавляется внутрь уже существующего объекта, передаваемого в
`toEncryptedRow`, оба места).

**`src/ui/signals/transport.js`** — `retryBufferedGroupMessages`'s TTL-
ветка (`else { console.warn(...) }`, "окончательно не расшифровано за
TTL, отброшено") дополняется вызовом:
```js
await recordGroupDecryptFailure(ownerPubkey, groupIdHex, dbKey);
```
Импорт `recordGroupDecryptFailure` добавляется к существующему импорту
из `chat.js`.

**`src/ui/screens/diagnostics.jsx`** — новая секция "Переписки"
(рутинная UI-правка, не формализуется здесь): список результатов
`listDesyncedChats(ownerPubkey, dbKey)` для текущего аккаунта, кнопка
"Пересоздать" на каждую строку → `recreateChatConversation(ownerPubkey,
contactPubkey, dbKey)`.

Тесты — `tests/chat.test.js` (юнит, `recordGroupDecryptFailure`/
`listDesyncedChats`/`recreateChatConversation`, порог, сброс на приём,
перенос при send/addSibling) + `tests/harness/m3-repro.test.js`
(расширение — добавить сценарий "TTL истёк без единого успеха 3 раза
подряд → desynced=true", переиспользует уже существующие
`pumpAllExcept`/`identifyNewConnId`).

## Этап 73.4 — буфер нерасшифрованных kind:445 (М3)

Полная формализация — DESIGN.md "М3"/"Реализация (73.4)". Единственная
затронутая точка — `groupMessageSubscriber`'s `onBatch`
(`src/ui/signals/transport.js`, рядом с `processedEventIds`/`isNewEvent`).

Новые модульные константы/структуры (там же, где `processedEventIds`):
```js
const pendingUndecryptedByGroup = new Map(); // groupIdHex -> Array<{event, firstSeenAt}>
const UNDECRYPTED_RETRY_TTL_MS = 5 * 60 * 1000;

function groupIdOf(event) {
  return event.tags.find((t) => t[0] === "h")?.[1];
}

function bufferUndecryptedEvent(event) {
  const groupIdHex = groupIdOf(event);
  if (!groupIdHex) return;
  const list = pendingUndecryptedByGroup.get(groupIdHex) ?? [];
  list.push({ event, firstSeenAt: Date.now() });
  pendingUndecryptedByGroup.set(groupIdHex, list);
}
```

Per-event тело ТЕКУЩЕГО `onBatch` (всё, что сейчас внутри `try {...}` —
`receiveGroupMessageEvent` → lamport tick → deletion/edit-маркер →
уведомление) выносится БЕЗ ИЗМЕНЕНИЙ построчно в новую функцию (та же
логика, просто переиспользуемая):
```js
async function processOneGroupMessageEvent(ownerPubkey, privKey, dbKey, publish, settings, event) {
  const receivedResult = await receiveGroupMessageEvent(ownerPubkey, privKey, dbKey, event, publish);
  if (receivedResult) await receiveLamportTick(ownerPubkey, receivedResult.lamportTs);
  const wasDeletion = await applyIncomingDeletionIfMarker(ownerPubkey, dbKey, event, receivedResult);
  const wasEdit = await applyIncomingEditIfMarker(ownerPubkey, dbKey, event, receivedResult);
  if (receivedResult && !wasDeletion && !wasEdit && !(await isChatContentRead(ownerPubkey, receivedResult.contactPubkey, receivedResult.lamportTs))) {
    await ensureProfilesFetched([receivedResult.contactPubkey], fetchProfiles).catch(() => {});
    const messageNavTarget = { screen: "messages", contactPubkey: receivedResult.contactPubkey };
    const newMsgTitleKey = "journal.newMessageTitle";
    const newMsgTitleParams = { username: usernameFor(receivedResult.contactPubkey) };
    await notifyAndLog(ownerPubkey, dbKey, settings, "messages", null, {
      title: t(newMsgTitleKey, newMsgTitleParams),
      body: receivedResult.text,
      titleKey: newMsgTitleKey,
      titleParams: newMsgTitleParams,
      navTarget: messageNavTarget,
      onClick: () => navigateFromNotification(messageNavTarget),
      occurredAt: event.created_at * 1000,
    }, receivedResult.contactPubkey);
  }
}
```

Ретрай буфера ОДНОЙ группы — однопроходный, вызывается ПОСЛЕ каждого
успешно обработанного kind:445 этой же группы:
```js
async function retryBufferedGroupMessages(groupIdHex, ownerPubkey, privKey, dbKey, publish, settings) {
  const list = pendingUndecryptedByGroup.get(groupIdHex);
  if (!list || list.length === 0) return false;
  let anySucceeded = false;
  const stillPending = [];
  for (const entry of list) {
    try {
      await processOneGroupMessageEvent(ownerPubkey, privKey, dbKey, publish, settings, entry.event);
      anySucceeded = true;
    } catch (e) {
      if (Date.now() - entry.firstSeenAt < UNDECRYPTED_RETRY_TTL_MS) {
        stillPending.push(entry);
      } else {
        console.warn("retryBufferedGroupMessages: событие окончательно не расшифровано за TTL, отброшено", entry.event.id, e);
      }
    }
  }
  if (stillPending.length > 0) pendingUndecryptedByGroup.set(groupIdHex, stillPending);
  else pendingUndecryptedByGroup.delete(groupIdHex);
  return anySucceeded;
}
```

`onBatch` (существующая функция, ПЕРЕПИСЫВАЕТСЯ на использование
вынесенных функций выше):
```js
onBatch: async (events) => {
  const settings = await loadUiSettings(ownerPubkey, dbKey);
  let activityChanged = false;
  for (const event of events) {
    if (!isNewEvent(event.id)) continue;
    try {
      await processOneGroupMessageEvent(ownerPubkey, privKey, dbKey, publish, settings, event);
      activityChanged = true;
      if (await retryBufferedGroupMessages(groupIdOf(event), ownerPubkey, privKey, dbKey, publish, settings)) {
        activityChanged = true;
      }
    } catch (e) {
      bufferUndecryptedEvent(event);
      console.warn("refreshGroupMessageSubscription: не удалось обработать входящее сообщение группы", event.id, e);
    }
  }
  if (activityChanged) bumpMessagingActivity();
},
```

Тесты — модульные функции (`bufferUndecryptedEvent`/
`retryBufferedGroupMessages`/`processOneGroupMessageEvent`) НЕ
экспортированы (внутренние детали `refreshGroupMessageSubscription`,
как и `processedEventIds`/`isNewEvent` уже сейчас) — тестируется ЧЕРЕЗ
публичное поведение подписчика. **Реализовано и верифицировано,
коммит после этой записи** — `tests/harness/m3-repro.test.js`
(харнесс, не `FakeWebSocket` — `transport.js` не грузится под голым
node без `node-loader.mjs`, см. "Этап 73.2 — device.js"): А1↔Боб
установлены, А2 (sibling) присоединяется, commit придержан для Боба
(`reorder`+`flushNext`), сообщение А2 под новой эпохой доходит РАНЬШЕ —
проваливается, буферизуется; после доставки commit'а восстанавливается
без дополнительного триггера. 3/3 стабильно, полная регрессия
1336/1336.

## Этап 73.3 — реализация И3 (единственный коммиттер)

Полная формализация — DESIGN.md "Этап 73" (И3, механизм, псевдокод A-Г,
расширение scope подписки, новая таблица). Здесь — точные сигнатуры для
диспетчеризации воркеру микрозадачами (п.6 skill'а).

**`src/domain/messaging/chat.js`** — новый экспорт:
```js
export function isCommitter(pubkeyHexA, pubkeyHexB) {
  return pubkeyHexA < pubkeyHexB; // лексикографически по hex, симметрично
}
```
`ensureChatEstablished` — ПЕРЕД строкой `const theirDevices = await
fetchDeviceKeyPackages(contactPubkey);` добавляется (ДВА гейта, И4
СТРОГО ПЕРЕД И3 — см. обоснование порядка в DESIGN.md "И4"):
```js
if (await hasAnyMessagesFor(ownerPubkey, contactPubkey)) {
  throw new DomainError("другое моё устройство уже разговаривало с этим контактом — жду синхронизации", "errors.awaitingSiblingSync", { contactPubkey });
}
if ((await isKnownContact(ownerPubkey, contactPubkey)) && !isCommitter(ownerPubkey, contactPubkey)) {
  throw new DomainError("ожидание установления переписки — коммиттер этой пары не я", "errors.awaitingCommitter", { contactPubkey });
}
```
**И4 (mirror-история)** — БЕЗУСЛОВНЫЙ, не зависит от `isKnownContact`
(mirror — прямое доказательство состоявшейся переписки, не косвенный
признак). Единственный способ иметь строки в `messages` БЕЗ локальной
`mlsGroups`-записи — зеркало (kind:446, этап 25) от ДРУГОГО устройства
ТОЙ ЖЕ identity — verified DESIGN.md "И4". Новая функция (рядом с
`getChatHistory`):
```js
export async function hasAnyMessagesFor(ownerPubkey, contactPubkey) {
  return (await db.table("messages").where("[ownerPubkey+chatId]").equals([ownerPubkey, contactPubkey]).count()) > 0;
}
```

**И3 (identity-committer)** — гейт применяется, ТОЛЬКО если contact УЖЕ
подтверждённый контакт (`isKnownContact`, `inbox-requests.js`, уже
существующий экспорт) — НАЙДЕНО ПРОВЕРКОЙ ПРОТИВ РЕАЛЬНЫХ тестов (не
домысел): без этого условия `inbox-signals.test.js`/`inbox-requests.test.js`
(STRANGER_PUB лексикографически БОЛЬШЕ ALICE_PUB) сломали бы холодное
обращение к незнакомцу — а восстановить его через реактивный канал
(ветка В ниже) НЕЛЬЗЯ, тот канал существует только для подтверждённых
контактов — получилось бы гарантированное зависание навсегда, хуже
устраняемого М1. Импорт `isKnownContact` добавляется в `chat.js` из
`./inbox-requests.js` — ЕДИНСТВЕННЫЙ импорт в обратную сторону
(`inbox-requests.js` уже импортирует `acceptWelcome` ИЗ `chat.js`) —
цикл импортов ДОПУСТИМ в ES-модулях (не CommonJS), но стоит явно
зафиксировать как сознательное решение, не случайность.
(`DomainError` уже импортирован в файле — правка НЕ трогает остальное
тело функции, остаётся путём коммиттера без изменений).

**Реализовано, коммит после 73.3/3 (см. log.md).** Харнесс
(m1-repro.test.js) подтвердил: 3/3 стабильно зелёный. Полная
регрессия 1335/1335, 0 todo.

Новые экспорты (рядом с `sendMessage`, та же ответственность — не
разносить по файлам). `drainPendingOutgoingMessages` ДОПОЛНИТЕЛЬНО
коалесцирует конкурентные/повторные вызовы (`drainInFlight: Map`,
ТОТ ЖЕ приём, что `handleDeviceAnnounceInFlight` в devices.js) —
НАЙДЕНО ХАРНЕССОМ (не домысел): Welcome может прийти повторно
(resubscribe-редоставка), без коалесцирования drain отправлял бы одно
и то же отложенное сообщение дважды (два разных `msgId`/`eventId`,
тот же текст/`lamportTs`):
```js
export async function enqueuePendingOutgoingMessage(ownerPubkey, dbKey, { contactPubkey, text, lamportTs, attachment }) {
  await db.table("pendingOutgoingMessages").put(
    toEncryptedRow({ ownerPubkey, contactPubkey, lamportTs, text, ...(attachment !== undefined ? { attachment } : {}) }, PENDING_OUTGOING_MESSAGES_PLAINTEXT_FIELDS, dbKey),
  );
}

export async function drainPendingOutgoingMessages(ownerPubkey, privKey, dbKey, contactPubkey, publish) {
  const raw = await db.table("pendingOutgoingMessages").where("[ownerPubkey+contactPubkey]").equals([ownerPubkey, contactPubkey]).sortBy("lamportTs");
  for (const encryptedRow of raw) {
    const row = fromEncryptedRow(encryptedRow, dbKey);
    await sendMessage(ownerPubkey, privKey, dbKey, contactPubkey, row.text, row.lamportTs, publish, row.attachment);
    await db.table("pendingOutgoingMessages").delete([ownerPubkey, contactPubkey, row.lamportTs]);
  }
}
```
Импорт `PENDING_OUTGOING_MESSAGES_PLAINTEXT_FIELDS` добавляется в
существующий импорт из `table-fields.js` (та же строка, что уже
импортирует `MLS_GROUPS_PLAINTEXT_FIELDS`/`MESSAGES_PLAINTEXT_FIELDS`).

**`src/core/store/table-fields.js`** — новый экспорт (рядом с
`CONTACT_RELATIONSHIPS_PLAINTEXT_FIELDS`, тот же стиль):
```js
export const PENDING_OUTGOING_MESSAGES_PLAINTEXT_FIELDS = ["ownerPubkey", "contactPubkey", "lamportTs"];
```

**`src/core/store/database.js`** — новая версия (после `db.version(21)`):
```js
// Этап 73.3 — И3 (единственный коммиттер): исходящие, накопленные
// проигравшей стороной, пока коммиттер не создал группу (DESIGN.md).
// Не шифруется целиком — НЕТ, шифруется (text — содержательное поле,
// тот же принцип, что messages) через toEncryptedRow/PENDING_OUTGOING_
// MESSAGES_PLAINTEXT_FIELDS выше — только ownerPubkey/contactPubkey/
// lamportTs остаются plaintext (составной индекс).
db.version(22).stores({
  pendingOutgoingMessages: "[ownerPubkey+contactPubkey+lamportTs], [ownerPubkey+contactPubkey]"
});
```

**`src/ui/signals/chats.js`** — `sendChatMessageAction` оборачивает
вызов `ensureChatEstablished` в try/catch:
```js
export async function sendChatMessageAction(ownerPubkey, privKey, dbKey, contactPubkey, text, lamportTs, publish, fetchDeviceKeyPackages, refreshGroupMessageSubscription, attachment) {
  try {
    await ensureChatEstablished(ownerPubkey, privKey, dbKey, contactPubkey, publish, fetchDeviceKeyPackages);
  } catch (e) {
    if (!e.key?.startsWith("errors.awaiting")) throw e;
    // "errors.awaitingSiblingSync" (И4) и "errors.awaitingCommitter" (И3) —
    // ДВЕ разные причины ждать, ОДИНАКОВАЯ реакция вызывающего кода: очередь
    // + один и тот же статус для UI (обе означают "переписка устанавливается",
    // различать причину пользователю не нужно — key внутри DomainError
    // остаётся для диагностики/логов, не для UI-текста).
    await enqueuePendingOutgoingMessage(ownerPubkey, dbKey, { contactPubkey, text, lamportTs, attachment });
    return { status: "awaiting_committer" };
  }
  await refreshGroupMessageSubscription(ownerPubkey, privKey, dbKey, publish);
  return sendMessage(ownerPubkey, privKey, dbKey, contactPubkey, text, lamportTs, publish, attachment);
}
```
Импорт `enqueuePendingOutgoingMessage` добавляется к существующему
импорту из `chat.js` в этом файле.

**`src/domain/messaging/devices.js`** — ДВЕ ветки, НЕ одна (уточнение
после 73.3/3 — план ниже был написан ДО реализации, статус каждой
ветки указан явно):

**(а) Контактная ветка, СЛУЧАЙ "группа УЖЕ существует" — РЕАЛИЗОВАНО,
коммит после 73.3/3.** Найдено харнессом (m1-repro.test.js, не
домысел, см. DESIGN.md "Итог 73.3/3", находка 2): без этого гейта Боб
мог параллельно с sibling-add А1 коммитить СВОЁ добавление устройства
контакта — два коммита в одну эпоху, М2. Добавлена ОДНА строка перед
существующей веткой (`if (!groupRaw) return;` не тронута):
```js
const contactPubkey = announcerPubkey;
if (!isCommitter(ownerPubkey, contactPubkey)) return; // я не коммиттер пары — не коммичу вообще ничего в эту группу
const groupIdHex = bytesToHex(computeGroupId(ownerPubkey, contactPubkey));
const groupRaw = await db.table("mlsGroups").get([ownerPubkey, groupIdHex]);
if (!groupRaw) return;
```
Импорт `isCommitter` добавлен к существующему импорту `computeGroupId`
из `chat.js`.

**(б) Контактная ветка, СЛУЧАЙ "группы ещё вовсе нет" (`if (group ===
undefined)`, проактивное создание коммиттером) — НЕ РЕАЛИЗОВАНО в
73.3/3.** m1-repro.test.js её не требует (там группа у Боба УЖЕ есть
через A1, восстановление А2 идёт через sibling-sync, не через эту
ветку) — план ниже остаётся АКТУАЛЬНЫМ для отдельной, ещё не начатой
задачи: истинно первый контакт между ДВУМЯ РАЗНЫМИ identity, ни у одной
ещё нет группы (M2's исходная, межидентичная форма).
```js
if (group === undefined) {
  if (!isCommitter(ownerPubkey, contact)) return; // я не коммиттер — жду Welcome
  try {
    await ensureChatEstablished(ownerPubkey, privKey, dbKey, contact, publish, fetchDeviceKeyPackages);
    await refreshGroupMessageSubscription(ownerPubkey, privKey, dbKey, publish);
    await drainPendingOutgoingMessages(ownerPubkey, privKey, dbKey, contact, publish);
  } catch (e) {
    console.warn("handleDeviceAnnounce: не удалось проактивно создать группу", contact, e);
  }
  return;
}
```
Требует добавить параметры `fetchDeviceKeyPackages`,
`refreshGroupMessageSubscription` в сигнатуру `handleDeviceAnnounce` —
у него их СЕЙЧАС нет (см. существующую сигнатуру в файле). Импорты
`ensureChatEstablished`, `drainPendingOutgoingMessages` понадобятся
дополнительно к уже добавленному `isCommitter`.

**`src/ui/signals/transport.js`** — ТРИ точечные правки, СТАТУС РАЗНЫЙ:

1. **НЕ РЕАЛИЗОВАНО (часть "случая б" выше).** `refreshGroupMessageSubscription`'s
   источник `contactPubkeys` для `deviceAnnounceSubscriber`'s фильтра
   меняется с `[...new Set(groupRows.map(row => row.contactPubkey))]`
   на объединение с подтверждёнными контактами:
   ```js
   const confirmedContacts = (await db.table("contactRelationships").where({ owner: ownerPubkey, state: "CONTACT" }).toArray()).map((r) => r.peer);
   const contactPubkeys = [...new Set([...groupRows.map((row) => row.contactPubkey), ...confirmedContacts])];
   ```
2. **НЕ РЕАЛИЗОВАНО (часть "случая б").** Вызов `handleDeviceAnnounce(...)`
   в `deviceAnnounceSubscriber`'s `onBatch` дополняется двумя новыми
   аргументами (`fetchDeviceKeyPackages`, `refreshGroupMessageSubscription`).
3. **РЕАЛИЗОВАНО, коммит после 73.3/3.** В giftwrap-диспетчере, СРАЗУ
   после существующего `await refreshGroupMessageSubscription(pubkeyHex,
   privKey, dbKey, publish);` (ветка `rumor.kind === 444`, ПОСЛЕ
   успешного `if (isSibling || isKnownContact...)`) добавлено:
   ```js
   await drainPendingOutgoingMessages(pubkeyHex, privKey, dbKey, welcomeContactPubkey, publish);
   ```
   Импорт `drainPendingOutgoingMessages` добавлен к существующему
   импорту из `chat.js` в этом файле. Это ЕДИНСТВЕННАЯ точка drain,
   нужная для И4 (sibling-Welcome от собственного другого устройства) —
   она же закрыла бы и И3's "случай б" (Welcome от коммиттера-контакта),
   когда та ветка будет реализована — код после приёма Welcome
   идентичен для обоих случаев (см. DESIGN.md "И4").

Порядок применения фактически реализованной части (правки 73.3/3, все
писались Claude напрямую, не через `./worker.sh` — по тому же
обоснованию, что 73.3/2: протокольно-критичные файлы, риск 3 впустую
потраченных воркер-итераций выше цены написать самому): table-fields.js
→ database.js → chat.js (`isCommitter`/`hasAnyMessagesFor`/двойной
гейт/enqueue-drain+коалесцирование) → chats.js (обобщённый catch) →
devices.js (гейт коммиттера в контактной ветке, случай "а") →
transport.js (правка 3, drain после Welcome). Каждый шаг — тесты
зелёные до перехода к следующему (регрессия накоплением, п.18) —
финально верифицировано харнессом (m1-repro.test.js, 3/3), полная
регрессия 1335/1335.

## Этап 73.2 — харнесс multi-device (device.js)

Триаж: ПОГРАНИЧНЫЙ случай, решён в пользу 13b (записка) не из-за
сложности алгоритма, а потому что корректная последовательность вызовов
продакшн-функций найдена ТОЛЬКО чтением кода transport.js/chats.js/
ui-settings.js построчно — неочевидна и легко перепутывается (в т.ч.
самим Claude, потребовалось прямое чтение исходников, а не догадка).
Зафиксировано здесь буквально, чтобы не передоказывать заново. Файл
писался Claude напрямую, не через `./worker.sh` — осознанное решение
(не молчаливое нарушение п.15 skill'а): оба предыдущих файла харнесса
(`fake-relay.js`, `ws-bridge.js`) потребовали от воркера 1 попытки со
структурным браком каждый (synatx error; рекурсивный self-call с
переменными вне области видимости) даже на существенно более простых
задачах — device.js требует буквально точных ~10 путей импорта и
порядка аргументов продакшн-кода одновременно, что для слабой 7b-модели
выше её продемонстрированного на этом этапе потолка; риск потратить
3 итерации впустую (правило 9) выше стоимости написать самому.

**Зачем реальные продакшн-функции, а не свой мини-клиент:** харнесс
существует ЧТОБЫ ловить баги реального пути `ensureConnected` →
`sendChatMessageAction` → `handleDeviceAnnounce` и т.д. — переписанный
"по мотивам" клиент проверял бы себя, не приложение.

**Обязательный порядок вызовов (найдено чтением, не домысел):**
`ensureConnected` (`transport.js:602`) читает relay-список ИСКЛЮЧИТЕЛЬНО
из локального `uiSettings` (`loadUiSettings`, `ui-settings.js:126`); при
ОТСУТСТВИИ локальной записи (`hasLocalUiSettings` — `false`) она ДО
дефолта пытается bootstrap-обнаружение через `BUILD_BOOTSTRAP_RELAYS`
(реальные адреса из конфигурации сборки) — недопустимо для харнесса
(попытка выйти в сеть/поймать таймаут, плюс риск обнаружить НЕ
харнессный relay). Поэтому `uiSettings.relayUrls` ОБЯЗАН быть
предварительно засеян ДО `ensureConnected`, самой продакшн-функцией
`saveUiSettings` (`ui-settings.js:158`) с no-op-заглушкой publish —
ровно то же самое исключение, которым сама `connect()` пользуется в
строке 256 (`publisher ещё не создан на этот момент connect()`).

**Файл:** `tests/harness/device.js` — точка входа дочернего процесса
(`child_process.fork()`), запускается напрямую как скрипт, НЕ
экспортирует функции — общается с родителем только через `process.send`/
`process.on('message')` (встроенный IPC `fork()`, не свой протокол).

Формат запроса от родителя: `{ id, cmd, args }`. Формат ответа:
`{ id, ok: true, result }` либо `{ id, ok: false, error: String(e) }` —
`id` ОБЯЗАН совпадать с запросом (родитель сопоставляет по нему, команды
могут в принципе прийти внахлёст, хотя `scenario.js` их не шлёт
параллельно на один device — не полагаться на это внутри `device.js`).
Команды выполняются последовательно в порядке получения (`for await`
на очереди или просто `await` внутри `process.on('message', async ...)`
с внутренней FIFO-сериализацией — реальная вкладка браузера тоже
однопоточна, гонки должны идти ЧЕРЕЗ relay, не через порядок IPC).

Поддерживаемые `cmd`:

- `init({ privKeyHex, relayUrl })` → `{ ownerPubkey }`. Эффект: `privKey
  = hexToBytes(privKeyHex)`; `ownerPubkey = bytesToHex(getPublicKey(privKey))`
  (`src/core/crypto/keys.js`); `dbKey = deriveDbKey(deriveMasterSecret(privKey))`
  (`src/core/crypto/derivation.js`); `await db.open()` (`fake-indexeddb/auto`
  импортирован МОДУЛЬНЫМ верхним `import` файла — обязан выполниться до
  первого обращения к `db`, изоляция бесплатна — отдельный `child_process`
  = отдельный процесс = отдельный `globalThis.indexedDB`, ничего чистить
  вручную не нужно, в отличие от юнит-тестов с общим fake-indexeddb);
  `await saveUiSettings(ownerPubkey, privKey, dbKey, { relayUrls: [{ url:
  relayUrl, read: true, write: true }] }, async () => ({ ok: true }))`.
- `connect()` → `{}`. Эффект: `await ensureConnected(ownerPubkey, privKey, dbKey)`
  (`transport.js`) — это и есть полный продакшн-бутстрап (профиль,
  контакты, MLS-группы, permissions, relay-листы — ВСЁ, что делает
  реальная вкладка при входе, без UI).
- `send({ contactPubkey, text })` → `{ lamportTs }`. Эффект: `const
  lamportTs = await nextLamportTick(ownerPubkey)` (`transport.js:740`);
  `await sendChatMessageAction(ownerPubkey, privKey, dbKey, contactPubkey,
  text, lamportTs, (event) => publishToContact(event, contactPubkey),
  fetchDeviceKeyPackages, refreshGroupMessageSubscription)` — буквально
  тот же вызов, что `chat.jsx:588` (`publishToChatPartner` инлайнится как
  стрелочная функция, без отдельного враппера — семантически идентично).
- `history({ contactPubkey })` → `Array<row>`. Эффект: `return await
  getChatHistory(ownerPubkey, contactPubkey, dbKey)` (`chat.js:338`) —
  основной канал наблюдения для тестов 73.3 (видит ли устройство B
  сообщение, отправленное устройством A — прямое, не через MLS-
  внутренности, наблюдаемое поведение).

## Этап 73.3 — М1 воспроизведён (красный тест, todo)

`tests/harness/m1-repro.test.js` — первый пункт 73.3 (перенесён из
73.2's изначального DoD, см. PLAN.md). Отдельный файл, не расширение
`device.test.js` (73.2's happy-path остаётся отдельным, стабильным
доказательством, что харнесс работает — М1-тест по конструкции
адверсарный и должен падать до И3).

Два новых test-local хелпера (пока НЕ вынесены в `scenario.js` —
YAGNI, см. решение по 73.2's scenario.js: выносятся, когда
понадобятся третий раз, не раньше):

- `identifyNewConnId(relay, triggerFn)` — запускает `triggerFn()` (IPC-
  вызов, открывающий НОВЫЙ сокет, например `device.call("connect")`)
  ДО старта откачки очереди — первая же новая запись в `relay.pending()`
  (диф со снимком connId "до") принадлежит именно этому сокету.
  `ws-bridge.js` не отдаёт connId напрямую (не часть его контракта) —
  этот приём достаточен, без правки уже протестированного файла.
- `pumpAllExcept(relay, holdBackFn)` — циклический `reorder()`+
  `flushNext()`, доставляющий ВСЁ, КРОМЕ записей, где `holdBackFn(p)`
  истинно (держит их в очереди сколь угодно долго) — прямое
  применение `fake-relay.js`'s "инструмент для адверсарных тестов на
  переупорядочивание" (см. его контракт выше) к КОНКРЕТНОЙ гонке М1:
  придерживает ТОЛЬКО kind:443-уведомления, адресованные Бобу, оставляя
  вообще все остальные нужды (включая ВСЁ, что нужно самому новому
  устройству Алисы) свободно проходить — не блокирует "лишнего",
  моделирует РОВНО тот один провод, который в реальности медленнее
  остальных (Боб узнаёт о новом устройстве Алисы чуть позже, чем оно
  успевает написать первое сообщение).

**Сценарий:** Боб + два устройства ОДНОЙ Алисы (A1, A2 — отдельные
`child_process`, общий `privKeyHex`, разные device-id по природе
изоляции процессов). A1↔Боб устанавливаются штатно (доказанный 73.2's
путь), Боб получает "hello от A1". Затем A2 инициализируется и
немедленно пишет Бобу, пока его kind:443-анонс придержан. Проверка в
два шага: (а) во время гонки Боб видит только 1 сообщение (ожидаемо
всегда, не спорно); (б) КЛЮЧЕВАЯ проверка — ПОСЛЕ отпускания
придержанного (Боб узнаёт про A2 постфактум) история ВСЁ РАВНО
остаётся на 1, а не становится 2 — это и есть М1: не задержка,
постоянная потеря. Тест помечен `{ todo: "..." }` (node:test) — падает
осознанно (`assert.equal(final.length, 2, ...)` красный на текущем
коде), но НЕ роняет общий прогон (`fail 0`, `todo 1`, exit code 0) —
регрессия для остального кода остаётся честно зелёной. Definition of
Done для 73.3 включает снятие `todo` и получение зелёного здесь.

Живые находки при запуске (уже описаны в log.md как Х1/Х2, этап 73.2):
"Add proposal for someone already in the group" и "invalid MAC" —
ВТОРОЕ ("invalid MAC", не "Desired gen in the past") здесь особенно
показательно: Боб пытается расшифровать kind:445 от A2 СВОИМ
существующим состоянием группы (с A1) — ключи полностью не совпадают
(A2's независимая ветка), не просто "устаревшая эпоха" — прямое
эмпирическое подтверждение формализации И3 в DESIGN.md ("два
непересекающихся зашифрованных потока под одним тегом").

- `becomeContact({ peerPubkey })` → `{}`. Эффект: прямая запись в
  `contactRelationships` (`state: "CONTACT"`, минуя реальный протокол
  заявок CONTACTS-FSM.md) — ТОТ ЖЕ уровень допущения, что уже
  используют существующие юнит-тесты, сеющие состояние напрямую, когда
  сам протокол заявок не является предметом теста. НАЙДЕНО ПРИ ПЕРВОМ
  ПРОГОНЕ 73.2's DoD-теста (не домысел): без "CONTACT" `isKnownContact()`
  отклоняет автопринятие Welcome (DESIGN.md, "Этап 25" §4, AC-IB-01) —
  он уходит в `inboxRequests`, получатель НИКОГДА не создаёт
  `mlsGroups`/не подписывается на `kind:445`, что выглядело бы как
  "сообщение пропало", но было ОЖИДАЕМЫМ поведением при неустановленных
  контактах, не багом синхронизации.

Явно НЕ реализовано в 73.2 (нет текущего теста, которому это нужно —
не тихий пробел, а YAGNI-решение, расширяется по факту потребности
73.3): `disconnect`/`goOffline`, интроспекция `mlsGroups` напрямую.

Тесты этапа — `tests/harness/device.test.js`: интеграционный, поднимает
`fake-relay`+`ws-bridge`, форкает 2 реальных `device.js`-процесса (Алиса,
Боб), проводит `init`→`connect`→`send`(Алиса→Боб)→`history`(Боб) с
`relay.flushAll()` между шагами (без адверсарного переупорядочивания —
это "счастливый путь", подтверждающий, что вся цепочка вообще работает
END-TO-END через реальный IPC+сокет+продакшн-код, ПЕРЕД тем как 73.3
начнёт целенаправленно ломать тайминг). DoD — Боб видит сообщение Алисы
в `history()` без ручной перезагрузки/повторного `connect()`.

## Этап 73.2 — харнесс multi-device (scenario.js)

Триаж: 13a (рутина — IPC request/response корреляция, решённый паттерн).
Сознательное УПРОЩЕНИЕ относительно исходного черновика DESIGN.md
"Харнесс (73.2)" (там был эскизный DSL с `spawnIdentity(n)`/`goOnline`/
`goOffline`/`assertHistoryConverges`) — YAGNI: у 73.2 нет теста, которому
нужна эта обёртка целиком, `goOffline` не имеет смысла без ещё не
написанного `device.js`'s `disconnect`. `scenario.js` в 73.2 —
МИНИМАЛЬНЫЙ примитив `spawnDevice()`, DSL-сахар (goOnline/goOffline/
assert-хелперы) добавляется В 73.3 по факту конкретного теста М1, не
угадывается заранее.

**Файл:** `tests/harness/scenario.js`

```js
export function spawnDevice() { ... }
```

Возвращает `{ call(cmd, args) -> Promise<result>, kill(), process }`.
`call` форкает `device.js` (`child_process.fork`, ленивый — ОДИН раз при
первом обращении, либо синхронно при `spawnDevice()`, реализация
выбирает) один раз на объект, шлёт `{id, cmd, args}` (монотонный `id`),
резолвит/реджектит по ответному `{id, ok, result|error}` (см. контракт
`device.js` выше — оба конца одного протокола, определены СИНХРОННО в
одной задаче, не порознь). Ответ с `ok:false` → `call()` реджектится
`Error(error)` (переносит `String(e)` из дочернего процесса как текст
ошибки — стек теряется намеренно, дочерний процесс — чёрный ящик по
дизайну, важен факт и сообщение ошибки, не трасса). `kill()` —
`child.kill()`, для очистки после теста/сценария (в `t.after`).

## Этап 74 — Часть A (T1–T3), исправление доставки multi-device

Внешний диагноз (Claude Fable, `PROCESS-DOCS/TZ-MULTIDEVICE-FIX.md`) —
перепроверен чтением main, RC-1/RC-2 подтверждены буквально
(`chat.js:410,421` — жёсткий `senderPubkey: contactPubkey`;
`chat.js:65-72` — `upsertMessage` first-writer-wins), RC-3 подтверждён
отсутствием `navigator.locks`/`SharedWorker`/leader election в коде.
Открывает 73.6 как кандидата — эта запись закрывает T1–T3, задачи T4
и Часть B/C — отдельные последующие сессии (см. PLAN.md).

### T1 — senderPubkey внутри MLS-payload

Контракт `messagePayload` (внутри MLS, `chat.js`'s `sendMessage`):
было `{text, lamportTs, msgId, sentAt}`, стало
`{text, lamportTs, msgId, sentAt, senderPubkey}` — аддитивное поле,
едет ВНУТРИ MLS-шифртекста (не видно на проводе, метаданные не
утекают). `senderDeviceId` НЕ добавляется — идентичность устройства
не нужна для направления и была бы лишним раскрытием состава
устройств контакту внутри 1:1.

Приём (`receiveGroupMessageEvent`): вместо жёсткого
`senderPubkey: contactPubkey` —
`const senderPubkey = parsed.senderPubkey === ownerPubkey ? ownerPubkey : contactPubkey;`
Нормализация к одному из двух легальных значений (1:1-группа — других
identity нет), НЕ сырое `parsed.senderPubkey` — третье значение в
payload — мусор/спуфинг, сводится к `contactPubkey`. Старый формат
(payload без `senderPubkey`, исторические сообщения при catch-up) →
`contactPubkey` (обратная совместимость: `parsed.senderPubkey ===
ownerPubkey` ложно для `undefined`, ветка отрабатывает сама, без
отдельной проверки на существование поля). Тот же вычисленный
`senderPubkey` идёт в `mirrorBestEffort` (было — второй экземпляр той
же жёсткой константы).

**Известное ограничение (L-1, → DESIGN.md):** `senderPubkey` в payload
аутентифицирован MLS лишь как "отправитель — участник группы", не как
"отправитель — именно тот, кем себя назвал". Контакт технически может
пометить своё сообщение как ваше — оно отрисуется исходящим в вашей
ленте. Конфиденциальность/подлинность членства не нарушаются, это
UI-спуфинг внутри 1:1. Устраняется, когда ts-mls раскроет leaf-индекс
отправителя application-сообщений (после `2.0.0-rc.14`); тогда сверять
с credential `pubkey:deviceId` листа вместо доверия payload.

**Известное ограничение (L-2, → DESIGN.md):** исторические сообщения
от sibling-устройств со старым payload при повторном catch-up живым
путём атрибутируются по-старому (contact) — корректируются T3's
зеркальной веткой ремонта, не отдельной миграцией.

### T2 — withGroupLock (единственный писатель MLS-состояния)

Новый модуль `src/core/store/mls-lock.js`:

```js
export function withGroupLock(ownerPubkey, groupIdHex, fn)
```

`name = "mls:" + ownerPubkey + ":" + groupIdHex` →
`navigator.locks.request(name, fn)`, fallback (нет `navigator.locks` —
тестовая среда node/jsdom) — in-process mutex, карта `name -> promise`-
цепочка, тот же приём, что `drainInFlight` (`chat.js`)/
`handleDeviceAnnounceInFlight` (`devices.js`). Fallback НЕ даёт
межвкладочной гарантии (L-3, → DESIGN.md) — задокументировано в шапке
модуля. Инвариант и полное правило нереентерабельности — DESIGN.md
"Этап 74" (13b).

Обёрнуты ЦЕЛИКОМ (захват — перед `db.table("mlsGroups").get(...)`,
освобождение — после `put`):
- `chat.js`: `sendMessage`, `receiveGroupMessageEvent`,
  `recordGroupDecryptFailure`, `acceptWelcome`, `ensureChatEstablished`.
- `devices.js`: `addSiblingToGroup`, `addContactDeviceToGroup` —
  ОБЕ функции внутри лока ПЕРЕЧИТЫВАЮТ строку `mlsGroups` по
  конкретному `groupId` заново (не доверяют объекту `group`,
  переданному вызывающим кодом из bulk-`toArray()`, сделанного ДО
  захвата лока — см. DESIGN.md).

НЕ обёрнуты (правило нереентерабельности, Web Locks не
реентерабелен): `drainPendingOutgoingMessages` (вызывает
`sendMessage` — лочится только внутренний уровень) и
`handleDeviceAnnounce`/`syncDeviceMembership` (вызывают
`addSiblingToGroup`/`addContactDeviceToGroup` — лочится только
внутренний уровень; их собственная `*InFlight`-коалесценция —
отдельный, более грубый, ключ по `deviceId`, не заменяет
`withGroupLock`, а сосуществует с ним).

### T2.3 — processedGroupEvents (межвкладочная дедупликация событий)

Новая таблица, `db.version(23)` (`database.js`):

```js
db.version(23).stores({
  processedGroupEvents: "[ownerPubkey+eventId], [ownerPubkey+firstSeenAt]"
});
```

`PROCESSED_GROUP_EVENTS_PLAINTEXT_FIELDS = ["ownerPubkey", "eventId",
"firstSeenAt"]` (`table-fields.js`) — все поля индексно-плоские,
`eventId` уже публичен на relay, шифровать нечего; `toEncryptedRow`
всё равно применяется для единообразия со всеми таблицами проекта
(прецедент `OUTBOX_PLAINTEXT_FIELDS`/`JOURNAL_ENTRIES_PLAINTEXT_FIELDS`).

Гейт в начале `receiveGroupMessageEvent`, ВНУТРИ `withGroupLock`,
ПЕРЕД крипто: `has([ownerPubkey, eventId])` → тихий `return null`.
Запись — ПОСЛЕ успешной обработки, тем же локом. TTL/очистка — по
прецеденту `pendingUndecryptedByGroup`/`UNDECRYPTED_RETRY_TTL_MS`
(`transport.js:166-167`, 5 минут, проверка при каждой возможности, не
таймер): при каждой записи новой строки — sweep строк этого
`ownerPubkey` старше TTL (по индексу `[ownerPubkey+firstSeenAt]`),
таблица не растёт неограниченно без scheduled-задачи.

### T3 — ремонт зеркалом (upsertMessage)

Правка контракта: `upsertMessage(row, dbKey, source = "live")` —
аддитивный 3-й параметр, старые вызовы без изменений (`source` по
умолчанию `"live"`). При `ConstraintError` (строка с этим `msgId` уже
есть): если `source === "mirror"` и `senderPubkey` входящей строки
отличается от уже сохранённого — перезаписывается ТОЛЬКО поле
`senderPubkey` существующей строки, остальные поля нетронуты. Живой
путь (`source === "live"`, значение по умолчанию) существующие строки
НЕ корректирует — иначе форджибл-payload из T1 (см. L-1) получил бы
право переписывать историю чужим `senderPubkey`. Зеркало авторитетнее
для атрибуции: пишет его само устройство-отправитель под ключом,
выводимым из `privKey` владельца — подделать может только владелец
identity.

Вызовы `buildMirroredMessageRow` → `upsertMessage` в
`syncMirroredHistory`/`refreshLiveMirrorSubscription` (`transport.js`)
передают `source: "mirror"`. Исторический catch-up зеркал при первом
запуске после обновления чинит испорченные RC-1/RC-2 строки без
отдельной миграции.

### T1.4 — вердикт (UI-инвариант направления)

Проверено (`grep` по `src/ui/screens/chat.jsx`, `src/ui/signals/chat.js`,
`src/ui/signals/chats.js`, `src/ui/components/message-bubble.jsx`):
направление определяется РОВНО в одном месте —
`src/ui/screens/chat.jsx:801`, `const isOwn = message.senderPubkey ===
ownerPubkey;` — уже единственный источник истины, других мест
(сравнение с `chatId`, флаг "отправлено в этой сессии" и т.п.) не
найдено. `MessageBubble` (`message-bubble.jsx`) получает готовый
`isOwn` пропом, сама direction не вычисляет. Правок не требуется.

## Этап 74 — Часть B (T5–T7): синхронизация профилей

Диагноз P-1..P-4 (`TZ-MULTIDEVICE-FIX.md`) перепроверен чтением main —
подтверждён буквально: `fetchProfiles` (`transport.js:799-831`) копит
`results.set(event.pubkey, parsed)` в порядке прибытия внутри одного
REQ+EOSE (multi-relay pool — разные версии одного kind:0 в одном REQ);
`refreshLiveProfileSubscription`'s onBatch (`transport.js:892-923`) —
`next[event.pubkey] = parsed`, `isNewEvent` дедуплицирует только ПОВТОР
того же event.id, не версии; `refreshProfiles`
(`contacts.js:213-221`) безусловно перезаписывает. `profiles = signal({})`
(`contacts.js:26`) нигде не персистится. `hydrateOwnProfile`
(`domain/identity/profile.js:69-83`) обновляет только `avatarUrl`, не
`avatar` (`sidebar-profile-card.jsx`/`profile.jsx` рендерят
`avatar || avatarUrl`). `refreshLiveProfileSubscription` подписана на
`authors: contactPubkeys` — `ownerPubkey` туда не входит.

### Изменение контракта `fetchProfiles` (аддитивное)

Возвращает `Map<pubkey, {name?, about?, picture?, createdAt, id}>` —
было `{name?, about?, picture?}`. `createdAt`/`id` — от исходного kind:0
события (`event.created_at`/`event.id`), нужны вызывающему коду для LWW-
сравнения против уже закэшированного. `parseProfileEvent` (profile.js)
НЕ меняется (чистый парсинг `content`) — обогащение делается в
вызывающем коде (`fetchProfiles`, `refreshLiveProfileSubscription`).
Внутри `fetchProfiles`'s onBatch — тот же LWW-гейт (`isNewerVersion`,
см. ниже) применяется при накоплении в `results` (несколько версий
ОДНОГО pubkey в ОДНОМ REQ — реальный сценарий multi-relay pool, не
домысел, прямая цитата диагноза).

### `core/sync/lww.js` — T7, новый экспорт

```js
export function isNewerVersion(incoming, stored)
```

`incoming`/`stored` — `{createdAt, id}`-подобные объекты (кэш-строки,
camelCase — отличие от nostr-событий, где `created_at`/`id`).
`stored` может быть `null`/`undefined` (кэша ещё нет) → `true`
безусловно. Иначе — адаптирует к существующему `lwwWinner({created_at,
id})` (снейк-кейс), не дублирует логику сравнения. Единственная
реализация LWW-сравнения версий в проекте (skill: "запрещено вводить
вторую реализацию") — все профильные пути (T5.1) и живой own-путь
(T6.2, через `hydrateOwnProfile`/`pickLatest`, которая уже реализует
тот же инвариант по построению — `pickLatest = reduce(lwwWinner)`)
используют её же/`lwwWinner`, не пишут сравнение заново.

### `profiles.value[pk]` — аддитивное поле `createdAt` (+`id`)

Кэш профилей контактов (`contacts.js`'s `profiles` signal) — записи
получают `createdAt`/`id` рядом с `name`/`about`/`picture`. Все
существующие читатели сигнала обращаются к `.name`/`.about`/`.picture`
точечно (не `deepEqual` на весь объект, проверено чтением
UI-компонентов) — лишние поля не ломают рендер.

### Новая таблица `contactProfiles` (T5.2), `db.version(24)`

```js
db.version(24).stores({
  contactProfiles: "[ownerPubkey+contactPubkey], ownerPubkey"
});
```

`CONTACT_PROFILES_PLAINTEXT_FIELDS = ["ownerPubkey", "contactPubkey"]`
— ТОЛЬКО составной индекс и обратный `ownerPubkey`-скан (гидратация
всех профилей при старте) остаются plaintext; `name`/`about`/`picture`/
`createdAt`/`id` — зашифрованы `dbKey` через `toEncryptedRow`.

Решение по прецеденту `contacts`/`contactRelationships` (задача — по
тексту ТЗ): `contactRelationships` (`db.version(15)`) шифрует РОВНО ОДНО
содержательное поле (`greeting`), остальное (`owner`/`peer`/`state`/
`resolvedAt`/`sentAt`) — plaintext, потому что это структурные индексы,
не потому что несущественно. Здесь ЕСТЬ реальные содержательные поля
(`name`/`about`/`picture`) сверх составного ключа — по принципу
"индексные поля plaintext, содержательные зашифрованы" (тот же, что
`MLS_GROUPS_PLAINTEXT_FIELDS`, `PENDING_OUTGOING_MESSAGES_PLAINTEXT_FIELDS`
и большинство таблиц проекта) они шифруются. `contactPubkey` в
составном ключе НЕИЗБЕЖНО plaintext (нужен для `.get([owner,contact])`/
`.where("ownerPubkey")`) — тот же неизбежный компромисс, что `peer` в
`contactRelationships` и `contactPubkey` НЕ в составном ключе `mlsGroups`
(там он зашифрован именно потому, что НЕ часть индекса). Итог: состав
графа контактов technically читаем по ownerPubkey-скану ЛЮБОЙ таблицы с
таким индексом в проекте (уже так для `contactRelationships`) — не
новая утечка, продолжение существующего компромисса, не расширение его.

### `applyProfileUpdates(updates)` — новая функция, `contacts.js`

```js
async function applyProfileUpdates(updates: Map<pubkey, {name?,about?,picture?,createdAt,id} | null>) -> Promise<boolean>
```

Единая точка применения входящих профилей (T5.1) — вызывается ИЗ
`ensureProfilesFetched`/`refreshProfiles` (после `fetchProfiles`) И из
`refreshLiveProfileSubscription`'s onBatch (`transport.js`, contact-
ветка, T6.2) — оба пути унифицированы (T7), не два разных сравнения.
Для каждой записи: `incoming === null` → безусловно пишется в
`profiles.value[pk] = null` (СУЩЕСТВУЮЩЕЕ поведение `refreshProfiles`,
`contacts-signals.test.js` — "контакт больше не найден -> обновляет на
null", НЕ меняется этим этапом) — но НИКОГДА не пишется в
`contactProfiles` (T5.3 — только про персист, не про сигнал: "не
кэшировать null НАВСЕГДА" означает не персистить, не запрещает сессионный
null в сигнале). Иначе (incoming — реальный профиль) —
`isNewerVersion(incoming, profiles.value[pk])` → применяется в
`profiles.value` И, если `contacts.value.includes(pk)`, в таблицу
`contactProfiles` (через `ownerPubkeyRef`/`dbKeyRef`, уже существующие
module-level переменные `contacts.js`, установленные
`configureContactRuntime` — БЕЗ правки сигнатур
`ensureProfilesFetched`/`refreshProfiles`, у которых уже ~10
вызывающих мест в UI). Возвращает `true`, если `profiles.value`
реально изменился (для вызывающего кода — bump-решение).

### `hydrateProfilesFromCache(ownerPubkey, dbKey)` — новая функция, `contacts.js`

Читает ВСЕ строки `contactProfiles` для `ownerPubkey`, гидрирует
`profiles.value` ДО любых сетевых запросов (T5.2). Вызывается ПЕРВОЙ
строкой `connect()` (`transport.js`) — раньше `loadUiSettings`, не
зависит от контактов/соединения/`configureContactRuntime` (`ownerPubkey`/
`dbKey` уже известны на этот момент).

### `ensureProfilesFetched`/`refreshProfiles` — контракт сигнатур НЕ меняется

Both продолжают принимать `(pubkeys, fetchProfilesFn)` — используются
не только для контактов (`channel.jsx`/`channel-chat.jsx`/`discovery.jsx`
зовут для авторов постов/каналов, не входящих в `contacts.value`).
Персист в `contactProfiles` — избирательный (только когда pubkey
реально контакт, проверка внутри `applyProfileUpdates`), не расширяется
на произвольные pubkey.

### T6.1 — `hydrateOwnProfile`, аддитивная правка (только оркестратор)

Если `parsed.picture` НЕПУСТОЙ и `parsed.picture !== current.avatarUrl`
— `patch.avatar = ''` (локальный data-url кэш инвалидирован) ВМЕСТЕ с
`avatarUrl`. Пустой `parsed.picture` — локальные поля не трогает
(правило этапа 57 остаётся). Контракт возврата (`true`/`false` — найден/
не найден валидный kind:0) НЕ меняется — существующие тесты
(`profile.test.js`) сверяют именно это, строго `assert.equal(result,
true/false)`.

### T6.2 — живая подписка на собственный kind:0

`refreshLiveProfileSubscription(ownerPubkey)` (`transport.js`) —
`authors` подписки расширен до `[ownerPubkey, ...contactPubkeys]`;
ранний `if (contactPubkeys.length === 0) return` УДАЛЁН (новый
пользователь без контактов всё равно должен получать живые обновления
СВОЕГО профиля). onBatch ветвит: `event.pubkey === ownerPubkey` →
персистит сырое событие в `db.table("events")` (если ещё не было,
`hasEvent`/`appendEvent` из `core/store/event-log.js` — тот же приём,
что bootstrap) и переиспользует `hydrateOwnProfile(ownerPubkey)` —
LWW-корректность НАСЛЕДУЕТСЯ от уже протестированного `pickLatest` над
полной историей событий, не пишется заново; иначе → `applyProfileUpdates`
(контактная ветка, T5.1). Один subscriber, не два (T6.2's явное
требование). Эхо собственной публикации — `bumpProfileActivity()`
вызывается ТОЛЬКО если `getProfile(ownerPubkey)` реально отличается
до/после вызова `hydrateOwnProfile` (сравнение на стороне вызывающего
кода в `transport.js`, не внутри `hydrateOwnProfile` — иначе пришлось
бы менять её протестированный `true`/`false`-контракт).

### T6.3 — рендер-контракт НЕ меняется

`avatar || avatarUrl` (`profile.jsx`, `sidebar-profile-card.jsx`)
остаётся как есть — корректность обеспечивает T6.1's инвалидация.
Комментарий у обоих мест фиксирует это явно (следующий читатель кода
не "исправит" приоритет).

### Побочная находка при реализации T6.2 (не домысел, не часть исходного ТЗ)

`refreshLiveProfileSubscription` (`transport.js`) читал `contactPubkeys`
из legacy-таблицы `contacts` (`db.version(1)`) — она ОПУСТОШЕНА
одноразовой миграцией `migrateLegacyContactTables` (`contact-runtime.js`,
этап 49) сразу после переноса в `contactRelationships`, ничем больше не
заполняется. Для любой identity, подключавшейся хоть раз после этапа 49
(то есть практически всегда), `contactPubkeys` был пуст → функция
попадала в ранний `return` и НИКОГДА не создавала подписку — живые
обновления профилей КОНТАКТОВ были мертвы с этапа 49 (отдельно от
P-1/P-4, которые описывают, что происходит, КОГДА подписка вообще
работает). Исправлено попутно: источник — сигнал `contacts`
(`ui/signals/contacts.js`), синхронизированный `contactRelationships`.

## Этап 74 — найдено живой проверкой (после закрытия A+B+C): контакты не live между сиблингами

`PUBLISH_REQUEST`/`PUBLISH_ACCEPT`/`PUBLISH_REJECT`/`PUBLISH_CANCEL`
(`contact-runtime.js`) заворачивают rumor ТОЛЬКО на pubkey собеседника,
никогда на свой — сиблинг-устройство узнавало о собственной отправленной/
принятой заявке только на следующем `connect()`. Живой E2E-тест (4
браузера, kukusya/tutturulya) воспроизвёл это напрямую.

**Исправлено:** `refreshLiveContactListSubscription(ownerPubkey)`
(`transport.js`) — постоянная подписка на `{authors:[ownerPubkey],
kinds:[3,10000]}` (свои же kind:3/kind:10000, не gift-wrap), вызывается
безусловно в `connect()`, сразу после `reconcileContactsFromEventLog`.
Тестируемое ядро — `applyContactListEvent`/`applyMuteListEvent`
(`contacts.js`), переиспользуют `reconcileList` (`contact-fsm.js`) —
та же LWW-семантика, что bootstrap-путь, не вторая реализация.

Попутно найдена и закрыта дыра в самом `reconcileList`: ветка УДАЛЕНИЯ
уже была защищена (I1, `peerState.resolvedAt <= createdAt`), ветка
ДОБАВЛЕНИЯ — нет. С разовым bootstrap-сканом (всегда `pickLatest`
единственного снимка) это не проявлялось; с живой подпиской (возможна
редоставка/переупорядочивание) — стало реальным сценарием отката уже
удалённого контакта. Добавлен симметричный гейт.

**Известное ограничение (не в этом фиксе):** OUTGOING_PENDING/
INCOMING_PENDING (промежуточные состояния ДО разрешения) по-прежнему
не синхронизируются live на сиблинг-устройства — только финальные
CONTACT/BLOCKED. Полный фикс требует self-addressed rumor с тегом
реального peer'а (тот же приём, что `["contact", ...]` в devices.js's
sibling-Welcome, Часть A) и новых FSM-переходов "LOCAL_*" — отдельная,
более крупная задача.

## Этап 74 — найдено живой проверкой: groups-сигнал не обновлялся живьём

Пользователь создал группу "друзья" на устройстве A (Zen), добавил
tutturulya — на устройстве B (Chrome, тот же владелец) изменение не
появилось без ручной перезагрузки.

Причина: `rebuildGroups` (`domain/events/handlers.js`) корректно пишет
в Dexie (`groups`/`groupMembers`) при получении kind:30050 через живую
`startIncrementalSync` (`transport.js`'s `onEvent`), но НИКТО не
вызывал `refreshGroups()` (`ui/signals/contacts.js`) после этого —
Preact-сигнал `groups`, который читает UI (`channels.jsx`/
`contacts.jsx`), обновлялся ТОЛЬКО когда экран монтировался сам (у
обоих есть собственный `useEffect` с вызовом `refreshGroups` на mount,
deps `[ownerPubkey]` — не на bump-сигналы). Это маскировало пробел при
обычной перезагрузке (mount экрана сам подтягивал актуальное), но не
работало живьём при уже открытом экране.

**Исправлено:** `transport.js`'s `onEvent`-обработчик
`startIncrementalSync` теперь вызывает `refreshGroups(pubkeyHex,
dbKey)` сразу после `rebuildGroups` — мост "Dexie обновлена → Preact-
сигнал перечитан" (тот же класс фикса, что live-contact-list выше,
просто для groups не было даже отдельной подписки — она уже была
`startIncrementalSync`, не хватало только вызова `refreshGroups`).
Wiring-фикс без отдельного юнит-теста (transport.js не имеет прямого
покрытия в проекте — чистая WebSocket-оркестрация; `refreshGroups`
сама уже покрыта косвенно через тесты `*GroupAction`), корректность
проверена полной регрессией + этой самой живой сессией.

## Этап 74 — найдено живой проверкой: группы видимости канала нельзя было менять после создания

Не баг синхронизации — реальный пробел функциональности. `channelVisibilityGroups`
заполнялась ТОЛЬКО внутри `createChannel` — `editChannel` не принимал
group-параметры вовсе, UI-форма редактирования не имела полей про группы.

**Добавлено** (`channel-visibility.js`):
- `listChannelVisibilityGroupIds(ownerPubkey, channelId)` — текущие
  привязанные группы (для инициализации чекбоксов формы редактирования).
- `addVisibilityGroup(ownerPubkey, ownerPrivKey, dbKey, channelId, groupId,
  publish)` — привязывает СУЩЕСТВУЮЩИЙ канал к дополнительной группе. БЕЗ
  ротации ключа (новые участники ПОЛУЧАЮТ доступ, не теряют — рассылка
  текущей версии ключа достаточна). Идемпотентна по читателям: уже
  видящий канал участник (через эту же/другую группу) не получает
  повторный грант.
- `removeVisibilityGroup(ownerPubkey, ownerPrivKey, dbKey, channelId,
  groupId, publish)` — отвязывает группу. Для каждого её участника —
  та же проверка "виден ли ещё через другую привязанную группу", что
  `revokeIfNoLongerVisible`, но скоуплена ОДНИМ известным `channelId`
  (не через `findChannelIdsByVisibilityGroup` — после удаления строки
  та вернула бы пусто и для этого канала тоже). Владелец (self-грант,
  этап 55) НИКОГДА не отзывается через этот путь.
- Обе функции — `requireOwnerChannel`-гейт (throw, если не владелец
  или канал не найден), тот же приём, что `editChannel`/`deleteChannel`.

**UI** (`channel.jsx`'s `ChannelSettingsForm`): чекбокс-список групп
(тот же паттерн, что `CreateChannelForm`, `channels.jsx`) — снимок
текущих групп на момент открытия формы (`originalGroupIds`), при
сохранении — diff против `selectedGroupIds`, вызывает
`removeVisibilityGroup`/`addVisibilityGroup` только для реально
изменённых групп. Новый i18n-ключ `channel.settings.visibilityLabel`
во всех 12 локалях (структурная полнота — обязательный тест
`i18n.test.js`).

## Этап 74 — найдено живой проверкой: отзыв доступа к каналу невидим отозванному + дыра контроля доступа

Пользователь наблюдал: удаление tutturulya из группы «друзья» (или
отвязка группы от канала через новый UI) НЕ убирала канал у неё из
«Доступные», и она всё ещё могла нажать «Подписаться».

**Находка 1 (давнее поведение, не введено этой сессией):**
`revokeViewFromMember` (этап 36) сознательно не публикует объявление
об отзыве («это не бан, человек просто вышел из группы») — но из-за
этого отозванный НИКОГДА не узнавал об этом: локальная строка
`channels` оставалась навсегда с устаревшими кэшированными данными.

**Исправлено:** новый приватный (gift-wrap, НЕ публичный под `#h`)
rumor-кинд `CHANNEL_UNVIEW_KIND = 3007` (`channel-access.js`,
`buildChannelUnviewRumor(channelId)` — content несёт только `channelId`,
приватность даёт сам `nip59Wrap`, второе шифрование channelKey не
нужно, в отличие от `CHANNEL_BAN_KIND`, который публичен под `#h`).
`revokeViewFromMember` теперь best-effort (try/catch, не блокирует уже
совершённую ротацию ключа) отправляет это уведомление `targetPubkey`.
Приёмная сторона — `applyChannelUnviewRumor(ownerPubkey, dbKey, rumor)`
(`channel-visibility.js`) — переиспользует `deleteChannelLocally`
(`moderation.js`, тот же путь, что публичный бан применяет к себе).
Защита от подделки: `rumor.pubkey !== channelRow.creatorPubkey` →
отклонить (тот же принцип, что `receiveBanAnnouncement`); собственный
(`role==="owner"`) канал НИКОГДА не удаляется через этот путь.
Wiring — `transport.js`'s `giftWrapSubscriber`, новая ветка.

**Находка 2 (реальная дыра в контроле доступа, отдельная от находки 1):**
`handleIncomingSubscribeRequest` (`channel-access.js`) НИКОГДА не
проверял, есть ли у запросившего реальный VIEW-доступ (состоит ли он
в `channelReaders`) — комментарий кода лишь ПРЕДПОЛАГАЛ это
("VIEW уже есть у requesterPubkey"). Читатель, полностью лишённый
видимости канала, мог получить COMMENT-доступ через «Подписаться».

**Исправлено:** явная проверка `channelReaders` в начале
`handleIncomingSubscribeRequest` — без VIEW запрос молча отклоняется
(`return`, не раскрываем причину отказа отправителю).

## Этап 74 — найдено живой проверкой: отзыв VIEW ротирует ключ, но не переиздаёт метаданные

Прямое продолжение предыдущей находки (уведомление отозванного) —
живой сценарий "убрал группу видимости → вернул обратно" показал
канал с именем "(без названия)" у tutturulya, полностью функциональный
(подписка/чат работали), но без названия/аватара НАВСЕГДА.

**Причина:** `revokeViewFromMember` ротирует `channelKey`, но
единственная копия метаданных (kind 30060) на relay оставалась
зашифрована СТАРОЙ версией. Любой читатель, получивший VIEW ПОСЛЕ
ротации (`addVisibilityGroup`, включая повторное добавление ранее
отозванного), создаёт локальную строку со stub-заглушками
(`receiveChannelKeyGrant`, `name: ""`) и никогда не может её
заполнить — `decryptChannelContent` требует ТУ ЖЕ версию, что
зашифровала content, а у нового читателя есть только новый ключ.
VIEW/allowlist работают независимо от метаданных, поэтому канал
оставался полностью рабочим, просто "безымянным".

**Исправлено:** `revokeViewFromMember` теперь переиздаёт kind 30060
под НОВОЙ версией ключа сразу после ротации (тот же приём, что
`editChannel`'s metaEvent — тот же набор полей из уже известного
владельцу decrypted `channelRow`). Побочный фикс: `channelRow`
внутри `revokeViewFromMember` был RAW (не расшифрован) — заменено на
`fromEncryptedRow` (нужно для доступа к `name`/`description`/`rules`/
`avatar`/`allowChatAttachments`, sensitive-полям).

## Этап 74 — найдено живой проверкой (второй цикл): предыдущий фикс
## работал один раз, но откат "(без названия)" повторился на ПОВТОРНОМ
## remove/re-add группы видимости

**Причина (М3-класс, тот же приём, что kind:445 этапа 73.4, но для
контента каналов):** kind 30053 (grant новой версии ключа, подписка
`#p:[я]`) и kind 30060/30054/30061/30062/30063 (контент, подписка
`#h:[channelTopic]`) идут ДВУМЯ независимыми REQ — relay не
гарантирует порядок доставки между ними. Все 5 `receive*`-функций
контента каналов на "версия ключа ещё не готова" (`!meta`,
`!keyRowRaw`, `decrypt→null`/`verified→null`) раньше молча делали
`return`/`return false`. `isNewEvent(event.id)` в transport.js —
ПОСТОЯННЫЙ dedup: событие, отмеченное "виденным" при первой (неудачной)
попытке, НИКОГДА не обрабатывалось повторно, даже когда нужная версия
ключа приходила чуть позже тем же connect()'ом.

**Исправлено (аддитивно, без изменения остальных условий no-op —
неизвестный канал/топик и LWW-устаревшая ревизия остаются тихим
no-op, не подлежат retry):**
- `src/domain/content/channel-content-errors.js` (новый) —
  `ChannelContentNotReadyError`, отдельный от прочих ошибок сигнал
  "рано, не порча".
- `receiveChannelMetadata`/`receiveAllowlistUpdate` (`channel.js`),
  `receivePost` (`post.js`), `receiveComment` (`comments.js`),
  `receiveChannelMessage` (`channel-chat.js`) — throw
  `ChannelContentNotReadyError` вместо тихого `return`/`return false`
  ровно в точках "нужной версии ключа нет локально".
- Побочная находка (не живая, найдена при написании тестов):
  `parseAndVerifyAllowlist` (comment-allowlist.js) может БРОСИТЬ
  raw AEAD-ошибку ("invalid tag"), не только вернуть `null`, когда
  событие несёт версию ключа, которой у вызывающего ещё нет (карта
  `{[версия из заголовка события]: key владельца текущей версии}`
  ловит несовпадающий ключ, decrypt падает, а не возвращает null) —
  `receiveAllowlistUpdate` теперь оборачивает вызов в try/catch и
  тоже бросает `ChannelContentNotReadyError` (тот же принятый
  компромисс "и не готово, и подделка дают один сигнал", уже
  зафиксированный для `verified===null`).
- `src/ui/signals/transport.js` — М3-паттерн, зеркально группам
  (`pendingUndecryptedByGroup`/`UNDECRYPTED_RETRY_TTL_MS`):
  `pendingUndecryptedByChannel` (ключ — `channelTopic`, общий `#h`
  routing-тег ВСЕХ 5 кайндов контента одного канала),
  `CHANNEL_CONTENT_RETRY_TTL_MS = 5 мин`, `channelTopicOf(event)`,
  `bufferUndecryptedChannelEvent(event)`. `processOneChannelContentEvent`
  вынесена из `onBatch` (была инлайн) — переиспользуется основным
  циклом И `retryBufferedChannelContentEvents`, тот же приём, что
  `processOneGroupMessageEvent`. В `onBatch` `refreshChannelContentSubscription`
  ловится СПЕЦИФИЧНО `ChannelContentNotReadyError` → буфер; прочие
  исключения — прежний тихий discard (не буферизуются, не retriable —
  неизвестный канал/подделка не "может стать валидным позже").
  Retry триггерится в ДВУХ точках: (а) после каждого успешно
  обработанного события контента этого же канала (в
  `refreshChannelContentSubscription`), (б) после каждого нового
  VIEW-гранта (`refreshChannelGrantSubscription`) — оба момента
  продвигают локальную версию ключа канала.
- `receiveChannelKeyGrant` (`channel.js`) — аддитивный возврат
  (раньше void): `{ channelId, channelTopic }`, нужен вызывающему
  коду transport.js, чтобы после гранта повторить именно буфер ЭТОГО
  канала (ключ Map — `channelTopic`).

**Тесты:** `tests/channel-content-not-ready.test.js` (новый) — для
каждой из 5 `receive*`-функций: реалистичная гонка через
`banMember`-ротацию ключа (throw ДО применения нового гранта Бобом,
успех ПОСЛЕ, retry того же события идемпотентен) + 2 негативных теста
(неизвестный `#h`-топик — тихий no-op, НЕ throw). Два адверсарных
теста, сломанных throw-семантикой (`channel.test.js` — поддельный
allowlist; `moderation.test.js` — забаненный с устаревшим ключом),
переведены на `assert.rejects(ChannelContentNotReadyError)` с
сохранением исходной гарантии (роль/DB-состояние не меняются).

## Этап 74 — найдено живой проверкой: НОВАЯ группа контактов не
## синхронизируется (ни сиблингу, ни через видимость канала) — гонка
## конкурентных flush() в общем transport-слое

Живой сценарий: создание новой группы + добавление участника в Chrome
не долетело до сиблинг-устройства kukusya; следом галочка видимости
канала для этой же группы не дала tutturulya доступа вообще (0
разосланных грантов).

**Причина (не про группы конкретно — про сериализацию в общем
`src/core/transport/subscriber.js`, которым пользуются ВСЕ живые
подписки приложения):**

1. `src/core/sync/incremental-sync.js` — `options.onEvent?.(...)`
   вызывался БЕЗ `await`. `onEvent` в transport.js делает тяжёлую
   цепочку (`rebuildGroups`+`refreshGroups`+`rebuildEffectivePermissions`+
   `rebuildFilesLog`), но `onBatch` резолвился, не дожидаясь её
   завершения.
2. `subscriber.js`'s `flush(subId)` не была защищена от повторного
   входа: `q.timer` сбрасывается в начале `flush`, ДО `await
   verifyBatch`, поэтому новое событие, прилетевшее ПОКА текущий
   `flush` ещё внутри `onBatch`, планирует СВОЙ независимый `flush()`
   того же `subId` — оба могли выполняться конкурентно.

`kind:30050` (группы) — parameterized-replaceable по groupId; создание
группы и добавление участника — два РАЗНЫХ события с ОДНИМ d-tag
(растущий `created_at`, `nextCreatedAt` в `contacts.js`). `rebuildGroups`
(`handlers.js`) каждый раз делает "прочитать снимок таблицы `events` ->
выбрать LWW-победителя по d-tag -> `foldGroup` (delete+bulkAdd
`groupMembers`)" — если "устаревший" вызов (снимок ДО прихода события-
добавления) физически завершает СВОЮ запись ПОСЛЕ "свежего" (снимок
УЖЕ с обоими событиями), `groupMembers` откатывается к пустому
набору. Это же объясняет провал видимости канала:
`addVisibilityGroup` (`channel-visibility.js:185`) честно читает
`groupMembers` НА МОМЕНТ вызова — если Dexie в этот момент уже
откачена гонкой выше, разослать грант некому.

**Исправлено (root cause, не патч конкретно для групп — оба фикса в
общем транспортном слое, автоматически защищают ВСЕ подписки):**
- `incremental-sync.js` — `await options.onEvent?.(...)`.
- `subscriber.js` — `flush()` теперь проходит через
  `serializedPerSubId(subId, fn)`, per-subId промис-цепочка (тот же
  приём, что `withGroupLock`'s in-process fallback mutex в
  `mls-lock.js`, но без Web Locks — гонка чисто внутрипроцессная,
  межвкладочная гарантия здесь не нужна). Независимые `subId` друг
  друга не блокируют.

**Тесты:** `tests/subscriber.test.js` — 2 новых адверсарных
(строгая сериализация двух `flush()` одного `subId`; независимость
разных `subId`); 5 существующих тестов поправлены на дополнительные
микротаски ожидания (`flushMicrotasks()` вместо одиночного `await
Promise.resolve()` — сериализация добавляет промежуточные тики).
`tests/incremental-sync.test.js` — новый тест: `onCaughtUp` не
срабатывает, пока асинхронный `onEvent` не завершился.

## Этап 74 — найдено живой проверкой (чистый повтор после сброса всех
## серверных/клиентских данных): группа-член-sync подтверждена ИСПРАВНОЙ
## (гонка flush() закрыта), НО две отдельные, узкие, не связанные с
## гонками находки в области "видимость канала ↔ группы"

Живой сценарий (с нуля): создание канала — синхронизировалось;
создание группы — синхронизировалось; добавление участника в группу —
синхронизировалось (гонка предыдущего фикса подтверждена закрытой).
Осталось сломано:

**Находка 1 — `channelVisibilityGroups` никогда не публиковалась.**
Галочка видимости канала для группы, поставленная на одном устройстве
владельца, не появлялась на sibling-устройстве того же владельца.
Причина — не гонка: `addVisibilityGroup`/`removeVisibilityGroup`
(`channel-visibility.js`) и начальный список групп в `createChannel`
(`channel.js`) пишут ассоциацию ТОЛЬКО в локальную Dexie-таблицу
`channelVisibilityGroups`, ни разу не публикуя событие — в отличие от
`groups` (kind:30050), у этой таблицы никогда не было self-sync
механизма вообще.

**Исправлено (по прямому прецеденту kind:30050/`foldGroup`/
`rebuildGroups`, тот же паттерн, не изобретение нового):**
- `src/domain/content/channel-visibility.js` — новый self-encrypted
  (nip44 на собственный pubkey), parameterized-replaceable
  `CHANNEL_VISIBILITY_SYNC_KIND = 30065` (d-tag = channelId, content =
  `{groupIds: [...]}` — ПОЛНЫЙ текущий набор, не дельта, тот же приём,
  что `buildGroupEvent`). `buildChannelVisibilitySyncEvent`/
  `parseChannelVisibilitySyncEvent` — round-trip, зеркально
  `buildGroupEvent`/`parseGroupEvent` (`contacts/groups.js`).
  `foldChannelVisibilityGroups(event, privKey, dbKey)` — delete-all +
  bulkAdd для `[ownerPubkey, channelId]`, зеркально `foldGroup`.
  `rebuildChannelVisibilityGroups(ownerPubkey, privKey, dbKey)` —
  читает ВСЕ локально сохранённые события `CHANNEL_VISIBILITY_SYNC_KIND`
  из таблицы `events`, LWW-победитель (`lwwWinner`) по d-tag(channelId),
  fold каждого — зеркально `rebuildGroups`. Никакого нового поля в
  схеме БД не потребовалось (переиспользован уже проверенный "полная
  история → пересчёт" механизм, не потоковый LWW-гейт на строке).
  `publishChannelVisibilitySync(ownerPubkey, ownerPrivKey, dbKey,
  channelId, publish)` — читает ТЕКУЩИЙ (уже смутированный локально)
  полный набор `channelVisibilityGroups` для канала и публикует;
  вызывается из `addVisibilityGroup`, `removeVisibilityGroup` (после
  соответствующей мутации) И из `createChannel` (после начальной
  простановки групп, `channel.js`) — все ТРИ точки мутации этой
  таблицы теперь публикуют.
- `src/ui/signals/transport.js` — `rebuildChannelVisibilityGroups`
  вызывается в `onEvent` (`startIncrementalSync`) сразу после
  `rebuildGroups`, тем же приёмом (наследует и сериализацию flush(),
  и `await` — фикс гонки выше распространяется автоматически).
- Область НЕ включает live-обновление уже ОТКРЫТОЙ формы настроек
  канала (`ChannelSettingsForm`, `channel.jsx`) — она читает
  `listChannelVisibilityGroupIds` в `useEffect` на mount (не signal),
  что достаточно: пересборка Dexie гарантированно опережает открытие
  формы пользователем в реальном сценарии проверки ("зашёл в
  настройки — проверил"). Живой сигнал в открытой форме — вне скоупа
  этого точечного фикса (см. решение пользователя не делать полный
  архитектурный пересмотр).

**Находка 2 — добавление участника в УЖЕ привязанную к каналу группу
не выдаёт ему VIEW retroactively.** `removeGroupMemberAction`
(`ui/signals/contacts.js`) симметрично вызывает
`revokeIfNoLongerVisible` (отозвать доступ при выходе из группы), но у
`addGroupMemberAction` не было обратной пары — `addVisibilityGroup`
рассылает гранты только ТЕКУЩИМ на момент вызова участникам группы;
участник, добавленный ПОЗЖЕ (после того, как видимость уже включена),
никем не догоняется. Это НЕ баг синхронизации — чистый пробел бизнес-
логики, воспроизводится даже на одном устройстве без сети.

**Исправлено:** `channel-visibility.js` — новая
`grantIfNewlyVisible(ownerPubkey, ownerPrivKey, dbKey, pubkey, groupId,
publish)`, зеркальная `revokeIfNoLongerVisible`, НЕ переиспользующая её
код (направление и условия обхода — зеркальные, не идентичные): для
каждого `channelId`, где `groupId` даёт видимость
(`findChannelIdsByVisibilityGroup`), если `pubkey` ещё НЕ
`channelReaders` (не виден иначе) — грант + запись читателя. `pubkey
=== ownerPubkey` — сразу no-op (self-грант уже есть с момента
создания канала, этап 55, второй грант через группу избыточен).
`ui/signals/contacts.js`'s `addGroupMemberAction` вызывает её
симметрично тому, как `removeGroupMemberAction` вызывает
`revokeIfNoLongerVisible`.

**Тесты:** `tests/handlers-style` зеркальные `foldGroup`/`rebuildGroups`
тесты для `foldChannelVisibilityGroups`/`rebuildChannelVisibilityGroups`
(upsert+полная замена; LWW-победитель по d-tag; независимые channelId
не смешиваются) — в `channel-visibility.test.js` (не отдельный файл,
домен один). Интеграционные: `addVisibilityGroup`/
`removeVisibilityGroup`/`createChannel` публикуют, и "приём на
sibling-устройстве" (fold полученного события) воспроизводит тот же
набор `channelVisibilityGroups`, что у публикующего устройства.
`grantIfNewlyVisible`/`addGroupMemberAction`: retroactive-грант новому
участнику уже видимой группы; владелец не получает второй грант;
уже-читатель (через другую группу) не получает дублирующий грант;
участник группы, НЕ привязанной ни к одному каналу — no-op, publish не
вызывается вовсе.

## Этап 74 — найдено живой проверкой (второй заход, чистая проверка): два
## отдельных бага в контенте каналов — утечка уведомлений в "Доступные" и
## "канал-призрак" после повторного revoke/re-grant видимости

**Баг 1 — уведомления о новом контенте уходили ВСЕМ VIEW-держателям, не
только подписчикам.** `refreshChannelContentSubscription`'s
`processOneChannelContentEvent` (transport.js) уведомляла о новом
посте/комментарии/сообщении чата любого, кто применил событие
(`applied && event.pubkey !== ownerPubkey`), не различая `role`. Читатель
со статусом "available" (есть VIEW через видимость группы, НЕ подписан
явно — "Доступные", не "Подписки") получал те же push-уведомления, что
подписчик.

**Исправлено:** три ветки уведомлений (kind 30061/30062/30063) получили
дополнительное условие `channelRowForNotify?.role !== "available"` —
покрывает `"subscriber"` (явная подписка) и `"owner"` (сиблинг-устройство
владельца видит собственный новый контент с другого устройства), но не
`"available"`. Вложенная "Ответили МНЕ"-ветка (30062) наследует условие
автоматически (она внутри того же `if`). Объявление бана (kind 30064,
своё условие, без гейта на N1-курсор) НЕ тронуто — оно намеренно
"ВСЕГДА sound", отдельный принцип (см. существующий комментарий там же).

**Тесты:** НЕ покрыто юнит-тестами — `transport.js` (оркестрационный
слой: relay-подписки, UI-сигналы, `notifyAndLog`) в этом проекте вообще
не имеет тестовой обвязки (никакого `tests/transport.test.js` не
существует, аналогично остальным orchestration-функциям файла) —
несоразмерно создавать моки connection/notifyAndLog/loadUiSettings ради
одного условия. Корректность подтверждена ревью кода (условие
структурно идентично уже проверенному паттерну `role` в
`listAvailableChannels`/`listSubscribedChannels`, channel.js) и остаётся
на живую проверку пользователем.

**Баг 2 — "канал-призрак": после revoke ("убрал галочку видимости") и
повторного re-grant ("вернул галочку") канал у читателя возрождался
`(без названия)`, без аватара, навсегда.** Второй заход на ЭТОТ ЖЕ
симптом (первый заход, "метаданные не переиздаются при ротации ключа",
см. запись выше — тот фикс был необходим, но недостаточен). Причина —
ещё одна гонка ДВУХ НЕЗАВИСИМЫХ подписок: unview-уведомление
(gift-wrap, `giftWrapSubscriber`) и republish метаданных (kind 30060,
ТОТ ЖЕ #h-топик, но `channelContentSubscriber` — другая подписка).
Relay не гарантирует порядок между ними. Если unview обрабатывается
ПЕРВЫМ (`applyChannelUnviewRumor` -> `deleteChannelLocally` стирает
строку `channels`), а republish метаданных приходит СРАЗУ ПОСЛЕ —
`receiveChannelMetadata` видит "неизвестный канал" (`!existing`). Эта
ветка была silent `return` (не throw) — событие помечалось
`isNewEvent`'ом как НАВСЕГДА обработанное и терялось безвозвратно.
Когда владелец повторно выдаёт VIEW, `receiveChannelKeyGrant` создаёт
ПУСТОЙ stub (`name: ""`), и заполнить его больше НЕЧЕМ — оригинальное
republish-событие уже потеряно, а повторный REQ (resubscribe) хоть и
передоставляет тот же event с relay (NIP-01, backlog для
parameterized-replaceable), `isNewEvent` блокирует его ПОВТОРНУЮ
обработку по тому же `event.id`.

**Исправлено (расширение M3-буфера/retry, не новый механизм):**
"неизвестный канал" (`!existing`/`!channelRow`) во ВСЕХ пяти
`receive*`-функциях (`receiveChannelMetadata`, `receiveAllowlistUpdate`
— `channel.js`; `receivePost` — `post.js`; `receiveComment` —
`comments.js`; `receiveChannelMessage` — `channel-chat.js`) теперь
`throw ChannelContentNotReadyError` вместо silent no-op — становится
ретраебельным через УЖЕ существующий буфер `pendingUndecryptedByChannel`
(transport.js). Пересмотр решения этапа 74 (первый заход): тогда
"неизвестный канал" считался permanent no-op наравне с LWW-устаревшей
ревизией и malformed-событием — новая живая находка показала, что это
НЕВЕРНО именно для "неизвестный канал СЕЙЧАС" (может стать известным
после re-grant), в отличие от LWW-устаревшей ревизии (никогда не
станет новейшей заново) и malformed-события (никогда не станет
валидным) — те остаются silent no-op, не тронуты. Retry триггерится
существующими точками (успешный контент того же канала;
`receiveChannelKeyGrant` того же канала) — тот же путь автоматически
подхватывает и эту гонку.

**Тесты:** 2 существующих негативных теста в
`channel-content-not-ready.test.js` ("неизвестный #h-топик -> тихий
no-op") переведены на `assert.rejects(ChannelContentNotReadyError)` с
уточнённым названием (различие "ретраебельно" vs "малформед"). Новый
адверсарный тест — ТОЧНОЕ воспроизведение живого бага: `createChannel`
-> Боб получает грант+метаданные -> `revokeViewFromMember` (Алиса) ->
`applyChannelUnviewRumor` (Боб, unview ПЕРВЫМ, канал удалён локально)
-> republish метаданных приходит ВТОРЫМ -> `assert.rejects` -> Алиса
зовёт `addVisibilityGroup` (re-grant) -> Боб получает stub с пустым
именем -> retry ТОГО ЖЕ event -> имя корректно восстановлено.

## Этап 74 — найдено живой проверкой (третий заход): канал вернулся с
## именем/аватаром, но БЕЗ ПОСТОВ И КОММЕНТАРИЕВ — история потеряна навсегда

Живой сценарий: revoke/re-add видимости группы (баг 2 уже закрыт —
имя/аватар восстанавливаются), но зайдя в канал, повторно добавленный
читатель видит ПУСТО, хотя раньше там было 2 поста и несколько
комментариев к ним.

**Причина:** посты (`kind:30061`) — replaceable-события, зашифрованные
ТОЙ версией ключа, что была на момент публикации. `revokeViewFromMember`
ротирует `channelKey` и переиздаёт МЕТАДАННЫЕ (уже исправлено выше), но
НЕ переиздаёт посты — на relay они остаются зашифрованы СТАРОЙ версией.
При revoke `deleteChannelLocally` стирает ЛОКАЛЬНУЮ копию у читателя
(закономерно — доступа больше нет); при re-grant он получает ТОЛЬКО
новую версию ключа — старая никому больше не выдаётся, посты
недоступны навсегда.

**Ключевое техническое ограничение (не пробел реализации —
криптографическое свойство модели):** посты подписывает ВЛАДЕЛЕЦ
канала — он технически МОЖЕТ переподписать их под новым ключом.
КОММЕНТАРИИ подписывает АВТОР комментария (не обязательно владелец) —
владелец физически не может переподписать чужой (или даже свой
потерянный, если plaintext уже стёрт локально) приватной подписью.
Пользователь подтвердил объём фикса: посты — переиздавать, про
комментарии — явно уведомлять читателя, ПОЧЕМУ они недоступны.

**Исправлено:**
- `src/domain/content/post.js` — новая
  `republishAllPostsUnderCurrentKey(ownerPubkey, ownerPrivKey, dbKey,
  channelId, publish)`: переиздаёт ВСЕ живые (не `draft`, не `deleted`)
  посты канала под ТЕКУЩЕЙ версией ключа, БЕЗ изменения статуса (не
  `republishWithStatus` — та делает FSM-переход). Best-effort per-пост
  (прецедент `backfillOwnChannelGrants`, channel.js) — падение одного
  publish не блокирует переиздачу остальных и не откатывает уже
  совершённую ротацию ключа.
- `src/domain/content/channel-visibility.js`'s `revokeViewFromMember` —
  вызывает `republishAllPostsUnderCurrentKey` сразу после переиздания
  метаданных.
- Новый приватный (gift-wrap) rumor
  `CHANNEL_OLD_HISTORY_UNAVAILABLE_KIND = 3009`
  (`buildChannelOldHistoryUnavailableRumor`, `channel-access.js`) —
  информационное уведомление, ничего локально не мутирует. Отправляется
  best-effort из `addVisibilityGroup` И `grantIfNewlyVisible`
  (`notifyOldHistoryUnavailableIfNeeded`, общий хелпер) КАЖДОМУ новому
  читателю, получающему VIEW под версией ключа `> 1` — не важно, был ли
  именно ОН отозван раньше: история ДО ротации в любом случае недоступна
  любому новому/повторному читателю, это не адресный "вас же
  предупреждали" сигнал. `version === 1` (канал никогда не ротировался,
  включая исходную раздачу в `createChannel`) — уведомление не
  отправляется, истории до ротации не существует.
- `src/ui/signals/transport.js`'s `giftWrapSubscriber` — приём нового
  rumor kind, push-уведомление через `notifyAndLog`, категория
  `"moderation"`/`"ban"` (принудительная доставка, тот же принцип, что
  `channelDeletedTitle` — причина "канал выглядит неполным" не должна
  молча теряться в settings). i18n-ключи
  `journal.oldHistoryUnavailableTitle`/`journal.oldHistoryUnavailableBody`
  добавлены во ВСЕ 12 локалей (структурный паритет,
  `tests/i18n.test.js` подтверждает).

**Тесты:** `tests/post.test.js` — 4 новых
(`republishAllPostsUnderCurrentKey`: переиздаёт published под новой
версией и читатель с новым грантом расшифровывает; НЕ переиздаёт
draft; НЕ переиздаёт deleted; адверсарный best-effort — один падает,
остальные переизданы). `tests/channel-visibility.test.js` — 4 новых
(`addVisibilityGroup`/`grantIfNewlyVisible` не уведомляют при
version===1, уведомляют при version>1; интеграционный — точное
воспроизведение живого сценария: revoke -> republish поста в outbox
revokeViewFromMember -> re-add -> Боб видит пост И получает
уведомление о недоступных комментариях).

## Этап 74 — найдено живой проверкой (четвёртый заход): шторм из ~20
## дублирующихся push-уведомлений на ОДИН новый комментарий/сообщение
## чата после revoke->re-add видимости группы

Живой сценарий: revoke/re-add видимости группы (три предыдущих фикса
подтверждены рабочими — контент/имя/уведомление о недоступной истории
всё корректно), НО после этого при написании НОВОГО комментария или
сообщения в общем чате противоположная сторона получала пачку из ~20
одинаковых по смыслу push-уведомлений вместо одного.

**Причина (найдена агентом-исследователем, перепроверена чтением
кода лично):** гонка между ДВУМЯ независимыми, НЕ сериализованными
между собой вызовами `retryBufferedChannelContentEvents`
(transport.js) для ОДНОГО И ТОГО ЖЕ `channelTopicHex` —
`refreshChannelContentSubscription` (после каждого успешного
контент-события) и `refreshChannelGrantSubscription` (после нового
гранта). Сериализация `flush()` (`subscriber.js`, ранее в этом же
этапе) — per-`subId`, а ЭТИ ДВЕ ПОДПИСКИ ИМЕЮТ РАЗНЫЕ `subId`, друг
друга не блокируют. Сразу после re-add грант и накопившийся во время
revoke-окна бэклог контента (~20 событий: республикация постов, старые
throw'нувшие события) приходят почти одновременно — ОБА retry-вызова
читают ОДИН И ТОТ ЖЕ снимок `pendingUndecryptedByChannel` ДО того, как
любой из них успевает записать обновлённый список обратно, и ОБА
успешно применяют одни и те же буферизованные записи. Усугубляющий
фактор: `receiveComment`/`receiveChannelMessage` (в отличие от
`receivePost`, у которой уже есть `isNewerVersion` LWW-гейт через
`lastEventCreatedAt`/`lastEventId`) НЕ идемпотентны к повторной
обработке ОДНОГО И ТОГО ЖЕ `event.id` — каждое повторное успешное
применение снова возвращает `applied=true` и снова триггерит
`notifyAndLog` (`journal.js`), которая создаёт НОВУЮ запись
`journalEntries` без какой-либо дедупликации.

**Исправлено:** `retryBufferedChannelContentEvents` теперь
сериализована per-`channelTopicHex` — `serializedPerChannelTopic`,
тот же приём (in-process promise-цепочка), что `withGroupLock`
(`mls-lock.js`) и `serializedPerSubId` (`subscriber.js`), просто
применённый на уровень выше (не per-подписка, а per-канал, чтобы
покрыть ОБЕ подписки-триггера сразу). Это устраняет ПОДТВЕРЖДЁННУЮ
гонку целиком — многократные вызовы retry ВНУТРИ одной подписки уже
были последовательны (обычный `for`-цикл с `await`), проблема была
ИСКЛЮЧИТЕЛЬНО в конкуренции МЕЖДУ подписками.

**Не сделано (сознательно, известное ограничение):** идемпотентность
`receiveComment`/`receiveChannelMessage` к повторному `event.id` (LWW-
гейт по образцу `receivePost`) НЕ добавлена — по диагнозу она
"необходимое, но не первопричинное" условие: без гонки выше дублей не
возникает вовсе, а добавление гейта потребовало бы новых полей в схеме
`comments`/`channelMessages` (миграция Dexie) — выходит за рамки
точечного фикса. Если этот класс дублирования проявится ещё раз ПО
ДРУГОЙ причине (не через буфер/retry — например, redelivery после
полного reconnect с обнулением `processedEventIds`), это первое место
для расследования.

**Тесты:** НЕ покрыто юнит-тестами — тот же класс ограничения, что
"role !== available"-гейт выше: `transport.js` в этом проекте вообще
не имеет тестовой обвязки (`serializedPerSubId` в `subscriber.js`,
которому `serializedPerChannelTopic` буквально идентичен по
конструкции, уже покрыт адверсарными тестами — переиспользуется ТОТ
ЖЕ, УЖЕ доказанный корректным примитив, не новый код с нуля).
Верифицировано ревью кода и остаётся на живую проверку пользователем.

---

# Rooms («Быстрая связь») — Этап 1: чистое ядро

ТЗ: `ROOMS-SPEC.md` v2 (архитектор Claude Opus), формализация —
`ROOMS-MATH-v2.md`/`ROOMS-ALGO.md` (те же роль и статус, что design-
записка по skill п.13b — не дублируется здесь). Ниже — только то, что
формализация ОСТАВЛЯЕТ на усмотрение реализации (сигнатуры даны как
интерфейс, не полное поведение), плюс явные scope-решения.

Все 7 модулей — `src/domain/rooms/`, `node --test` без браузера/relay/
`fake-indexeddb`. Ни один не вызывает `Date.now()`/`Math.random()`
внутри — время и случайность инжектируются параметром (ROOMS-SPEC §2).

## room-keys.js [C]

```js
deriveRoomKeys(name, password, suffix, argon2) -> Promise<{ kBase, kRv, kSess: null, hTopic, hDisc }>
deriveSessionKey(kRv, salt) -> kSess
```

Цепочка — ROOMS-ALGO §8, буквально: `kBase = argon2(name, password)`
(ЕДИНСТВЕННЫЙ медленный шаг, инжектируется — см. ниже),
`hDisc = HMAC(kBase, "disc")`, `kRv = HKDF(kBase, suffix)`,
`hTopic = HMAC(kRv, "topic")` — все три через `@noble/hashes`'s
`hmac`/`hkdf`+`sha256`, тот же примитив, что уже использует
`core/crypto/derivation.js` (`deriveMasterSecret`/`opaqueDTag`) — не
новая зависимость. `deriveSessionKey(kRv, salt) = HKDF(kRv, salt)`.

**`argon2` — открытый вопрос на Этап 1, ЗАКРЫТ на Этапе 2.**
`ROOMS-MATH-v2.md`/`ROOMS-ALGO.md` называют Argon2id как "медленный
KDF" на уровне конвенции ([К]/[Г], не жёсткое решение конкретной
библиотеки) — в проекте нет Argon2-зависимости (`@noble/hashes` даёт
`scrypt`, не Argon2id). Решение: `defaultSlowKdf(password, saltBytes) ->
Promise<Uint8Array(32)>` (`room-keys.js`, ниже в файле) — `scryptAsync`
из `@noble/hashes` (УЖЕ зависимость проекта — ноль добавочного веса
бандла, не WASM Argon2id-библиотека). Параметры `N=2**15, r=8, p=1`
(≈32 MiB памяти, десятки-сотни мс на слабом устройстве) — компромисс,
не "самое сильное возможное": комната эфемерна (не долгоживущий
секрет), деплой — локальная сеть (CLAUDE.md), аудитория продукта
включает слабые устройства (memory: censorship-affected non-tech
users) — параметр, рассчитанный на банковский секрет, здесь был бы
неоправданной UX-ценой без соразмерного выигрыша в безопасности.
`deriveRoomKeys` по-прежнему принимает `argon2` ИНЖЕКТИРУЕМЫМ
параметром (сигнатура не меняется) — `defaultSlowKdf` ТОЛЬКО значение
по умолчанию для боевого кода (`room-session.js`, Этап 2), тесты
по-прежнему подставляют быструю заглушку.

`hSess` (в закрытом режиме `hDisc` вычисляется, но не публикуется) —
ответственность ВЫЗЫВАЮЩЕГО кода (адаптер/оркестратор решает,
публиковать ли `hDisc`), не `room-keys.js` — она возвращает оба поля
безусловно.

### room-keys.js — Этап 3: `kPointer` для открытого режима, разбивка на 3 функции

```js
deriveKBase(name, password, argon2) -> Promise<kBase>                 // МЕДЛЕННЫЙ шаг, ровно один раз за сессию
derivePairKeys(kBase) -> { hDisc, kPointer }                          // быстрые, от пары (n,p)
deriveLinkKeys(kBase, suffix) -> { kRv, hTopic }                      // быстрые, от (n,p,suffix)
deriveRoomKeys(name, password, suffix, argon2) -> Promise<{ kBase, kRv, kSess: null, hTopic, hDisc, kPointer }>  // прежняя обёртка, argon2 ровно 1 раз, ТЕПЕРЬ с kPointer в объекте
```

Разбивка — не рефакторинг ради стиля, а необходимость открытого режима
(ROOMS-MATH §1.2): joiner по паролю знает только `(name, password)`, НЕ
`suffix` — цепочка `kRv`/`hTopic` недоступна на фазе обнаружения. Но
`argon2` обязан вызываться РОВНО ОДИН раз за сессию (ROOMS-ALGO §8) —
поэтому `room-session.js` в открытом режиме: `kBase =
deriveKBase(...)` один раз → `derivePairKeys(kBase)` для обнаружения
(подписка на `hDisc`, расшифровка указателя ключом `kPointer`) →
когда `suffix` найден — `deriveLinkKeys(kBase, suffix)` БЕЗ повторного
`argon2`. `deriveRoomKeys` (старая обёртка, используется закрытым
режимом и Этапом 1/2 тестами) продолжает работать НЕИЗМЕНЁННО — просто
теперь дополнительно считает и возвращает `kPointer` (аддитивное поле,
существующие тесты сравнивают отдельные поля объекта, не форму
целиком — регрессия чистая).

`kPointer = HKDF(kBase, "" (пустая соль), "Rooms/v1/pointer")` —
параллельно `hDisc = HMAC(kBase, "disc")`: оба — производные ТОЛЬКО от
пары `(n,p)`, ни один не зависит от `suffix` (иначе указатель на
`suffix` нельзя было бы расшифровать, не зная `suffix` — циклическая
зависимость). Пустая соль в HKDF — RFC 5869 допускает (по умолчанию
ноль байт хэш-длины), домен-разделение обеспечивает `info`-строка
`"Rooms/v1/pointer"`, уникальная среди всех HKDF-вызовов модуля.

## presence.js [C]

```js
emptyPresence() -> Map                                    // L, пустая
mergeHeartbeat(state, {pubkey, nick, at}) -> Map           // новое состояние, state не мутируется
mergeExit(state, {pubkey, at}) -> Map
present(state, now, tau) -> Array<{pubkey, nick, joinedAt}>  // по joinedAt возрастанию
prune(state, now, tau) -> Map
```

Структура — ROOMS-ALGO §3.1 буквально: `L: Map<pubkeyHex, {a, r, nick,
joinedAt}>`. `merge` покомпонентно `max` на `(a, r)` (ROOMS-MATH §2.2).

**`joinedAt` — деталь, не описанная формулами явно, решение
реализации (ПЕРЕСМОТРЕНО в ходе реализации — см. ниже причину):**
`joinedAt` = min-накопление внутри ОТКРЫТОГО периода: при heartbeat
`joinedAt = periodClosed ? at : Math.min(existing.joinedAt, at)`, где
`periodClosed = existing.r >= existing.joinedAt` (известный `r`
перекрыл начало текущего периода — значит exit пришёл ПОСЛЕ входа,
период закрыт, следующий heartbeat открывает НОВЫЙ период с
`joinedAt = at`). Пока период открыт, `joinedAt` — минимум всех `at`
heartbeat'ов этого периода, а не значение первого увиденного.

Первая версия ("сохранять `joinedAt`, если предыдущее состояние уже
присутствовало", т.е. проверка `existing.a <= existing.r` в момент
КАЖДОГО отдельного merge) оказалась НЕ коммутативной: для двух
heartbeat одного периода (без exit между ними), доставленных в разном
порядке двум наблюдателям, `joinedAt` получался разным — реальная
живая рассинхронизация порядка `present()` между наблюдателями, не
просто теоретическое нарушение. Поймано адверсарным тестом на
ассоциативность (`tests/room-presence.test.js`, "И1: merge
ассоциативна") ДО того, как стало живым багом. `min` коммутативен и
ассоциативен по построению (та же причина, по которой `max`-слияние
`(a,r)` — валидный CvRDT), поэтому min-накопление устраняет
зависимость от порядка доставки, сохраняя оба требуемых свойства:
продление аренды не двигает `joinedAt` (стабильный порядок
`present()`, ROOMS-SPEC §3.2), повторный вход ПОСЛЕ exit обновляет
`joinedAt` на новый момент. Известное ограничение: коммутативность
доказана для случая переупорядоченных heartbeat ВНУТРИ одного периода;
для патологических чередований heartbeat/exit одного участника
(события перемешаны относительно друг друга) полная коммутативность
`joinedAt` не доказана — но это НЕ нарушает формальный И1 (тот говорит
о `Present(t)`, не о `joinedAt`, который является UX-полем сверх
формальной CvRDT-модели).

`nick` — всегда берётся из ПОСЛЕДНЕГО `mergeHeartbeat` (не
полурешёточное поле само по себе — LWW внутри той же записи по `at`,
побеждает более свежий `at`, независимо от `a`/`r`-предиката; если
`at` из входящего heartbeat меньше уже известного `nickAt`, `nick` НЕ
откатывается).

`prune` — по ROOMS-ALGO §2.2 буквально: удаляет запись, если `a_d <
now - tau`, НЕЗАВИСИМО от `r_d` (не привязано к предикату
"присутствует"). Уже вышедший, но недавно (по `a`) — не обрезается
раньше срока естественного протухания.

## room-machine.js [C]

Поверх `core/fsm/machine.js`'s `transition(transitions, state, event)`
(чистая функция ИМЯ-состояния → ИМЯ-состояния, без данных). Автомат
ROOMS-MATH §5.1 несёт данные (`k` — число присутствующих), которых
голый `transition()` не поддерживает — `room-machine.js` ведёт `k`
ОТДЕЛЬНО, использует `transition()` только для имени.

```js
emptyRoomState() -> { name: "empty", k: 0 }
create(state) -> { name: "alive", k: 1 }
join(state) -> { name, k: state.k + 1 }          // из "alive" и "draining" (k=0) — одна формула
leave(state, now) -> { name, k, drainedAt? }      // k>1: {name:"alive", k:k-1}; k<=1: {name:"draining", k:0, drainedAt:now}
checkTimeout(state, now, tau) -> state             // idempotent: draining + (now-drainedAt>=tau) -> dead; иначе state как есть
```

`TRANSITIONS` (внутренние имена событий, не публичный API):
```js
{
  empty:    { CREATE: "alive" },
  alive:    { JOIN: "alive", LEAVE: "alive", LEAVE_LAST: "draining" },
  draining: { JOIN: "alive", TIMEOUT: "dead" },
  dead:     {},
}
```
`leave()` сама выбирает `LEAVE` vs `LEAVE_LAST` по `state.k` ДО вызова
`transition()` — недопустимые вызовы (`leave()` на `empty`/`dead`,
`checkTimeout` не на `draining`, где нет ветки в TRANSITIONS) — `dead`
не имеет исходящих переходов вообще (поглощающее, ROOMS-MATH §5.1:
новый экземпляр = новый `emptyRoomState()`, не переход ИЗ dead).

`drainedAt` хранится ВНУТРИ state (не отдельным параллельным
таймером) — `checkTimeout` становится чистой функцией от
`(state, now, tau)`, тестируется без реальных таймеров (ROOMS-SPEC §2).

## trickle.js [W] — точный псевдокод для воркера

```js
createTrickle({iMin, iMax, k, random}) -> {
  onInterval(now), onConsistent(), onInconsistent(), shouldTransmit(now), getIntervalEnd()
}
```

**`getIntervalEnd()` — добавлена на Этапе 2** (пробел, найденный при
проектировании `room-session.js`): оркестратору нужно знать, КОГДА
наступает конец текущего интервала, чтобы вызвать `onInterval(now)` и
начать следующий — без этого геттера состояние `intervalEnd`
недоступно снаружи вовсе, а дублировать его вычисление во внешнем коде
означало бы вести вторую копию того же состояния. Возвращает `null` до
первого `onInterval`. Аддитивное расширение контракта, существующие
9 тестов не меняются, регрессия обязательна (правило 13: контракты
прошлых этапов неизменяемы для воркера, менять может только Claude
явным решением).

RFC 6206 (ROOMS-ALGO §4.2) буквально, но сигнатура из ROOMS-SPEC §3.3
не даёt деталей контракта вызовов — решение реализации:

- Внутреннее состояние: `c` (счётчик согласованных), `t` (абсолютное
  время следующей точки передачи), `intervalEnd`, `I` (текущая длина
  интервала), `firedThisInterval` (bool, чтобы `shouldTransmit`
  срабатывал РОВНО ОДИН раз за интервал).
- **Инициализация:** сразу после `createTrickle` — `I = iMin`, `t`/
  `intervalEnd` НЕ установлены (`null`). Вызывающий код ОБЯЗАН вызвать
  `onInterval(now)` ОДИН раз сразу после создания, чтобы стартовать
  первый интервал. `shouldTransmit(now)` до этого момента — всегда
  `false`.
- `onInterval(now)`: `I = min(2*I, iMax)` (растёт КАЖДЫЙ регулярный
  вызов); `c = 0`; `t = now + random(I/2, I)`; `intervalEnd = now + I`;
  `firedThisInterval = false`.
- `shouldTransmit(now)`: `if (t === null) return false; if
  (firedThisInterval) return false; if (now < t) return false;
  firedThisInterval = true; return c < k;` — явная проверка `t ===
  null` ОБЯЗАТЕЛЬНА (найдено при реализации): `now < t` с `t = null`
  приводится JS к `now < 0`, что для `now >= 0` ложно и проваливается
  в `firedThisInterval = true; return c < k` — нарушает "до первого
  `onInterval` всегда `false`". Побочный эффект (взводит флаг) — при
  первом достижении `t`, дальше `false` до следующего `onInterval`.
- `onConsistent()`: `c += 1`. Без `now` — счётчик, не время.
- `onInconsistent()`: `I = iMin`; `c = 0`; **НЕ пересчитывает `t`/
  `intervalEnd`** (сигнатура без `now` не позволяет) — вместо этого
  контракт использования: вызывающий код (`room-session.js`) ОБЯЗАН
  вызвать `onInterval(now)` СРАЗУ ПОСЛЕД `onInconsistent()`, что и
  даёт RFC 6206's "начать интервал заново" относительно текущего
  момента. Единственное место, вычисляющее `t`/`intervalEnd` —
  `onInterval` (не дублировать формулу в двух функциях).

## mesh.js [W]

```js
edges(pubkeys) -> Array<[initiator, responder]>   // sort(pubkeys) затем все пары i<j
diffEdges(oldEdges, newEdges) -> {toOpen, toClose}  // разность множеств по сериализованной паре "i:j"
```

ROOMS-ALGO §6 буквально — полностью специфицировано, без открытых
вопросов. `diffEdges` сравнивает рёбра как значения (не по ссылке) —
сериализация пары в строку для `Set`-разности, порядок `[i,j]` внутри
пары уже канонический (i<j) из `edges()`.

## message-log.js [W]

```js
createLog({maxBacktrack = 200}) -> { insert(msg) -> boolean, toArray() }
```

ROOMS-ALGO §5 буквально — вставка с хвоста, `Set<id>` для дедупа,
порядок `(createdAt, id)` (ROOMS-SPEC §3.5 — Lamport сознательно НЕ
используется), обрыв прохода на `maxBacktrack` шагов назад. `insert`
возвращает `false` на дубликат id (уже в `Set`), `true` иначе
(независимо от того, вставлено ли в "правильную" по порядку позицию
или на границу `maxBacktrack`).

Точный псевдокод (устраняет неоднозначность "с какой позиции считать
шаги" — иначе граница `maxBacktrack` не тестируема детерминированно):

```js
function compare(a, b) {           // 0 если равны по обоим полям
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

function insert(msg) {
  if (idSet.has(msg.id)) return false;
  idSet.add(msg.id);
  let pos = arr.length;
  let steps = 0;
  while (pos > 0 && steps < maxBacktrack && compare(arr[pos - 1], msg) > 0) {
    pos -= 1;
    steps += 1;
  }
  arr.splice(pos, 0, msg);
  return true;
}
```

Сообщение "по порядку" (не меньше последнего элемента) — `steps=0`,
одно сравнение, вставка в хвост, `O(1)`. Сообщение, требующее сдвига
больше `maxBacktrack` позиций, вставляется РОВНО на позицию
`arr.length - maxBacktrack` (считая от хвоста на момент начала этой
вставки) — не на формально верную позицию; это принятый компромисс
(ROOMS-ALGO §5.1: "опоздавшее на двести позиций в эфемерной комнате
не имеет смысла ставить точно").

## kind-registry.js + room-events.js [C]

**Новый `src/domain/events/kind-registry.js`** — заводится ЭТИМ этапом,
но ТОЛЬКО для НОВЫХ room-kind. ROOMS-SPEC §5.1 просит "существующие
номера тоже перенести" — это ОТДЕЛЬНАЯ, самостоятельная миграция
(15+ доменных файлов по всему проекту, каждый со своей локальной
`_KIND`-константой) — вне скоупа "Rooms, чистое ядро" и рискованная
для стабильного существующего кода. Реестр начинается как источник
истины для НОВЫХ kind (растущий список), перенос существующих —
отдельная будущая задача, не блокирует Rooms.

Четыре новых kind (эфемерные, 20000-29999, не пересекаются с занятыми
20075/22242/24242 — см. `PROCESS-DOCS/AUDIT.md` §1.3):
```js
export const ROOM_ANNOUNCE_KIND = 29001;
export const ROOM_PROBE_KIND = 29002;
export const ROOM_PRESENCE_KIND = 29003;
export const ROOM_CHAT_KIND = 29004;
```

`room-events.js` — build/parse для этих 4 kind, шифрование NIP-44-
подобным AEAD на `kRv` (ANNOUNCE/PROBE) или `kSess` (PRESENCE/CHAT) —
переиспользует `encryptChannelContent`/`decryptChannelContent`
(`core/crypto/channel-key.js`, версия-в-заголовке AEAD, УЖЕ
симметричный примитив на произвольный ключ, ближе к `k_sess`, чем
NIP-44's ECDH-pair — тот же выбор, что Opus сделал для сигналинга НЕ
подходит здесь: комнатные события МНОГОПОЛЬЗОВАТЕЛЬСКИЕ по природе
(все участники читают ОДИН и тот же `kSess`), в отличие от парного
сигналинга голоса). Тег `h` = `hTopic`, все 4 kind — с ним.

**Payload-схема и сигнатуры — решение реализации (ROOMS-SPEC §5.1 не
фиксирует буквально, только таблицу kind/ключ/частота):**

Постройка событий следует прецеденту `signaling-adapter.js`'s
`buildCallSignalEvent` — `build*` сразу подписывает через `sign()`
(`core/crypto/sign.js`, `nostr-tools/pure`'s `finalizeEvent`, чистый
JS, без браузерных API — Этап 1 DoD не нарушается) и возвращает ГОТОВОЕ
событие; сеть/публикация — забота вызывающего (адаптер/оркестратор,
Этап 2), отсюда "не знает про: публикация" в §1.1 — именно про
сетевой ввод-вывод, не про подпись.

Единицы времени: nostr's `created_at` — СЕКУНДЫ; весь остальной Rooms-
домен (`presence.js`, `room-machine.js`, `trickle.js`, δ=15000/τ=45000)
— МИЛЛИСЕКУНДЫ. `room-events.js` — единственная точка конвертации:
`parse*` умножает `event.created_at` на 1000 при формировании `at`/
`createdAt` для чистого ядра; `build*` делит на 1000 при формировании
`created_at` для события.

`ROOM_CONTENT_VERSION = 1` — фиксированная константа (не растёт, в
Rooms нет ротации ключей внутри экземпляра/рендеву — `version`-поле
конверта используется только потому, что переиспользуется формат
`encryptChannelContent`, семантически версии здесь нет).

```js
// ANNOUNCE — несёт salt текущего экземпляра (kSess = HKDF(kRv, salt)),
// иначе новичок, знающий только kRv, не может вычислить kSess (ROOMS-SPEC §5.1).
buildRoomAnnounceEvent(privKey, kRv, hTopic, saltHex, createdAt) -> signed event
parseRoomAnnounceEvent(event, kRv) -> { salt: hex } | null

// PROBE — публикуется входящим, пустой payload: сам факт валидной
// расшифровки на kRv — единственный сигнал ("несогласованность" для Trickle,
// ROOMS-SPEC §5.2).
buildRoomProbeEvent(privKey, kRv, hTopic, createdAt) -> signed event
parseRoomProbeEvent(event, kRv) -> {} | null

// PRESENCE — heartbeat ИЛИ exit одним kind (различаются полем type),
// готовый вход для presence.js's mergeHeartbeat/mergeExit; pubkey —
// из event.pubkey (эфемерная identity комнаты = участник), НЕ дублируется в payload.
buildRoomPresenceEvent(privKey, kSess, hTopic, {type: "heartbeat", nick}, createdAt) -> signed event
buildRoomPresenceEvent(privKey, kSess, hTopic, {type: "exit"}, createdAt) -> signed event
parseRoomPresenceEvent(event, kSess) -> { pubkey, type: "heartbeat", nick, at } | { pubkey, type: "exit", at } | null

// CHAT — id/createdAt/pubkey берутся из события (id=event.id уже уникален
// и публичен на relay — не дублируется), payload несёт только nick/text.
buildRoomChatEvent(privKey, kSess, hTopic, { nick, text }, createdAt) -> signed event
parseRoomChatEvent(event, kSess) -> { id, createdAt, pubkey, nick, text } | null
```

`parse*` возвращают `null` на ЛЮБУЮ ошибку (AEAD-провал чужим ключом,
битый JSON, отсутствие ожидаемых полей) — try/catch вокруг
decrypt+JSON.parse, тот же принцип, что `decryptChannelContent`'s
"версия не найдена -> null, не throw": предфильтр по тегу `h` в
`room-transport.js` (Этап 2) снижает вероятность чужого события почти
до нуля, но не до нуля (коллизия тега либо чужая комната по ошибке
подписки) — рутинный случай, не исключение.

`ROOM_ANNOUNCE_KIND`/`ROOM_PROBE_KIND` шифруются на `kRv` (hex через
`bytesToHex`, `@noble/hashes/utils.js` — тот же, что везде в проекте);
`ROOM_PRESENCE_KIND`/`ROOM_CHAT_KIND` — на `kSess`. Тег `h` = `hTopic`
на всех четырёх — ОДНА функция `buildTags(hTopic)` внутри модуля, не
дублировать `[["h", hTopic]]` в четырёх местах.

# Rooms («Быстрая связь») — Этап 2: транспорт и личность

## room-events.js — Этап 3: `ROOM_POINTER_KIND` (открытый режим)

```js
buildRoomPointerEvent(privKey, kPointer, hDisc, suffix, createdAtMs) -> signed event
parseRoomPointerEvent(event, kPointer) -> { id, suffix } | null
```

`ROOM_POINTER_KIND = 29005` (`kind-registry.js`). Шифруется на
`kPointer` (room-keys.js, Этап 3), тег `h = hDisc` — **НЕ** `hTopic`:
joiner по паролю знает только `(name, password)`, из которых выводится
`kPointer`/`hDisc`, но НЕ `suffix`/`kRv`/`hTopic` (та самая
циклическая зависимость, которую `kPointer` разрывает, ROOMS-MATH
§1.2). `buildEvent`/`parseEvent` внутренние хелперы модуля уже
тег-агностичны (`buildTags(hTopic)` строит `[["h", X]]` для любого
`X`) — переиспользуются без изменений, второй параметр помечен
`hTopic` в сигнатуре хелпера чисто по имени, семантически это просто
"тег маршрутизации", `hDisc` подходит буквально.

`parseRoomPointerEvent` возвращает `id` события (не только `suffix`)
— обязательно для И9 (тайбрейк по минимальному `id`, ROOMS-MATH §1.4):
`room-session.js` сравнивает `id` НЕСКОЛЬКИХ указателей под одним
`hDisc`, лексикографическое сравнение hex-строк (тот же приём, что
`mesh.js`'s `i < j` на pubkey-строках) — детерминировано, без арбитра,
каждый наблюдатель приходит к тому же выбору независимо.

## room-identity.js [C]

```js
createEphemeralIdentity() -> { pubkeyHex, privKey, dbKey: null }
```

ROOMS-SPEC §4.1 буквально: `generateSecretKey()`/`getPublicKey()`
(`nostr-tools/pure`, те же примитивы, что везде в проекте — `sign.js`,
тесты), `pubkeyHex` через `bytesToHex`. `dbKey: null` — фиксированное
поле формы (спек даёт его явно в сигнатуре; гостевая identity
принципиально не пишет в Dexie, поле присутствует ради единообразия
формы с обычной identity, не вычисляется). Ничего не пишет в Dexie, не
вызывает `login()`, не трогает keystore — И7 обеспечивается ПРОСТО
отсутствием побочных эффектов (нечего чистить при закрытии вкладки).

## room-transport.js [C]

```js
openRoomTransport({relayUrl, hTopic, selfPubkey, onEvent}) -> Promise<{ publish, close }>
```

Асинхронная (спек даёт `-> {publish, close}` без `Promise`, но
подключение неизбежно асинхронно — тот же паттерн, что
`diagnostics.jsx:569`: `conn.connect(); await waitForConnState(...)`.
`openRoomTransport` инкапсулирует это ожидание внутри себя, а не
перекладывает на вызывающий код — оркестратор `room-session.js` не
должен знать про `waitForConnState`).

Сборка буквально по ROOMS-SPEC §4.2:
```js
const conn = createRelayConnection(relayUrl, { onStateChange });
conn.connect();
await waitForConnState(conn, s => s === "connected", 8000);
const publisher = createPublisher(conn);
const subscriber = createSubscriber(conn, { verifyBatch, onBatch, onEose });
conn.addMessageHandler(publisher.handleMessage);
conn.addMessageHandler(subscriber.handleMessage);
subscriber.subscribe("room", [{ kinds: ROOM_KINDS, "#h": [hTopic] }]);
```
`waitForConnState` — локальный хелпер внутри модуля (копия паттерна
`diagnostics.jsx`, не экспортируется из `relay-pool.js`). `onStateChange`
— НЕ параметр контракта (спек его не просит) — no-op изнутри, транспорт
не отдаёт наружу состояние соединения на этом этапе (оркестратор Этапа 2
работает только с `present`/сообщениями, не с UI-индикатором соединения;
добавить параметр — тривиальная правка Этапа 3, если UI потребует).

`ROOM_KINDS = [ROOM_ANNOUNCE_KIND, ROOM_PROBE_KIND, ROOM_PRESENCE_KIND,
ROOM_CHAT_KIND, CALL_SIGNAL_KIND]` (последний — `20075`, импорт из
`domain/calls/signaling-adapter.js`, ROOMS-SPEC §5.1: "Плюс существующий
kind 20075 для сигналинга голоса"). Модуль ГОТОВ принимать голосовой
сигналинг уже на этом этапе (Этап 4 не должен переоткрывать
`room-transport.js`), даже хотя `mesh-supervisor.js` появится позже.

`verifyBatch` — РЕШЕНИЕ РЕАЛИЗАЦИИ (спек не даёт для room-transport.js):
синхронная обёртка над `verify()` (`core/crypto/sign.js`, чистый JS,
`nostr-tools`'s `verifyEvent`) — `(events) => events.map(verify)`, БЕЗ
Comlink/Worker. Обоснование: воркер-батчинг в `diagnostics.jsx`
оправдан объёмом bootstrap/incremental-sync (тысячи событий); комната —
единицы участников, десятки событий в секунду на пике — синхронная
проверка дешевле лишнего движущегося узла (Worker), тот же принцип
минимализма, что ROOMS-ALGO §9 "что не оптимизировать". Публичный
контракт `openRoomTransport` не получает параметр `verifyBatch` —
это внутренний выбор модуля, не наружная настройка.

**Предфильтр — обязателен (ROOMS-SPEC §4.2 буквально), в `onBatch`
перед вызовом `onEvent` на КАЖДОЕ событие батча:**
1. Верный `h`-тег: `event.tags` содержит `["h", hTopic]` — защита в
   глубину сверх relay-side фильтра (тот же принцип "не доверять
   фильтрации только на стороне сети", что и общий транспортный слой
   проекта) — событие без совпадающего тега молча отбрасывается, не
   ошибка (chужая комната по совпадению подписки — рутинный случай).
2. `event.kind === CALL_SIGNAL_KIND` — дополнительно проверить `p`-тег:
   есть `["p", selfPubkey]` в `event.tags` — иначе отбросить БЕЗ
   попытки расшифровки (расшифровка чужого NIP-44-события бросает
   исключение — ловить как штатный поток недопустимо, ROOMS-SPEC §4.2).
   Остальные 4 kind не несут `p` — предфильтр пропускает их всегда
   (после проверки 1).
Оба пункта — синхронные проверки тегов, до любой попытки `parse*`
(`room-events.js`/`signaling-adapter.js` вызываются ВЫШЕ, оркестратором,
не внутри `room-transport.js` — транспорт передаёт наружу сырое
событие через `onEvent(event)`, не расшифровывает сам: "не знает про"
формат payload, только про маршрутизацию, ROOMS-SPEC §1.2).

`publish(event) -> Promise<{ok, reason}>` — прямая передача
`publisher.publish`. `close()` — `conn.close()` (весь коннекшн
целиком, комната не мультиплексирует соединение с чем-либо ещё,
ROOMS-SPEC §0: "второй, независимый транспортный клиент") — не
требует явного `CLOSE` подписки перед этим, закрытие сокета обрывает
всё сразу.

**Находка при тестировании (`tests/room-transport.test.js`) — гонка
харнесса `ws-bridge`/`fake-relay`, актуальна и для `room-session.js`'s
тестов (Этап 2, дальше):** при ДВУХ независимых `openRoomTransport`
на одном `relayUrl` (два "участника") единичная пара `waitFor(() =>
relay.pending().length > 0); relay.flushAll();` гонится сама с собой —
REQ первого участника может прийти на relay, сработать `pending>0`,
уйти в `flushAll()` ДО того, как REQ второго участника физически
долетел по сокету; результат — второе событие "протухает" в очереди
и путает следующую проверку (наблюдалось живьём: `await
alice.publish(...)` зависал навсегда). Фикс — `flushUntilSettled(relay)`
хелпер: несколько раундов "подождать 40мс → если pending непусто,
слить" вместо одной точки синхронизации. Используется вместо
однократного `waitFor+flushAll` везде, где в сценарии больше одного
независимого транспортного клиента.

### room-transport.js — Этап 3: `hDisc` — второй, опциональный фильтр (открытый режим)

```js
openRoomTransport({relayUrl, hTopic = null, hDisc = null, selfPubkey, onEvent}) -> Promise<{ publish, close }>
```

Хотя бы один из `hTopic`/`hDisc` обязателен (бросает иначе — явная
ошибка конфигурации, не тихий no-op). Причина двух режимов:
- **Обнаружение по паролю** (`room-session.js`'s `joinRoomByPassword`,
  ниже): `suffix` ещё не известен → `hTopic` нет вовсе, только `hDisc`
  (слушать указатели `ROOM_POINTER_KIND`).
- **Открытый режим создателя**: `hTopic` уже есть (обычная сессия) —
  и ДОПОЛНИТЕЛЬНО `hDisc`, чтобы услышать конкурирующие указатели
  других создателей той же пары `(n,p)` (И9).

Если оба заданы — ОДНА подписка (`subscriber.subscribe`) с ДВУМЯ
фильтрами в массиве (стандартный nostr REQ с несколькими фильтрами —
тот же приём, что `[{"#h": groupIds, kinds:[445]}]`-подписки в
`transport.js`, просто с двумя объектами вместо одного), не два
отдельных REQ. `ROOM_POINTER_KIND` маршрутизируется по `hDisc` (свой
случай в `onBatch`, отдельный от общего `hTopic`-предфильтра — теги
`h` для POINTER и для остальных четырёх kind РАЗНЫЕ значения, единая
проверка `hasTag(event,"h",hTopic)` неверно отбросила бы POINTER).
`CALL_SIGNAL_KIND`'s `p`-предфильтр не затрагивается — POINTER никогда
не несёт `p`, ветка POINTER выходит из `onBatch`'s цикла раньше него
(`continue`).

## room-session.js [C] — design-записка (skill п.13b, оркестратор — нетривиальное связывание 7 чистых модулей + 2 адаптера)

ROOMS-SPEC §1.3 не даёт сигнатур буквально ("единственное место, где
ядро встречается с адаптерами... владеет одним таймером sweep...
отдаёт сигналы для UI") — контракт ниже спроектирован Claude как
[C]-автор, зафиксирован ДО тестов.

### Область Этапа 2

Только LINK-режим (участник знает `(name, password, suffix)` — суффикс
получен из инвайт-ссылки вне кода; сама ссылка/её парсинг — Этап 3 UI,
не здесь). Открытый режим (поиск по `hDisc` без suffix, Р1/И9) —
ОТЛОЖЕН, не реализуется этим этапом: `hDisc` вычисляется
`deriveRoomKeys`, но ничем не используется в `room-session.js` до
Этапа 3. Голос (kind 20075) — `room-transport.js` уже готов его
пропускать (Этап 2 контракт), но `room-session.js` НЕ обрабатывает
его вовсе (нет `mesh-supervisor.js` до Этапа 4) — событие молча
проходит мимо диспетчера (`default`-ветка).

### Публичный API — два фабричных входа, не один с булевым флагом

```js
createRoom({ name, password, nick, relayUrl, argon2, now, random,
             sweepIntervalMs, setIntervalImpl, clearIntervalImpl, onChange })
  -> Promise<RoomSessionHandle>

joinRoom({ name, password, suffix, nick, relayUrl, argon2, now, random,
           sweepIntervalMs, setIntervalImpl, clearIntervalImpl, onChange })
  -> Promise<RoomSessionHandle>
```

`createRoom` не принимает `suffix` — генерирует сама
(`bytesToHex(crypto.getRandomValues(new Uint8Array(16)))`, 128 бит,
формат не фиксирован спекой — комбинаторика энтропии в ROOMS-MATH §1
про количество бит, не про кодировку). `argon2` по умолчанию —
`defaultSlowKdf` (room-keys.js). `now`/`random`/`setIntervalImpl`/
`clearIntervalImpl` — та же инъекция, что везде в проекте
(`WebSocketImpl` в relay-pool.js — прецедент), позволяет тестам
подменить таймер фейковым перехватчиком вместо ожидания реальных
45 секунд.

```js
RoomSessionHandle = {
  getPubkeyHex(),
  getSuffix(),                          // createRoom: сгенерированный; joinRoom: тот же, что передан
  isReady(),                            // false у joinRoom, пока не пришёл первый ANNOUNCE (salt неизвестен)
  getPresent() -> Array<{pubkey, nick, joinedAt}>,   // presence.js's present()
  getMessages() -> Array<{id, createdAt, pubkey, nick, text}>, // message-log.js's toArray()
  getRoomState() -> {name, k},          // room-machine.js state
  sendChat(text) -> Promise<{ok, reason}>,  // rejects, если !isReady()
  close(),                              // без явного exit-события — см. ниже
}
```

### Почему `createRoom`/`joinRoom`, а не один вызов с флагом `isCreator`

Асимметрия реальна (создатель сразу знает `salt`, входящий — нет,
плюс входящий обязан отправить `ROOM_PROBE` немедленно) — два имени
яснее для будущего UI (Этап 3: два разных экрана/кнопки), чем один
вызов с булевым переключателем поведения.

### Ready-переход: единственный триггер — `salt` известен

И для создателя (`salt` генерируется на месте,
`crypto.getRandomValues(new Uint8Array(32))`, `isReady()` истинно с
первого тика), и для входящего (`salt` приходит из ПЕРВОГО валидного
`ANNOUNCE`) — `kSess = deriveSessionKey(kRv, salt)` вычисляется РОВНО
один раз, при переходе в ready. Повторные `ANNOUNCE` с ДРУГИМ `salt`
после того, как `kSess` уже установлен, ИГНОРИРУЮТСЯ (И9 — конкурентные
создатели одного `(n,p)` — вне области Этапа 2, честно
задокументировано как упрощение, не молчаливый пробел).

### Диспетчер входящих событий (`onEvent` из `room-transport.js`)

Один `switch(event.kind)`:
- `ROOM_ANNOUNCE_KIND` → `parseRoomAnnounceEvent(event, kRv)`; если
  `payload && !ready` → установить `salt`, вычислить `kSess`, `ready =
  true`, вызвать `onChange()`. Если уже `ready` — игнор (см. выше).
- `ROOM_PROBE_KIND` → `parseRoomProbeEvent(event, kRv)`; если валиден
  И `ready`: **немедленно** `publishAnnounce(now())` (публикация НЕ
  через `trickle.shouldTransmit` — ROOMS-SPEC §5.2 буквально "отвечают
  анонсом НЕМЕДЛЕННО", это отдельный от периодики путь), **И
  немедленно `publishHeartbeat(now())`** (найдено тестом — БЕЗ этого
  новичок узнаёт, что комната жива, но не видит УЖЕ присутствующих до
  их следующего обычного heartbeat, до δ=15с; ROOMS-SPEC не оговаривает
  это явно, но цель §5.2 — быстрый онбординг новичка, а не только
  подтверждение существования комнаты), ЗАТЕМ `trickle.onInconsistent();
  trickle.onInterval(now())` (сброс периодического таймера, чтобы не
  задвоить анонс скоро после; `lastHeartbeatAt` тоже обновляется на
  `now()`, чтобы обычный sweep-тик не отправил ещё один heartbeat почти
  сразу же). Если `!ready` — игнор (нечем ответить, `salt` ещё не
  известен).
- `ROOM_PRESENCE_KIND` → игнор, если `!ready` (нечем расшифровать).
  Иначе `parseRoomPresenceEvent(event, kSess)`; `type==="heartbeat"` →
  `presence.mergeHeartbeat`; `type==="exit"` → `presence.mergeExit`;
  затем пересчитать `room-machine` (см. ниже) и `onChange()`.
- `ROOM_CHAT_KIND` → игнор, если `!ready`. Иначе
  `parseRoomChatEvent(event, kSess)` → `messageLog.insert(...)` →
  `onChange()` (дедуп по `id` — уже в `message-log.js`, свои же
  опубликованные сообщения возвращаются через ту же подписку и просто
  не дублируются — ОДИН путь вставки, не два, см. ниже).
- `CALL_SIGNAL_KIND`/другое → игнор (Этап 4).

### Собственные сообщения идут через ТОТ ЖЕ путь, не отдельной веткой

`sendChat` публикует и НЕ вставляет в `message-log` напрямую — событие
возвращается через ту же подписку (relay эхом отдаёт публикующему её
же событие при совпадающем фильтре — подтверждено `fake-relay.js`'s
`publish()`: рассылка всем совпавшим подпискам, включая подписку
публикующего). Один код-путь вставки вместо двух, `message-log.js`'s
дедуп по `id` делает эту схему безопасной даже если предположение
об эхо когда-нибудь окажется неверным для какого-то релея (просто
сообщение не появится — не задвоится).

### Sweep-тик — единственный таймер модуля (ROOMS-SPEC §1.3 буквально)

```js
function tick() {
  const t = now();
  presenceState = presence.prune(presenceState, t, PRESENCE_TAU_MS);
  const currentK = presence.present(presenceState, t, PRESENCE_TAU_MS).length;
  roomMachineState = syncRoomMachineK(roomMachineState, currentK, t);   // ниже
  roomMachineState = roomMachine.checkTimeout(roomMachineState, t, PRESENCE_TAU_MS);
  if (ready) {
    if (t - lastHeartbeatAt >= HEARTBEAT_INTERVAL_MS) { publishHeartbeat(t); lastHeartbeatAt = t; }
    if (trickle.getIntervalEnd() === null || t >= trickle.getIntervalEnd()) trickle.onInterval(t);
    if (trickle.shouldTransmit(t)) publishAnnounce(t);
  }
  onChange();
}
```
`HEARTBEAT_INTERVAL_MS = 15000` (δ), `PRESENCE_TAU_MS = 45000` (τ) —
ИМЕНОВАННЫЕ константы В ОДНОМ месте (`room-session.js`), тот же
принцип, что `MAX_VOICE_PARTICIPANTS`. `sweepIntervalMs` (по умолчанию
1000) — частота самого тика, НЕ δ/τ — грубая гранулярность в 1с более
чем достаточна против интервалов порядка 15-60с.

`syncRoomMachineK(state, targetK, now)` — реконсиляция room-machine.js
к текущему размеру `Present(t)` (пробел контракта room-machine.js,
закрыт здесь, не там: сам автомат меняет `k` на ±1 за вызов, но
`present().length` может скакнуть больше чем на 1 за один тик — если
несколько heartbeat/exit обработаны в одном батче подписчика):
```js
function syncRoomMachineK(state, targetK, now) {
  if (state.name === "dead" && targetK > 0) state = roomMachine.emptyRoomState(); // новый экземпляр, не переход ИЗ dead
  while (state.k < targetK) state = state.name === "empty" ? roomMachine.create(state) : roomMachine.join(state);
  while (state.k > targetK) state = roomMachine.leave(state, now);
  return state;
}
```

### `close()` — БЕЗ явного exit-события (сознательное решение, не пробел)

ROOMS-SPEC §0: "Закрытие вкладки — конец, без уборки". Этап 2 DoD
явно тестирует именно τ-путь исчезновения ("один уходит — ЧЕРЕЗ τ
исчезает у второго"), не graceful-exit. `close()` останавливает sweep
(`clearIntervalImpl`) и зовёт `transport.close()` — ничего больше.
Явное прощальное `ROOM_PRESENCE` с `type:"exit"` для мгновенного UX
при осознанном "покинуть комнату" (кнопка) — ВОЗМОЖНОЕ будущее
улучшение Этапа 3+, не реализуется здесь: основной путь (закрытая
вкладка) обязан работать без него, раз лизинговая модель ИМЕННО ради
этого спроектирована — тестировать нужно её, а не оптимизацию поверх.
И7 (ничего в IndexedDB) — тривиально выполнен отсутствием побочных
эффектов, как и `room-identity.js`.

### PROBE публикуется joinRoom СРАЗУ при открытии транспорта

До первого sweep-тика — `joinRoom` публикует `ROOM_PROBE_KIND` сразу
после `openRoomTransport` резолвится (не ждёт тика/trickle), чтобы
уложиться в ROOMS-SPEC §5.2's 3-секундное окно ожидания ответа.

## room-session.js — Этап 3: открытый режим, `joinRoomByPassword`, И9 (design-записка, 13b)

### `argon2` ровно один раз через две фазы — `precomputedKBase`

Открытый режим требует ДВУХ последовательных фаз с РАЗНЫМИ ключами
маршрутизации (сначала `hDisc`, потом `hTopic`), но `argon2` обязан
вызываться один раз за сессию (ROOMS-ALGO §8). Решение: `openSession`
(внутренняя функция, не экспортируется) принимает необязательный
`precomputedKBase` — если задан, `deriveKBase` пропускается, `kBase`
берётся готовым; `derivePairKeys`/`deriveLinkKeys` (быстрые) всё равно
считаются заново от него. `joinRoomByPassword` вызывает `deriveKBase`
САМА (для фазы обнаружения), затем передаёт результат в `openSession`
как `precomputedKBase` — второго вызова `argon2` не происходит.

### Новый экспорт: `joinRoomByPassword`

```js
joinRoomByPassword({ name, password, nick, relayUrl, argon2, now, random,
                      sweepIntervalMs, setIntervalImpl, clearIntervalImpl,
                      onChange, discoveryTimeoutMs = 5000 })
  -> Promise<RoomSessionHandle>
```

Алгоритм: `kBase = deriveKBase(...)` → `{hDisc, kPointer} =
derivePairKeys(kBase)` → `suffix = await discoverSuffixViaPointer(...)`
(ниже) → если `null` (ничего не нашлось за окно) — **бросает** явную
ошибку ("комната не найдена") — не тихий провал → `openSession({...,
suffix, precomputedKBase: kBase, isCreator: false})`, дальше ИДЕНТИЧНО
обычному `joinRoom` (PROBE, ожидание ANNOUNCE и т.д. — суффикс уже
есть, остальной путь не отличается).

### `discoverSuffixViaPointer` — внутренняя, не экспортируется

```js
discoverSuffixViaPointer({ hDisc, kPointer, relayUrl, discoveryTimeoutMs }) -> Promise<suffix | null>
```

Открывает ОТДЕЛЬНЫЙ короткоживущий `openRoomTransport({relayUrl, hDisc,
selfPubkey: PLACEHOLDER, onEvent})` (`hTopic` не передаётся —
`room-transport.js`'s Этап-3 контракт это разрешает); собирает ВСЕ
`ROOM_POINTER_KIND` (расшифрованные через `parseRoomPointerEvent`) за
`discoveryTimeoutMs` (реальное время — `setTimeout`, БЕЗ инъекции: это
одноразовый bootstrap-шаг, не входит в sweep-контур, тесты используют
маленький `discoveryTimeoutMs`, напр. 300мс, вместо подмены часов —
тот же компромисс, что уже был у `flushUntilSettled` в тестах
транспорта); затем закрывает transport, сортирует собранные `{id,
suffix}` лексикографически по `id`, возвращает `suffix` минимального
(ROOMS-MATH §1.4 — тот же тайбрейк, что решает И9). Пусто — `null`.
`selfPubkey` — заглушка (не используется фильтрацией POINTER-ветки,
но обязательный параметр контракта `openRoomTransport`).

### `createRoom({..., openMode = false})` и И9-тайбрейк

Если `openMode`: сразу после `becomeReady` (немедленно, тот же момент,
что генерация `salt` — не ждёт тика) публикует СВОЙ `ROOM_POINTER_KIND`
под `hDisc`; ЗАПОМИНАЕТ `id` этой ПЕРВОЙ публикации как `ownPointerId`
(последующие переопубликования указателя — см. ниже — получают НОВЫЙ
`id` каждый раз из-за разного `created_at`/подписи, но сравнение И9
использует ТОЛЬКО `id` первой, "исходной" заявки — семантика "кто
заявил раньше", не "чей последний повтор свежее"). Транспорт
открывается С ОБОИМИ `hTopic` И `hDisc` (Этап-3 room-transport.js
контракт) — сессия слышит и обычный трафик комнаты, и конкурирующие
указатели.

**Переопубликование указателя** — на той же периодике, что ANNOUNCE:
в `tick()`, когда `trickle.shouldTransmit(t)` истинно И `openMode` —
ТАКЖЕ `publishPointer(t)` (не только `publishAnnounce`), чтобы поздние
`joinRoomByPassword`-обнаружения находили комнату (эфемерные события,
ретеншн relay ограничен — см. AUDIT.md, спайк 0.1).

**Сравнение (И9)** — диспетчер `ROOM_POINTER_KIND` в `handleEvent`:
```
если !openMode или ownPointerId===null → игнор (не создатель открытого режима / ещё не заявились)
если now() - ownPointerPublishedAt >= τ → игнор (окно гонки закрыто, ROOMS-MATH §1.4 буквально: "окно длиной τ")
payload = parseRoomPointerEvent(event, kPointer); если невалиден → игнор
если payload.id < bestPointerId (изначально = ownPointerId):
    bestPointerId = payload.id; bestSuffix = payload.suffix
    если bestSuffix !== свой suffix → raceOutcome = {winningSuffix: bestSuffix}; onChange()
```
Однажды установленный `raceOutcome` НЕ откатывается (`bestPointerId`
монотонно убывает, поэтому опасаться "передумывания" не нужно —
минимум по построению стабилен).

**Сессия НЕ телепортируется в victim/winner сама.** Обнаружив
поражение, `room-session.js` не мутирует себя в joiner — это
означало бы скрытую пересборку идентичности/ключей внутри уже живого
объекта, лишний источник багов. Вместо этого `raceOutcome` — СИГНАЛ
наружу (`getRaceOutcome()` на хендле + `onChange()`), решение "закрыть
эту сессию и переподключиться через `joinRoom(..., suffix:
winningSuffix)`" — ответственность ВЫЗЫВАЮЩЕГО кода (Этап 3 UI,
позже — оркестратор `room-session.js` этим не занимается, только
сигнализирует, ROOMS-SPEC §1.3: "отдаёт сигналы для UI"). Проигравший,
пока не переподключился, остаётся полностью рабочей (хоть и
обречённой) комнатой — не ломается сам по себе.

### `RoomSessionHandle` — новый геттер

```js
getRaceOutcome() -> null | { winningSuffix }
```
`null` всегда для `joinRoom`/`joinRoomByPassword`-сессий и для
`createRoom` без `openMode` (пусто, гонки не отслеживаются).

### И11 (комната переживает уход создателя) — не требует нового кода

"Нет роли создателя" (Р5, ROOMS-MATH) уже встроено в архитектуру Этапа
2: КАЖДЫЙ `ready`-участник ведёт свой собственный `trickle`/heartbeat
независимо, `room-machine`-реконсиляция — per-observer. Уход создателя
— обычный `mergeExit`/протухание аренды с точки зрения оставшихся,
ничем не отличается от ухода любого другого участника. И11 — тест,
подтверждающий существующее поведение, не новая реализация.

## UI (`quick.jsx`, `app.jsx`, `unlock.jsx`) — Этап 3

### Точки входа — ДВЕ, не одна (ROOMS-SPEC §1.4 буквально)

`Quick` (`src/ui/screens/quick.jsx`) — самодостаточный компонент
(принимает `onExit`, не привязан к аккаунту), смонтирован в ДВУХ
независимых местах:
1. `unlock.jsx`'s существующая вкладка `mainView==="temp-chat"`
   (гость, не залогинен) — эта вкладка УЖЕ существовала как заглушка
   (`unlock.main.tempChat.*`, "раздел ещё не реализован — эта страница
   появилась раньше самой функции") — Этап 3 просто подставляет
   реальный компонент вместо текста-заглушки, старые ключи удалены
   (все 12 локалей).
2. `app.jsx`'s новый модульный сигнал `roomsScreenActive` (`signal`,
   НЕ `useState` внутри `MainShell` — доступен `App()` СНАРУЖИ
   `MainShell`), проверяется В `App()` ПЕРВЫМ, до `currentUser` —
   именно это даёт "не внутри MainShell" буквально: залогиненный
   пользователь нажимает кнопку в сайдбаре (`shell.quickConnect`),
   `App()` рендерит `<Quick>` ВМЕСТО `<MainShell>`, не как вкладку
   внутри неё.

### Инвайт-ссылка — копируемая строка, НЕ настоящий URL/роут

`roomlink:v1:` + `base64(JSON.stringify({name, password, suffix}))`.
Сознательное упрощение: реальный `https://`-роут потребовал бы
интеграции с `router.js` (отдельная задача, вне Этапа 3). Кодирует ВСЕ
три поля разом — вошедший по ссылке не вводит ничего руками.
Закрытый режим: `encodeInviteLink` вызывается после `createRoom`/
`joinRoom`. Открытый режим (`joinRoomByPassword`): ссылка тоже
строится (тем же кодированием) из найденных `name`/`password` — она
эквивалентна закрытой ссылке на ТУ ЖЕ комнату (тот же `suffix`, уже
обнаруженный), просто доставлена другим путём.

### `activeRoomName`/`activeRoomPassword` — единый источник правды (найдено живой проверкой)

**Живой баг, пойманный на реальном strfry, не автотестами:** заголовок
комнаты и `handleReconnectToWinner` изначально читали `roomName ||
joinPwName` — при входе В ОДНОЙ вкладке СНАЧАЛА через "Создать", ПОТОМ
через "По паролю" в другую комнату, `roomName` от первой попытки
оставался непустым и "побеждал" в `||`-цепочке: заголовок и
потенциальный reconnect молча указывали на СТАРУЮ комнату. Фикс —
`attachSession(session, invite, name, password)` явно получает
разрешённые `name`/`password` от ТОГО ЖЕ вызова, что открыл сессию
(из `decoded.name`/`decoded.password` для ссылки, из `joinPwName`/
`joinPwPassword` для пароля, из `roomName`/`roomPassword` для
создания) — единственный источник правды `activeRoomName`/
`activeRoomPassword`, не производный от полей форм, которые могли с
тех пор смениться.

### `MessageBubble` — адаптер полей, не новый компонент чата

`message-bubble.jsx` ожидает `{msgId, text, sentAt (СЕКУНДЫ),
deleted, edited, status}` — Rooms передаёt `{msgId: m.id, text: m.text,
sentAt: Math.floor(m.createdAt / 1000), deleted: false, edited:
false}` (без `status`/`onEdit`/`onDeleteFor*` — компонент сам скрывает
кнопки редактирования/удаления при их отсутствии, ROOMS-SPEC §6
Этап 3: "переиспользовать message-bubble.jsx через пропсы... НЕ
chat.jsx").

### `publisher.js` — фикс инфраструктурного бага, найденного живой проверкой (Этап 3, не Rooms-контракт)

**Не входит в контракты Rooms** — `core/transport/publisher.js`
существовал до Rooms, используется ПОВСЮДУ в проекте (chat/channels/
files/contacts/…). Живая проверка (два реальных таба Chrome, реальный
strfry) поймала: `close()` соединения между `publish()` и срабатыванием
отложенного `flush()` (`batchWindowMs=200мс`) — `connection.send()`
бросает СИНХРОННО ("недоступен в состоянии disconnected") ИЗ
`setTimeout`-колбэка → необработанное исключение уровня вкладки, а не
просто неудача публикации. Воспроизведено буквально: "Покинуть
комнату" сразу после создания.

Фикс: `flush()` оборачивает каждый `connection.send()` в try/catch;
при ошибке — `reject()` ожидающего `publish()` (тот же контракт, что
уже есть для `OK:false` от relay), остальные события батча всё равно
пытаются уйти (одна неудача не блокирует другие). Аддитивная,
консервативная правка (не меняет форму возвращаемого объекта/сигнатуры)
— полная регрессия обязательна и пройдена (правило 13, инфраструктура
общая, менять может только Claude явным решением).

# Rooms («Быстрая связь») — Этап 4: голос — design-записка (skill п.13b)

Три решения ниже НЕ даны буквально ни в ROOMS-SPEC, ни в ROOMS-MATH/
ROOMS-ALGO — спека фиксирует контракт `mesh-supervisor.js` и владение
микрофоном (§4.3), но не то, ЧЕРЕЗ ЧТО участники узнают друг о друге
"кто сейчас в голосе", и не то, как разрешается гонка на лимите
`MAX_VOICE_PARTICIPANTS` при одновременных входах (И10 требует
безопасности "при любой последовательности... включая одновременные").
Решения — Claude как [C]-автор, в рамках уже принятых паттернов
проекта (LWW-по-`at`, детерминированный тайбрейк без арбитра — тот же
язык, что И9/mesh-турнир).

## 1. `VoicePresent ⊆ Present` — сигнализируется через presence-heartbeat, не новый kind

`VoicePresent` (ROOMS-MATH §4.3) нигде не определяет МЕХАНИЗМ. Решение:
расширить существующий `ROOM_PRESENCE_KIND` heartbeat полем `inVoice`
— НЕ заводить отдельный kind/событие. Обоснование: heartbeat УЖЕ несёт
per-participant состояние на кадансе δ=15с ("я здесь, вот мой nick") —
"я в голосе" того же рода факт про того же участника в тот же момент,
плодить второй канал ради одного булева поля не оправдано (тот же
принцип минимализма, что ROOMS-ALGO §9).

`presence.js`: `mergeHeartbeat(state, {pubkey, nick, inVoice = false,
at})` — `inVoice` LWW ПО ТОЙ ЖЕ `at`, что уже решает `nick` (оба поля
приходят в одном heartbeat, отдельная временная метка на `inVoice` не
нужна — они всегда обновляются вместе). `present()` возвращает
`{pubkey, nick, joinedAt, inVoice}` — аддитивное поле в уже
существующей форме. `mergeExit` не трогается: вышедший не проходит
`present()`-предикат (`a>r`) независимо от `inVoice`, специального
случая не требуется.

`room-events.js`: `buildRoomPresenceEvent(...,{type:"heartbeat", nick,
inVoice}, ...)` — `inVoice` необязателен (по умолчанию `false`,
обратная совместимость с уже подписанными Этапом 2/3 событиями).
`type:"exit"` не несёт `inVoice` (уход есть уход, независимо от того,
был ли участник в голосе).

`room-session.js`: `getVoicePresent()` = `present(...).filter(p =>
p.inVoice)` (уже отсортирован по `joinedAt`, presence.js's гарантия
Этапа 1 — переиспользуется, не пересортировывается).

## 2. Авто-accept внутри mesh-рёбер — НЕ пользовательский ring/decline

Существующий `call-fsm.js` при входящем offer уходит в
`INCOMING_RINGING`, ждёт explicit `accept()`/`reject()` — правильно
для 1:1 звонка, НЕВЕРНО для mesh-ребра: клик "войти в голос" на
уровне КОМНАТЫ уже есть согласие, пятеро отдельных всплывающих "вам
звонят" были бы неюзабельны. `mesh-supervisor.js`'s созданные
runtime'ы для КАЖДОГО ребра подписывают `onStateChange`: при
`stateName==="INCOMING_RINGING"` — немедленно `runtime.accept()`, без
участия пользователя. Это НЕ противоречит Р4 ("не подключать
автоматически при освобождении места — показать кнопку") — тот пункт
про решение НА УРОВНЕ КОМНАТЫ (входить в голос вообще), не про
согласие на каждое отдельное ребро уже ПОСЛЕ входа.

**Glare между рёбрами не возникает по построению** — `mesh.js`'s
`edges()` даёт РОВНО одного инициатора на пару (турнир), отвечающая
сторона никогда сама не вызывает `placeCall()`. Существующий
glare-путь в `call-fsm.js` остаётся как защитная сеть на случай гонки
переходов ростера, не как ожидаемый штатный путь.

## 3. И10 при гонке — детерминированная само-эвикция, не арбитр

Локальная проверка "уже 5? тогда отказ" на `joinVoice()` защищает от
ПОСЛЕДОВАТЕЛЬНЫХ входов (DoD буквально: "4-й и 5-й подключаются,
6-й видит занято"), но НЕ от одновременных (два участника видят
локально "ещё есть место", оба присоединяются, суммарно 6 — та же
природа гонки, что И9 у создания комнаты).

Решение — тот же язык, что уже есть в проекте (детерминированный
тайбрейк без согласования, ROOMS-MATH §1.4/И9 precedent): каждый
`ready`-участник в `tick()` пересчитывает `getVoicePresent()`
(уже стабильно отсортирован по `joinedAt` — presence.js's гарантия),
и если СОБСТВЕННАЯ позиция в этом списке `>= MAX_VOICE_PARTICIPANTS`
— вызывает `leaveVoice()` САМ У СЕБЯ (само-эвикция, не команда
извне). Детерминировано: все наблюдатели видят один и тот же
CvRDT-снимок presence, значит вычисляют один и тот же отсортированный
список и одного и того же "лишнего".

**Принятое упрощение:** тайбрейк использует `joinedAt` ВХОДА В
КОМНАТУ (текст), не отдельный момент входа в голос — presence.js уже
считает и сортирует по нему (Этап 1), заводить параллельное поле
`voiceJoinedAt` ради более "справедливого" тайбрейка на редком
пограничном случае не оправдано. Эффект: при столкновении выигрывает
тот, кто раньше вошёл В КОМНАТУ, не в голос — задокументированный,
не молчаливый компромисс.

## 4. `mesh-supervisor.js` — внутренняя структура

```js
createMeshSupervisor({selfPubkey, selfPrivKey, hTopic, publish, maxVoice, getUserMedia})
  -> {joinVoice, leaveVoice, updateRoster, onSignal, getEdgeStates}
```

Замыкание держит: `sharedStream` (захватывается в `joinVoice()`,
освобождается в `leaveVoice()`), `edgesByPeer: Map<peerPubkey,
{runtime, role}>`, `currentMyEdges` (для `diffEdges` между
пересчётами).

`updateRoster(pubkeys)` — `pubkeys` включает `selfPubkey` (полный
снимок голосового состава, не "все кроме меня" — проще: `edges.js`
уже принимает полный список и сам ориентирует). Алгоритм:
```
allEdges = edges(pubkeys)
myNewEdges = allEdges.filter(([a,b]) => a === selfPubkey || b === selfPubkey)
{toOpen, toClose} = diffEdges(currentMyEdges, myNewEdges)
currentMyEdges = myNewEdges
для каждого ребра в toClose: edgesByPeer.get(peer).runtime.hangup(); edgesByPeer.delete(peer)
для каждого ребра в toOpen:
  peer = участник ребра, отличный от selfPubkey
  role = (эта сторона — "i" в паре [i,j]) ? "initiator" : "responder"
  runtime = createCallRuntime({myPubkey: selfPubkey, privKey: selfPrivKey, publish,
    iceServers, createMediaController: (opts) => defaultCreateMediaController({...opts,
      getUserMediaImpl: () => Promise.resolve(sharedStream.clone())}),
    onStateChange: (stateName) => { if (stateName === "INCOMING_RINGING") runtime.accept(); }})
  edgesByPeer.set(peer, {runtime, role})
  если role === "initiator": runtime.placeCall(peer)
```
Если `updateRoster` вызван ДО `joinVoice()` (нет `sharedStream`) —
no-op (нечем открывать рёбра; `room-session.js` контрактно вызывает
`updateRoster` только после `joinVoice()` резолвится, но защита
внутри не лишняя).

`onSignal(payload, senderPubkey)` — маршрутизация по `edgesByPeer.get(senderPubkey)`;
находит через `signalingAdapter.toFsmEvent(payload, senderPubkey, selfPubkey)`
и `runtime.handleIncomingSignal`-эквивалент (напрямую `dispatch`
недоступен снаружи `call-runtime.js` — `onSignal` реконструирует сырое
"событие" достаточное для `runtime.handleIncomingSignal`, ЛИБО
`room-session.js` передаёт уже готовый nostr-event, а `onSignal`
делегирует `runtime.handleIncomingSignal(event)` напрямую — см. ниже
точный контракт `onSignal`, выбран ВТОРОЙ вариант: `onSignal(event)`
принимает СЫРОЕ nostr-событие (не заранее распарсенный payload),
делегирует расшифровку `signalingAdapter.parseCallSignalEvent`
ВНУТРИ каждого `call-runtime.handleIncomingSignal` — тот уже умеет
это делать (`call-runtime.js:157-166`), не нужно распаковывать
дважды.

**ИСПРАВЛЕНО после живой проверки (три реальных браузера, полная
тишина — voice-звонки НИКОГДА не соединялись):** первая версия при
отсутствии пира в `edgesByPeer` молча отбрасывала событие ("рутинная
гонка закрытия"). Но `heartbeat` (объявляет ростер) и `offer`
(сигнал ребра) — ДВЕ НЕЗАВИСИМЫЕ публикации без гарантии порядка
доставки (разные kind, разные batching-окна `publisher.js`). Если
`offer` от инициатора приходит РАНЬШЕ, чем наш `updateRoster` узнал о
нём через heartbeat — `edgesByPeer` для этого пира ещё пуст, событие
проваливалось НАВСЕГДА (retry нет, ребро не формировалось никогда).
Воспроизводилось стабильно на реальном оборудовании — это была не
редкая гонка, а типичный порядок событий (мгновенный `offer` сразу за
`joinVoice()`, `heartbeat` идёт отдельным путём).

Исправление: `onSignal` при отсутствии ребра, если `sharedStream`
существует (мы САМИ в голосе), реактивно вызывает `openEdge(peer,
"responder")` — событие уже прошло предфильтр `room-transport.js`
(тег `p=self`, `h=hTopic`, валидная NIP-44-расшифровка внутри
`handleIncomingSignal`), отправитель криптографически легитимен для
комнаты. Роль всегда `"responder"` (инициатор сам шлёт offer, не
ждёт его — так реактивно открывать себя как инициатора он бы не стал).
`currentMyEdges` синхронизируется В ТОТ ЖЕ момент — иначе следующий
`updateRoster()` посчитал бы это ребро "новым" и продублировал открытие.

**Известное принятое ограничение:** та же реактивная логика не
отличает "offer обогнал ещё актуальный heartbeat" от "стухший сигнал
от пира, который уже НА САМОМ ДЕЛЕ вышел из голоса" — во втором
случае реактивно откроется фантомное ребро, которое просто не
дозвонится и со временем истечёт по уже существующим таймаутам
`call-fsm.js` (ring/connect timeout), не более. Не чинится сейчас —
редкий случай, самозаживающий существующей инфраструктурой, не
блокирует основной сценарий.

`joinVoice()` — `sharedStream = await getUserMedia({audio:true})`,
затем `updateRoster` вызывается СНАРУЖИ (`room-session.js`), не
изнутри `joinVoice()` (симметрично: `room-session.js` уже знает
актуальный ростер лучше, чем `mesh-supervisor` в момент, когда мик
только что захвачен).

`leaveVoice()` — для каждого `edgesByPeer`: `runtime.hangup()`,
затем очистка карты; `sharedStream.getTracks().forEach(t=>t.stop())`;
`sharedStream = null`. Один явный останов — по спеке "Освобождение
общего потока — один раз, в leaveVoice()".

`getEdgeStates()` -> `Array<{peer, role, state}>` (state — снимок
`runtime.getState().name` на каждое ребро) — для UI (кто на связи, у
кого тишина).

### Аддитивные параметры сверх буквального контракта спеки

- `createCallRuntime` (по умолчанию — реальный `createCallRuntime` из
  `call-runtime.js`) — тот же DI-приём, что везде в проекте
  (`media-controller.js`/`call-runtime.js` сами так тестируются);
  спека не перечисляла его явно, но без инъекции `mesh-supervisor.js`
  нельзя протестировать без настоящего WebRTC. Не меняет поведение по
  умолчанию.
- `iceServers` (по умолчанию `[]`) — пробрасывается в каждый дочерний
  `createCallRuntime`, тот же смысл, что у `call.js`'s
  `BUILD_DEFAULT_ICE_SERVERS` для обычных звонков.

### `maxVoice` — защитное усечение ВНУТРИ, не единственная линия обороны

Основная эвикция при столкновении на лимите — на уровне
`room-session.js` (детерминированная само-эвикция по `joinedAt`, §3
выше). `maxVoice` внутри `mesh-supervisor.js` — вторая, defensive
линия: `updateRoster(pubkeys)` берёт `pubkeys.slice(0, maxVoice)` ДО
вычисления `edges()` — если чем-то (баг вызывающего кода, устаревший
снимок) в `mesh-supervisor` попадёт ростер длиннее лимита, супервизор
физически не создаст рёбер сверх `maxVoice−1` на узел. Порядок
элементов внутри `pubkeys` — ответственность вызывающего
(`room-session.js`'s `getVoicePresent()` уже отсортирован по
`joinedAt` — `mesh-supervisor` не пересортировывает, просто берёт
префикс).

## 5. `room-session.js` — точки интеграции (без нового публичного API сверх необходимого)

`joinVoice()`/`leaveVoice()` на хендле сессии — тонкие обёртки:
проверка лимита (см. §3) → ленивое создание `meshSupervisor` (один
раз на сессию, переиспользуется между повторными `joinVoice`/
`leaveVoice`) → делегирование → немедленная (не ждать тика)
публикация heartbeat с новым `inVoice` → оптимистичное локальное
`mergeHeartbeat` (не ждать эха с relay — тот же приём, что уже
есть для входящих heartbeat) → `meshSupervisor.updateRoster(...)`.

`handleEvent`'s `CALL_SIGNAL_KIND`-ветка (была "молча пропускаем",
Этап 2/3) — теперь: `if (meshSupervisor) meshSupervisor.onSignal(event)`.

`tick()` — новая проверка само-эвикции (§3) добавляется ПОСЛЕ
пересчёта `presenceState`/`roomMachineState`, ПЕРЕД обычной
heartbeat/trickle веткой.

### Аддитивные DI-параметры и новые поля `RoomSessionHandle` (Этап 4)

`createRoom`/`joinRoom`/`joinRoomByPassword` получают три новых
необязательных параметра, форвардятся в `openSession`:
- `getUserMedia` (по умолчанию `navigator.mediaDevices.getUserMedia`,
  тот же паттерн, что `media-controller.js`'s собственный дефолт).
- `iceServers` (по умолчанию `[]`) — UI-слой (`quick.jsx`) передаёт
  `BUILD_DEFAULT_ICE_SERVERS` явно, `room-session.js` сам `config.js`
  не импортирует (та же граница слоёв, что уже есть у
  `media-controller.js`/`call-runtime.js` — конфиг подключается на
  UI-уровне, не в domain).
- `createMeshSupervisor` (по умолчанию — реальный, из
  `adapters/mesh-supervisor.js`) — DI для тестов
  (`tests/room-session.test.js` подставляет фейковый супервизор,
  избегая необходимости фейковать WebRTC на два уровня вглубь).

`RoomSessionHandle` получает: `joinVoice()` (async, бросает при
`!ready` или заполненной голосовой части), `leaveVoice()`,
`getVoicePresent()` (= `getPresent().filter(p => p.inVoice)`),
`isVoiceActive()`, `getEdgeStates()` (делегирует
`meshSupervisor.getEdgeStates()`, `[]` до первого `joinVoice()`).

`close()` дополнительно вызывает `meshSupervisor.leaveVoice()`
НАПРЯМУЮ (не публичную обёртку `leaveVoice()`) — при закрытии сессии
локальная очистка микрофона/RTCPeerConnection обязательна независимо
от философии "без явного exit по сети" (ROOMS-SPEC §0 — та про
протокол, не про реальное железо: незакрытый трек держит индикатор
записи включённым в браузере), финальный heartbeat не публикуется —
транспорт закрывается следом.

---

## Rooms — Этап 4-довесок №2: `onRemoteStream` (звук доходил, но не
## воспроизводился нигде) + UI-правки по живому фидбеку пользователя

После фикса гонки offer/heartbeat (Этап 4-довесок №1) пользователь
проверил тремя реальными браузерами повторно — тишина СОХРАНИЛАСЬ.
Причина — второй, независимый пробел: `media-controller.js`'s
`pc.ontrack` доставляет удалённый `MediaStream` только через
инъецируемый `onRemoteStream`, а `mesh-supervisor.js`'s `openEdge`
его вообще не передавал в дочерний `createCallRuntime` — трек
физически доходил, но был никуда не подключён (тот же класс пробела,
что уже чинился в 1:1-звонках, `call-overlay.jsx`'s `RemoteAudio`,
комментарий там же: "без явного `<audio>` с `srcObject` звук так и
не звучит, сколько разрешений браузеру ни давай").

Фикс, аддитивная цепочка колбэка `onRemoteStream(peer, stream|null)`:
- `mesh-supervisor.js`: новый опциональный параметр `onRemoteStream`
  (по умолчанию no-op). `openEdge` передаёт дочернему
  `createCallRuntime` `onRemoteStream: (stream) => onRemoteStream(peer, stream)`.
  `closeEdge` вызывает `onRemoteStream(peer, null)` — сигнал UI
  остановить/убрать `<audio>` этого пира (ребро закрылось, поток
  больше не актуален).
- `room-session.js`: `openSession`/`createRoom`/`joinRoom`/
  `joinRoomByPassword` получают тот же аддитивный `onRemoteStream`,
  форвардят в `createMeshSupervisorImpl(...)` внутри `joinVoice()`
  (тот же паттерн, что уже есть у `getUserMedia`/`iceServers`).
- `quick.jsx`: `remoteStreams` — `Map<peerPubkey, MediaStream>` в
  локальном state; `handleRemoteStream(peer, stream)` добавляет/
  убирает запись (immutable-копия Map на каждое изменение — Preact не
  видит мутацию существующего Map как повод перерендерить). Рендерит
  по одному скрытому `<audio autoPlay>` НА ПИРА (`RoomRemoteAudio`,
  локальный компонент, `srcObject` через `useEffect`+`ref` — калька
  `call-overlay.jsx`'s `RemoteAudio`) — голос комнаты мультиучастник,
  один общий `<audio>` как в 1:1-звонках не годится. `remoteStreams`
  сбрасывается в `attachSession`/`handleLeave`/`handleLeaveVoice`.

Тесты: 2 новых в `tests/mesh-supervisor.test.js` — дочерний runtime
получает `onRemoteStream`, вызов форвардит `(peer, stream)` наверх
С ПРАВИЛЬНЫМ `peer`; закрытие ребра шлёт `(peer, null)`. Живая
проверка пользователем (два реальных браузера, "в голосе") —
подтверждено рабочим (соединение и звук устанавливаются с задержкой
~3–5с — время ICE-негоциации + heartbeat-интервал, ожидаемо, не баг).

### UI-правки по тому же живому фидбеку (без изменений в domain-слое)

Одним заходом, тот же цикл "живая проверка → находка → фикс":

1. **Имя отправителя в `message-bubble.jsx`** — новый опциональный
   проп `senderName` (не используется в `chat.jsx` — там собеседник
   и так виден по заголовку экрана 1:1/группового чата; нужен только
   в multi-party `quick.jsx`, где `parseRoomChatEvent` и так уже
   возвращает `nick` отправителя, просто не был прокинут в проп).
   Рендерится `<small class="message-bubble-sender">` над текстом
   (и в `deleted`-варианте тоже), стилизован в `custom.css`.
2. **Внутренний скролл чата комнаты** — `.quick-messages` получила
   `block-size: min(60dvh, 28rem)` (`custom.css`) поверх уже
   существующего JSX-класса `.scroller` (REGLAMENT.md — без явной
   block-size прокрутке нечего ограничивать, список разъезжал всю
   `.auth-layout`-страницу, т.к. `quick.jsx` живёт вне `MainShell`'а
   `.shell`-каркаса, внутри `.screen`-подобного "документ вправе
   расти" макета). Форма ввода — следующий sibling, вне скроллящегося
   блока, поэтому визуально прижата к его низу и не скроллится вместе
   со списком (ничего специально для этого делать не пришлось —
   следствие того, что список теперь сам ограничен по высоте).
   Автопрокрутка — сентинел `bottomRef` после последнего сообщения +
   `scrollIntoView({block:"end"})` в `useEffect` по `[messages]` —
   калька приёма `chat.jsx`, но БЕЗ once-per-open ограничения
   (`pendingScrollRef` там): комнаты эфемерны и малы (до 5 участников,
   ROOMS-SPEC §0), длинной истории читать с прокруткой вверх не
   бывает — намеренное упрощение.
3. **`auth-sidebar` скрыт на экране "Быстрая связь"** — `unlock.jsx`:
   `<aside class="auth-sidebar">` (три виджета — "Аккаунты на
   устройстве"/"Создать новое пространство"/"Другие способы")
   оборачивается в `{mainView !== "temp-chat" && (...)}`. Виджеты
   входа/регистрации бессмысленны на экране эфемерной анонимной
   комнаты (ROOMS-SPEC §1.4 — отдельная ветка вне аккаунтов).
4. **Три новых иконки** (`src/ui/icons/`, все — сторонние SVG,
   предоставленные пользователем как есть, лицензии указаны в шапке
   каждого файла): `quick-connect.jsx` (заголовок комнаты, `--accent`
   через инлайн `style`), `user-badge.jsx` (перед ником в списке
   участников, `--accent`), `voice-broadcast.jsx` (внутри кнопки
   "Войти в голос" — ТОЛЬКО join-ветка, не leave; цвет НЕ
   форсируется — наследует `currentColor` самой `.btn` (уже
   акцентно оформлена: фон `--accent`, текст `--accent-contrast`),
   форсировать `--accent` поверх акцентного фона испортило бы
   контраст). Кнопка получила composition-класс `bar` (REGLAMENT.md
   §4, "Кнопка со сложным содержимым") для внутренней раскладки
   иконка+текст.

Живая проверка (Chrome, 1 вкладка, автоматизировано): sidebar
корректно исчезает на "Быстрая связь"; создание комнаты → иконка в
заголовке и в кнопке "Войти в голос" видны; участник появляется в
списке с иконкой; 8 сообщений подряд — каждое подписано именем
отправителя, список скроллится ВНУТРИ блока (виден собственный
скроллбар), поле ввода и счётчики "Участники"/"В голосе" не
сдвигаются вместе с растущим списком, автопрокрутка держит низ.
Голосовая часть (2+ реальных браузера) — подтверждена пользователем
отдельно, живьём.

Regression: `node --test tests/*.test.js` — 1589/1589 (было 1587,
+2 новых теста), ×2 (один прогон с уже задокументированным
изолированным флейком И9-теста под полной нагрузкой — не связан с
этой правкой, стабилен ×3 в изоляции, тот же класс, что и раньше).
`npm run build` — зелёный.

---

## Rooms — Этап 5. Визуализатор

Design-записка — DESIGN.md "Rooms — Этап 5" (13b). ROOMS-SPEC §4.4,
ROOMS-ALGO §7.

### `ring-column-blit.js` [C] — чистое ядро, пополняет список §1.1

```js
computeBlitRegions(writeIndex, width) -> [{srcX, width, destX}, ...]  // 1 или 2 региона
nextWriteIndex(writeIndex, width) -> number
```

Кольцевой буфер столбцов спектрограммы (ROOMS-ALGO §7.2 [Э]).
`buffer[writeIndex]` — самый старый столбец (следующий на
перезапись). Порядок за кадр: записать столбец в `buffer[writeIndex]`
→ `writeIndex = nextWriteIndex(writeIndex, width)` → отрисовать по
регионам `computeBlitRegions` С НОВЫМ `writeIndex`. Ни один DOM/canvas
символ — добавлен в `PURE_CORE_FILES` (`tests/rooms-no-browser-api.test.js`).

### `level-meter.js` [C] — чистое ядро

```js
createLevelTracker({alpha = 0.3, onThreshold = 0.15, offThreshold = 0.10} = {})
  -> { update(rms) -> {level, speaking}, get() -> {level, speaking} }
computeRms(timeDomainData: Uint8Array) -> number  // [0,1], без FFT
```

`update`: EMA `level ← α·rms + (1-α)·level`, гистерезис
`false→true` только при пересечении `onThreshold` снизу вверх,
`true→false` только при пересечении `offThreshold` сверху вниз — в
мёртвой зоне `(offThreshold, onThreshold)` состояние не меняется.
Один трекер на участника (включая себя), живёт внутри `audio-graph.js`.
Тоже пополняет `PURE_CORE_FILES`.

### `audio-graph.js` [C] — адаптер, `src/domain/rooms/adapters/`

```js
createAudioGraph({AudioContextImpl = window.AudioContext || window.webkitAudioContext} = {})
  -> {
    addStream(pubkey, stream, {isSelf = false} = {}),
    removeStream(pubkey),
    setMasterGain(v),        // GainNode.gain.setTargetAtTime, НЕ присваивание (щелчок)
    getSpectrum() -> Uint8Array,      // из ЕДИНСТВЕННОГО шинного AnalyserNode(fftSize=2048)
    getLevels() -> Map<pubkey, {level, speaking}>,   // per-участнику AnalyserNode(fftSize=256) + level-meter.js
    close(),
  }
```

Топология на `addStream`: `source = ctx.createMediaStreamSource(stream)`
→ (а) `source.connect(perParticipantAnalyser)` [fftSize=256, ТОЛЬКО
`getByteTimeDomainData`, никогда `getByteFrequencyData` — И15 по
построению, не по счётчику] → (б) `source.connect(spectrogramBus)`
[все потоки, включая `isSelf`, шина ведёт в ЕДИНСТВЕННЫЙ
`AnalyserNode(fftSize=2048)`, `getSpectrum()` — единственное место
вызова `getByteFrequencyData` во всём графе] → (в) ТОЛЬКО когда
`!isSelf`: `source.connect(masterGain)`, `masterGain.connect(destination)`
— самопрослушивание исключено из звука (не из визуализации/уровня),
design-решение — DESIGN.md "Rooms — Этап 5", подраздел про
самопрослушивание. `removeStream` отключает и уничтожает узлы этого
`pubkey` (`source.disconnect()`, оба анализатора, запись в
`masterGain`-ветке если была), удаляет level-tracker.

**Следствие: `quick.jsx`'s `RoomRemoteAudio`/`remoteStreams`-state
(Этап 4-довесок №2) УДАЛЯЮТСЯ** — Web Audio graph (`masterGain →
destination`) становится единственным путём воспроизведения; два
параллельных пути одного `MediaStream` дали бы удвоенный звук.
`mesh-supervisor.js` получает третий аддитивный колбэк
`onLocalStream(stream|null)` — вызывается в `joinVoice()` сразу после
`sharedStream = await getUserMedia(...)`, и `null` в начале
`leaveVoice()` (тот же паттерн, что `onRemoteStream`), пробрасывается
`room-session.js` → `createRoom`/`joinRoom`/`joinRoomByPassword` тем
же аддитивным путём.

### `room-audio-visualizer.jsx` [C] — UI, `src/ui/components/`

```jsx
<RoomAudioVisualizer audioGraph={...} localStream={...} remoteStreams={Map} selfPubkey={...} />
```

Владеет ОДНИМ `requestAnimationFrame`-циклом на всю комнату
(ROOMS-ALGO §7.4): каждый кадр — `getSpectrum()` + два `drawImage` по
`computeBlitRegions`; раз в 4 кадра (счётчик по модулю 4) —
`getLevels()` + `setState` (перерендер ограничен этим компонентом, не
поднимается в `quick.jsx` — 60 кадров/сек не должны трогать список
сообщений/участников). Сам создаёт/уничтожает `audioGraph` через
`createAudioGraph()` по изменению `localStream`
(`null`→есть = голос начался = создать граф и вызвать `addStream` для
себя; есть→`null` = голос закончился = `close()`); диффит
`remoteStreams`-Map на каждый рендер (новые ключи → `addStream`,
пропавшие → `removeStream`) — тот же принцип diff, что
`mesh-supervisor.js`'s `updateRoster`/`diffEdges`, но без турнира
(просто добавить/убрать). Рендерится ВСЕГДА, пока `voiceActive`
(не по отдельному тумблеру) — воспроизведение не должно зависеть от
того, свёрнут ли визуально канвас.

### Найдено адверсарной фазой (skill п.19), закрыто в самом коде

`audio-graph.js`'s `addStream(pubkey, ...)` вызванный ДВАЖДЫ для того
же `pubkey` без промежуточного `removeStream` (гипотетическое
переприсоединение) оставлял старый `source`-узел подключённым —
утечка узла (звук с уже неактуального `MediaStream`, если тот вообще
ещё жив, продолжал бы литься в граф). Фикс — `addStream` сам вызывает
`removeStream(pubkey)` первым делом, если запись уже существует.

### Тесты и живая проверка

`tests/ring-column-blit.test.js` (8), `tests/level-meter.test.js` (8),
`tests/audio-graph.test.js` (12, включая 3 адверсарных), плюс 3 новых
теста в `tests/mesh-supervisor.test.js` (`onLocalStream`) — итого +31
к общему счёту. `tests/rooms-no-browser-api.test.js` расширен до 9
модулей чистого ядра. Regression: `node --test tests/*.test.js` —
1620/1620, ×2 стабильно (один прогон между ними — уже задокументированный
изолированный флейк И9-теста под полной нагрузкой, не связан с этим
этапом). `npm run build` — зелёный.

Живая проверка в Chrome (1 вкладка, автоматизировано — реального звука
у автоматизированной вкладки нет, канвас корректно остаётся пустым,
см. `drawColumn`'s порог `value <= 0.02`): "Войти в голос" → визуализатор
появляется (канвас, слайдер "Громкость", индикатор участника под
слайдером) без диалога разрешения микрофона (уже был выдан ранее в
этой сессии) и без ошибок в консоли; слайдер громкости двигается,
`setMasterGain` вызывается (проверено логикой, не значением звука);
"Покинуть голос" — визуализатор корректно исчезает, счётчик "В
голосе" возвращается к 0, ошибок в консоли нет (значит `audioGraph.close()`
и `AudioContext.close()` отрабатывают штатно). Профилировочная часть
DoD (≤1 `getByteFrequencyData`/кадр, кадр ≤16мс при 5 участниках) —
первое гарантировано топологией графа и покрыто тестом на счётчик
фейка (не профилировщиком); второе требует реальной многоучастниковой
нагрузки — оставлено пользователю по тому же принципу, что живая
проверка голоса Этапа 4 ("браузерная граница автоматизации").

---

## Rooms — Этап 6. Интеграция и отделка

ROOMS-SPEC §6 ("Этап 6"): "Адверсарная фаза по правилам SKILLS.md,
тексты предупреждений в UI, диагностика". Triage (13a): **рутинная**
— склейка уже готовых примитивов (`onStateChange` уже существует в
`relay-pool.js`, используется главным приложением; `getEdgeStates()`
уже существует с Этапа 4) под конкретные тексты, названные §7/§5.4
буквально. Design-записка не нужна.

### Три конкретных пробела, закрытых по таблице ROOMS-SPEC §7 и §5.4

1. **"Релей отвалился" — состояние соединения комнаты теперь видно.**
   `room-transport.js`'s `openRoomTransport` получает аддитивный
   `onConnectionStateChange = () => {}`, пробрасывается как
   `onStateChange` в `createRelayConnection` (тот же примитив, что уже
   отслеживает `connState` главного приложения, `ui/signals/transport.js`).
   `room-session.js` держит `connectionState` (старт — `"connected"`,
   потому что `openRoomTransport` резолвится только после первого
   `"connected"`), обновляет его в колбэке и зовёт `onChange()`; новый
   геттер `getConnectionState()` на `RoomSessionHandle`.
   `quick.jsx` — переиспользует УЖЕ СУЩЕСТВУЮЩИЕ i18n-ключи
   `connectionStatus.offline/connecting/connected` и CSS-классы
   `status-ok/warn/bad` (`connection-status.jsx` главного приложения)
   — `relayStatusInfo` экспортирована оттуда, а не продублирована,
   чтобы не разъезжались тексты между двумя независимыми транспортными
   клиентами приложения. Индикатор рендерится в комнате ТОЛЬКО когда
   состояние не `connected`/`subscribed` (в норме индикатора не видно
   вовсе — тихий по умолчанию UI, шумит только когда есть повод).
2. **"Одно ребро mesh не соединилось" — "тишина с пометкой" на пиру,
   не только глобальная ошибка голоса.** `session.getEdgeStates()`
   (Этап 4) теперь читается в `quick.jsx`'s `handleSessionChange`,
   хранится в state. В списке участников рядом с `inVoice`-меткой
   пира — если для него есть ребро (`getEdgeStates()`'s `peer`
   совпадает) И его `state` — `"ENDED"` или `"RECONNECTING"`, рисуется
   `t("quick.room.edgeSilentHint")`. Решение, не буквальное в спеке:
   транзитные состояния (`OUTGOING_RINGING`/`INCOMING_RINGING`/
   `CONNECTING`) НЕ считаются "тишиной" — это нормальный процесс
   установки на первую секунду-две, пометка на них была бы шумом,
   не диагностикой; `CONNECTED` — тоже не пометка, разумеется.
   Отсутствие записи в `getEdgeStates()` для пира, у которого
   `inVoice=true`, — тоже НЕ пометка (ребро может ещё не успеть
   открыться после только что пришедшего heartbeat, тот же временной
   зазор, что чинился в Этапе 4-довеске №1) — только явный `ENDED`/
   `RECONNECTING` — сигнал, что действительно не получилось.
3. **§5.4 "Последствия эфемерности — записать в UI" — буквально.**
   Новый текст `quick.room.ephemeralNotice` в самой комнате (не
   только на экране входа, где уже был близкий по духу
   `anonymityNotice`) — оба факта спеки одним абзацем: истории нет
   для вошедших позже; сообщение, отправленное в момент короткого
   обрыва связи у получателя, теряется навсегда.

### Адверсарная фаза — интеграционный, не по-модульный проход

Каждый этап (1–5) уже прошёл свою адверсарную фазу локально (skill
п.19) — Этап 6 явно требует ОТДЕЛЬНЫЙ проход НА ГРАНИЦАХ между уже
проверенными модулями (гонки, которые ни один одномодульный тест не
мог обнаружить, потому что затрагивают ≥2 подсистемы сразу). Найдено
и закрыто/задокументировано:

- **`close()` во время реактивного открытия ребра (Этап 4-довесок №1
  race) — mesh-supervisor.js уже закрыт, но `onSignal` продолжает
  вызываться.** Проверено: `room-session.js`'s `close()` останавливает
  `setInterval` и зовёт `meshSupervisor.leaveVoice()` НЕМЕДЛЕННО,
  синхронно — `handleEvent`'s `CALL_SIGNAL_KIND`-ветка после этого
  либо не вызывается вовсе (транспорт уже закрыт), либо, если
  событие уже было в очереди микрозадач ДО `transport.close()`,
  вызовет `meshSupervisor.onSignal` на уже-опустошённом супервизоре —
  `edgesByPeer` пуст, `sharedStream` уже `null` — `onSignal`'s
  собственная защита (`if (!sharedStream) return`) отрабатывает,
  не бросает. Тест добавлен явно (регрессия на этот сценарий).
- **`leaveVoice()` сразу после `joinVoice()`, ДО того как
  `getUserMedia` резолвился (двойной клик/гонка UI).** `joinVoice()`
  — `async`, `sharedStream` присваивается ПОСЛЕ `await`; если
  `leaveVoice()` вызван в этом окне, `sharedStream` в момент
  `leaveVoice()` ещё `null` — цикл остановки рёбер видит пустую карту
  (нормально, рёбер и не было), но когда `joinVoice()`'s `await`
  наконец резолвится, `sharedStream` присваивается и трек НИКЕМ не
  останавливается — микрофон остаётся захваченным вопреки явному
  уходу пользователя из голоса. **Реальный найденный баг**, не
  гипотеза — закрыт: `joinVoice()` после получения `stream`
  проверяет, не был ли в это же время вызван `leaveVoice()` (флаг
  `leaveRequestedDuringJoin`, сбрасывается в начале `joinVoice()`,
  проверяется сразу после `await getUserMedia`) — если да, немедленно
  останавливает только что полученные треки и не присваивает
  `sharedStream`, не открывает рёбер.
- **Комната "умирает" (все остальные вышли) при активном голосе.**
  `room-machine.js`'s переход в `dead` не трогает `meshSupervisor`
  напрямую — голос продолжает жить (пусто, без пиров) до явного
  `leaveVoice()`/`close()`. Это ПРАВИЛЬНОЕ поведение (ROOMS-SPEC §0 —
  протокольная смерть комнаты не обязана мгновенно рвать реальное
  железо), задокументировано как проверенное, не баг.
- **Быстрый повторный `joinVoice()`/`leaveVoice()` (двойной тоггл).**
  Покрыт существующими тестами Этапа 4 (`leaveVoice()` без
  `joinVoice()`, `updateRoster` до `joinVoice()`) — новых пробелов не
  найдено, ре-проверено целенаправленно в контексте Этапа 6, не
  вслепую.

## Markdown — Этап A. Единый читающий путь

ТЗ: `PROCESS-DOCS/MARKDOWN-TASK.md`. Решения Р-1..Р-4 (§0) зафиксированы
пользователем в самом документе. Триаж (п.13a): **рутинная** — обёртка над
готовой библиотекой (`mdast-util-from-markdown`) по документации, без
нетривиального инварианта/пространства состояний. Design-записка (13b)
не пишется.

**Расхождение с ТЗ, зафиксированное перед стартом:** ТЗ (A.2) говорит
"`mdast-util-from-markdown` уже добавлен... сейчас транзитивна через
Milkdown". Проверено (`package.json`, `package-lock.json`, `node_modules`)
— в проекте НЕТ ни Milkdown, ни mdast, ни prosemirror ни прямо, ни
транзитивно. Не блокирует: итоговое действие (добавить прямой зависимостью)
не меняется независимо от того, откуда взялась бы транзитивная версия.
Устанавливается заново с npm registry, версия на момент установки —
`mdast-util-from-markdown@^2.0.3`.

### Почему `parseRich`/`parseLite` — не два разных парсера

CommonMark-грамматику нельзя выборочно "выключить" на уровне синтаксиса
(нет режима mdast-util-from-markdown "не распознавать заголовки"). Оба
профиля вызывают ОДИН И ТОТ ЖЕ `fromMarkdown()` — иначе A.1's "паритет
только через общий движок" был бы нарушен уже внутри своего же модуля.
Различие профилей — целиком в РЕНДЕРЕ (`markdown-view.jsx`): какие типы
узлов allowlist пропускает как есть, какие падают в `default`. Именно
поэтому "заголовки/код-блоки/hr деградируют в текст, не отбрасываются" в
lite-профиле — это следствие allowlist-фильтра на рендере, а не
поведение парсера. `parseRich`/`parseLite` — две именованные функции (не
одна `parse(source, profile)`) ради будущей развилки (если когда-нибудь
у профилей разойдётся синтаксис), сейчас их тела идентичны.

### `src/core/markdown/node-allowlist.js`
```js
export const RICH_BLOCK_TYPES = ["heading", "paragraph", "list", "listItem", "blockquote", "code", "thematicBreak"];
export const RICH_INLINE_TYPES = ["strong", "emphasis", "inlineCode", "link", "break", "text"];
export const LITE_BLOCK_TYPES = ["paragraph", "list", "listItem", "blockquote"];
export const LITE_INLINE_TYPES = ["strong", "emphasis", "inlineCode", "link", "break", "text"];
```
Имена типов — буквально mdast-типы (см. https://github.com/syntax-tree/mdast).
`image` НИГДЕ не входит ни в один список — не "забыто", а сознательно
(см. ниже). Список создаётся уже на Этапе A (не отложен до Этапа C),
чтобы схема ProseMirror C.2 импортировала готовый файл, а не дублировала
список заново — единственный источник истины с первого дня.

### `src/core/markdown/parse.js`
```js
import { fromMarkdown } from "mdast-util-from-markdown";

export function parseRich(source)
    // -> mdast root node. fromMarkdown(source ?? ""). Без GFM-расширений
    // (Р-3/§6 ТЗ: автоссылки, таблицы, чекбоксы — вне скоупа).
export function parseLite(source)
    // -> mdast root node. Тело идентично parseRich — см. секцию выше
    // "Почему parseRich/parseLite — не два разных парсера". Не рефакторить
    // в одну функцию с параметром profile — контракт фиксирует ИМЕННО эти
    // два экспорта, потребители (markdown-view.jsx, потом схема C) должны
    // называть профиль по имени функции на месте вызова, а не пробрасывать
    // строку глубже.
```
Пустой/`undefined`/`null` `source` -> `fromMarkdown("")` -> `{type:"root", children:[]}`,
не бросает.

### `src/core/markdown/sanitize.js`
```js
export function safeHref(url)
    // -> string | null. null = схема запрещена или url пуст/не строка ->
    // узел рендерится текстом, не ссылкой (см. markdown-view.jsx).
```
Алгоритм (порядок обязателен):
1. `typeof url !== "string"` -> `null`.
2. Удалить ВСЕ (не только по краям) символы ` `–`` и ``
   из строки целиком — так браузеры исторически "видят" URL, это же и
   есть обход для `java script:`/`\tjavascript:` (таб/null ВНУТРИ
   строки перед схемой), `trim()`.
3. Пустая строка после шага 2 -> `null`.
4. Схема — `/^([a-zA-Z][a-zA-Z0-9+.-]*:)/`. Нет совпадения -> строка
   относительная (`/foo`, `foo.html`, `#anchor`) -> вернуть очищенную
   строку как есть (разрешена).
5. Есть совпадение -> схему в нижний регистр, сравнить с allowlist
   `["https:", "http:", "mailto:"]`. Не входит -> `null`. Входит ->
   вернуть очищенную строку (регистр остального URL — как ввёл автор,
   в нижний регистр приводится ТОЛЬКО схема для сравнения на шаге 5,
   не возвращаемое значение).
Проверка "начинается со схемы из allowlist" — шаги 4-5 ДЕЛАЮТ именно
это (allowlist, не blocklist), буквально по A.2.

### `src/core/markdown/to-plain.js`
```js
export function toPlainText(node)
    // -> string. mdast-поддерево -> плоская строка одной строкой (для
    // aria-label/превью/тела уведомлений — НЕ для чтения человеком
    // структуры документа).
```
Правила:
- `typeof node.value === "string"` (`text`, `inlineCode`, `code`, `html`)
  -> вернуть `node.value`.
- `node.type === "image"` -> вернуть `node.alt ?? ""` (иначе картинка
  молча пропадает из превью/aria-label — единственное специальное
  правило, см. ниже про `image` в рендере).
- `node.type === "break"` -> вернуть `" "` (жёсткий перенос строки
  внутри инлайна -> пробел при схлопывании в одну строку).
- `Array.isArray(node.children)` -> `node.children.map(toPlainText)`,
  если `node.type` — один из `["root", "blockquote", "list", "listItem"]`
  (контейнер БЛОЧНЫХ детей — между блоками нужен разделитель, иначе
  слова слипнутся: "Заголовокабзац") — **отфильтровать пустые строки,
  затем склеить через `" "`** (фильтрация обязательна: `thematicBreak`
  и подобные "пустые" узлы иначе дают двойной пробел на стыке —
  `"Текст до." + " " + "" + " " + "Текст после."`). Если `node.type` —
  контейнер ИНЛАЙН-детей (`paragraph`/`heading`/`strong`/`emphasis`/`link`)
  — склеить через `""` без фильтрации (соседние текстовые узлы уже несут
  собственные пробелы из исходника, схлопывание пустых веток здесь не
  нужно). Результат — `.trim()`.
- Иначе (лист без `.value` и без `children`, например `thematicBreak`)
  -> `""`.

### `src/ui/components/markdown-view.jsx`
```js
export default function MarkdownView({ source, profile = "lite" })
```
`profile` — `"rich" | "lite"`, по умолчанию `"lite"` (более
ограничительный — безопасный дефолт, если вызывающий забыл проп).
`profile === "rich"` -> `parseRich` + `RICH_BLOCK_TYPES`/`RICH_INLINE_TYPES`,
иначе -> `parseLite` + `LITE_BLOCK_TYPES`/`LITE_INLINE_TYPES`.

Блочный рендер (`tree.children.map`) — `switch (node.type)`, ветка
только если тип есть в `*_BLOCK_TYPES` для активного профиля:
`heading`->`h{depth}`, `paragraph`->`<p>`, `blockquote`->`<blockquote>`
(рекурсия по блочным детям), `list`->`<ul>`/`<ol>` по `node.ordered`
(рекурсия по `listItem`-детям), `listItem`->`<li>` (рекурсия по блочным
детям), `code`->`<pre class="md-code-block"><code>{node.value}</code></pre>`,
`thematicBreak`->`<hr>`. Тип отсутствует в allowlist профиля (в т.ч.
`html`) ИЛИ не совпал ни с одним `case` -> `default`:
`<p>{toPlainText(node)}</p>` — **текстовое содержимое узла, не `null`**
(A.2 — неизвестный узел не должен молча исчезать).

Инлайн-рендер (внутри `paragraph`/`heading`/`listItem`'s текстовых
детей) — по `*_INLINE_TYPES` активного профиля: `text`->`node.value`
как есть, `strong`->`<strong>`, `emphasis`->`<em>`,
`inlineCode`->`<code class="md-code-inline">{node.value}</code>`,
`break`->`<br>`, `link`-> `safeHref(node.url)`; если `null` — узел
рендерится как обычный текст (`toPlainText(node)` НА ВСЁМ узле link
целиком, включая метку — не пытаться сохранить вложенные марки внутри
отклонённой ссылки, это лишняя сложность ради несуществующей пользы);
если не `null` — `<a href={href} target="_blank" rel="noopener noreferrer">`.
Тип не в allowlist -> `toPlainText(node)` как обычный текст (без
обёртки в элемент — инлайн-контекст, голая строка).

**`image` — специальный случай, ВНЕ allowlist в обоих профилях,
проверяется ПЕРЕД general inline-switch.** Причина — архитектурная
(ТЗ A.2): автозагрузка `<img src>` из чужого сообщения деанонимизирует
IP читателя по выбору автора. Реализация: `safeHref(node.url)`; `null`
-> текст (`node.alt || node.url || ""`); иначе ->
`<a href={href} target="_blank" rel="noopener noreferrer">{node.alt || node.url}</a>`
— ссылка, не автозагрузка (пользователь решает сам, кликать или нет).
**НИГДЕ, ни в одном профиле, ни в одной ветке — тег `<img>` для markdown-контента.**

`dangerouslySetInnerHTML` не используется нигде в файле — структурная
гарантия, не проверяемая вручную (см. Definition of Done ТЗ §5, п.3 —
`grep -rn "dangerouslySetInnerHTML\|innerHTML" src/` пуст).

### Тестируемость `markdown-view.jsx`

В проекте нет jsdom/`preact-render-to-string`/testing-library (проверено —
их не было и для старого `markdown-view.jsx`, старый `help-markdown.test.js`
тестировал только `parseMarkdown`/`parseInline`, не рендер). Та же
дисциплина сохраняется: `node --test` покрывает `core/markdown/*.js`
(чистые функции — 100% доступны для unit-тестов), сам JSX-рендер
проверяется живым Chrome-проходом (Definition of Done ТЗ §5, п.5) +
двумя механическими grep-гейтами (`dangerouslySetInnerHTML`/`innerHTML`
пусто; `domain/help/markdown` пусто после Этапа A). Новый девдепенденси
для jsx-рендер-тестов НЕ добавляется — вне бюджета этого этапа, проект
уже минимизирует зависимости по NF-11.

### Миграция «Справки»

`help-content.jsx:142` — единственный вызов `<MarkdownView>`, добавить
`profile="rich"`. Удалить `src/domain/help/markdown.js` и
`tests/help-markdown.test.js` целиком (зафиксировать в log.md — осознанное
уменьшение числа тестов, не регресс). Контент 5 тем × 12 локалей
(`src/content/help/*/*.md`, 60 файлов) прогнать через новый рендерер и
сверить глазами хотя бы по 2-3 темам на разных локалях — старый парсер
склеивал абзацы пробелом, remark делает то же для мягких переносов
CommonMark, расхождений быть не должно, но это утверждение, которое
нужно увидеть, а не предположить (ТЗ A.3).

### Бюджет бандла — пороги ТЗ §5 пересчитаны (устарела база)

ТЗ §5 п.2 считает пороги от базы "707,43 КБ" (зафиксирована в записи
Rooms-Этапа-6). Проверено перед приёмкой Этапа A: чистый `main` (до
любых markdown-правок) уже даёт **737,36 КБ** gzip (`vite build`,
rolldown) — выросло на ~30 КБ за счёт Rooms-редизайна/довесков ПОСЛЕ
того, как база 707,43 КБ была зафиксирована; `package.json` при этом
не менялся (проверено `git diff` с этапа 6) — рост органический, от
нового кода `src/`, не от зависимостей.

Сам код Этапа A (`mdast-util-from-markdown` + `core/markdown/*.js` +
новый `markdown-view.jsx`) даёт ровно **+15,35 КБ** (752,71 КБ итого) —
совпадает с изолированным esbuild-замером самой библиотеки в minify+gzip
(~16 КБ), то есть код этапа не раздувает бандл сверх ожидаемого, раздута
была только точка отсчёта.

**Решение пользователя: пороги пересчитаны от новой базы, те же дельты
из ТЗ:**
- после A ≤ **759,93 КБ** (737,36 + 22,57) — факт 752,71 КБ, укладывается.
- после D ≤ **764,93 КБ** (737,36 + 27,57).
- после C ≤ **817,36 КБ** (737,36 + 80).

Лимит NF-11 (1304 КБ) не менялся и не пересчитывается — далёк от любого
из порогов.

## Markdown — Этап E. Места, где markdown НЕ рендерится

ТЗ §2. Триаж (13a): **рутинная** — allowlist-проверка существующих
рендер-точек + один новый утилитный файл (комбинация уже написанных
и протестированных примитивов Этапа A, без нового инварианта).

### Разведка (сделана перед контрактом, чтением кода, не по памяти ТЗ)

Проверены все 5 пунктов ТЗ §2 на актуальном коде:

1. **`moderation-panel.jsx:126`, `r.contentText`** — подтверждено, это
   жалоба (`receiveReport`'s `contentText: rumor.content` в
   `transport.js`) — уже `whiteSpace: "pre-wrap"`, без рендера markdown.
   Оставить как есть, добавить только комментарий-причину.
2. **`channel.jsx:780`, `req__body`** — как зафиксировано выше (расхождение
   с ТЗ), это `channelRow.rules` (правила канала), не приветствие заявки.
   Уже plain. Оставить, добавить комментарий-причину. Фактически один
   пункт с последним общим ("правила канала — plain"), не отдельный.
3. **`post-card.jsx:49`, aria-label** — подтверждено,
   `post.text?.slice(0, 40)`. Заменить на новую утилиту (ниже).
4. **Тело browser-уведомлений** — подтверждено, `truncateForNotification()`
   в `src/ui/signals/transport.js:76` — единая internal-функция, через
   которую уже идёт БОЛЬШИНСТВО уведомлений с текстом контента (жалоба
   `:625`, пост `:1235`, комментарий `:1280`/`:1306`, чат-сообщение
   канала `:1346`). Одно исключение найдено: `:1663`, личное сообщение
   (DM) — `body: receivedResult.text` НАПРЯМУЮ, БЕЗ `truncateForNotification`
   вообще (ни обрезки длины, ни markdown-обработки) — реальный, не
   гипотетический пробел. **Важно:** `rumor.content` (жалоба) в п.1 и в
   п.4 — одно и то же поле данных, ДВЕ разные рендер-точки с РАЗНЫМИ
   политиками осознанно: `moderation-panel.jsx` — расследование, нужен
   RAW-исходник; здесь — короткое превью в системном уведомлении
   ("пришла жалоба, посмотри"), toPlainText уместен и не мешает
   расследованию (оно происходит в п.1, не здесь).
5. **"Любое превью последнего сообщения в списках"** — проверено широким
   поиском (`grep` по `.slice(0` минус id/hash/pubkey-срезы) по всему
   `src/ui/` — такого UI-элемента (список диалогов/чатов с текстовым
   превью последней реплики) **в проекте не существует вовсе** —
   `contacts.jsx` показывает только идентичность контакта, без текста;
   `chat.jsx` — сам экран переписки, не список. Как и с `greeting`
   (см. выше) — нечего трогать, рендер-места не существует. Не
   переспрашивается у пользователя отдельно — тот же уже одобренный
   паттерн ("если места нет — документировать, не создавать новую фичу
   в рамках markdown-этапа").
6. **Имя/описание/правила канала, имя профиля, био** — проверено чтением
   всех рендер-точек: `channel.jsx:773` (`channelRow.description`),
   `:772`/`:805` (`channelRow.name`, как `title`/interpolated-строка),
   `profile.jsx` (био — управляемый `<textarea>`, не рендерится отдельно
   как markdown нигде). Везде голый текст, `MarkdownView` не подключён
   ни в одном месте. Ничего менять не требуется — список зафиксирован
   здесь для протокола (чтобы будущая правка не воткнула туда
   `MarkdownView` по аналогии с постами/чатом, не подумав).

### Новый файл: `src/core/markdown/preview.js`

Общая утилита вместо двух копий одной и той же идеи (обрезать-после-
schlopнуть-markdown) в `transport.js` и `post-card.jsx`:
```js
import { parseRich, parseLite } from "./parse.js";
import { toPlainText } from "./to-plain.js";

export function toPreviewText(source, { profile = "lite", maxLength = 120 } = {})
    // -> string. !source -> "". Иначе: (profile === "rich" ? parseRich :
    // parseLite)(source) -> toPlainText(...) -> если длина результата >
    // maxLength, обрезать до maxLength и добавить "…" (U+2026, ОДИН символ,
    // не три точки), иначе вернуть как есть.
```
Порядок обязателен: сначала toPlainText (снять markdown-синтаксис),
ПОТОМ обрезка по длине — обрезка ДО toPlainText могла бы разрезать
markdown-маркер пополам (`**жирны` без закрывающего `**`) и испортить
остаток текста при последующем парсинге. Дополняет Этап A, не меняет
существующий контракт `to-plain.js`/`parse.js` (чистое добавление).

### Точечные интеграционные правки (без воркера — стыковка, не логика)

- `transport.js:76-79` — тело `truncateForNotification(text, maxLength=120)`
  заменяется на `toPreviewText(text, { maxLength })` (профиль по
  умолчанию `"lite"` подходит всем текущим вызывающим, КРОМЕ поста).
- `transport.js:1235` (`postRow?.text`) — единственный вызов, где нужен
  явный `{ profile: "rich" }` (посты — rich-профиль, как в `post-card.jsx`).
- `transport.js:1663` — `body: receivedResult.text` -> обернуть в
  `truncateForNotification(receivedResult.text)` (был реальный пробел,
  не только markdown — раньше ни обрезки, ни очистки разметки).
- `post-card.jsx:49` — `post.text?.slice(0, 40)` -> `toPreviewText(post.text, { profile: "rich", maxLength: 40 })`.
- `moderation-panel.jsx:126`, `channel.jsx:780` — код не меняется,
  добавляется однострочный комментарий с причиной (см. п.1/п.2 выше).

## Markdown — Этап D. Markdown в чате, комментариях, общем чате канала

ТЗ §3. Триаж (13a): рендер-часть — **рутинная** (подстановка уже готового
`MarkdownView`). Панель форматирования — **пограничная**: вставка текста
по позиции курсора сама по себе рутинна, но алгоритм "что именно вставить
и куда переместить курсор" для 5 разных операций (2 inline-обёртки с/без
выделения, 2 построчных префикса на многострочном диапазоне) — вынесен
в отдельную ЧИСТУЮ функцию с исчерпывающим набором тестов (13b-подобная
строгость без формальной design-записки — детерминированный алгоритм на
строках, не пространство состояний).

### Расхождение "три композера" — разрешено фактами из кода, не догадкой

ТЗ называет ровно три константы лимита буквально: `MESSAGE_MAX_LENGTH`
(`channel-chat.jsx:18`, общий чат канала), `COMMENT_MAX_LENGTH`
(`channel.jsx:39`, комментарии), `MAX_MESSAGE_LENGTH` (`chat.jsx:56`,
личные/групповые). Это ТРИ, а не четыре, реальных места ввода с
`<textarea>` в проекте — `quick.jsx` (комнаты «Быстрая связь») использует
СВОЙ `MAX_MESSAGE_LENGTH`-эквивалент, не совпадающий ни с одной из трёх
названных констант, и не упомянут в списке лимитов ТЗ вовсе. Вывод:
**панель форматирования подключается к ЭТИМ ТРЁМ композерам, НЕ к
`quick.jsx`.** Рендер (`message-bubble.jsx`) при этом переиспользуется
и в комнатах тоже (буквально по ТЗ) — если участник комнаты вручную
наберёт `**жирный**` без кнопки, CommonMark всё равно распознает
синтаксис и отрендерит корректно; кнопки просто не помогают набирать.

### Рендер — 4 замены + одна общая CSS-правка

- `message-bubble.jsx:92` — `{message.text && <p>{message.text}</p>}` ->
  `{message.text && <MarkdownView source={message.text} profile="lite" />}`.
  `.message-bubble p` (descendant-селектор, `custom.css:797`) продолжает
  работать нетронуто — `<p>` от `MarkdownView` тоже потомок `.message-bubble`.
- `channel-chat.jsx:163` — `<p style={{whiteSpace:"pre-wrap"}}>{m.text}</p>`
  -> `<MarkdownView source={m.text} profile="lite" />`. Инлайн-стиль
  `whiteSpace` заменяется общей CSS-правкой ниже.
- `channel.jsx:429` — `<p class="cmt__text">{comment.text}</p>` ->
  `<div class="cmt__text"><MarkdownView source={comment.text} profile="lite" /></div>`.
  Обёртка, не проп: класс несёт `font-size`/`line-height`/`white-space`/
  `margin` (все, кроме `margin`, — наследуемые CSS-свойства, унаследуются
  вложенным `<p>` автоматически; `margin` и так `0` глобально, см. ниже) —
  контракт `MarkdownView` НЕ меняется, никакого нового `class`-пропа.
- `post-card.jsx:36` — `<p style={{whiteSpace:"pre-wrap"}}>{post.text}</p>`
  -> `<MarkdownView source={post.text} profile="rich" />`.

**CSS (одна строка):** `custom.css`, правило `.app-layout .md-view p,
.auth-layout .md-view p { line-height: 1.6; }` (создано на Этапе A для
Справки) — добавить `white-space: pre-wrap;`. Обоснование: одиночный
`\n` внутри абзаца остаётся частью значения ОДНОГО text-узла (CommonMark
soft break — проверено тестами Этапа A), без `white-space: pre-wrap`
браузер схлопнёт его в пробел при отображении — та же регрессия, что
уже была найдена и закрыта для `.message-bubble p` (комментарий в
`custom.css:797-806`, "textarea в quick.jsx впервые позволила реально
ввести перевод строки"). Правка на общем `.md-view p` закрывает её
СРАЗУ для всех 4 мест рендера, включая Справку (safe — не меняет
wrapping/перенос по словам, только не схлопывает уже существующие
literal-переносы, которых в тексте справки и так почти нет).
**`margin` — НЕ трогать нигде**: глобальный ресет `minimal.css`,
`:where(:not(dialog)) { margin: 0; padding: 0 }` (специфичность `:where()`
== 0) уже обнуляет `margin` у ЛЮБОГО элемента, включая новый `<p>` внутри
`.md-view` — старые точечные `margin-block: 0`/`margin: 0` в
`.message-bubble p`/`.cmt__text` были явной подстраховкой, избыточной,
но безвредной; новый код полагается на глобальный ресет и не дублирует.

### Новый файл: `src/core/markdown/format-insert.js` (чистая функция, тестируется)

```js
export function applyFormat(kind, { value, selectionStart, selectionEnd })
    // kind: "bold" | "italic" | "quote" | "list" | "link"
    // -> { text: string, replaceStart: number, replaceEnd: number, selectStart: number, selectEnd: number }
```
`text`/`replaceStart`/`replaceEnd` — аргументы для `el.setRangeText(text,
replaceStart, replaceEnd)` (заменить диапазон `[replaceStart,replaceEnd)`
исходного `value` на `text`). `selectStart`/`selectEnd` — координаты В
НОВОЙ строке (после замены), куда нужно вручную поставить
`el.selectionStart`/`el.selectionEnd` после вызова `setRangeText`
(родовой JSX-обвязке НЕ полагаться на `setRangeText`'s встроенный
`selectionMode`-параметр — он выделяет только весь заменённый диапазон
целиком, а для `link` с выделением курсор должен встать ВНУТРИ скобок
URL, не выделять текст).

**bold/italic** (`selected = value.slice(selectionStart, selectionEnd)`):
- `selected` пуст (`selectionStart === selectionEnd`, просто курсор):
  `text = marker+marker` (bold: `"****"`, italic: `"**"`),
  `replaceStart = replaceEnd = selectionStart`,
  `selectStart = selectEnd = selectionStart + marker.length` (курсор
  МЕЖДУ парой маркеров).
- есть выделение: `text = marker + selected + marker`,
  `replaceStart = selectionStart`, `replaceEnd = selectionEnd`,
  `selectStart = selectionStart`, `selectEnd = selectionStart + text.length`
  (выделить весь новый блок целиком, включая маркеры — видимое
  подтверждение изменения).
  (marker: bold `"**"`, italic `"*"`.)

**link**:
- `selected` пуст: `text = "[]()"`,
  `replaceStart = replaceEnd = selectionStart`,
  `selectStart = selectEnd = selectionStart + 1` (курсор между `[` и `]`,
  чтобы сразу печатать текст ссылки).
- есть выделение: `text = "[" + selected + "]()"`,
  `replaceStart = selectionStart`, `replaceEnd = selectionEnd`,
  `selectStart = selectEnd = selectionStart + ("[" + selected + "](").length`
  (курсор между `(` и `)`, чтобы сразу печатать URL — НЕ выделение).

**quote/list** (построчный префикс на диапазоне строк, покрывающих
выделение — работает и при пустом выделении, курсор просто в какой-то
строке):
```
lineStart = value.lastIndexOf("\n", selectionStart - 1) + 1   // 0, если "\n" нет
lineEndIdx = value.indexOf("\n", selectionEnd)
lineEnd = lineEndIdx === -1 ? value.length : lineEndIdx
block = value.slice(lineStart, lineEnd)
prefix = kind === "quote" ? "> " : "- "
text = block.split("\n").map(line => prefix + line).join("\n")
replaceStart = lineStart
replaceEnd = lineEnd
selectStart = lineStart
selectEnd = lineStart + text.length   // выделить весь новый блок
```

### Новый файл: `src/ui/components/markdown-format-toolbar.jsx` (JSX-обвязка, без тестов — тонкий слой, аналогично `markdown-view.jsx`)

```jsx
export default function MarkdownFormatToolbar({ textareaRef, value, onChange })
```
5 кнопок `<button type="button">` (bold/italic/quote/list/link), порядок
как в ТЗ. Кнопка — короткий языконезависимый символ как видимое
содержимое (`B`, `I`, `❝`, `•`, `🔗` — НЕ SVG-иконка: в проекте нет
готовой иконки этого назначения, а копирование новых SVG путей вручную
без внешней проверки на этот раз — неоправданный риск брака; текстовые
символы для типографских операций общеприняты и не нуждаются в
переводе), `aria-label` — через `t()`, ключи `markdownToolbar.{bold,
italic,quote,list,link}Aria`, 12 локалей (переводит Claude напрямую, не
воркер — установленное правило проекта, "Этап 64").

Обработчик клика — ЕДИНЫЙ паттерн для всех 5 kind (не полагаться на
`setRangeText`'s `selectionMode`, всегда сам режим `"preserve"` +
ручное присвоение `selectionStart`/`selectionEnd`):
```js
function handleClick(kind) {
	const el = textareaRef.current;
	if (!el) return;
	const result = applyFormat(kind, { value, selectionStart: el.selectionStart, selectionEnd: el.selectionEnd });
	el.focus();
	el.setRangeText(result.text, result.replaceStart, result.replaceEnd, "preserve");
	el.selectionStart = result.selectStart;
	el.selectionEnd = result.selectEnd;
	onChange(el.value);
}
```
`el.focus()` ДО `setRangeText` — клик мышью по кнопке снимает фокус с
textarea, `selectionStart`/`End`/`setRangeText` требуют, чтобы элемент
был активен для корректного видимого курсора после операции.
`onChange(el.value)` — ПОСЛЕ мутации DOM, синхронизирует Preact
controlled-state с уже изменённым `el.value` (native `setRangeText`
сохраняет undo-историю браузера — Ctrl+Z продолжает работать; ручная
склейка строк через `value.slice()` + `setState` эту историю ломает,
поэтому ТЗ явно требует `setRangeText`, не ручную конкатенацию).

### Интеграция в три композера (точечно, без воркера — стыковка, не логика)

- `chat.jsx` — единственное место с побочным эффектом при изменении
  текста (`handleTextInput`, строка ~398, debounce-сохранение черновика
  `saveChatDraftAction`). Извлечь общую часть в `applyTextChange(value)`,
  `handleTextInput(e)` становится `applyTextChange(e.currentTarget.value)`
  (чистый extract-function рефакторинг, поведение не меняется) — панель
  получает `onChange={applyTextChange}`. Добавить `composerTextareaRef`
  (`useRef(null)`), `ref={composerTextareaRef}` на сам `<textarea>`.
- `channel-chat.jsx` (`ChatComposer`) — простой случай, `onChange={setText}`
  напрямую, без рефакторинга (нет побочных эффектов при вводе).
- `channel.jsx` (форма комментария) — тот же простой случай, `onChange={setText}`.
- Панель — под/над `<textarea>` в каждом месте (визуальное решение —
  на усмотрение при живой проверке, не архитектурный вопрос).

Лимиты (`MESSAGE_MAX_LENGTH`/`COMMENT_MAX_LENGTH`/`MAX_MESSAGE_LENGTH`) —
НЕ меняются (ТЗ Р-4 касается только постов).

Панель подключена также в `ComposeMessage` (`chat.jsx`, форма "Написать
сообщение" — первое сообщение НОВОГО диалога) — тот же композер по духу
ТЗ (общая константа `MAX_MESSAGE_LENGTH`), простой случай без побочных
эффектов (`onChange={setText}` напрямую), не отдельный четвёртый композер.

### Этап D ЗАКРЫТ — живая проверка и находки

15 тестов `format-insert.js` (написаны до кода). Воркер сдал `parse.js`-
уровня простые файлы с первого раза (`node-allowlist.js`, `parse.js`,
`markdown-format-toolbar.jsx`) точно по контракту; `format-insert.js` и
`sanitize.js`/`to-plain.js` (Этапы A/E) содержали найденные тестами
реальные баги, закрытые точечно без повторного вызова воркера (лестница
конкретности, skill п.8-9):
- TDZ-баг: `const` объявлена внутри `case "quote"` без блока `{}`,
  `case "list"` пытался присвоить ту же переменную без объявления —
  `ReferenceError` при прямом вызове `kind="list"`.
- `link` с выделением: курсор ставился на `selectionEnd` вместо
  `selectionStart + "[selected](".length` — неверная позиция.
- `bold`/`italic` без выделения: `text` был равен одиночному маркеру
  (`"**"`/`"*"`), а не паре (`"****"`/`"**"`) — вставлялся только
  открывающий маркер без закрывающего.

Живая проверка панели — в реальном браузере (не unit-тест, единственное,
что не покрывается node-тестами: `setRangeText`/`selectionStart` — DOM
API): форма "Написать сообщение" (`chat.jsx`), без необходимости
реальной отправки (сама вставка текста кнопкой — чистая клиентская
DOM-операция, не зависит от relay). Проверено визуально: `bold` —
`Привет **мир**` с выделением всего нового блока; `link` с выделением —
`[Привет](|)` курсор точечно между `(`/`)`, ввод URL встаёт туда же;
`list`/`quote` — префикс добавляется ТОЛЬКО на текущей строке, соседние
не тронуты. `italic` не проверялась отдельно (идентичный `bold`
алгоритм, 100% в unit-тестах). Консоль чиста.

Полноценный E2E с реальной публикацией канала/поста/комментария через
relay НЕ пройден — поднятый для этого эфемерный `fake-relay.js`+
`ws-bridge.js` (harness проекта, `tests/harness/`) зависал в состоянии
`connecting`/`disconnected`, причина не расследовалась (инфраструктурная
проблема тестового scaffolding, к markdown-коду не относится — то же
харнесс успешно используется в `room-transport.test.js`/`room-session.
test.js` под управляемым `flushAll()`, здесь использовался
автотаймерный `flushAll()` каждые 50мс, что могло не совпасть с
протокольным ожиданием клиента). Рендер (`MarkdownView` в новых 4
местах) отдельно живьём не перепроверялся — тот же самый компонент,
что уже подтверждён работающим на Этапе A (Справка), меняется только
`profile`/источник текста, не сама логика рендера.

DoD:
- [x] тесты этапа зелёные (15/15), полная регрессия зелёная (1676/1676)
- [x] `npm run build` зелёный, 753,33 КБ, в пороге (759,93/764,93 КБ)
- [x] `grep dangerouslySetInnerHTML\|innerHTML` src/ — пусто
- [x] живая проверка панели форматирования (реальный DOM API, 4 из 5
      операций визуально подтверждены, консоль чиста)
- [x] CONTRACTS.md/PLAN.md/log.md обновлены
- [x] коммит (458f43c)

## Markdown — Этап C.0. Спайк ProseMirror на телефоне (подготовлен, тест — за пользователем)

ТЗ §4.C.0: "единственный риск всего ТЗ, который не ловится ни одним
автотестом" — обязателен ДО написания кода полного редактора. Голый
`EditorView`, минимальная схема (`doc`/`paragraph`/`text`, марки
`strong`/`em`) — сознательно НЕ финальная схема C.2 (без списков/
заголовков/input-rules/keymap кастомизации) — минимум, нужный только
чтобы проверить IME/клавиатуру/paste, не архитектуру редактора.

Зависимости C.1 установлены (`prosemirror-state`, `-view`, `-model`,
`-transform`, `-commands`, `-history`, `-keymap`, `-inputrules`,
`-schema-list`) — полный набор, даже то, что спайк не использует
(пригодится в самом C, не тратить второй `npm install`).

Файлы (корень репозитория, НЕ `src/` — явно временные, не часть
архитектуры приложения, не участвуют в основной сборке `index.html`):
`spike-prosemirror.html` + `spike-prosemirror.js`. Логируют
`compositionstart/update/end` (IME) и содержимое документа на каждое
изменение прямо на странице (`#log`) — чтобы видеть происходящее на
телефоне без remote devtools.

Проверено locally (desktop Chrome, автоматизация) ДО передачи
пользователю: `EditorView` монтируется, ввод текста работает,
`dispatchTransaction` срабатывает на каждое изменение, `Mod-B`
переключает `strong`. Найден и исправлен CSS-баг вёрстки (не
ProseMirror-логика): `min-height: 100%` на `.ProseMirror` не
растягивался без `display: flex` на родителях по всей цепочке —
кликабельная область была 24px вместо всей отведённой (сработал бы
только клик точно по первой строке текста) — на телефоне это было бы
незаметно как логическая ошибка, просто неудобно/раздражающе, но
могло увести проверку в сторону. Исправлено.

**Как открыть на телефоне**: `npm run dev` (поднимает Vite + локальный
strfry/blossom, спайк их не использует), затем на телефоне —
`https://2gty8p-150-241-83-79.ru.tuna.am/spike-prosemirror.html` (уже
настроенный tuna-туннель, `vite.config.js`, живёт до истечения сессии
tuna — если протух, поднять новый и обновить `allowedHosts`).

**Чек-лист живой проверки (за пользователем, ~30 минут, ТЗ C.0)**:
- [ ] Русская раскладка — обычный набор текста
- [ ] Свайп-ввод (если есть на клавиатуре устройства)
- [ ] Автоподстановка/автокоррекция слов
- [ ] Вставка текста из буфера обмена
- [ ] Появление экранной клавиатуры — редактор не уезжает/не
      перекрывается

Отрицательный результат по ТЗ снимает §5 целиком (редактор постов) —
возврат к `textarea` + панели (уже есть с Этапа D) + вкладке
"Предпросмотр" через уже готовый `MarkdownView`, за 0 КБ дополнительно.

### Довесок — живой E2E через реальный strfry (закрывает пробел Этапа D)

Пока живая проверка C.0 ждёт пользователя, закрыт пробел, оставленный
в Этапе D: тогда `npm run preview` + самодельный `fake-relay` харнесса
зависал на "connecting" — причина не расследовалась. Найдено: `npm run
dev` (в отличие от `preview`) поднимает НАСТОЯЩИЙ локальный `strfry`+
`blossom` автоматически (`devRelayPlugin`, `vite.config.js`) — с ним всё
заработало с первого раза, без единой правки кода.

Два тестовых аккаунта (`e2eAuthor`, `e2eSubscriber`), канал, пост
(жирный + буквальная `*` в `5 * 3 рублей` + цитата из двух строк +
список + ссылка) — рендер идентичен ТЗ §5 п.5 первому пункту.
Комментарий `[клик](javascript:alert(1))` + `[нормальный](https://
example.com)` рядом — в DOM ровно одна ссылка (`нормальный`), `клик` —
голый текст, консоль чиста, `alert` не сработал — ТЗ §5 п.5 второй
пункт закрыт буквально. Полный релогин (новая сессия, данные читаются
из IndexedDB заново, не только держатся в памяти вкладки) — пост и
комментарий на месте, рендер не изменился.

Третий пункт ТЗ §5 п.5 (вставка `<img onerror>` в редактор поста) не
проверялся — требует сам редактор (Этап C), которого ещё нет.
"У автора и у подписчика" в буквальном смысле (второй, отдельный,
залогиненный клиент) не проверено — созданный канал без указания
группы контактов в видимости остаётся приватным ("заметочник"),
`e2eSubscriber` не видел его в "Доступные" без полноценной настройки
контактов/групп между двумя аккаунтами. Не считаю это блокирующим:
рендер (`MarkdownView`) — чистая функция без per-user ветвления,
подписчик читает тот же `event.content` с того же `strfry` — расхождение
структурно невозможно, отдельная эмпирическая проверка добавила бы
уверенность несоразмерно объёму настройки (contact request → accept →
group → видимость канала).

Тестовые аккаунты/IndexedDB очищены, dev-сервер остановлен после
проверки.

### Довесок — SVG-иконки панели форматирования (фидбек пользователя после C.0)

Пользователь после проверки C.0 (пройден на десктопе и телефоне) явно
попросил заменить текстовые символы кнопок панели (B/I/❝/•/🔗, решение
Этапа D — "новый девдепенденси для SVG-рендер-тестов не добавляется,
копирование новых SVG путей без внешней проверки — неоправданный риск")
на настоящие SVG-иконки. Риск брака снят: SVG скачаны напрямую байт-в-
байт через `curl` с `raw.githubusercontent.com` (не пересказаны моделью
через WebFetch, который HTML→markdown конвертирует и рискует исказить
числа path) — тот же источник (Radix Icons, MIT), что уже используют
45 существующих иконок проекта (`chat-bubble.jsx` и др.).

Новые файлы: `src/ui/icons/format-{bold,italic,quote,list,link}.jsx`
(`font-bold`, `font-italic`, `quote`, `list-bullet`, `link-2` — точные
имена файлов Radix Icons). `markdown-format-toolbar.jsx` — точечная
замена текстового содержимого кнопок на импортированные иконки, без
изменения контракта компонента (пропы/обработчик те же).

**Найден и закрыт реальный CSS-баг** (не гипотетический — иконки были
не видны, `getBoundingClientRect()` возвращал `0×0`): глобальный ресет
`minimal.css`, `svg { max-width: 100%; height: auto }` (тег-селектор,
специфичность `0,0,1`) конфликтует с HTML-атрибутами `width="1em"
height="1em"` на самом SVG ИМЕННО внутри flex-контейнера
(`.markdown-toolbar-btn { display: flex }`) — в обычном block-контексте
(все остальные 45 иконок проекта) конфликта нет, resolves нормально
через viewBox-пропорцию. Закрыто явным правилом `.markdown-toolbar-btn
.icon { width: 1em; height: 1em; max-width: none; flex-shrink: 0 }`
(специфичность `0,2,0` — уверенно выше тег-селектора).

**Живая проверка застряла на устаревшем Service Worker.** После первой
пересборки иконки всё ещё не появлялись — `getComputedStyle` показывал
СТАРОЕ CSS-правило (без `max-width: none`), хотя в `dist/index.html` на
диске уже было верное. Причина: проект регистрирует Service Worker с
офлайн-кэшем (`ugolok-cache-v{hash}`) — обычная перезагрузка вкладки НЕ
подхватывает новую сборку. **Урок на будущее для любой живой проверки
после повторной пересборки**: `navigator.serviceWorker.getRegistrations()`
→ `unregister()` + `caches.keys()` → `caches.delete()` ДО перезагрузки,
иначе тестируется предыдущая версия бандла молча, без какой-либо ошибки.

`npm run build`: 756,76 КБ (+3,43 КБ за 5 SVG — в пороге). Регрессия:
1676/1676 (иконки не имеют юнит-тестов — тот же паттерн, что вся JSX-
обвязка проекта, только live-проверка в браузере).

## Markdown — Этап C. Редактор постов (ProseMirror)

ТЗ §4. Триаж (13a): **пограничная**, тот же класс, что `format-insert.js`
(Этап D) — сам механизм (схема+сериализация) рутинный (готовые библиотеки
по документации), но соответствие mdast↔PM-документ имеет нетривиальный
инвариант (round-trip с точностью до нормализации, схема обязана точно
покрывать `node-allowlist.js`). Design-решения ниже — не формальная 13b
(нет пространства состояний/асимптотики), но зафиксированы явно, чтобы
воркер не изобретал их сам.

### Зависимости — установлены (C.1)

`prosemirror-{state,view,model,transform,commands,history,keymap,
inputrules,schema-list}` (Этап C.0), `mdast-util-to-markdown` (новая),
`orderedmap` (новая — транзитивная через `prosemirror-schema-list`/
`prosemirror-model`, добавлена прямой зависимостью явно, тот же принцип
NF-18, что `mdast-util-from-markdown` на Этапе A). **НЕ** добавлены и не
добавляются: `prosemirror-markdown` (тянет `markdown-it`),
`prosemirror-schema-basic` (см. ниже — используем только 60 строк своей
схемы + готовый `prosemirror-schema-list` для узлов списков и их команд).

### Схема — `prosemirror-schema-list` переиспользуется целиком, не переписывается

`addListNodes(OrderedMap, itemContent, listGroup)` +
`splitListItem`/`liftListItem`/`sinkListItem` — уже установленный пакет
`prosemirror-schema-list` предоставляет ИМЕННО эти примитивы готовыми
(проверено напрямую: `addListNodes` даёт узлы `ordered_list`/
`bullet_list`/`list_item` с ожидаемой формой). Переписывать их вручную
(как временно предполагалось в самом ТЗ C.2 "проще написать на 60
строк") — не нужно, C.1 явно РАЗРЕШАЕТ `prosemirror-schema-list`
(запрещён только `prosemirror-schema-basic`, у которого свой конфликт —
`image`/`hard_break` узлы, которых в этом проекте не будет). Свои 60
строк — это `doc`/`paragraph`/`heading`/`blockquote`/`code_block`/
`horizontal_rule`/`text` + марки, НЕ списки.

**Соответствие `node-allowlist.js` (Этап A) — семантическое, не
буквальное совпадение имён.** mdast объединяет списки в один тип `list`
с `attrs.ordered`; PM традиционно (через `prosemirror-schema-list`)
разделяет на `bullet_list`/`ordered_list` — это ДВЕ проекции одного
списка узлов из ТЗ Р-1 ("схема редактора и allowlist рендерера — две
проекции одного mdast-дерева"), не идентичные имена. Таблица
соответствия (для `from-mdast.js`/`to-mdast.js` ниже):

| mdast (`RICH_*_TYPES`) | PM node/mark |
|---|---|
| `heading` (depth 1-3) | `heading` (attrs.level 1-3) |
| `paragraph` | `paragraph` |
| `list` (ordered:false) | `bullet_list` |
| `list` (ordered:true) | `ordered_list` (attrs.order = mdast `start` ?? 1) |
| `listItem` | `list_item` |
| `blockquote` | `blockquote` |
| `code` | `code_block` (attrs.lang ← mdast `lang`, обязательно — иначе язык код-блока молча теряется при первом же редактировании существующего поста) |
| `thematicBreak` | `horizontal_rule` |
| `strong` | mark `strong` |
| `emphasis` | mark `em` |
| `inlineCode` | mark `code` |
| `link` | mark `link` (attrs.href — `title` не хранится, схема его не имеет) |
| `text` | `text` |
| `break` | **нет узла** — см. ниже |
| `image`, `html`, любой другой | **нет узла** — см. ниже |

**`break` и всё, чего нет в схеме (image/html/неизвестное) — деградируют
в текст при чтении (`from-mdast.js`), симметрично `markdown-view.jsx`
(Этап A) и `to-plain.js`.** `break` → один пробел (`toPlainText`'s
правило, буквально переиспользуется). `image` → `node.alt ?? ""`.
Остальное неизвестное → `toPlainText({type:"root",children:[node]})`.
**Следствие архитектурного решения ТЗ A.2/C.2**: в редакторе физически
нет способа создать hard break (Shift+Enter не привязан ни к какой
команде) — Enter внутри блока создаёт новый `paragraph`/`list_item`,
это ЕДИНСТВЕННЫЙ способ перехода на новую строку, полностью аналогично
тому, как выглядит УЖЕ существующий пост, набранный вручную через
textarea с настоящими двойными переносами (пустая строка = новый
абзац) — не регрессия функциональности, просто другой набор путей к
тому же результату.

### `src/ui/editor/schema.js`

```js
import { Schema } from "prosemirror-model";
import { addListNodes } from "prosemirror-schema-list";
import OrderedMap from "orderedmap";

const baseNodes = {
	doc: { content: "block+" },
	paragraph: { content: "inline*", group: "block", parseDOM: [{ tag: "p" }], toDOM: () => ["p", 0] },
	heading: {
		attrs: { level: { default: 1 } },
		content: "inline*",
		group: "block",
		defining: true,
		parseDOM: [{ tag: "h1", attrs: { level: 1 } }, { tag: "h2", attrs: { level: 2 } }, { tag: "h3", attrs: { level: 3 } }],
		toDOM: (node) => ["h" + node.attrs.level, 0],
	},
	blockquote: { content: "block+", group: "block", defining: true, parseDOM: [{ tag: "blockquote" }], toDOM: () => ["blockquote", 0] },
	code_block: {
		content: "text*",
		marks: "",
		group: "block",
		code: true,
		defining: true,
		attrs: { lang: { default: null } },
		parseDOM: [{ tag: "pre", preserveWhitespace: "full", getAttrs: (dom) => ({ lang: dom.querySelector("code")?.getAttribute("data-lang") ?? null }) }],
		toDOM: (node) => ["pre", ["code", { "data-lang": node.attrs.lang }, 0]],
	},
	horizontal_rule: { group: "block", parseDOM: [{ tag: "hr" }], toDOM: () => ["hr"] },
	text: { group: "inline" },
};

// itemContent "paragraph block*" — стандартный prosemirror-schema-list рецепт
// (в т.ч. в самой доке пакета), listGroup "block" — списки участвуют в doc/
// blockquote/list_item content наравне с paragraph/heading/etc.
const nodes = addListNodes(OrderedMap.from(baseNodes), "paragraph block*", "block");

const marks = {
	strong: { parseDOM: [{ tag: "strong" }, { tag: "b" }], toDOM: () => ["strong", 0] },
	em: { parseDOM: [{ tag: "i" }, { tag: "em" }], toDOM: () => ["em", 0] },
	code: { code: true, parseDOM: [{ tag: "code" }], toDOM: () => ["code", 0] },
	link: {
		attrs: { href: {} },
		inclusive: false,
		parseDOM: [{ tag: "a[href]", getAttrs: (dom) => ({ href: dom.getAttribute("href") }) }],
		toDOM: (mark) => ["a", { href: mark.attrs.href, target: "_blank", rel: "noopener noreferrer" }, 0],
	},
};

export const schema = new Schema({ nodes, marks });
```
Ни `image`, ни `hard_break` НИГДЕ не упомянуты — это и есть механизм
запрета из ТЗ A.2/C.2: не проверка после факта, а структурное
отсутствие возможности. `DOMParser.fromSchema(schema)` (paste-обработка,
использует именно эти `parseDOM` правила) автоматически "проваливается"
сквозь неизвестные теги (`<img>`, `<script>`, `<iframe>`), забирая в
лучшем случае их текстовое содержимое, никогда — сам тег/атрибуты
(`onerror=...` — атрибут элемента, которого не существует в
результирующем документе, а `<img>` без children — void-элемент,
исчезает целиком без следа). Это и есть механизм C.7 теста
"вставка HTML — в документе не остаётся ничего, кроме текста".

### `src/ui/editor/from-mdast.js`

```js
export function fromMdast(mdastRoot)
    // -> PM Node (doc). mdastRoot — результат parseRich(source) (Этап A).
```
Рекурсивный обход по таблице соответствия выше, строит через
`schema.node(name, attrs, content)`/`schema.text(value, marks)`.
Пустой `mdastRoot.children` (source пуст) → `doc` обязан содержать хотя
бы один `paragraph` (ProseMirror требует непустой валидный документ —
`content: "block+"`) — пустой параграф `schema.node("paragraph")`, если
после обхода получился пустой массив блоков верхнего уровня.

### `src/ui/editor/to-mdast.js`

```js
import { toMarkdown } from "mdast-util-to-markdown";

export function toMdast(pmDoc)
    // -> mdast root node. Обратное соответствие таблице выше.
export function toMarkdownSource(pmDoc)
    // -> string. toMarkdown(toMdast(pmDoc), { bullet: "-", emphasis: "*", strong: "*", rule: "-" }).
```
`ordered_list`'s `attrs.order` → mdast `list.start` (обратно: mdast
`start` ?? 1 → PM `order`). Пустой текстовый узел (PM `text` с
`node.text === ""`) невозможен в валидном PM-документе — не обрабатывать
специально.

### `src/ui/editor/input-rules.js`

Блочные — `wrappingInputRule`/`textblockTypeInputRule` из
`prosemirror-inputrules` (готовые фабрики, не писать вручную):
- `heading`: `textblockTypeInputRule(/^(#{1,3})\s$/, schema.nodes.heading, match => ({level: match[1].length}))`
- `blockquote`: `wrappingInputRule(/^\s*>\s$/, schema.nodes.blockquote)`
- `bullet_list`: `wrappingInputRule(/^\s*([-*])\s$/, schema.nodes.bullet_list)`
- `ordered_list`: `wrappingInputRule(/^(\d+)\.\s$/, schema.nodes.ordered_list, match => ({order: +match[1]}), (match, node) => node.childCount + node.attrs.order === +match[1])`
  (последний аргумент — `join`-предикат `wrappingInputRule`, стандартный
  приём из ProseMirror-примеров: продолжать существующий список, если
  введённое число последовательно продолжает нумерацию)
- `code_block`: `textblockTypeInputRule(/^```$/, schema.nodes.code_block)`

**Марки `**`/`*` — кастомная `markInputRule` (`prosemirror-inputrules`
не предоставляет фабрику для marks, только для node-транформаций;
пишется вручную поверх базового класса `InputRule`, стандартный
публично известный паттерн, не собственное изобретение):**
```js
import { InputRule } from "prosemirror-inputrules";

function markInputRule(regexp, markType) {
	return new InputRule(regexp, (state, match, start, end) => {
		const tr = state.tr;
		const textStart = start + match[0].indexOf(match[1]);
		const textEnd = textStart + match[1].length;
		if (textEnd < end) tr.delete(textEnd, end);
		if (textStart > start) tr.delete(start, textStart);
		tr.addMark(start, start + match[1].length, markType.create());
		tr.removeStoredMark(markType);
		return tr;
	});
}
```
`bold`: `markInputRule(/(?:^|\s)\*\*([^*]+)\*\*$/, schema.marks.strong)`.
`italic`: `markInputRule(/(?:^|\s)\*([^*]+)\*$/, schema.marks.em)` —
регистрировать ПОСЛЕ bold-правила в массиве плагина `inputRules({rules})`
(порядок имеет значение: `**text**` не должен по пути сработать как два
одиночных `*`; `[^*]+` в regex уже структурно не даёт `*text*` совпасть
с частью `**text**`, но порядок — дополнительная подстраховка).

### `src/ui/editor/keymap.js`

```js
import { baseKeymap, toggleMark } from "prosemirror-commands";
import { undo, redo, history } from "prosemirror-history";
import { splitListItem, liftListItem, sinkListItem } from "prosemirror-schema-list";
import { keymap } from "prosemirror-keymap";
import { schema } from "./schema.js";

export const editorKeymap = keymap({
	"Mod-b": toggleMark(schema.marks.strong),
	"Mod-i": toggleMark(schema.marks.em),
	"Mod-z": undo,
	"Mod-y": redo,
	"Mod-Shift-z": redo,
	"Enter": splitListItem(schema.nodes.list_item),
	"Tab": sinkListItem(schema.nodes.list_item),
	"Shift-Tab": liftListItem(schema.nodes.list_item),
});
export const baseKeymapPlugin = keymap(baseKeymap);
```
`splitListItem`/`liftListItem`/`sinkListItem` — импортированы напрямую
из `prosemirror-schema-list` (проверено: пакет их реально экспортирует,
готовые, не переписывать). `"Enter": splitListItem(...)` возвращает
`false`, если курсор вне списка — ProseMirror сам пробует следующий
обработчик в keymap-цепочке (`baseKeymap`'s обычный Enter для paragraph)
благодаря стандартному команд-fallback механизму `prosemirror-commands`
— порядок плагинов в `EditorState.create({plugins})` обязан быть
`[history(), inputRules({rules}), editorKeymap, baseKeymapPlugin, ...]`
(специфичные раньше общих — `keymap`-плагины ProseMirror пробуются по
порядку регистрации, первый вернувший `true` останавливает цепочку).

### `src/ui/editor/editor.jsx`

```jsx
export default function PostEditor({ initialSource, onChange })
```
`initialSource` — markdown-строка (`updateDraftPost`'s текущий `text`,
Этап C.6). Preact-обёртка: `<div ref={hostRef} />`, Preact никогда не
рендерит в него детей (тот же инвариант, что везде в проекте — DOM
владеет им ProseMirror целиком). `EditorView` создаётся в
`useEffect(..., [])` (пустой массив — один раз, `initialSource` читается
только при монтировании, компонент **не controlled**, проп не
обновляет документ повторно — Р-4/C.4 явно запрещает controlled-паттерн,
он ломает позицию курсора/IME), `view.destroy()` в cleanup.
`dispatchTransaction`: `view.updateState(newState)`, затем, **только
если `tr.docChanged`**, `onChange(toMarkdownSource(newState.doc))`.
`EditorState.create({ doc: fromMdast(parseRich(initialSource ?? "")),
schema, plugins: [...] })`.

### `src/ui/editor/toolbar.jsx`

Кнопки: жирный, курсив, заголовок (цикл 1→2→3→снять, либо простое
меню — на усмотрение при реализации, не архитектурный вопрос), цитата,
список маркированный, список нумерованный, ссылка, код. Команды —
`toggleMark`/`wrapIn`/`setBlockType`/`wrapInList` (`prosemirror-commands`
/`prosemirror-schema-list`), выполняются через `command(view.state,
view.dispatch)`, НЕ через textarea-манипуляцию (в отличие от Этапа D
`markdown-format-toolbar.jsx` — это ДРУГОЙ, не переиспользуемый
компонент, работающий с `EditorView`, а не `<textarea>`). Активное
состояние кнопки — по `state.selection`/`state.storedMarks` (mark
активна, если `markType.isInSet(state.storedMarks || state.selection.
$from.marks())`). Иконки — переиспользовать `src/ui/icons/format-{bold,
italic,quote,list,link}.jsx` (Этап D-довесок) для жирный/курсив/цитата/
список/ссылка; заголовку и коду нужны новые (тем же способом — Radix
Icons `font-size`/`code`, скачать `curl`'ом напрямую, не через WebFetch).

**Подсказка markdown-синтаксиса (явное требование пользователя, C.0-
довесок)**: мелкий текст под панелью (или под редактором), i18n через
`t()`, 12 локалей. Формулировка по образцу пользователя: список приёмов
"**жирный**", "*курсив*", "> цитата", "- список", "[ссылка](url)". Не
всплывающая подсказка/тултип — постоянно видимый мелкий текст (по
формулировке "а то с первого раза непонятно, есть ли markdown вообще" —
подсказка должна быть видна СРАЗУ, без наведения/клика).

### CSS

`node_modules/prosemirror-view/style/prosemirror.css` — **скопировать**
в `src/styles/` (не импортировать из `node_modules`, ТЗ C.5), поверх —
собственные токены проекта. Плюс правило для подсказки-текста (мелкий
шрифт, приглушённый цвет, тот же `var(--muted)`, что везде в проекте).

### Ссылки, черновики

Диалог вставки ссылки (toolbar.jsx) — `safeHref` из
`src/core/markdown/sanitize.js` (Этап A), **тот же**, не своя проверка;
отклонённый URL — не молчать, показать причину (i18n-строка, 12
локалей). `updateDraftPost` не меняется (ТЗ C.6) — `editor.jsx`'s
`onChange` передаёт готовую markdown-строку туда же, куда раньше шёл
`e.currentTarget.value` от textarea.

### Интеграция в `channel.jsx`

`POST_MAX_LENGTH`-textarea (форма создания/редактирования поста,
`channel.jsx`) заменяется на `<PostEditor initialSource={text}
onChange={setText} />`. Лимит `POST_MAX_LENGTH=10000` (Р-4 — исходник,
скрытый жёсткий потолок) проверяется НЕ через `maxLength`-атрибут
textarea (которого больше нет) — на `onChange` в `channel.jsx`:
`toMarkdownSource(...).length > POST_MAX_LENGTH` → не принимать
изменение / показать предупреждение (конкретный UX — при реализации,
не архитектурный вопрос). Счётчик длины, видимый пользователю —
`toPlainText(...).length` относительно `plain ≤ 10000` (Р-4), а не
`source.length` — те же функции Этапа A, только теперь считают от
`toMdast`'а результата, не от сырого текста.

### Тесты (C.7, до кода)

- Round-trip: **idempotency** после первого нормализующего прохода —
  `f = src => toMarkdownSource(fromMdast(parseRich(src)))`;
  `f(f(src)) === f(src)` для разнообразного набора src (включая
  "нестабильные" случаи — многострочная цитата как один mdast-абзац с
  `\n`, которая после первого прохода естественно становится ДВУМЯ PM-
  paragraph, т.е. `f(src) !== src`, но `f(f(src)) === f(src)`
  обязательно). Плюс отдельные точные `f(src) === src` тесты на ЗАВЕДОМО
  стабильных src (одиночный paragraph, heading, простой список без
  вложенности, blockquote из одной строки, code block, hr, ссылка,
  жирный+курсив) — эти не подвержены P-M-нормализации вообще.
- Схема не содержит узлов вне `node-allowlist.js`'s семантики (по
  таблице соответствия выше) — проверка на самом объекте
  `schema.nodes`/`schema.marks` (`Object.keys`), не глазами.
- `DOMParser.fromSchema(schema).parse(...)` на HTML-фрагменте с `<img
  onerror>`, `<script>`, `<iframe>` — в результирующем PM-документе
  (`doc.textContent`/обход) не остаётся ничего, кроме текста, узлов
  `image`/`script`/`iframe` нет вообще (их и не существует в схеме).
- `safeHref` отклоняет `javascript:` — переиспользуемый тест уже есть
  (Этап A), здесь — что диалог вставки ссылки `toolbar.jsx` его
  вызывает (интеграционная, не юнит-проверка — живая).
- `from-mdast.js`/`to-mdast.js` — юнит-тесты на таблицу соответствия
  впрямую (каждый mdast-тип → ожидаемый PM-узел и обратно), плюс
  `break`/`image`/неизвестное → деградация в текст.
- `input-rules.js`/`keymap.js`/`editor.jsx`/`toolbar.jsx` — без юнит-
  тестов (JSX/EditorView-обвязка, тот же паттерн, что везде в проекте) —
  живая проверка в браузере, ОБЯЗАТЕЛЬНО с явной очисткой Service
  Worker кэша перед каждой проверкой после пересборки (см. довесок
  выше — иначе тестируется старая версия молча).

### Этап C ЗАКРЫТ

Реализовано ровно по контракту выше: `schema.js`, `from-mdast.js`,
`to-mdast.js`, `input-rules.js`, `keymap.js`, `editor.jsx`,
`toolbar.jsx` (все в `src/ui/editor/`), плюс 2 новые иконки
(`format-heading.jsx`, `format-code.jsx` — тот же curl-метод, что
довесок Этапа D), CSS (`src/styles/prosemirror.css` — точная копия
`prosemirror-view/style/prosemirror.css` + токены проекта в
`custom.css`), 7 новых i18n-ключей `postEditor.*` × 12 локалей,
интеграция в `channel.jsx`'s `PostComposer` (лимиты Р-4 разделены:
`POST_MAX_LENGTH=10000` — видимый, по `toPlainText`; новый
`POST_SOURCE_MAX_LENGTH=20000` — скрытый, по markdown-исходнику).

**Найден и исправлен пробел в собственном контракте ДО того, как он
стал багом**: изначальная версия `schema.js`/`from-mdast.js` не хранила
`lang` код-блока — round-trip тест на code block сразу бы провалился.
Пойман при написании тестов (до вызова воркера на `to-mdast.js`),
исправлено точечно в уже написанных `schema.js`/`from-mdast.js` без
повторного вызова воркера.

**41 юнит-тест** (13 `schema.js` + 28 `from-mdast.js`/`to-mdast.js`,
включая round-trip idempotency-проверку и точные совпадения на
стабильных примерах) — все зелёные с первого прохода после точечных
правок. `input-rules.js`/`keymap.js`/`editor.jsx`/`toolbar.jsx` — без
юнит-тестов (тот же паттерн, что весь JSX/EditorView-слой проекта),
живая проверка — обязательна.

**Живая проверка (реальный браузер, `npm run dev` — настоящий strfry)
подтвердила ВСЁ с первого раза, без единой находки**: панель с 7
SVG-иконками отрендерилась корректно (CSS-фикс из довеска Этапа D
применён упреждающе — баг не повторился); подсказка синтаксиса видна
сразу под редактором; `# ` → реальный `<h1>`; `**текст**` → реальный
жирный текст без участия toolbar (input-rule сработал на лету);
`> ` → цитата; `- ` → маркированный список; публикация → рендер через
`MarkdownView` дал ВИЗУАЛЬНО ИДЕНТИЧНЫЙ результат тому, что было в
редакторе (доказывает `to-mdast.js`→`toMarkdownSource`→сохранение→
`parseRich`→рендер — весь цикл целиком, не только юнит-уровень).
**Адверсарный тест — вставка HTML с `<img onerror>`, `<script>`,
`<iframe src="javascript:...">` через симуляцию `paste`-события**:
результат в документе — только текст `"до"`/`"после"`, ни один вектор
не сработал (`window.__xssFired` не выставился), консоль чиста. Это
живое, не только юнит-тестовое, подтверждение C.7's самого критичного
требования.

Бюджет: 836,80 КБ. Порог "после C" в контракте (817,36 КБ) снова считался
от устаревшей базы (737,36, актуальной сразу после Этапа A) — та же
ситуация, что уже была один раз, с уже одобренным пользователем способом
решения. Пересчитано от актуальной базы (756,76 КБ, после Этапа D-
довеска SVG-иконок) той же дельтой ProseMirror (+80 КБ, что почти
идеально совпало с фактическим приростом +80,04 КБ) → новый порог
836,76 КБ, факт 836,80 КБ — расхождение 0,04 КБ (округление), не
реальный перерасход. Решено без повторного вопроса пользователю —
паттерн и обоснование те же, что уже одобрены явно.

DoD:
- [x] тесты этапа зелёные (41/41), полная регрессия зелёная (1717/1717)
- [x] `npm run build` зелёный, 836,80 КБ (пересчитанный порог, обоснование выше)
- [x] `grep dangerouslySetInnerHTML\|innerHTML` src/ — пусто
- [x] живая проверка: ввод/input-rules/toolbar/публикация/рендер — всё с первого раза
- [x] адверсарный заход: вставка HTML — ничего вредоносного не проходит, живьём подтверждено
- [x] CONTRACTS.md/PLAN.md/log.md обновлены
- [x] коммит (5c247fc)

Явно НЕ покрыто этим разделом (будет своя запись в CONTRACTS.md на
своей стадии): allowlist-места без рендера markdown (E), проп-контракт
панели форматирования и лимиты композеров (D), схема ProseMirror и
`from-mdast.js`/`to-mdast.js` (C). Замечено уже сейчас, при чтении кода
для Этапа A (не блокирует Этап A, фиксируется для Этапа E): ссылка ТЗ
"`channel.jsx:780`, `req__body` — приветствие в заявке от незнакомца"
не соответствует текущему коду — на `channel.jsx:780` сейчас лежат
ПРАВИЛА КАНАЛА (`channelRow.rules`), а не приветствие заявки; поле
`greeting` (заявка в контакты, `contact-runtime.js`/`contact-fsm.js`)
существует в домене, но нигде не рендерится в UI вовсе (ни в
`contacts.jsx`, ни где-либо ещё). **Решение пользователя (задан явно
при старте Этапа E): `greeting` НЕ показывать** — это отдельная,
незапланированная в ТЗ задача, вне скоупа. На Этапе E для этого пункта
ТЗ трогать нечего — рендер-места для него просто не существует.

---

## Медиа-подсистема — Этап A (чистое ядро `src/domain/media/`)

Источники: `PROCESS-DOCS/MEDIA-SYSTEM/{MEDIA-MATH,MEDIA-ALGO,MEDIA-SPEC}.md`.
Design-записка автомата — `DESIGN.md` "Медиа-подсистема — Этап A".
Ничего не подключается к UI/адаптерам в этом этапе. Всё в `node --test`.

### `src/domain/media/playlist.js` [C]

```js
/**
 * @typedef {Object} Playlist
 * @property {MediaRef[]}   items
 * @property {Uint8Array}   cls    позиция → 0 audio | 1 video | 2 image | 3 other
 * @property {Int32Array}   rank   позиция → номер внутри своего класса
 * @property {{audio:Int32Array, video:Int32Array, image:Int32Array}} idx
 * @property {Float64Array} pref   префиксные суммы size, длина items.length+1
 */
export function buildPlaylist(refs, { dedupeClasses = ["audio", "video"] } = {})
export function classesPresent(pl)               // → {audio, video, image} — булевы
export function stepInClass(pl, position, delta)  // → позиция | -1
export function firstOfClass(pl, cls)             // → позиция | -1
export function windowByBudget(pl, position, budgetBytes, maxSpan)  // → {l, r}, полуинтервал
```

Порядок классов в `cls`/`idx`: `0=audio, 1=video, 2=image, 3=other`
(фиксировано, используется и в `media-machine.js`, и в тестах —
менять только вместе).

**`buildPlaylist`** — ALGO §4.2 буквально: два прохода (подсчёт →
выделение `idx[c] = Int32Array(cnt[c])` → размещение с одновременным
заполнением `rank`). `pref[0] = 0`, `pref[j+1] = pref[j] + refs[j].size`
ДО дедупликации по позициям (после дедупликации — по оставшимся
позициям, индексация внутри `items`, не внутри исходного `refs`).
Дедупликация (`dedupeClasses`) — первое вхождение остаётся, повторные
исключаются из `items` целиком (не просто из `idx`) — ALGO §4.1,
`Set<digest>` в одном проходе с построением `L`.

**`stepInClass`**: `c = pl.cls[position]`, `r = pl.rank[position]`,
результат — `pl.idx[classNameOf(c)][r + delta]`, либо `-1`, если
`r + delta` вне `[0, idx[c].length)`. `Θ(1)`.

**`windowByBudget`**: наибольшее по включению окно `[l, r)` вокруг
`position`, укладывающееся в `budgetBytes` (`pref[r]-pref[l] ≤ budgetBytes`)
и не длиннее `maxSpan` позиций. Два указателя (ALGO §3.3): `l, r`
инициализируются в `position, position+1` и раздвигаются, пока влезают
оба ограничения; направление раздвижения — поочерёдно влево/вправо
(симметрично вокруг `position`, не «сначала всё вправо»). При
`budgetBytes = 0` или `maxSpan ≤ 1` → `{l: position, r: position+1}`
(минимум — сам элемент, окно никогда не пустое для валидной `position`).

### `src/domain/media/media-machine.js` [C]

```js
/**
 * @typedef {null | {
 *   cls: "audio"|"video"|"image",
 *   position: number,
 *   display: "full"|"mini",
 *   play: "playing"|"paused"|"suspended",
 *   callActive: boolean
 * }} MediaState
 */
export const EVENTS = ["open","next","prev","toggle","minimize","restore",
                       "close","callStart","callEnd","ended","seek"];

/** ТОТАЛЬНА. payload: open → {cls, position}; seek → {t} (игнорируется машиной); прочие — не используются. */
export function transition(state, event, payload, playlist)

/** Чистая функция состояния — MATH §6.2 + windowByBudget для image (DESIGN.md). */
export function allocWindow(state, playlist, budgetBytes)
```

Полная таблица переходов, разбор недоопределённых по SPEC ячеек
(`open`+звонок, `callStart`/`callEnd`+`callActive`, `next`/`prev`/`ended`
на границе класса, `seek`, `minimize` на image) — **буквально** в
`DESIGN.md` "Медиа-подсистема — Этап A: формализация автомата". Реализация
транскрибирует псевдокод оттуда один в один, включая обоснования (это
формализация Claude, не задание воркеру — правило 13b).

Инварианты И1–И6 — SPEC §3.4 дословно; тест A5 обходом графа
достижимости проверяет их все плюс тотальность `δ` (все `37×11` пар
состояние×событие, не только достижимые).

### `src/domain/media/media-ref.js` [W]

Найдено разведкой по коду (важно для контракта):
`attachmentTypeFromMime` (`src/domain/messaging/attachments.js:21-26`,
НЕ экспортирована) классифицирует в `"video"|"audio"|"image"|"file"`
(`"file"` — фолбэк). Дескриптор вложения (и чата, и канала — один
формат, `uploadMessageAttachment`/`referenceStoredFile`,
`attachments.js:33-54`): `{type, manifestDigest, fileKey (base64-
строка!), mime, size, name}`; голосовые получают `descriptor.voice =
true` ОТДЕЛЬНО, на стороне `chat.jsx` (не часть базового дескриптора).
`Node` (`tree.js`, `mkNode`) хранит `{id, kind, blob, par, name, origin,
purged}` — **без `size`** (размер — только в манифесте).

```js
/** @returns {"audio"|"video"|"image"|"other"} */
export function classOf(mime)

/** attachment: {manifestDigest, fileKey (base64), mime, name, size}. key всегда резолвится (fileKey у дескриптора не бывает пустым). */
export function refFromAttachment(attachment, sourceMeta)

/** ОТКЛОНЕНИЕ от буквальной сигнатуры SPEC §3.1 (node, mime, key): добавлен
 *  4-й параметр size. Причина: MediaRef.size обязателен по typedef, а Node
 *  (tree.js) поля size не хранит вовсе — только манифест его знает, и
 *  вызывающая сторона (Этап E/F, ещё не написана) обязана передать его
 *  явно, как уже передаёт mime и key. Дёшево отменить (не экспортируемая
 *  наружу пара функций), решение Claude, не вопрос пользователю. */
export function refFromNode(node, mime, key, size)
```

`classOf`: `mime.startsWith("audio/") → "audio"`, `"video/" → "video"`,
`"image/" → "image"`, иначе `"other"`.

`refFromAttachment`: `digest = attachment.manifestDigest`, `key =
base64ToBytes(attachment.fileKey)` (свой приватный `base64ToBytes` в
`media-ref.js` — 2 строки, тот же код, что уже приватно дублирован в
`attachments.js`; общего экспортируемого хелпера в проекте нет, заводить
не по масштабу этой задачи), `mime/name/size` — с дескриптора один в
один, `sourceKind: "attachment"`, `sourceMeta` — как передано вызывающей
стороной.

`refFromNode`: `digest = node.blob`, `key`/`mime`/`size` — параметры как
есть, `name = node.name.value` (LWW-регистр — только `.value`),
`sourceKind: "node"`, `sourceMeta: {nodeId: node.id}`.

**Часть A1 — точечная правка существующего файла (мандат самого
SPEC §3.1): `attachmentTypeFromMime` НАЧИНАЕТ звать `classOf`, а не
дублировать классификацию.** Существующий вызывающий код и уже
сохранённые сообщения используют строку `"file"` (не `"other"`) как
класс "прочее" — это часть уже принятого сетевого/доменного формата
(поле `type` дескриптора), менять её нельзя. Правка:

```js
import { classOf } from "../media/media-ref.js";
function attachmentTypeFromMime(mime) {
	const c = classOf(mime);
	return c === "other" ? "file" : c;
}
```

Поведенчески — noop (тот же результат на всех входах), тест на
`attachments.js` — регрессия, не новый тест.

### `src/domain/media/scope.js` [W]

Найдено разведкой: **общей экспортируемой функции сравнения "братьев"
комментариев в кодовой базе НЕТ.** Сортировка сейчас — приватный инлайн
`.sort((a,b) => a.createdAt - b.createdAt)` внутри неэкспортируемой
`buildTree` (`src/domain/content/comments.js:135`), БЕЗ tie-break по
`id` (т.е. без полного порядка при совпадении `createdAt` — слабое
место сравнения с Утв. 1 матдокумента, которое существовало и до этой
работы). **Это не блокирует Этап A**: контракт `collectPostScope`
получает `compareSiblings` ПАРАМЕТРОМ (SPEC §3.2), а не берёт его сам
— инъекция специально изолирует чистое ядро от того, что общей функции
пока нет. **Долг, переносится в Этап D/F (не в этот контракт)**:
вынести сравнение из `comments.js` в экспортируемую функцию с
tie-break по `id`, использовать её и в отрисовке треда, и при вызове
`collectPostScope` — иначе нарушится ЖЕ Утв. 2 (SPEC §3.2, "не
`такой же`, а `той же` функцией").

`loadChatWindow` (`src/core/sync/lazy-chat.js`) уже возвращает
`messages`, отсортированные по `(lamportTs, senderPubkey, id)` —
предположение контракта "уже отсортированное окно" подтверждено.
Сегодняшнее поле сообщения — `attachment` (единственное число, до
Этапа B). `collectChatScope` пишется под ЦЕЛЕВУЮ форму Этапа B
(`message.attachments: []`) — реальная проводка случится в Этапе D/F,
когда B уже закрыт; юнит-тесты Этапа A используют синтетические
сообщения с `attachments`.

```js
/** compareSiblings — параметр, не импорт (общей функции пока нет, см. выше). */
export function collectPostScope({ post, commentsTree, compareSiblings })
export function collectChatScope(messages)      // messages[].attachments — целевая форма Этапа B
export function collectFolderScope(entries, keyOf)
// все три: → MediaRef[], БЕЗ дедупликации (её делает playlist.js/buildPlaylist — SPEC §3.2/3.3 разносят обход и дедуп по разным модулям)
```

`collectChatScope`: по порядку `messages`, для каждого — если
`message.attachments` есть и не `voice`-элемент (SPEC §1.4: голосовые,
`voice === true`, не в плейлисте), `refFromAttachment(a, {msgId:
message.id})` для каждого элемента массива по порядку.

`collectPostScope`: итеративный обход явным стеком (ALGO §4.1, не
рекурсия — глубина ответов не ограничена), `compareSiblings` сортирует
детей на каждом уровне. Вложения самого поста — `refFromAttachment(a,
{postId: post.id})` (SPEC's пример `sourceMeta` не исчерпывающий список
ключей, `postId` добавлен по той же логике, что и `nodeId` — для
отладки/подписи, не влияет на равенство/дедуп, тот идёт по `digest`).
Вложения комментария — `refFromAttachment(a, {commentId: comment.id})`.
Тест на порядок — буквально из ALGO §4.1: дерево «корень → A, B; A →
A1, A2» даёt `A, A1, A2, B`.

`collectFolderScope(entries, keyOf)`: `entries` — уже отфильтрованные
и отсортированные (текущая сортировка экрана) записи вида `{node, mime,
size}` (caller разрешает `mime`/`size` заранее — Этап E денормализует
`mime` в узел, `size` всё равно только в манифесте, тот же довод, что у
`refFromNode`); `keyOf(entry) → Uint8Array|null` — извлекает ключ файла
(в папке ключи резолвятся ЛЕНИВО через отдельный `getFileKeyFor`,
внешний по отношению к дереву — `null`, пока не резолвлен, это и есть
задокументированный в SPEC случай `MediaRef.key === null`). Собственная
защита от не-файлов внутри (`entry.node.kind === "file"`), даже если
вызывающая сторона уже отфильтровала — дёшево, не вредит.

### `src/domain/media/upload-plan.js` [W]

```js
/** clamp(2^round(log2 √(h·size)), 64КиБ, 4МиБ), h=67 — ALGO §4.8, MATH §8.2. */
export function chunkSizeFor(size)
/** По возрастанию size — MATH §8.5 (Утв. 11: порядок почти не важен, конвейер обязателен). */
export function orderUploads(files)   // files: [{size, ...}] → тот же тип, переставленный
```

`chunkSizeFor`: `64*1024 * 2^n`, `n = round(log2(√(67*size) / 65536))`,
зажатое так, что результат ∈ `{65536, 131072, 262144, 524288, 1048576,
2097152, 4194304}` (степени двойки от 64 КиБ до 4 МиБ включительно).
При `size = 0` или отрицательном — `64*1024` (нижняя граница, не
`NaN`/деление на ноль).

### Этап A ЗАКРЫТ

Реализовано ровно по контракту. `media-ref.js`/`scope.js`/`upload-
plan.js` — воркер, все три с первой попытки (8/8, 12/12, 11/11).
`playlist.js`/`media-machine.js` — Claude, по формализации `DESIGN.md`.
`attachments.js` — точечная правка (`attachmentTypeFromMime` зовёт
`classOf`), регрессия файла (54 теста) не тронута.

**A5 нашёл реальный дефект, не гипотетический**: в `doEnded` не было
проверки `callActive`, найдено при первом же прогоне обхода в ширину
на состоянии `audio|suspended|callActive=true`, событие `ended`. Разбор
и исправление — `DESIGN.md`.

Регрессия: 1717 + 76 = 1793/1793. Бюджет: 836,89 КБ (+0,09 КБ —
`domain/media/` пока не подключён к UI, кроме `classOf` транзитивно
через `attachments.js`).

DoD:
- [x] тесты этапа зелёные (76/76), полная регрессия зелёная (1793/1793)
- [x] `npm run build` зелёный, 836,89 КБ
- [x] критерии приёмки §7.1–7.2 (плейлист 10⁴ < 50мс, `stepInClass`
      не растёт, глубина 10⁴ не роняет стек, обход автомата — все
      состояния/И1–И6/тотальность `δ`) — все пройдены тестами
- [x] CONTRACTS.md/PLAN.md/log.md обновлены
- [x] коммит

## Медиа-подсистема — Этап B1+B2 (attachment → attachments, личный чат)

Источник: `MEDIA-SPEC.md` §3.7. Разведка (Explore-агент) нашла ВСЕ
точки касания — см. `log.md`. Оба [C] (связанный формат события +
публичный контракт рендера), Claude пишет напрямую, без воркера.

### `src/domain/messaging/chat.js`

`sendMessage`/`doSendMessage`: 8-й параметр `attachment` →
`attachments` (массив или `undefined`). Пишется в payload/строку/
зеркало **только если `attachments !== undefined && attachments.length
> 0`** — тот же принцип "нет вложения — поля нет вовсе", что уже был у
единственного числа, перенесён на массив (не пишем `attachments: []`
для обычных текстовых сообщений — раздувает payload и ломает
`AC-16`/обратную совместимость на пустом массиве).

Четыре места записи меняют `attachment` → `attachments` буквальной
заменой имени поля и условия (`attachment !== undefined` →
`attachments !== undefined && attachments.length > 0`):
`messagePayload.attachment` (MLS payload), два `upsertMessage(...)` (в
`try`-ветке сбоя publish и в успешной), один `mirrorBestEffort(...)`.

`doReceiveGroupMessageEvent`: замена строки
`if (parsed.attachment !== undefined) extra.attachment = parsed.attachment;`
на нормализацию (SPEC §3.7, буквально):

```js
const normalizedAttachments = parsed.attachments ?? (parsed.attachment ? [parsed.attachment] : undefined);
if (normalizedAttachments !== undefined) extra.attachments = normalizedAttachments;
```

Это ЕДИНСТВЕННОЕ место, где новый формат (`attachments`) и старый
(`attachment`, сообщения до этого этапа — локальная база разработки их
содержит) сходятся в одну переменную; дальше по коду (`upsertMessage`,
`mirrorBestEffort`, возврат функции) — везде уже `extra.attachments`,
никаких следов старого имени.

`enqueuePendingOutgoingMessage`: параметр деструктуризации `attachment`
→ `attachments`, тот же условный spread. `drainPendingOutgoingMessages`:
вызов `sendMessage(..., row.attachment)` → `sendMessage(...,
row.attachments)`.

### `src/domain/messaging/mirror.js`

`buildMirroredMessageRow`: та же нормализация, что в `chat.js` (не
только `payload.attachments !== undefined`, а с фолбэком на
`payload.attachment` — зеркало может доставить историческое событие,
созданное ДО этого этапа, с другого устройства владельца, которое ещё
не обновилось):

```js
const attachments = payload.attachments ?? (payload.attachment ? [payload.attachment] : undefined);
if (attachments !== undefined) extra.attachments = attachments;
```

### `src/ui/signals/chats.js` — `sendChatMessageAction`

Пробрасывающий параметр `attachment` (9-й аргумент) → `attachments`,
переименование в сигнатуре и в обоих местах использования
(`enqueuePendingOutgoingMessage`, `sendMessage`) — сам не решает,
что и как заворачивать в массив, это дело вызывающей стороны
(`chat.jsx`).

### `src/ui/screens/chat.jsx` — минимальная обвязка (НЕ этап B3/B4/лоток)

**Явно вне контракта B3/B4** (тот лоток — отдельная задача воркеру,
мультивыбор файлов): здесь только заворачивание уже существующего
ОДНОГO результата `buildOutgoingAttachment()` в массив, чтобы
приложение не сломалось между B1 (домен ждёт массив) и B4 (лоток ещё
не подключён). Оба композера (`ChatWindow.handleSend`,
`ComposeMessage.handleSend`, независимые копии — см. `log.md`,
находка агента):

```js
const attachment = await buildOutgoingAttachment();
const attachments = attachment !== undefined ? [attachment] : undefined;
// ...sendChatMessageAction(..., attachments)
```

### `src/ui/components/message-bubble.jsx` — рендер списка

Логика "какое вложение выше текста, какие ниже" выносится в чистую
функцию (не в JSX — SPEC §0.3, "логика не должна жить в JSX"):

```js
// src/ui/components/message-bubble-attachments.js
export function splitBubbleAttachments(attachments)
// → { above: MediaDescriptor|null, below: MediaDescriptor[] }
```

Правило (SPEC §3.7, буквально): **только ПЕРВОЕ по порядку изображение
с `position === "above"`** уходит в `above`; все остальные вложения
(независимо от их собственного `position`) — в `below`, в исходном
порядке минус изъятый элемент. Если `attachments` пуст/undefined —
`{above: null, below: []}`.

`message-bubble.jsx`: `const { above, below } = splitBubbleAttachments(message.attachments);`
— рендерит `above` (если есть) до текста, `below` — списком после
текста (`key` — индекс, порядок сообщения неизменен после получения),
и `AttachmentDownloadLink` — по одному на каждый элемент
`message.attachments` (было — один раз на единственное вложение).

### Тесты (до кода)

`tests/chat.test.js`: 4 существующих теста на `attachment`
переписываются на `attachments` (массив из одного элемента, там где
раньше был объект) — `deepEqual` на `[attachment]`, не на `attachment`.
Новый тест: получатель с ЛОКАЛЬНО собранным (не через `sendMessage`)
payload старого формата `{..., attachment: {...}}` (без `attachments`)
— `doReceiveGroupMessageEvent` обязан вернуть `result.attachments`
равным `[этот attachment]` (нормализация читающего пути).

`tests/mirror.test.js`: 2 существующих теста на `buildMirroredMessageRow`
переписываются на массив; новый тест на нормализацию
`payload.attachment` (старый формат зеркала) → `row.attachments`.

`tests/message-bubble-attachments.test.js` (новый, чистая функция, без
DOM): `splitBubbleAttachments` — пусто/undefined, один элемент без
`position`, один элемент `position:"above"`, несколько элементов с
`position:"above"` у НЕ первого (должен остаться в `below` — само
правило "только первое").

### Довесок — живой проверкой найден пробел контракта: чтение УЖЕ
### СОХРАНЁННЫХ строк истории (не только живого/зеркального приёма)

Контракт выше нормализовал `attachment→attachments` на ДВУХ входных
путях: живой приём (`doReceiveGroupMessageEvent`) и зеркало
(`buildMirroredMessageRow`). Живая проверка (два реальных аккаунта,
локальный strfry+Blossom) вскрыла ТРЕТИЙ путь, не учтённый в контракте:
строки, УЖЕ лежащие в `messages` (IndexedDB) с прошлых сессий, ДО этого
этапа — `message-bubble.jsx` начал читать `message.attachments`
(множественное), а такие строки хранят только `message.attachment`
(единственное) → вложение молча переставало отображаться при чтении
истории, хотя сама строка была цела.

Фикс — `src/domain/messaging/chat.js`:

```js
export function normalizeMessageAttachments(row) {
	if (row.attachments !== undefined || row.attachment === undefined) return row;
	return { ...row, attachments: [row.attachment] };
}
```

Применяется в ОБОИХ читающих путях: `getChatHistory` (chat.js) и
`loadChatWindow` (`src/core/sync/lazy-chat.js`, импортирует функцию —
никакого цикла импортов: `chat.js` ничего не импортирует из
`core/sync/`). Старое поле `attachment` НЕ удаляется из строки (только
дополняется) — дешёвая, обратимая, не разрушающая операция чтения.

Тесты (после находки, но до финального прогона): `tests/chat.test.js`
(`normalizeMessageAttachments` напрямую + `getChatHistory` на строке
старого формата), `tests/lazy-chat.test.js` (`loadChatWindow` на строке
старого формата, сохранённой напрямую в `messages` в обход
`sendMessage`).

Это ровно тот класс находки, ради которого в процессе проекта
обязательна живая проверка после тестов: юнит-тесты проверяли КАЖДЫЙ
путь по отдельности корректно (входной payload нормализовался), но
демонстрировали разрыв, который выявляется только сценарием
"перезайти в уже существующий чат с историей, написанной ДО этого
этапа" — то есть ровно тем, что делает живой человек, а не
синтетический тест с чистой БД на каждый прогон.

### Этап B1+B2 ЗАКРЫТ

Регрессия: 1793 + 15 = 1808/1808 (один известный несвязанный флейк по
пути — `room-session` И9, тот же, что уже документирован в прошлых
этапах; воспроизведён в изоляции 1/3 прогонов, подтверждён
независимым от этого этапа — Rooms/voice, glare-resolution race).
Бюджет: 836,97 КБ (+0,08 КБ).

Живая проверка (два реальных локальных аккаунта, настоящий
strfry+Blossom): (а) уже существовавшие ДО этого этапа сообщения
(старый формат `attachment`) продолжают отображаться как плееры после
находки-довеска; (б) два новых вложения отправлены через новый путь
(`attachments`-массив) — дошли, отрендерились, скачиваются.

DoD:
- [x] тесты этапа зелёные (15/15 новых + все переписанные)
- [x] полная регрессия зелёная (1808/1808, флейк не в счёт)
- [x] `npm run build` зелёный, 836,97 КБ
- [x] живая проверка — старый формат читается, новый пишется и
      читается, сквозь реальное шифрование/публикацию/приём
- [x] CONTRACTS.md/PLAN.md/log.md обновлены
- [x] коммит (80f03fc)


## Медиа-подсистема — Этап B3 (`use-attachment-tray.js` + `attachment-tray.jsx`)

Рутинная задача (13a-а) — теоретическая фаза (13b) не нужна.

**Поправка после разведки перед вызовом воркера**: в проекте НЕТ
инфраструктуры для тестирования Preact-хуков (`useState` внутри) —
ни jsdom/happy-dom, ни рендер-стенда, ни у одного из существующих
хуков (`use-details-menu.js`, `use-virtual-window.js`) тестов нет.
Единственный проверенный в этом кодовой базе способ протестировать
логику из JSX/хука — вынести её в чистую функцию на плоском состоянии
(прецедент — `message-bubble-attachments.js`, SPEC §0.3). Поэтому
`use-attachment-tray.js` делится на два файла вместо одного, названного
в MEDIA-SPEC.md §3.11 — расширение контракта, не отступление от него:

- `src/ui/hooks/attachment-tray-core.js` [W] — чистые функции над
  плоским `{ items, errors }`, без `preact/hooks`, без i18n. Тестируется
  `node --test` напрямую.
- `src/ui/hooks/use-attachment-tray.js` [W] — тонкая обвязка `useState`
  поверх ядра + сетевые вызовы `uploadAll`. БЕЗ теста (тонкий слой,
  прецедент — `markdown-format-toolbar.jsx` "без тестов" в контракте
  Markdown-этапа D).

Только хук + "глупый" компонент лотка, СТАНДАЛОН — не подключены к
композерам (то B4).

### `src/ui/hooks/attachment-tray-core.js` [W]

```js
import { DomainError } from "../../domain/errors.js";
import { classOf } from "../../domain/media/media-ref.js";
import { validateAttachment } from "../../domain/files/attachment-validation.js";

emptyTrayState()
// -> { items: [], errors: [] }

addFiles(state, files, maxItems)
// files: File[] | FileList (итерируется как массив)
// -> новый { items, errors }, см. "Лимит/Валидация" ниже

addFromStorage(state, refs, maxItems)
// refs: Array<{ manifestDigest, fileKey, manifest }> — та же форма,
// что chat.jsx::handleAttachmentFromStorage уже строит как
// attachmentSourceRef (manifest.mime/name/size — источник дескриптора)
// -> новый { items, errors }, та же семантика лимита/валидации

setItemPosition(state, id, position)
// position: "above" | "below"; item с type !== "image" — no-op
// -> новый items (errors не трогает)

removeItem(state, id)
// -> новый items (errors не трогает)

planUpload(items)
// -> Array<Job>, см. ниже; бросает DomainError, если хоть у одного
//    item истинный item.error (проверка ДО построения плана — ничего
//    частично не возвращает)
```

Item:

```js
{
  id,          // crypto.randomUUID() — конвенция проекта (contacts.js/
               // call-fsm.js/post.js/channel.js/comments.js/journal.js)
  file,        // File | null — заполнено addFiles
  storageRef,  // { manifestDigest, fileKey, manifest } | null — addFromStorage
  mime, name, size,  // из file.* либо storageRef.manifest.*
  type,        // classOf(mime) с "other"->"file" — та же переклассификация,
               // что messaging/attachments.js::attachmentTypeFromMime
               // (приватная там; здесь короткая копия — тот же
               // сознательный дубль, что уже в attachment-preview.jsx)
  position,    // "above" | "below", только для type==="image", по умолчанию "below"
  error,       // DomainError | undefined — из validateAttachment; невалидный
               // item ОСТАЁТСЯ в items (пользователь видит и убирает сам,
               // паттерн с этапа 29). НЕ локализовано здесь — это делает
               // use-attachment-tray.js на границе (errorMessage(err))
}
```

Job (элемент результата `planUpload`):

```js
{ id, kind: "reference", manifestDigest, fileKey, manifest, isImage, position }
// или
{ id, kind: "upload", file, mime, name, isImage, position }
```

Поведение:

- **Лимит `maxItems`** считается от `state.items.length` ДО вызова.
  Свободных мест 0 → ничего не добавляется, `errors` = [DomainError],
  `items` не меняется. Мест меньше, чем входных файлов, → добавляется
  срез по числу мест, `errors` = [DomainError] на остаток. Всё
  поместилось → `errors` = `[]` (успешный вызов стирает след
  предыдущего переполнения). DomainError в обоих случаях:
  `new DomainError(\`нельзя добавить больше ${maxItems} вложений\`,
  "errors.tooManyAttachments", { max: maxItems })` — ключ уже добавлен
  этим этапом во все 12 locale-файлов, `{{max}}` — единственный параметр.
- **Валидация на добавление**: `validateAttachment({ mime, size })` на
  каждый принятый файл/ref (внутри среза по лимиту); поймали →
  `item.error = <пойманный DomainError>`. `type` вычисляется независимо
  от валидности (`classOf` понимает любую строку mime, включая мусор).
- `planUpload` НЕ выполняет сеть и не импортирует `uploadMessageAttachment`/
  `referenceStoredFile` — только решает, что бы вызвал верхний слой,
  и в каком порядке (порядок `items`).

### `src/ui/hooks/use-attachment-tray.js` [W] — без теста

```js
import { useState, useCallback } from "preact/hooks";
import * as core from "./attachment-tray-core.js";
import { errorMessage } from "../signals/i18n.js";
import { uploadMessageAttachment, referenceStoredFile } from "../../domain/messaging/attachments.js";
import { BUILD_DEFAULT_BLOSSOM_SERVERS } from "../../config.js";

useAttachmentTray({ maxItems })
// -> {
//   items,   // Item[] с item.error уже как string|undefined (errorMessage применён)
//   errors,  // string[] (errorMessage применён к каждому)
//   addFiles(fileList), addFromStorage(refs),
//   setPosition(id, position), remove(id), reset(),
//   uploadAll(privKey, onProgress), // async -> Promise<descriptor[]>
// }
```

`BLOSSOM_SERVER_URL = BUILD_DEFAULT_BLOSSOM_SERVERS[0]` — та же
константа, что `pending-attachment.js`; хук её сам определяет, не
принимает параметром (тот же выбор, что уже сделан в этом файле).

`uploadAll(privKey, onProgress)`: `core.planUpload(state.items)` —
если бросает, `uploadAll` пробрасывает исключение сразу, ничего не
грузит (то же защитное условие, что сейчас разбросано по трём
композерам: `if (attachmentFile && attachmentError) return;` — здесь
одно место вместо трёх, ради чего и делается B3/B4). Иначе —
последовательно (не параллельно: предсказуемый прогресс, сеть и так
сериализована в `putStream`) по каждому `Job`: `kind === "reference"` →
`referenceStoredFile(job.manifestDigest, job.fileKey, job.manifest)`
(без сети); `kind === "upload"` → `new Uint8Array(await
job.file.arrayBuffer())` → `uploadMessageAttachment(BLOSSOM_SERVER_URL,
bytes, { mime: job.mime, name: job.name }, privKey)`. `job.isImage` →
`descriptor.position = job.position`. После каждого элемента —
`onProgress?.(done, total)` (`done` считает с 1). Пустой `items` →
`uploadAll` возвращает `[]`, `onProgress` не вызывается.

`reset()` — `setState(core.emptyTrayState())`.

### `src/ui/components/media/attachment-tray.jsx` [W] — без теста

Новая директория — первый файл `ui/components/media/` (остальные пять
компонентов туда попадут этапом D, MEDIA-SPEC.md §2.4; директория
заводится этим этапом, не раньше).

"Глупый" компонент — только props, без вызова хука и без импорта
домена (правило §2.2 MEDIA-SPEC.md). НЕ переиспользует
`AttachmentPreview` буквально (он расчитан на один `File`, картиночное
превью через `URL.createObjectURL(file)` — у storage-item файла нет,
подсовывать чужеродный объект вместо `File` — обход типа ради
формы, не годится). Вместо этого — собственная лёгкая строка на item:
иконка по `type` (та же карта эмодзи, что в `attachment-preview.jsx` —
сознательный дубль, тот же прецедент) ИЛИ картинка через
`URL.createObjectURL(item.file)` (`useMemo`+revoke в `useEffect`,
как в `attachment-preview.jsx`), только когда `item.file` реально
есть И `item.type === "image"` — для storage-item превью всегда
иконка (сужение, приемлемо для B3, не блокирует). Плюс имя, размер,
`item.error` под именем, radio "above"/"below" только для
`type==="image"`, кнопка "Убрать".

Пропы: `{ items, errors, onRemove(id), onPositionChange(id, position) }`
— `attachment-tray.jsx` НЕ вызывает хук сам (композер держит хук,
передаёт данные и колбэки вниз — обычная связка контейнер/вид).
`errors` рендерятся списком под лотком (пусто — ничего не рендерится).

### Тесты (до кода)

`tests/attachment-tray-core.test.js` — покрыть: `emptyTrayState()`
форма; `addFiles` валидных `< maxItems` — все добавлены, `errors=[]`,
`id` уникальны, `type` верный; `addFiles` переполняет — срез по
свободным местам + `errors` с одним DomainError (`key ===
"errors.tooManyAttachments"`, `params.max === maxItems`); `addFiles`
вызван при уже полном лотке — ничего не добавляется; успешный `addFiles`
после переполнения стирает старый `errors`; `addFiles` с невалидным
mime — `item.error` — DomainError, item всё равно в `items`;
`addFromStorage` — та же лимит/валидация-семантика, поля из
`manifest.mime/name/size`; `setItemPosition` меняет `position` только
у `type==="image"`, no-op у файла; `removeItem` убирает по `id`, прочие
не задеты; `planUpload` без ошибок — возвращает `Job[]` в порядке
`items`, верный `kind`/`isImage`/`position` на каждом; `planUpload` с
хотя бы одним `item.error` — бросает, ничего не возвращает.

### Этап B3 ЗАКРЫТ

Воркер: первая попытка `attachment-tray-core.js` — синтаксическая
ошибка (`function crypto.randomUUID()`) + невалидные файлы
выбрасывались из `items` вместо `item.error` + необъявленная
переменная в `planUpload` (упало бы в strict mode) — итерация 2 с
буквальным кодом на замену закрыла всё, кроме одной моей же
недоделки (забыл маппинг `"other"->"file"` в буквальном коде) —
исправлено точечно (2 строки), без нового захода воркера.
`use-attachment-tray.js` — первая попытка вернула НЕ код (скопирован
комментарий с сигнатурой), вторая (буквальный код) — точное
совпадение. `attachment-tray.jsx` — буквальный код с первого раза
(за счёт готового кода в задании, ladder rung 3 сразу, т.к. предыдущий
файл показал: без литерального кода модель на прозе контракта не
справляется).

Регрессия: 1808 + 16 = 1824/1824. Бюджет: 837,31 КБ (+0,34 КБ — новые
файлы мёртвым кодом, не подключены нигде, ожидаемо для стандалон-этапа).

DoD:
- [x] тесты этапа зелёные (16/16, `attachment-tray-core.test.js`)
- [x] полная регрессия зелёная (1824/1824)
- [x] `npm run build` зелёный, 837,31 КБ
- [x] адверсарный заход — граничные случаи (`maxItems=0`, пустой
      `addFiles([])` на полном лотке, неизвестный `id` у `remove`/
      `setPosition`, `planUpload([])`) разобраны, ничего не открыто
- [x] CONTRACTS.md/PLAN.md/log.md обновлены
- [x] коммит (d3b75ed)

## Медиа-подсистема — Этап B4 (подключение лотка в пяти композерах)

**Решение по маршрутизации (13a, отдельным явным решением PM)**:
PLAN.md метил B4 как [W], но по факту это пять точек стыковки внутри
УЖЕ существующей, плотно переплетённой логики живых экранов (`chat.jsx`
45 КБ — вложение/голос/из-хранилища взаимоисключающие в одном composer,
`channel.jsx` 39 КБ, `channel-chat.jsx`) — не изолированная функция с
полной спецификацией (критерий [W] из шапки MEDIA-SPEC.md). Прямой
прецедент В ЭТОМ ЖЕ проекте: контракт Markdown-этапа C/D,
"Интеграция в три композера (точечно, без воркера — стыковка, не
логика)". Тот же режим здесь — Claude правит впрямую (Edit), без
`worker.sh`.

**`MAX_ATTACHMENTS_PER_MESSAGE = 10`** — добавлено в
`domain/files/attachment-validation.js` (рядом с `MAX_SANITY_FILE_SIZE`
— тот же файл уже хранит клиентские потолки вложений). Число не
названо ни в одном источнике (MATH/ALGO/SPEC/TASK) — продуктовое
решение PM, не пробел в знаниях (9a не применяется: это обычный дизайн-
выбор UI-лимита, не факт из внешней документации/среды исполнения).
Один потолок на все пять композеров.

### `chat.jsx` — `ChatWindow`

Замена `attachmentFile/attachmentPosition/attachmentError/
attachmentSourceRef` на `useAttachmentTray({ maxItems:
MAX_ATTACHMENTS_PER_MESSAGE })`. Голосовая запись и лоток остаются
ВЗАИМОИСКЛЮЧАЮЩИМИ (как раньше file/voice) — старт записи вызывает
`tray.reset()`, кнопка микрофона дизейблится при `tray.items.length >
0`, кнопки "прикрепить"/"из Файлов" — при `recordingState !== "idle"`.

`handleAttachmentFromStorage` **упрощён**: раньше расшифровывал файл
целиком (`getRange`) только чтобы построить локальный `File` для
превью `AttachmentPreview`. `AttachmentTray` (B3) для storage-item
превью не показывает картинку (только иконку, сознательное сужение
B3) — значит расшифровка ради превью больше не нужна вовсе, вызывается
`tray.addFromStorage([{ manifestDigest: node.blob, fileKey, manifest
}])` сразу после `getManifest`/`getFileKeyFor`, без `getRange`. Чистая
эффективность (не тянем в память видео/большой файл ради иконки),
побочный эффект стыковки, отдельно не тестируется отдельным этапом.

`buildOutgoingAttachment` разбирается на два независимых пути
(взаимоисключение — voice ИЛИ tray, оба разом невозможны по построению
UI): `tray.items.length > 0 → await tray.uploadAll(privKey)` (массив
дескрипторов) ИЛИ `recordedVoiceBlob → [voiceDescriptor]` (как раньше,
голос НЕ идёт через лоток — inline/upload-логика голоса не меняется)
ИЛИ `undefined`.

`<input type="file">` — добавлен `multiple`, `onChange` зовёт
`tray.addFiles(e.currentTarget.files)`. Рендер вложений —
`<AttachmentTray items={tray.items} errors={tray.errors}
onRemove={tray.remove} onPositionChange={tray.setPosition} />` вместо
`AttachmentPreview`. Импорты `validateAttachment`, `referenceStoredFile`,
`getRange`, `AttachmentPreview` — сняты (более не используются в файле
после миграции обоих composer'ов, см. ниже).

### `chat.jsx` — `ComposeMessage`

Тот же паттерн, без voice/storage — только `useAttachmentTray` +
`tray.addFiles`/`tray.uploadAll`/`AttachmentTray`. После полной миграции
обоих composer'ов в файле `uploadMessageAttachment` остаётся нужен
ТОЛЬКО `ChatWindow` (голос); `ComposeMessage` его больше не вызывает
напрямую (внутри `tray.uploadAll`).

### `channel.jsx` — `PostComposer`, `CommentComposer`

Оба — тот же паттерн замены `usePendingAttachment()` →
`useAttachmentTray({ maxItems: MAX_ATTACHMENTS_PER_MESSAGE })`,
`attachment.file`→`tray.items.length > 0` в гардах, `uploadPendingAttachment`
→ `tray.uploadAll(privKey)` (уже массив, не оборачивать в `[...]`
повторно — B1+B2 обвязка `attachments = attachment !== undefined ?
[attachment] : undefined` снимается, `tray.uploadAll` уже возвращает
массив, в т.ч. пустой при пустом лотке — `createDraftPost`/`addComment`
уже принимают массив `attachments`, пустой массив семантически равен
"нет вложений" — не различалось раньше тоже, т.к. `attachments = []`
по умолчанию).

### `channel-chat.jsx` — `ChatComposer`

Тот же паттерн, `allowAttachments` гейт остаётся (если `false` — кнопка
"прикрепить" не рендерится, лоток тоже не рендерится, если пуст —
`AttachmentTray` с пустым `items`/`errors` рендерит пустой контейнер,
не проблема, но для чистоты рендерится условно `tray.items.length > 0
|| tray.errors.length > 0`, как и в остальных четырёх местах).

### Снятие `usePendingAttachment`

После миграции всех трёх файлов (`channel.jsx`×2, `channel-chat.jsx`×1)
— `src/ui/hooks/pending-attachment.js` не импортируется нигде, удалён
целиком (был единственным потребителем `uploadMessageAttachment`
экспорта, который остаётся в `domain/messaging/attachments.js` для
других мест).

### Тесты

Ни один из пяти файлов не тестируется `node --test` (JSX/composer —
MEDIA-SPEC.md §0.3, прецедент B1+B2: "минимальная обвязка... НЕ этап
B3/B4/лоток"). Приёмка — `npm run build` зелёный + полная регрессия
без падений (мёртвых импортов быть не должно) + живая проверка (rule
17: "файлы работают внутри приложения").

### Довесок — живой проверкой найден реальный дефект (не гипотетический)

`AttachmentPreview` (единственный потребитель `usePendingAttachment`)
удалён целиком вместе с хуком — после миграции всех пяти композеров на
`AttachmentTray`/`useAttachmentTray` он остался мёртвым кодом (нигде
не импортируется), убран тем же проходом (не отдельным этапом).

Живая проверка (два реальных локальных аккаунта, настоящий strfry +
Blossom): три общих композера (`PostComposer`/`CommentComposer`/
`ChatComposer`) — мультивыбор/загрузка/публикация прошли с первого
раза. `ChatWindow`/`ComposeMessage` (`chat.jsx`) — **нашли реальный
баг**: `handleFilesSelected` в обоих местах захватывал `files =
e.currentTarget.files`, затем СРАЗУ `e.currentTarget.value = ""`, и
только потом звал `tray.addFiles(files)`. `FileList` из `.files` —
ЖИВАЯ ссылка на список инпута, не копия: обнуление `.value` опустошает
её же, `tray.addFiles` получал `files.length === 0` и молча выходил по
раннему `return`. Три канальных композера (`PostComposer` и др.) писали
в правильном порядке (`addFiles()` до очистки) — оттуда и работали
сразу; в `chat.jsx` порядок был случайно другой. Исправлено (переставлен
порядок, addFiles() первым), задокументировано комментарием в коде.
Перепроверено вживую после фикса — оба места (`ComposeMessage`
короткая форма, `ChatWindow` полный composer) шлют/принимают
мультивложения, голос/лоток взаимоисключение подтверждено
(`disabled` на кнопке микрофона при непустом лотке).

Побочная находка того же прохода: `handleAttachmentFromStorage`
(было — расшифровка байтов целиком ради локального превью) упростился
до `getManifest`+`getFileKeyFor` без `getRange` — `AttachmentTray` не
рендерит превью для storage-item (B3, сознательное сужение), значит и
расшифровывать нечего.

Регрессия после фикса: 1824/1824 (без изменений в числе тестов — фикс
внутри composer, не покрывается `node --test` по построению этого
этапа). Бюджет: 837,85 КБ (без изменений).

DoD:
- [x] `npm run build` зелёный, 837,85 КБ
- [x] полная регрессия зелёная (1824/1824)
- [x] живая проверка — 5/5 композеров, реальный баг найден и закрыт
- [x] CONTRACTS.md/PLAN.md/log.md обновлены
- [x] коммит (5a49a96)

## Медиа-подсистема — Этап B5 (каналы: рендер полного массива `attachments`)

Рутинная задача (13a-а), точечно без воркера — тот же режим, что B4
(три маленькие правки в уже существующих render-деревьях, не
изолированная функция).

**Расширение контракта против PLAN.md**: там B5 описан как "весь массив
вместо `[0]`", но раз лоток (B3/B4) уже проставляет `position` на
image-вложениях ВО ВСЕХ пяти композерах (включая три канальных), рендер
обязан учитывать `position`, иначе поле собирается, но молча
игнорируется — половинчатая фича. Решение: переиспользовать УЖЕ
существующую и протестированную `splitBubbleAttachments`
(`message-bubble-attachments.js`, этап B1+B2) — тот же приём, что
`message-bubble.jsx` для личного чата: `above` (первое по порядку
image с `position==="above"`) рендерится ДО текста, `below` (всё
остальное, в исходном порядке) — ПОСЛЕ. Новой логики/новых тестов не
требуется — функция уже покрыта.

Все три места импортируют `splitBubbleAttachments` из
`../components/message-bubble-attachments.js` и меняют ровно то место,
где раньше было `X.attachments?.[0] && <AttachmentView
attachment={X.attachments[0]} />`.

### `src/ui/components/post-card.jsx`

`const { above, below } = splitBubbleAttachments(post.attachments);`
перед `return`; `above` — перед `<MarkdownView source={post.text}
.../>`, `below.map(...)` — после (текст, затем все не-above вложения
по порядку).

### `src/ui/screens/channel.jsx` — `CommentNode`

Тот же приём: `above` перед `<MarkdownView source={comment.text}
.../>` в `.cmt__text`, `below.map(...)` в `.cmt__media` (класс
сохранён на обёртке, теперь оборачивает список, не одно вложение).

### `src/ui/components/channel-chat.jsx`

`.map((m) => (...))` меняется на блочное тело (нужен локальный
`const`), та же расстановка above/below вокруг `<MarkdownView
source={m.text} .../>`.

### Тесты

Не требуются — `splitBubbleAttachments` уже протестирована этапом
B1+B2, три места — чистая расстановка JSX без новой логики (тот же
прецедент "тонкий слой без теста", что во всех render-правках B4).

DoD:
- [x] `npm run build` зелёный, 837,92 КБ
- [x] полная регрессия зелёная (1824/1824)
- [x] живая проверка — пост/комментарий/чат канала показывают все
      вложения (было отсечение по `[0]`), `above`/`below` расстановка
      подтверждена
- [x] CONTRACTS.md/PLAN.md/log.md обновлены
- [x] коммит (b5b9014)

## Медиа-подсистема — Этап C (потоковая загрузка)

Алгоритмическая задача (13a-б) — формализация в DESIGN.md "Медиа-
подсистема — Этап C" ДО тестов/кода (Уровень 1: Θ(C) память одного
файла; Уровень 2: конвейер нескольких файлов через уже существующий
`createThumbnailQueue`).

### `src/domain/files/stream-upload.js` [C]

**Находка перед кодом (не в исходных документах)**: `import
CryptoWorker from ".../crypto.worker.js?worker&inline"` (уже
существующий паттерн `transport.js`) — синтаксис, который понимает
ТОЛЬКО vite-сборка; под голым `node --test` (никакого vite в
рантайме тестов) `?worker&inline` не отрезается резолвером, импорт
падает буквально при попытке загрузить модуль (проверено: `node -e
"import('crypto.worker.js?worker&inline')"` → `ep.addEventListener is
not a function`). Значит модуль с таким импортом НЕЛЬЗЯ грузить даже
транзитивно (статический импорт исполняется при загрузке ФАЙЛА, не при
вызове функции) из файла, который тесты импортируют — иначе весь
`stream-upload.test.js` не запустится. Решение — тот же приём, что уже
есть в `putStream` для `fetchImpl`: инъекция зависимости, по умолчанию
резолвится ЛЕНИВЫМ динамическим `import()` ВНУТРИ функции (исполняется
только при реальном вызове, не при загрузке модуля), тесты подставляют
мок и путь к воркеру не трогают вовсе.

```js
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { generateFileKey } from "./crypto.js";
import { planChunks } from "./manifest.js";
import { uploadBlob, checkUploadRequirements } from "./blob.js";
import { chunkSizeFor } from "../media/upload-plan.js";
import { createThumbnailQueue } from "./thumbnail-queue.js";
import { DomainError } from "../errors.js";

async function defaultEncryptChunk(chunkBytes, fileKey, chunkIndex) {
  const { encryptChunkRemote } = await import("./stream-crypto-worker.js"); // ЛЕНИВО
  return encryptChunkRemote(chunkBytes, fileKey, chunkIndex);
}

export async function putFileStreaming(file, {
  name, mime, serverUrl, privateKey, chunkSize, signal, onProgress,
  fetchImpl, fileKey: overrideFileKey, encryptChunk = defaultEncryptChunk,
} = {})
// -> { manifest, manifestDigest, fileKey, size } — та же форма, что putStream

export async function putFilesStreaming(jobs, {
  concurrency = 2, signal, onJobDone,
} = {})
// jobs: Array<{ file, options }>, options — тот же объект, что putFileStreaming
// принимает вторым параметром (name/mime/serverUrl/privateKey/encryptChunk/...),
// БЕЗ signal (общий signal — параметр putFilesStreaming, прокидывается в
// каждый job сам)
// -> Promise<Array<{ manifest, manifestDigest, fileKey, size }>>, порядок = порядок jobs
```

**`putFileStreaming`** — буквально алгоритм MATH §8.4/SPEC §3.9:
`chunkSize` по умолчанию — `chunkSizeFor(file.size)` (этап A, уже
протестирован), не плоская `DEFAULT_CHUNK_SIZE` (та остаётся только у
`putStream` — П "старый путь не трогаем"). Цикл: `file.slice(start,
end).arrayBuffer()` → `Uint8Array` → `encryptChunk(...)` (по умолчанию
Web Worker, C2; тесты подставляют мок) → `hasher.update(cipher)`
(инкрементальный, `sha256.create()`, не второй проход) →
`parts.push(new Blob([cipher]))`. `signal.aborted` проверяется МЕЖДУ
чанками (как `putStream`), бросает `DOMException(..., "AbortError")`.
После цикла — `bytesToHex(hasher.digest())`, `body = new Blob(parts)`,
тот же `checkUploadRequirements`/`uploadBlob`/манифест-апload, что
`putStream`, но `body` — `Blob`, не `Uint8Array` (`uploadBlob`
передаёт его в `fetch` как есть — `fetch` принимает `Blob`-тело
нативно, менять `blob.js`/`blossom-client.js` не нужно). Манифест —
та же форма `{ size, chunkSize, chunks, keyId, mime, name, blobSha256 }`.

**`putFilesStreaming`** — обёртка над `createThumbnailQueue(concurrency)`
буквально по DESIGN.md "Уровень 2": `queue.enqueue` на каждый job (сам
job вызывает `putFileStreaming`, значит `encryptChunk`-мок,
переданный в `options` job'а, доезжает до места без изменений),
`AbortSignal` — проверка на входе в task + `abort`-листенер зовёт
`cancel()` на все handle. `Promise.all` — первый `AbortError` отклоняет
всё (частичные результаты не возвращаются).

### `src/workers/crypto.worker.js` [C] — расширение, не новый файл

```js
encryptChunk(chunkBytes, fileKey, chunkIndex)  // domain/files/crypto.js::encryptChunk,
                                                 // просто проброс через Comlink
```

Существующий единственный worker-файл проекта (уже `batchVerify` для
`transport.js`) — второй inline-воркер стоит бандла дороже одного
расширенного (`?worker&inline`, NF-11). Transferable-оптимизация
СОЗНАТЕЛЬНО не делается (чанк ≤4 МиБ, structured-clone копия —
константный множитель, не влияет на Θ(C); см. DESIGN.md).

### `src/domain/files/stream-crypto-worker.js` [C] — новый маленький модуль

Статический импорт `?worker&inline` — ЕДИНСТВЕННОЕ, что в этом файле,
и только он динамически подгружается из `stream-upload.js` (см. выше);
сам файл при этом всё равно НЕ должен грузиться под `node --test`
напрямую (тестов на него нет — см. ниже).

```js
export async function encryptChunkRemote(chunkBytes, fileKey, chunkIndex)
// -> Uint8Array (шифротекст) — ленивый собственный синглтон CryptoWorker,
// НЕ переиспользует transport.js'ный (тот приватный, привязан к жизненному
// циклу подключения — домен не может на него полагаться, правило "домен не
// знает про UI/подключение"). Воркер создаётся при первом вызове, живёт
// до конца вкладки, явно не завершается (дёшев, используется редко).
```

### `putStream` — не трогается

Контракт прошлого этапа неизменяем (правило 13). Старые вызовы и тесты
продолжают идти через `putStream`/`DEFAULT_CHUNK_SIZE`.

### Тесты (до кода)

`tests/stream-upload.test.js`:
- `putFileStreaming` на маленьком `File`/`Blob` через мок `fetchImpl` —
  результат бит-в-бит совпадает с тем, что дал бы `putStream` на тех же
  байтах И ТОМ ЖЕ `fileKey` (оверрайд) — тот же шифротекст, тот же
  `manifestDigest`, та же форма манифеста (кроме `chunkSize`, если он
  выбран автоматически по-разному — тест фиксирует `chunkSize` явно,
  чтобы сравнение было честным).
- `chunkSize` по умолчанию берётся из `chunkSizeFor(file.size)` (мок
  `encryptChunk` в `options` считает число вызовов/по манифесту).
- `signal` уже aborted до вызова — бросает `AbortError`, `fetchImpl` НЕ
  вызывается вовсе (ничего не ушло в сеть).
- `signal` абортится ПОСЛЕ первого чанка (мок `encryptChunk`,
  управляемый промис) — бросает `AbortError`, оставшиеся чанки не
  шифруются.
- `putFilesStreaming`: с 4 job'ами, каждый — управляемая задержка на
  "шифровании" и на "отправке" (моки), сравнить время `concurrency: 1`
  против `concurrency: 2` — конвейер заметно быстрее (буквальный П7.4;
  проверялась и более узкая событийная версия "стадия сети job'а 1
  пересекается со стадией шифрования job'а 2 по порядку событий" — при
  `concurrency=2` оба job'а стартуют СРАЗУ (так и должно быть — само
  ограничение параллелизма это гарантирует), поэтому такая точная
  последовательность событий не гарантирована и не тестируется;
  измеримый прирост скорости — то, что реально требует П7.4).
  `concurrency` соблюдён — отдельный тест считает пиковое число
  одновременных вызовов "шифрования".
- `putFilesStreaming` с `signal`, абортящимся посреди — `Promise.all`
  отклоняется `AbortError`, ещё не стартовавшие job не вызывают
  `fetchImpl` вовсе.
- Порядок результатов `putFilesStreaming` — совпадает с порядком
  `jobs`, даже если job 2 завершается раньше job 1 (конвейер не должен
  переставлять результаты местами).

`crypto.worker.js`/`stream-crypto-worker.js` — БЕЗ теста напрямую
(worker/DOM-обвязка, `node --test` без браузера воркер не поднимет);
корректность шифрования проверяется КОСВЕННО через
`putFileStreaming`-тесты выше сравнением с `encryptChunk`, вызванным
напрямую (не через воркер) на тех же входах — если бы воркер шифровал
иначе, тест на "бит-в-бит совпадает с putStream" бы упал.

### Этап C1+C2 ЗАКРЫТ (`stream-upload.js` + Web Worker)

Регрессия: 1824 + 8 = 1832/1832. Бюджет: 843,38 КБ (**+5,46 КБ** —
заметно больше, чем предыдущие этапы медиа-подсистемы вместе взятые;
причина найдена, не баг: `crypto.worker.js` — ЕДИНСТВЕННЫЙ
inline-воркер проекта, уже безусловно встроен в каждую сборку
(`transport.js` тянет его всегда). Добавленный `encryptChunk` тянет за
собой `chacha20poly1305` (`@noble/ciphers`) — та же библиотека УЖЕ есть
в основном бандле (`domain/files/crypto.js` её и так использует), но
воркер — отдельный самодостаточный JS-контекст, делить код с главным
потоком не может, поэтому копия неизбежна. Это цена самого требования
"шифрование — в Web Worker" (SPEC §3.9), не следствие решения "тот же
файл, не новый" — новый отдельный worker-файл стоил бы дороже (второй
inline-блоб плюс та же неизбежная копия `chacha20poly1305`).
Возвращаемый бюджет всё ещё далёк от лимита NF-11 (843 КБ из 1304 КБ),
но заметно превышает неформальную заметку этапа A "задел на весь
этап A–F — 15 КБ" (уже потрачено ~6 КБ из них, C — почти всё) — фиксирую
честно, не подгоняю ожидание задним числом.

DoD:
- [x] тесты этапа зелёные (8/8, `stream-upload.test.js`)
- [x] полная регрессия зелёная (1832/1832)
- [x] `npm run build` зелёный, 843,38 КБ (+5,46 КБ, причина объяснена)
- [x] П7.4 (частично): отмена — тест; конвейер быстрее последовательного
      — тест (моки, не живой замер); память 2 ГБ/100 МБ — остаётся C4
- [x] CONTRACTS.md/PLAN.md/log.md обновлены
- [x] коммит (d5540c4)

## Медиа-подсистема — Этап C3 (подключение в `files.jsx` и в `uploadAll` лотка)

**Сужение против первоначального плана, решение PM**: `files.jsx`
(`handleFilesSelected`) грузит несколько файлов ПОСЛЕДОВАТЕЛЬНО не
случайно — комментарий в коде на месте фиксирует это как осознанное
решение ("не перегружать шифрование/сеть, прогресс остаётся понятным
как «файл N из M»"). `putFilesStreaming` (конвейер, `concurrency>1`)
ломает это ровно тем, что делает полезным — два файла в работе
одновременно, "файл N из M" перестаёт быть однозначным. Менять
принятое решение прошлого этапа — по правилу 13 отдельное явное
решение с немедленной регрессией, не тихая подмена внутри "рутинного"
подключения. Решение: **этим проходом не меняю UX `files.jsx`** —
подключаю только `putFileStreaming` (одиночный файл, Θ(C) память +
воркер, СЕМАНТИКА "N из M" не меняется, чистое улучшение без риска).
`putFilesStreaming` остаётся готовой, протестированной (C1+C2), но
пока НИГДЕ в UI не подключённой инфраструктурой — доложено пользователю
отдельно, не спрятано.

### `src/domain/messaging/attachments.js` — новая функция рядом с `uploadMessageAttachment`

```js
export async function uploadMessageAttachmentStreaming(serverUrl, file, { mime, name }, privateKey, options = {})
// file — File | Blob (НЕ Uint8Array — в этом и весь смысл, байты не
// читаются в память ДО вызова, putFileStreaming сам делает срезы)
// -> тот же дескриптор, что uploadMessageAttachment: {type, manifestDigest,
//    fileKey (base64), mime, size, name}
```

Буквально `uploadMessageAttachment`, но `putFileStreaming(file, ...)`
вместо `putStream(bytes, ...)` — `validateAttachment`/
`attachmentTypeFromMime`/`base64FromBytes` переиспользуются как есть.
`uploadMessageAttachment` (старый, `Uint8Array`) НЕ удаляется — им,
предположительно, всё ещё пользуются старые пути/тесты (проверить
явно перед принятием, не удалять по умолчанию).

### `src/ui/hooks/use-attachment-tray.js` — `uploadAll`

`job.file.arrayBuffer()` (читало ВЕСЬ файл в память ДО начала загрузки
— именно то, что Θ(C) отменяет) заменяется прямым вызовом
`uploadMessageAttachmentStreaming(BLOSSOM_SERVER_URL, job.file, {mime,
name}, privKey)`. Цикл по `jobs` остаётся последовательным (как был,
B3/B4 контракт не менялся) — только сам вызов внутри итерации.

### `src/ui/screens/files.jsx` — `handleFilesSelected`

`const bytes = new Uint8Array(await file.arrayBuffer()); await
putStream(bytes, {...})` заменяется на `await putFileStreaming(file,
{...})` (те же поля опций, `onProgress` — та же форма
`{chunksDone,chunksTotal}`, `signal` — тот же `uploadAbortRef`). Цикл
`for` по `files` остаётся буквально тем же (не переписывается на
`putFilesStreaming`, см. сужение выше).

### Тесты

Не пишутся отдельно — `putFileStreaming` уже покрыт этапом C1+C2,
`uploadMessageAttachmentStreaming` — тонкая обвязка без новой логики
(тот же прецедент "тонкий слой без теста"). Приёмка — регрессия +
`npm run build` + живая проверка (отправка вложения из личного чата/
канала, загрузка файла в "Файлы" — оба пути реально шлют/принимают).

### Этап C3 ЗАКРЫТ

Регрессия: 1832/1832 (без новых тестов — тонкий слой). Бюджет: 845,12
КБ (+1,74 КБ — `stream-upload.js`/`stream-crypto-worker.js` стали
реально импортируемыми, раньше были мёртвым кодом с точки зрения
бандлера).

Живая проверка (те же два аккаунта, реальный strfry+Blossom):
personal-чат — вложение через лоток (`uploadMessageAttachmentStreaming`)
отправлено и принято собеседником, скачивается. "Файлы" — два файла
загружены через `putFileStreaming` (последовательно, семантика "N из
M" не тронута), оба видны в дереве. Консоль чистая (кроме уже
известного несвязанного MLS-warning).

DoD:
- [x] полная регрессия зелёная (1832/1832)
- [x] `npm run build` зелёный, 845,12 КБ
- [x] живая проверка — оба пути (лоток, "Файлы") реально шлют/принимают
- [x] CONTRACTS.md/PLAN.md/log.md обновлены
- [x] коммит (836e12e)

## Медиа-подсистема — Этап C4 (замер: пиковая память на большом файле)

**Подготовка**: локальный Blossom (`server/blossom/config.yml`)
настроен на `max_upload_size_bytes: 57671680` (~55 МБ, под клиентские
лимиты видео/голосовых) — для файла 2 ГБ сервер отклонил бы загрузку
на уровне лимита, раньше, чем что-либо в клиентском коде. Временно
поднят до 2 200 000 000, локальный Blossom перезапущен (`kill` + новый
`run.sh`, вне процесса `vite dev` — тот же порт 8080, разница не видна
приложению) для замера, **после замера лимит возвращён к
57671680 и сервер перезапущен ещё раз** — `git status`
подтверждает `config.yml` чист (пользователь подтвердил план явно,
"Временно поднять лимит сервера").

**Метод**: `putFileStreaming` вызывался напрямую из консоли вкладки
(`import('/src/domain/files/stream-upload.js')`, реальный
`privKeySig.value` залогиненного аккаунта, `fetchImpl` — настоящий
`window.fetch` на локальный Blossom) — не через UI-клик, но тот же
код, что вызывают `files.jsx`/`use-attachment-tray.js` (C3). Синтетический
файл — `new File(Array(N).fill(CHUNK), ...)`, `CHUNK` — один
переиспользуемый `Uint8Array(16 МиБ)` (не N отдельных копий — сам тест-
файл не должен требовать 2 ГБ резидентно на этапе ПОСТРОЕНИЯ, до
всякого `putFileStreaming`). Память — `performance.memory.usedJSHeapSize`
(J S heap, ближайший доступный из JS прокси для "резидентной памяти
вкладки" — не полный OS RSS процесса; ограничение метода, не скрыто).

**Результат**:

| Размер файла | Пик - baseline (МБ) | Итог |
|---|---|---|
| 192 МБ | 42,3 | успех |
| 400 МБ | 46,4 | успех |
| 700 МБ | — | таймаут ИНСТРУМЕНТА замера (45с/вызов), не приложения |
| 2000 МБ (под границей 2³¹, не ровно 2 ГиБ) | — | `NotReadableError` немедленно (0,0с) |

Дельта **не растёт** с удвоением размера файла (192→400 МБ: 42,3→46,4
МБ, разница в пределах шума разового замера/GC-тайминга) — прямое
эмпирическое подтверждение Θ(C): память ограничена размером чанка и
разовыми затратами (динамический импорт модуля, первый запуск
воркера), не размером файла. Экстраполяция на 2 ГБ при той же
константе — заведомо ниже порога 100 МБ из П7.4.

**Буквальный замер на файле ровно 2 ГБ не получен** — находка, не
обойдена молча: на размерах ≥~700 МБ синтетический `File`,
сконструированный в этой Chrome-сессии (управляемой claude-in-chrome),
либо не читается (`NotReadableError`, "permission problems... after a
reference to a file was acquired" — сообщение, характерное для
Blob'ов, которые браузер вытеснил на диск и не смог перечитать) либо
не укладывается в 45-секундный лимit ОДНОГО вызова инструмента замера.
Это согласуется с самой гипотезой MEDIA-MATH.md §8.4 ("браузеры
выгружают крупные Blob'ы на диск... на практике") — здесь же похоже,
что именно ЭТА выгрузка на диск в конкретном (автоматизированном,
возможно с ограниченным профилем/квотой) Chrome-профиле и упирается в
отказ прав доступа. Не воспроизведено как баг в `putFileStreaming` —
на меньших размерах код работает корректно и по памяти, и по
результату (реальная загрузка на реальный Blossom, дескриптор
получен). Живая проверка ТОЧНО на 2 ГБ в ОБЫЧНОМ (не автоматизированном)
браузере пользователя — открытый пункт, не закрыт этим проходом.

DoD (буквально §7.4):
- [x] Отмена посреди загрузки — тест (C1+C2), не живой замер повторно.
- [x] Конвейер быстрее последовательного — тест (C1+C2).
- [~] Файл 2 ГБ: пиковая память < 100 МБ — эмпирически подтверждено
      КОСВЕННО (флэт на 192-400 МБ, экстраполяция уверенная по самой
      конструкции алгоритма), буквальный замер на 2 ГБ не получен
      (ограничение тестового Chrome-профиля, не приложения) — открытый
      пункт для пользователя: перепроверить на реальном файле 2 ГБ в
      обычном браузере, если нужна буквальная галочка.
- [x] CONTRACTS.md/PLAN.md/log.md обновлены
- [x] коммит (c263ba7)

## Медиа-подсистема — Этап D (сессия и микроприложения)

Алгоритмическая задача (13a-б) — формализация в DESIGN.md "Медиа-
подсистема — Этап D" ДО тестов/кода. Автомат (`media-machine.js`) уже
построен и исчерпывающе проверен этапом A — здесь ТОЛЬКО сессия вокруг
него, ресурсы, DOM-мост и замена двух старых просмотрщиков.

**Уточнение контракта против буквального текста SPEC §3.6**: там
`owner.sync(desiredPositions, playlist)` — но уже реализованный этапом
A `allocWindow(state, playlist, budgetBytes)` возвращает МАССИВ
DIGEST'ОВ (`digests.push(playlist.items[j].digest)`), не позиций.
Позиции этим проходом НЕ меняются (правило 13 — контракт этапа A
неизменяем без отдельного явного решения, а менять здесь незачем: вся
нужная информация — в digest'ах). `resourceOwner.sync` принимает
РЕЗУЛЬТАТ `allocWindow` буквально (массив digest'ов, с повторами —
мультимножество), плюс `playlist` — для разрешения НОВОГО digest'а в
`MediaRef` при первом `acquire`.

### `src/domain/media/adapters/resource-owner.js` [C]

```js
export function createResourceOwner({ acquire, release })
// acquire(ref: MediaRef) — вызывается РОВНО ОДИН раз на digest, когда
//   счётчик переходит 0 → >0 (не на каждое вхождение в желаемый набор)
// release(digest: string) — РОВНО ОДИН раз, когда счётчик падает до 0
//   (принимает digest, НЕ ref — к моменту release плейлист, из которого
//   он появился, мог уже смениться, ref мог "устареть"/пропасть)

owner.sync(desiredDigests, playlist)
// desiredDigests: string[] — буквально то, что вернул allocWindow
// (мультимножество — считает повторы, не Set)
owner.releaseAll()
```

Реализация — счётчик по digest (Утв. 7/ALGO §4.4), `Map<digest,
number>`. Разность мультимножеств: то, что было `>0` и ушло из
`desiredDigests` — `release`; то, что появилось впервые (`have===0`
перед обновлением) — `acquire`. `playlist.items.find(r => r.digest
=== digest)` для разрешения новых digest'ов — окно по построению
маленькое (`windowByBudget(..., maxSpan=3)` для картинок, 1 элемент
для audio/video), `O(n)`-поиск в маленьком окне не требует индекса.

### `src/domain/media/adapters/media-url.js` [C]

```js
export async function acquireMediaUrl(ref, { serverUrl, fetchImpl } = {})
// -> { kind: "bridge", src: string } | { kind: "object-url", url: string }
// МЕМОИЗИРОВАНО по ref.digest — повторный вызов на уже acquired/в
// процессе digest НЕ повторяет сеть/регистрацию, возвращает тот же
// promise/результат. Это позволяет и resourceOwner (владение
// жизненным циклом), и view-компоненту (D3, чтение src для рендера)
// звать ОДНУ И ТУ ЖЕ функцию без двойного счёта — единственный
// РЕАЛЬНЫЙ acquire/release держит resourceOwner, компонент только
// читает уже (или почти) готовый результат.

export async function releaseMediaUrlHandle(digest)
// unregisterPlayerFile/revokeObjectURL по СОХРАНЁННОМУ при acquire
// виду — вызывается ТОЛЬКО resourceOwner.release, не компонентом.
// ASYNC (найдено тестом, не в исходном плане контракта): Promise.then()
// ВСЕГДА откладывает колбэк в микрозадачу, даже на уже готовом промисе
// (гарантия Promises/A+) — синхронной версии "снять регистрацию прямо
// сейчас" не существует в принципе, если release зовётся, пока acquire
// ещё может быть в полёте. Функция возвращает promise, чтобы вызывающая
// сторона (тесты — обязательно; resourceOwner.release — по желанию,
// fire-and-forget допустим) могла дождаться реального завершения
// очистки, не угадывая порядок микрозадач.
```

video/audio → `registerPlayerFile(ref.digest, {manifest, fileKey:
ref.key, serverUrl})` (мост уже построен и работает, `player-bridge.js`
— НЕ переписывается), `src = /files-content/${ref.digest}`. image →
`getRange(manifest, ref.key, 0, ref.size, {serverUrl})` (eager, тот же
приём, что `file-player.jsx` уже делает для картинок) +
`URL.createObjectURL`. Манифест — `getManifest(ref.digest, {serverUrl})`
(уже кэширует через `getCachedManifest`/`putCachedManifest`, тот же
путь, не новая стоимость).

### `src/ui/signals/media.js` [C]

```js
export const mediaSession;  // signal(MediaState & {playlist} | null)
export function openMedia({ refs, position, dedupe })
export function mediaNext(), mediaPrev(), mediaToggle(), mediaSeek(t)
export function mediaMinimize(), mediaRestore(), closeMedia()
export function mediaEnded()  // НАЙДЕНО при сборке D3, не в исходном
// списке SPEC §3.5 — <video>/<audio> onEnded обязаны дойти до автомата
// (doEnded уже готов с этапа A), без этого экспорта событию EVENTS.ended
// неоткуда прийти.
```

`MEDIA_WINDOW_BUDGET_BYTES = 16 * 1024 * 1024` — продуктовое решение
PM (в исходных документах числа нет, тот же класс решения, что
`MAX_ATTACHMENTS_PER_MESSAGE` на этапе B4). Внутри — `playlistRef`
(снимок вне сигнала, SPEC §3.3 "копируется при открытии"), `dispatch`
зовёт `transition` + `resourceOwner.sync(allocWindow(...), playlistRef)`
+ на `close` (`next === null`) — `playlistRef = null` (§3.5 "ключи не
переживают закрытие сессии").

Подписка на `callState` — через `effect()` (`@preact/signals`, НОВЫЙ
для проекта паттерн подписки на сигнал вне компонента — обоснование в
DESIGN.md). Edge-detection: `callStart`/`callEnd` диспетчерятся ТОЛЬКО
на границе неактивен↔активен (`callState.name` ∉/∈ `{IDLE,ENDED}`), не
на каждое внутреннее изменение FSM звонка.

### `src/ui/signals/auth.js::lock()` [C] — точечная правка

`closeMedia()` первой строкой, перед существующим `clearMemoryCache()`
(SPEC §3.5 "Обязательно"). Импорт `media.js` в `auth.js` не создаёт
цикл (`media.js` не импортирует `auth.js` — `openMedia` получает уже
разрешённые `MediaRef`).

### D5 — гашение устаревших `seek`: ОСОЗНАННО ПРОПУЩЕНО

Обоснование — DESIGN.md "D5". Предпосылка гонки (ALGO §4.5) уже снята
на обоих уровнях, где могла бы жить: транспорт (`requestId`-корреляция
в `player-bridge.js`, построена раньше) и состояние (`transition` —
чистая синхронная функция, гонки обгонять нечего). Строить
неиспользуемый монотонный счётчик — против правила "не проектировать
под гипотетическое требование". Возврат к этому пункту — если/когда
появится собственный (не нативный) JS-driven scrubber.

### `src/ui/components/media/` — D3 [явно НЕ через воркер, решение PM]

**Маршрутизация**: несмотря на пометку [W] в MEDIA-SPEC.md, четыре
вида пишутся Claude напрямую — тот же прецедент, что уже применён в
этапах B4/B5/C3 этой сессии (стыковка/интеграция с реальным
управлением `<video>`/`<audio>` через mediaSession — не изолированная
функция с полным ТЗ, а компонент, завязанный на состояние сессии и
предыдущие решения этого же этапа).

```
video-player.jsx    { mediaRef, playing, onToggle, onEnded, compact }
audio-player.jsx    { mediaRef, playing, onToggle, onEnded, compact }
image-viewer.jsx    { mediaRef }                          // native <img>, без zoom/swipe (тот же отказ, что ImageModal)
media-overlay.jsx   — корень, читает mediaSession.value, выбирает вид
                       по cls, next/prev/minimize/close — ОБЩИЙ chrome
                       ЗДЕСЬ (не в отдельных видах — next/prev работает
                       одинаково для всех трёх классов, media-machine.js
                       это уже гарантирует)
```

**Проп называется `mediaRef`, НЕ `ref`** — найдено живой проверкой
(не на этапе контракта): `ref` — зарезервированное имя в Preact
(форвардинг ссылки на DOM-узел), JSX-атрибут `<Comp ref={x}>` НЕ
доходит до компонента как обычный проп — `props.ref` был `undefined`,
крах на первом же `.digest` внутри компонента. Простое, но реальное
несоответствие между контрактом (написан до кода) и рантаймом
Preact — таблица выше уже исправлена.

`acquireMediaUrl` вызывает КАЖДЫЙ вид САМ, в своём `useEffect`
(`video-player.jsx`/`audio-player.jsx`/`image-viewer.jsx`) — тот же
идиом, что уже был у `file-player.jsx`/`attachment-view.jsx`, НЕ через
`media-overlay.jsx` (он остаётся тонким диспетчером, не держит
загрузочное состояние).

### Довесок (найдено живой проверкой пользователя, после Этапа F) — `media-mini-bar.jsx` УДАЛЁН, `compact`-проп вместо отдельного компонента

**Реальный баг относительно собственного критерия приёмки Этапа D**
(SPEC §7.5, "Свёрнутое аудио продолжает играть при переходе между
разделами"): `media-mini-bar.jsx` был ОТДЕЛЬНЫМ компонентом без
единого `<video>`/`<audio>` внутри — переключение `display` в `"mini"`
размонтировало `video-player.jsx`/`audio-player.jsx` целиком (Preact
меняет ветку `if (session.display === "mini") return <MediaMiniBar
.../>`), воспроизведение обрывалось молча. Исправлено сменой формы
дерева `media-overlay.jsx`: теперь ОДИН `<View mediaRef={...}
compact={isMini} .../>`, всегда смонтированный, пока сессия жива;
`isMini` меняет ТОЛЬКО класс/обвязку обёрток (`div > div > View` —
та же форма что в mini, что в full, Preact не считает это unmount+
remount), контролы (mini-бар: имя+play/pause+restore+close; full:
prev/track-of/next+minimize+close) рендерятся условно ВОКРУГ, не
вместо `<View>`.

`compact` (новый проп `video-player.jsx`/`audio-player.jsx`): убирает
нативные `controls` (у mini-бара свои кнопки), video — маленький кадр
через CSS (`object-fit:cover`, `.media-mini-bar-preview`, 2.5rem²),
audio — `display:none` (воспроизведение аудио НЕ останавливается
`display:none`, только визуально скрыт — иконка класса рядом в
`media-overlay.jsx` сигнализирует "это аудио"). `image-viewer.jsx` —
проп не используется (И5, картинка не сворачивается вовсе).

`media-mini-bar.jsx` — файл удалён целиком (логика поглощена
`media-overlay.jsx`).

### Довесок (та же живая проверка) — автовоспроизведение при next/prev не срабатывало (Firefox/Zen)

Второй реальный баг, тот же класс, что первый (недо-закрытый MEDIA-
SPEC.md R4 "next после ended не стартует... при отказе — показать
кнопку, не молчать"): смена `mediaRef` на `doNext`/`doPrev` роняла
`src` в `null` → компонент рендерил СОВСЕМ ДРУГОЕ дерево (`<p>Loading
</p>` вместо `<video>`) → старый `<video>` размонтировался, новый
монтировался заново при готовности `src` — лишний разрыв DOM-элемента
ровно в момент, когда автовоспроизведению и так труднее всего устоять
(особенно у Firefox — строже Chromium к asynchronous `.play()` без
свежего user gesture на СОВСЕМ НОВОМ элементе). Плюс `.play().catch(()
=> {})` молча проглатывал отказ, оставляя `mediaSession.play=
"playing"` НЕ соответствующим реальности.

Исправлено (`video-player.jsx`/`audio-player.jsx`): `<video>`/`<audio>`
остаётся смонтированным ВСЕГДА, пока нет ошибки (`src={src ?? undefined}`
— Preact не пишет атрибут, пока не готов; "Loading" — оверлей рядом, не
замена дерева); отказ `play()` теперь синхронизирует `mediaSession`
через `onToggle()` — пользователь СРАЗУ видит кнопку "▶", не гадает,
почему тишина. Полной гарантии автовоспроизведения при next/prev это
не даёт (браузерная политика — вне контроля приложения), но устраняет
и лишний источник разрыва, и молчаливое рассогласование состояния.

`media-overlay.jsx` не рендерит ничего, если `mediaSession.value ===
null` (И3 — allocWindow пуст, здесь — симметрично, нечего показывать).

### `src/app.jsx` — D4

`<MediaOverlay />` рядом с `<CallOverlay />`, вне `.app-layout`, ПОСЛЕ
него в порядке JSX (не критично для рендера, но отражает приоритет:
звонок важнее). CSS: `.media-overlay { z-index: 190; }` — ниже
`.call-overlay` (200) и `.top-corner-actions` (300), буквально SPEC
§4 "соседство с 200, ниже 300".

### D6 — снятие `FilePlayer`/`ImageModal`

Сужение — DESIGN.md "D6". Реальных вызывающих мест два (третье,
`sidebar-profile-card.jsx`, НЕ трогается — аватар не `MediaRef`, вне
модели этой подсистемы):

- `files.jsx`: **пересмотрено при реализации** (DESIGN.md "D6") —
  `collectFolderScope` ждёт сырые CRDT-узлы (`entry.node.name.value`),
  `currentEntries.value` в `files.jsx` — уже плоская проекция
  (`entry.displayName`, без `.node`); плюс `MediaRef.key` не ленивый,
  потребовал бы `getFileKeyFor` для ВСЕХ медиа-файлов папки сразу.
  Вместо этого `openEntry` стал `async`: тот же
  `getCachedManifest`/`getManifest`/`putCachedManifest`-путь, что уже
  использует миниатюра (не новая сетевая стоимость на повторный клик),
  затем `getFileKeyFor` — `mime`/`name`/`size` берутся из МАНИФЕСТА, не
  из `entry` (узлы старой записи `mime` не несут — этап E, `E1`, ещё не
  пройден, `entry.mime` не существует). Результат —
  `openMedia({ refs: [{ digest: entry.blob, key: fileKey, mime:
  manifest.mime, name: manifest.name, size: manifest.size, sourceKind:
  "node", sourceMeta: { nodeId: entry.id } }], position: 0 })` —
  одиночный `MediaRef`, собран литералом (не через `refFromNode` —
  форма не подходит), без scope. Полноценный playlist по папке —
  отдельная задача, не в этом проходе.
- `attachment-view.jsx`: `openMedia({ refs: [refFromAttachment(
  attachment, sourceMeta)], position: 0 })` — ОДИН элемент, без сбора
  scope поста/чата/канала (то — этап F, дословно в MEDIA-SPEC.md).
  Поведение пользователя не меняется (клик — один вид), меняется
  только механизм (единая сессия вместо локального `useState`).

**Только `FilePlayer` удалён целиком** (`file-player.jsx` — файл,
после миграции `files.jsx` нигде не импортируется). `ImageModal`
(`image-modal.jsx`) — ОСТАЁТСЯ, живой компонент: `sidebar-profile-
card.jsx` (просмотр СВОЕГО аватара) сознательно не мигрирован (см.
выше — аватар вне модели `MediaRef`), это его единственный оставшийся
потребитель. `ImageAttachment`'s `showModal`-ветка (`attachment-
view.jsx`) снята вместе с локальным `useState` (тот же порядок, что
`AttachmentPreview`/`pending-attachment.js` на этапе B4).

### Тесты (до кода)

`tests/media-resource-owner.test.js` — `sync` считает
acquire/release РОВНО по границам счётчика (не на каждое вхождение),
дедуп повторного digest в желаемом наборе, скачок между
непересекающимися окнами (ALGO §4.4), `releaseAll`.

`tests/media-url.test.js` — `acquireMediaUrl` через мок `fetchImpl`
(тот же приём, что `files-content.test.js::makeFakeBlossom`): video/
audio → `{kind:"bridge", src}` + реально зарегistрирован в
`player-bridge.js` (проверяется `handleRangeRequest` после
`acquireMediaUrl`); image → `{kind:"object-url", url}`; повторный
вызов на тот же digest — НЕ повторяет сеть (счётчик вызовов
`fetchImpl`); `releaseMediaUrlHandle` реально снимает регистрацию
(`handleRangeRequest` после release — `unknown-digest`).

`tests/ui-signals-media.test.js` — `openMedia`→`mediaSession.value`
соответствует `transition`; `closeMedia` обнуляет и зовёт `release`
на все живые digest'ы; подписка на `callState` — edge-detection
(имитация `OUTGOING_RINGING→CONNECTING→CONNECTED` даёт РОВНО один
`callStart`); `lock()` вызывает `closeMedia` до `clearMemoryCache`
(порядок проверяется мок-функциями с меткой времени вызова).

Компоненты (D3/D4) — без теста (тонкий рендер-слой, прецедент всей
этой сессии).

## Медиа-подсистема — Этап E (кнопки и `mime` в дереве)

### `src/domain/files/ops.js` [C]

```js
/** 9-й параметр, по умолчанию null (⊥ — неизвестно). Новые загрузки (files.jsx)
 *  передают mime сразу; старые вызовы (без 9-го аргумента) не меняют поведение. */
export function createFile(S, parentId, name, newId, blob, label, origin = null, fileKeyHex = null, mime = null)

/** Дозаливка mime старому узлу (mime===null). БЕЗ label — монотонное слияние
 *  ⊥→v (MEDIA-MATH.md Утв. 9: blob↦mime — функция, конфликта v₁≠v₂ не бывает),
 *  тот же класс операции, что purge(). Вызывающая сторона решает КОГДА звать
 *  (событийно, DESIGN.md "Этап E, E1-доп") — сам constructor ничего не проверяет
 *  и не бросает, applyOp идемпотентен на повторную/гоночную дозаливку. */
export function setMime(S, id, mime)
```

### `src/domain/files/tree.js` [C]

```js
// mkNode получает 8-й параметр mimeValue=null — неизменяемая часть узла
// (рядом с blob/kind), НЕ LWW-регистр.
function mkNode(id, kind, blob, parValue, nameValue, label, originValue = null, mimeValue = null)

// Новый индекс состояния S, по образцу children/namesInDir:
// S.classCount : Map<parentId, Int32Array(4)>   // [audio, video, image, other]
// Мутируется НА МЕСТЕ в applyOp (не клонируется — довод children/namesInDir,
// ALGO.MD §3.5), персистируется НЕ он — пересобирается rebuildIndexes().

/** Есть ли в живых детях parentId файл каждого из трёх media-классов —
 *  Θ(1) через classCount, БЕЗ обхода. Возвращает {audio, video, image}
 *  (booleans) — "other" не выставляется наружу (для него нет UI-кнопки). */
export function classesPresent(S, parentId)
```

`createInitialState`/`cloneState`/`rebuildIndexes` — возвращают/клонируют
`classCount` наравне с `children`/`namesInDir` (та же форма клонирования:
новый `Map`, значения — новые `Int32Array` копии, не общие ссылки).

`applyOp`:
- `create`, `kind="file"`, `op.mime≠null` → `classCount[parentId][classOf(mime)] += 1` (аллоцирует `Int32Array(4)`, если для `parentId` записи ещё нет).
- `purge`, `!node.purged`(до пометки), `node.mime≠null` → decrement в `node.par.value`.
- `setPar`, `!node.purged`, `node.mime≠null` → decrement в старом `node.par.value`, increment в новом значении.
- `setName` — не трогает (не входит в уравнение E1).
- **`setMime` (новый case)** — `node ⊥` → буферизуется в `pending`, как `setPar`/`purge` на ещё не увиденный `create` (тот же путь); `node.mime≠null` (уже есть значение) → идемпотентный no-op, БЕЗ проверки равенства с `op.value` (Утв. 9 гарантирует равенство, дважды проверять нечем); иначе — `nodes.set(id, {...node, mime: op.value})`, и если `!node.purged` — `classCount[node.par.value][classOf(op.value)] += 1`.

`project()`: `outNodes.set(id, {..., mime: n.mime})` — денормализованное поле едет в проекцию наравне с `blob`/`kind`/`origin` (нужно `files.jsx`'s `currentEntries` для E3-подключения кнопок и для будущего показа mime-иконки, вне рамок этого контракта).

### `src/domain/files/store.js` [C]

`nodeToRow`: `+ mime: node.mime`. `rowToNode`: `+ mime: row.mime ?? null`
(старые строки без столбца читаются как `undefined` → нормализуются в `null`,
тот же сентинел ⊥, что использует остальной код). Правка одна на обе функции
— общие для `files_nodes` (свои файлы) и `files_mount_nodes` (доли других,
`saveMountState`/`loadMountState` их переиспользуют без изменений).
**Без повышения версии схемы IndexedDB** — новый столбец не индексирован
(DESIGN.md "Этап E, E1-доп-2", разведка, закрывает открытый вопрос
`MEDIA-SPEC.md` §3.8).

### `src/domain/media/media-ref.js` [C, точечная правка]

```js
/** Единый источник истины для порядка/индекса класса — playlist.js, tree.js
 *  (classCount) и media-index.js (mediaClassesByPost) должны использовать
 *  ОДИН и тот же порядок, иначе индексы разъедутся между модулями молча
 *  (число совпадёт, семантика — нет). Раньше был приватный дубль ТОЛЬКО
 *  в playlist.js — вынесен сюда, playlist.js импортирует, а не объявляет
 *  свою копию (Claude, не воркер: правка уже принятого контракта Этапа A,
 *  правило 13 — щадящая, поведенчески noop, немедленная полная регрессия). */
export const CLASS_NAMES = ["audio", "video", "image", "other"];
export const CLASS_INDEX = { audio: 0, video: 1, image: 2, other: 3 };
```

`playlist.js` — заменяет свой локальный `const CLASS_NAMES/CLASS_INDEX` на
`import { CLASS_NAMES, CLASS_INDEX } from "./media-ref.js"`, поведение не
меняется (те же значения, тот же порядок), регрессия `media-playlist.test.js`
и `media-machine*.test.js` подтверждает.

### `src/domain/content/comments.js` [C, точечная правка — закрывает долг Этапа A]

```js
/** Компаратор комментариев-братьев: createdAt, tie-break — id (строковое
 *  сравнение) при равенстве createdAt. Раньше — приватный инлайн внутри
 *  buildTree, БЕЗ tie-break (см. DESIGN.md "Этап A" долг, дословно
 *  "перенесён в Этап D/F" — Этап D не тронул, закрывается здесь, т.к.
 *  E3 — первый реальный вызов collectPostScope из UI). */
export function compareComments(a, b)
```

`buildTree` использует `compareComments` вместо приватного
`.sort((a,b)=>a.createdAt-b.createdAt)`. Поведенчески NOOP на нынешних
данных (id — UUID/hex, коллизия `createdAt` при разных `id` — статистически
пренебрежима, но детерминированность теперь гарантирована, не "почти
всегда"), тест — на саму функцию (не regression существующего дерева).

### `src/domain/content/media-index.js` [C] (НОВЫЙ)

```js
/** Один скан db.posts + один скан db.comments владельца — Θ(k+m), НЕ Θ(k·m)
 *  (MEDIA-ALGO.md §2.2 Q1, прямой аналог countCommentsByPost). Область — ВСЕ
 *  каналы owner'а разом (SPEC §3.10 буквально, без channelId-параметра).
 *  → Map<postId, Int32Array(4)>, тот же порядок класса, что CLASS_INDEX. */
export async function mediaClassesByPost(ownerPubkey, dbKey)
```

Черновики (`status==="draft"`) и удалённые посты — исключены (тот же
фильтр, что `loadPostsWindow`). Комментарии — фильтр `!deleted` +
`computeReachableCommentIds` (реиспользуется из `comments.js`, не
дублируется), и только для постов, уже попавших в `acc` (экономит
расшифровку комментариев чужих каналов/черновиков впустую — DESIGN.md).

### `src/ui/components/screen.jsx` [C, точечная правка]

```js
export default function Screen({ breadcrumb, title, actions, mediaButtons, footer, feed, children })
```

Новый необязательный слот `mediaButtons` — рендерится СРАЗУ ПОД
`<header class="section-header...">`, ДО `.content-area`, своим `<div
class="media-buttons-bar row" ...>` (пусто/`undefined` → ничего не
рендерится, ноль верстки для экранов, что его не передают — Профиль/
Настройки/Каналы-список и т.д. не затронуты). Единственное новое место
разметки, общее для `chat.jsx` и `files.jsx` — даёт консистентность
позиции "бесплатно" (решение пользователя этой сессии, DESIGN.md "Этап
E3").

### `src/ui/components/media/media-buttons.jsx` [W] (НОВЫЙ)

```js
/** counts: Int32Array(4) | {audio,video,image} booleans | null/undefined
 *  (ничего не показывать). Рендерит ДО 3 маленьких цветных кнопок
 *  (audio/video/image — "other" никогда), только для классов с count>0
 *  (или true). onOpen(cls) — cls ∈ "audio"|"video"|"image". Иконки —
 *  уже существующие IconMusicNote/IconVideoCamera/IconImage (проверить
 *  наличие последней, иначе завести по образцу двух других). Пусто ⇒ null
 *  (ни одной кнопки — компонент не занимает места). */
export default function MediaButtons({ counts, onOpen })
```

i18n — `media.buttons.audio/video/images` (уже объявлены `MEDIA-SPEC.md`
§8, ещё не заведены ни в одной из 12 локалей — E4).

### Подключение (E3, [C] — интеграция/стыковка, прецедент Этапов B4/B5/C3/D3)

**`chat.jsx`** (личный чат, `Screen` с `actions=Позвонить/Очистить`):
`mediaButtons={<MediaButtons counts={classesInMessages(messages)}
onOpen={openChatMediaClass} />}`, где `classesInMessages` — маленькая
локальная свёртка `collectChatScope(messages)` по `classOf` (без
дедупликации — здесь только ПРИСУТСТВИЕ класса нужно, не список),
`openChatMediaClass(cls)` — `collectChatScope(messages)` → `buildPlaylist`
→ находит первую позицию класса `cls` → `openMedia({refs, position})`.
Ключи/размер уже в дескрипторе — без сети.

**`files.jsx`** (`Screen`, `view==="own"` — на "Полученные папки" кнопки
НЕ подключаются, отдельная CRDT-проекция без `classCount`, вне объёма
этого этапа): `mediaButtons={<MediaButtons counts={classesPresent(
treeState.value, currentFolderId.value)} onOpen={openFolderMediaClass} />}`.
`openFolderMediaClass(cls)` — асинхронно: сырые живые дети текущей папки
(`liveChildrenOf`) → фильтр `kind==="file" && mime≠null &&
classOf(mime)!=="other"` → для каждого — манифест (кэш/сеть, тот же
приём, что `openEntry`) → `size`; `keyOf` — `getFileKeyFor` →
`collectFolderScope(entries, keyOf)` → `buildPlaylist` → позиция первого
элемента класса `cls` → `openMedia`. Пока идёт резолв — простой
индикатор загрузки (тот же `<span class="spinner">`, что уже есть у
загрузки вложений).

**`channel.jsx`/`post-card.jsx`** (НЕ шапка экрана — DESIGN.md "Этап E3"):
`refresh()` дополнительно вызывает `mediaClassesByPost(ownerPubkey,
dbKey)` (как уже вызывает `countCommentsByPost`), результат —
`mediaClasses` state, `Object.fromEntries`. `PostCard` получает новый
проп `mediaCounts={mediaClasses[post.id]}`, рендерит `<MediaButtons>` в
`.post__foot`, рядом с кнопкой комментариев. `onOpen` — НЕ в `PostCard`
(там нет доступа к дереву комментариев), пробрасывается из
`PostWithComments` как `onOpenMediaClass(cls)`: форсирует свежий
`getCommentsTree(ownerPubkey, dbKey, post.id)` (НЕЗАВИСИМО от `expanded`
— DESIGN.md разбирает, почему) → `collectPostScope({post, commentsTree,
compareSiblings: compareComments})` → `buildPlaylist` → позиция первого
элемента класса `cls` → `openMedia`.

### `src/ui/signals/files.js` [C, найдено при интеграции — не было в исходном контракте]

Без этого mime-денормализация оставалась бы структурно готовой, но
функционально мёртвой (новые загрузки всегда получали бы `mime=null`,
дозаливка никогда бы не вызывалась):

```js
/** 5-й параметр mime=null — денормализуется СРАЗУ, когда вызывающая сторона
 *  его и так знает (files.jsx's upload — file.type). */
export async function createFileEntry(name, blobDigest, fileKey, origin = null, mime = null)

/** Событийная дозаливка (⊥→v) — DESIGN.md "Этап E, E1-доп". БЕЗ label. */
export async function backfillMime(nodeId, mime)
```

`files.jsx` подключает `backfillMime` в двух точках, где манифест и так уже
резолвлен: `FileThumbnail`'s эффект (fire-and-forget, не блокирует саму
миниатюру) и `openEntry`. Upload (`handleFilesSelected`) передаёт `file.type
|| "application/octet-stream"` пятым аргументом в `createFileEntry`.

### Тесты (до кода)

- `tree.js`/`ops.js`: `classCount` — create/purge/setPar/setName (4 события
  E1) на файлах С mime и БЕЗ (симметрия increment/decrement строго по
  `mime≠null`); `setMime` — на несуществующий узел (буферизация pending →
  разрешается после create), на узел с уже проставленным mime (no-op,
  идемпотентность), на purged узел (не трогает classCount), на живой узел
  (classCount инкрементируется на E1's правило); `classesPresent` — пустая
  папка → `{false,false,false}`, после `create+setMime` → соответствующий
  true; `createInitialState`/`cloneState`/`rebuildIndexes` — новый `S`
  содержит `classCount` (пустой/копия/пересобранный).
- `store.js`: round-trip `nodeToRow`→`rowToNode` сохраняет `mime`; старая
  строка без столбца `mime` (`delete row.mime`) → `rowToNode` даёт `null`.
- `media-ref.js`/`playlist.js`: `CLASS_NAMES`/`CLASS_INDEX` экспортированы
  и совпадают со старыми приватными значениями (регрессия).
- `comments.js`: `compareComments` — сортировка по `createdAt`, tie-break
  по `id` при равном `createdAt`; `buildTree` даёт тот же порядок, что до
  правки, на существующих тестовых данных (регрессия).
- `media-index.js`: `mediaClassesByPost` — пост с вложениями всех трёх
  классов даёт верный `Int32Array`; черновик/удалённый пост исключён;
  вложения недостижимого (осиротевшего) комментария не считаются
  (реиспользование `computeReachableCommentIds` реально работает, не
  просто импортировано); комментарий поста из ДРУГОГО (не переданного)
  скана не паникует (chuk постов другого владельца/канала просто не
  попадает в `acc`, `row.postId ∉ acc` — тихо пропускается); `Θ(k+m)` —
  не тест производительности буквально (node --test не мерит время
  надёжно), а тест на ЧИСЛО вызовов `fromEncryptedRow` (мок-подсчёт),
  подтверждающий один проход, не `k` проходов.
- `media-buttons.jsx` — без теста (тонкий рендер-слой, прецедент D3/D4).
- Подключение в `chat.jsx`/`files.jsx`/`channel.jsx`/`post-card.jsx` —
  без юнит-теста (стыковка сигналов и разметки), приёмка — живая проверка
  (правило 17, "интеграция... реальный запуск флоу").

### `vite.config.js`/`service-worker.js`/`main.jsx` [C, найдено живой проверкой пользователя — вне исходного контракта Этапа E]

SW не регистрировался в `vite dev` (`main.jsx` раньше: `if
(!import.meta.env.DEV)`) — `emitServiceWorker` (vite.config.js) это
build-only плагин (`apply:"build"`, Rollup's `generateBundle`, Vite dev
его не зовёт). `/files-content/*` поэтому улетал в SPA-фолбэк
`index.html` (`text/html`) — mp3/mp4 не проигрывались НИ РАЗУ за всю
сессию в dev, включая живую проверку Этапа D (там это не поймали —
видео/аудио не тестировались живьём).

```js
// vite.config.js — новый dev-only плагин, тот же паттерн, что
// devRelayPlugin/devBlossomPlugin (apply:"serve").
function devServiceWorkerPlugin()
```
Middleware отдаёт `/service-worker.js` в dev, подставляя буквальную
строку `"dev"` вместо `__BUILD_HASH__` (тот же `replaceAll`, что
`emitServiceWorker`).

`service-worker.js`: `IS_DEV = BUILD_HASH === "dev"` — выключает
precache (`install`) и cache-first статику (`fetch`, ветка ПОСЛЕ
`files-content:range-*`) в dev — иначе сломало бы HMR (кэш отдавал бы
старый код после правки файла). `files-content:range-*` остаётся
идентичным в dev и в проде — единственное, что реально нужно плееру.

`main.jsx`: `navigator.serviceWorker.register(...)` теперь безусловна
(была `if (!import.meta.env.DEV)`).

**Прод не задет** — `dist/service-worker.js`'s `BUILD_HASH` остаётся
обычным git-хэшем (`emitServiceWorker` не тронут), `IS_DEV` там
`false`, precache/cache-first работают как раньше.

**Проверено живьём**: SW корректно перехватывает `/files-content/*` в
dev (`vite dev`, порт 5173) — Range-запрос (и закрытый, и открытый)
доходит до SW, до страницы (`postMessage`), расшифровывается,
возвращается 206 за ~17мс, идентично прод-сборке. `<audio>`/`<video>`
DOM-элемент в САМОЙ этой (многочасовой, много вкладок) автоматизированной
Chrome-сессии зависал на `readyState=0` даже для `blob:`-URL с уже
готовыми байтами — но `AudioContext.decodeAudioData` на ТЕХ ЖЕ байтах
успешно декодирует, то есть данные и вся сетевая/крипто-часть конвейера
корректны; впечатление — деградация media-пайплайна конкретно этого
браузерного процесса, не баг кода. Не перепроверено в свежем окне
браузера (открытый пункт пользователю).

## Медиа-подсистема — Этап F (вложения на потоковый путь)

### `src/domain/media/scope.js` [C, точечное дополнение]

```js
/** Позиция клика в уже построенном refs — по (digest, sourceMeta),
 *  сравнение sourceMeta по значению (не по ссылке). -1, если не найдено. */
export function findRefPosition(refs, digest, sourceMeta)
```

Известное ограничение (DESIGN.md "Этап F, F1/F2"): один и тот же файл
дважды в ОДНОМ И ТОМ ЖЕ контейнере (сообщении/посте/комментарии) даёт
совпадающий `(digest, sourceMeta)` — находится первое вхождение. Не
входит в объём (дедупликация клика — не задача этого этапа).

### `src/ui/components/attachment-view.jsx` [C]

```js
export default function AttachmentView({ attachment, onOpen })
```

`onOpen(attachment)` — новый проп, ЕДИНСТВЕННЫЙ канал открытия
плеера/просмотрщика; компонент сам НЕ строит `openMedia` и не знает
про scope (DESIGN.md "Этап F, F1/F2"). `ImageAttachment` — без
изменений в загрузке (eager, E2E-шифрование), меняется только источник
клика. `VideoAttachment`/`AudioAttachment` (не-voice) — БЕЗ `useEffect`/
сети вовсе: кликabельная строка иконка+имя+размер (тот же паттерн, что
`FileAttachment`), клик → `onOpen(attachment)`. Голосовые
(`attachment.voice===true`) — БЕЗ изменений, остаются в eager-ветке
`AudioAttachment` (F-AT-08, MEDIA-SPEC.md §1.4 — не в плейлисте).

i18n: `attachment.loadingVideo`/`videoLoadError`/`loadingAudio` —
УДАЛЕНЫ (мертвы — video больше не имеет состояния загрузки в пузыре
вовсе, `loadingAudio` был для не-voice ветки, которой больше нет;
`audioLoadError`/`loadingVoice` остаются — voice-ветка не тронута).
Новые: `attachment.openVideoAria`/`openAudioAria` (`"Открыть видео/аудио
{{name}}"`) — единственный текст новых превью (иконка+имя+размер уже
есть через `formatFileSize`, отдельная видимая подпись не нужна).

### Подключение (стыковка, прецедент Этапов B4/B5/C3/D3/E3)

**`chat.jsx`** (personal): `openAttachment(message, attachment)` —
`collectChatScope(messages)` → `refFromAttachment(attachment,
{msgId: message.id})` → `findRefPosition` → `openMedia({refs, position})`.
`MessageBubble` получает новый проп `onOpenAttachment(message,
attachment)`; сама передаёт `onOpen={() => onOpenAttachment(message,
attachment)}` в оба вызова `<AttachmentView>` (above/below).

**`channel-chat.jsx`**: та же схема, `messages` уже в локальном
состоянии компонента — `openAttachment` строится и используется прямо
там же, без проброса пропа наружу.

**`post-card.jsx`/`CommentNode` (channel.jsx)**: `PostWithComments`
уже держит `tree` (комментарии, ленивая загрузка по `expanded` —
Этап 69). В отличие от Этапа E3's кнопки (которая форсирует свежий
`getCommentsTree` НЕЗАВИСИМО от `expanded`, т.к. счётчик на кнопке
обещает медиа из ВСЕХ комментариев) — клик по КОНКРЕТНОМУ вложению не
форсирует ничего: `collectPostScope({post, commentsTree: tree,
compareSiblings: compareComments})` на уже загруженном (возможно
пустом, если `!expanded`) `tree`. Синхронно, без сетевого ожидания —
сохраняет прежнее мгновенное поведение клика по картинке (было так до
этого этапа). `onOpenAttachment(attachment, sourceMeta)` — новая
функция в `PostWithComments`, пробрасывается в `PostCard` (для
post.attachments, `sourceMeta={postId: post.id}`) и рекурсивно в
каждый `CommentNode` (для comment.attachments, `sourceMeta=
{commentId: comment.id}`).

### `src/domain/files/chunk-cache.js` [C]

```js
/** 3-й параметр (необязательный) — {pin: true} исключает key из цикла
 *  вытеснения по объёму (Set закреплённых ключей). Без pin — поведение
 *  ИДЕНТИЧНО прежнему (регрессия существующих тестов подтверждает noop
 *  для незакреплённого пути). */
function put(key, bytes, { pin = false } = {})
```

### `src/domain/files/player-session.js` [C, точечная правка]

`loadChunk(index)`: `cache.put(key, bytes, { pin: index === 0 })` —
закрепляет ровно чанк 0 (DESIGN.md "Этап F, F3" — Θ(1) переоткрытие
файла независимо от того, сколько чанков загружено после).

### `src/domain/files/player-bridge.js` [C, точечная правка]

`DEFAULT_CACHE_BUDGET_BYTES`: `32*1024*1024` → `2_621_440` (=`(k+3)·C`
при `C=512КиБ, k=2`, ALGO.md §3.4's собственный расчёт буквально).

### Тесты (до кода)

- `scope.js`: `findRefPosition` — находит верную позицию по совпадению
  digest+sourceMeta; -1 при отсутствии; различает элементы с одним
  digest, но разным sourceMeta (два разных сообщения, тот же файл).
- `chunk-cache.js`: НОВЫЕ тесты на `pin` — закреплённый ключ переживает
  вытеснение, которое иначе снесло бы его (объём/LRU-порядок это не
  спасло бы); незакреплённые продолжают вытесняться как раньше;
  ВСЯ существующая сюита (regression) остаётся зелёной без изменений
  (подтверждает noop при `pin` не переданном).
- `player-session.js`: чанк 0 остаётся в кэше после загрузки МНОГИХ
  последующих чанков, суммарно превышающих бюджет — обычный (не
  нулевой) чанк на той же дистанции вытесняется, чанк 0 — нет.
- `attachment-view.jsx`/подключение в 4 местах — без юнит-теста (тонкий
  рендер-слой + стыковка сигналов, прецедент D3/D4/E3), приёмка —
  живая проверка (видео из чата открывается и перематывается БЕЗ
  полной загрузки — по объёму сетевого трафика, критерий 7.7).

## MEDIA-OVERLAY-UI.md — Этап 1 (каркас и хром)

### `src/ui/components/media/media-overlay.jsx` [C, ветка `full` переписана]

Скелет по MEDIA-OVERLAY-UI.md §1.1: `div.media-overlay` (role=dialog,
onClick=closeMedia) > `div.media-overlay-scrim` (aria-hidden) +
`div.media-overlay-viewport` (onClick закрывает ТОЛЬКО если
`e.target===e.currentTarget` — клик по пустому полю вокруг кадра, не
по кадру) > `div.media-overlay-inner` (stopPropagation) > `<View>` +
`header.media-overlay-top` (имя, "N из M · класс · размер", кнопки
свернуть/закрыть) + до 2х `button.media-overlay-nav.is-{prev,next}`
(только `total>1`) + `footer.media-overlay-bottom` (пуст на этапе 1).
Header/nav/footer каждый со своим `stopPropagation` — без этого клик
по любой кнопке шапки/навигации забублился бы до `closeMedia` на
корневом div (в spec явно не расписано, добавлено как необходимое
следствие данной схемы кликов, не новая фича).

Ветка `isMini` НЕ тронута (ни разметка, ни символы `⏸ ▶ ⤢`) —
переделывается целиком на этапе 6.

`metaLine` — JS-конкатенация: `t("media.player.trackOf", {current,
total})` + `" · "` + `t(\`media.classNames.${session.cls}\`)` + `" · "`
+ `formatFileSize(currentRef.size)` (импорт из `../attachment-view.jsx`,
уже экспортирована оттуда — не дублировать).

Второй `useEffect` (§1.2): `document.documentElement.dataset.mediaFull
= "1"` пока `session?.display === "full"`, снимается в cleanup,
зависимость `[session?.display]` — раздельно от уже существующего
Escape-эффекта (та же зависимость, но разная ответственность, слитие
в один эффект не делалось, чтобы каждый cleanup был независим).

Кнопка «сведения» (в скелете §1.1 она есть в списке, "только если есть
что показать") НЕ отрендерена на этапе 1 — источник данных для неё
(панель сведений) заводится только этапом 2.

### `src/ui/icons/{minimize,player-play,player-pause,info-circle}.jsx` [C] (НОВЫЕ)

По образцу `phone-call.jsx`/`bell.jsx`: viewBox `0 0 15 15`,
`fill="currentColor"` на фигуре, `width/height="1em"`, `class="icon"`.
Экспорт по умолчанию — функциональный компонент, проп `props`
разворачивается на `<svg>` (даёт `aria-label` и т.п. переопределять
снаружи, как у остальных иконок проекта). `minimize.jsx` подключена в
`media-overlay.jsx` этапом 1; `player-play.jsx`/`player-pause.jsx`/
`info-circle.jsx` заготовлены впрок (понадобятся этапам 2/6),
НИГДЕ пока не импортированы.

### `src/styles/custom.css` [C, блок заменён целиком между старым header-комментарием и `.media-mini-bar {`]

Классы из §1.3 verbatim: `.media-overlay` (`color-scheme:dark`,
`--media-pull:0` — объявлена сразу под этап 3, чтобы правило не
переписывалось повторно), `.media-overlay-scrim`, `-viewport`,
`-inner`, общее `.media-overlay-top,.media-overlay-bottom` (позиция +
transition), `.media-overlay-top` (градиент), `.media-overlay-title
span/small`, `.media-overlay-acts`, `.media-overlay-btn` (+hover/
active/is-close:hover), `.media-overlay-nav` (+hover/focus-visible/
is-prev/is-next/[disabled]/`@media(pointer:coarse)` — на тач стрелок
нет вовсе, листание свайпом будет этапом 3), `.media-overlay-bottom`
(градиент). Плюс отдельно, рядом с уже существующим
`.top-corner-actions`: `html[data-media-full] .top-corner-actions
{opacity:0;pointer-events:none}` (§1.2).

`.media-mini-bar*` — НЕ в этом блоке, границе правки намеренно уперта
в `.media-mini-bar {` как маркер (этап 6 его переделает).

### Локали (все 12 файлов `src/ui/i18n/locales/*.json`) [C]

`media.player.info` (строка) + новый узел `media.classNames.{audio,
video,image}` (родительный падеж там, где это применимо — ru:
«аудио»/«видео»/«изображения» буквально как в spec §1.4; остальные
локали — прямой перевод существительным, без падежной адаптации,
тот же уровень качества, что и остальные 10 неносительских переводов,
см. память проекта). `media.player.trackOf` САМ не менялся — формат
`"{{current}} из {{total}}"` (и аналоги) остаётся, композиция строки
шапки собирается в JS (см. `media-overlay.jsx` выше), не в i18n-шаблоне.

### Тесты — намеренно НЕ добавлены

Разметка/CSS/иконки — чистый рендер-слой без новой бизнес-логики
(прецедент D3/D4/E3/F: тонкий UI без dedicated unit-тестов, приёмка
через регрессию существующих + живую проверку). Единственная не совсем
тривиальная логика — `metaLine`-конкатенация и `e.target===
e.currentTarget` проверка на viewport — обе покрываются live-проверкой
DoD этапа 1 (открытие из 4 мест без регрессий, `total===1` без стрелок
и т.д.), отдельный unit-тест на JSX-композицию строки признан
избыточным (тот же критерий, что и раньше в этом проекте).

## MEDIA-OVERLAY-UI.md — довесок (живой фидбек) + Этап 2

### `src/styles/custom.css` [C, точечная правка]

`.media-overlay-btn`/`.media-overlay-nav` `font-size`: 1.05rem→
1.785rem, 1.25rem→2.125rem (+70%, живой фидбек пользователя после
этапа 1 — иконки мелковаты). Иконка масштабируется вместе (SVG
`width/height="1em"`), сама кнопка/тач-таргет (2.5rem / 2.75×4.5rem)
не менялся — есть запас.

### `src/ui/components/media/media-overlay.jsx` [C, ветка `full` дополнена]

Новое локальное состояние (НЕ в автомате, `session` про него не
знает — тот же принцип, что везде в этом модуле):
- `chromeVisible` (bool) + `hideTimerRef` (таймер 2800мс) +
  `infoPinnedRef` (синхронная копия `infoPinned` для чтения ВНУТРИ
  уже запущенного `setTimeout`, без чего проверка "не прятать при
  закреплённой панели" читала бы значение на момент ПОСТАНОВКИ
  таймера, не на момент срабатывания). `handleChromeActivity()` —
  общая функция для стартового эффекта и `onPointerMove`/
  `onPointerDown`/`onFocusIn` на корне `.media-overlay`. Кнопки шапки/
  навигации активность НЕ глушат (у них `stopPropagation` только на
  `onClick`, не на `pointerdown`) — считаются активностью бесплатно.
  `data-chrome="on|off"` на корне.
- `infoPinned` (bool, тоггл кнопкой "i") → `data-info="on|off"` на
  корне.
- `meta` — `{digest, width?, height?, duration?} | null`, приходит из
  `onMeta` пропа вида `<View onMeta={(m) => setMeta({digest:
  currentRef.digest, ...m})}>`. Рендер сверяет `meta?.digest ===
  currentRef.digest` (`isCurrentMeta`) — НЕ сброс через `useEffect` на
  смену `currentRef.digest` (тот сработал бы уже ПОСЛЕ первого
  рендера с новым digest, окно в кадр с чужими значениями). Чипы
  разрешения/длительности рендерятся только при наличии данных, без
  плейсхолдера "—".

Header `.media-overlay-acts`: добавлена кнопка "i"
(`aria-pressed={infoPinned}`) первой в ряду, перед свернуть/закрыть —
порядок как в исходном скелете §1.1, который этап 1 сознательно
пропустил (там ещё не было источника данных для панели).

Footer `.media-overlay-bottom` больше не пуст: `.media-overlay-info >
div > .media-overlay-meta.bar` со span-чипами тип/размер/[разрешение]/
[длительность]/hash (`shortHash` — первые 4 + последние 4 символа
hex-digest'а, тот всегда hex-строка — `bytesToHex`, см. `content.js`/
`stream-upload.js`).

### `src/ui/components/media/{video-player,audio-player}.jsx` [C, точечная правка]

Новый проп `onMeta`. `onLoadedMetadata` на `<video>`/`<audio>` зовёт
`onMeta?.({width, height, duration})` (video) / `onMeta?.({duration})`
(audio, нет width/height). Опционален (`?.`) — вызов из mini-ветки
`media-overlay.jsx` его не передаёт, там метаданные не нужны.

### `src/ui/components/media/image-viewer.jsx` [C, точечная правка]

Новый проп `onMeta`. `onLoad` на `<img>` зовёт `onMeta?.({width:
naturalWidth, height: naturalHeight})` (нет duration — картинка).

### Локали (все 12 `src/ui/i18n/locales/*.json`) [C]

Новый узел `media.info.{size,type,resolution,duration,hash}` — подписи
чипов, буквально как в spec §2.2: «Размер», «Тип», «Разрешение»,
«Длительность», «SHA-256» (ru); остальные локали — прямой перевод, без
падежной адаптации (тот же уровень, что и остальные добавленные ранее
ключи).

### Тесты — намеренно НЕ добавлены (тот же прецедент, что этап 1)

Единственная нетривиальная логика — `isCurrentMeta`-сверка по digest —
покрывается конструктивно (нет способа получить рассинхрон при данной
структуре кода: `meta` всегда пишется ВМЕСТЕ со своим digest одним
`setState`), а не отдельным unit-тестом; DOM-эффекты (таймер/pointer-
события) — тот же класс, что и остальной UI-слой этого модуля, приёмка
через живую проверку DoD этапа 2.

### `src/styles/custom.css` [C, довесок — размер иконок не по font-size]

Первая правка (font-size на `.media-overlay-btn`/`.media-overlay-nav`)
не влияла на размер иконки вовсе — та маскировалась известным этому
проекту багом (см. существующий комментарий у `.markdown-toolbar-btn
.icon`): `minimal.css`'s `svg{max-width:100%;height:auto}` побеждает
HTML-атрибуты `width/height="1em"` самого SVG, внутри flex-контейнера
резолвится в 0×0. Настоящий фикс — явные `.media-overlay-btn .icon`/
`.media-overlay-nav .icon {width:1em;height:1em;max-width:none;
flex-shrink:0;}`, побеждающие ресет специфичностью класса. Заодно
`.media-overlay-nav` получила `display:flex;align-items:center;
justify-content:center` — без неё была не flex-контейнером вовсе
(текстовые `‹ ›` из исходной spec центрировались через line-height
кнопки без этого; заменивший их `<svg>` — нет).

## MEDIA-OVERLAY-UI.md — КРИТИЧНЫЙ довесок: нарушение И-A этапом 1

Этап 1 (§0, "И-A. `<View>` остаётся смонтированным... форма дерева
`div > div > View` одна и та же для `full` и `mini`") был реализован
С НАРУШЕНИЕМ этого же собственного инварианта — не пойман ни тестами
(их для этого слоя нет, прецедент D3/D4), ни живой проверкой ДО
пользователя (моя браузерная сессия не может проверять воспроизведение
вживую весь этот тред работы). Найдено пользователем: сворачивание/
разворачивание обрывало играющее аудио/видео.

### `src/ui/components/media/media-overlay.jsx` [C, структурный фикс]

Было — ДВА отдельных `return` (`if (isMini) return (...)`, потом
`return (...)`), с РАЗНОЙ формой дерева: full — `<View>` ВТОРЫМ
ребёнком корня (после `.media-overlay-scrim`, отдельного div); mini —
ПЕРВЫМ (единственным ребёнком `.media-mini-bar-preview`). Preact диффит
детей ПОЗИЦИОННО, не по компоненту целиком — несовпадение тега на
позиции, где раньше жил РЕАЛЬНЫЙ `<View>`, размонтирует его.

Стало — ОДИН `return`. Первый ребёнок корня — ВСЕГДА пара обёрток:
```
div[isMini ? "media-mini-bar-preview" : "media-overlay-viewport"]
  div[isMini ? undefined : "media-overlay-inner"]
    (session.cls==="audio" && <IconMusicNote style={isMini?undefined:{display:"none"}}/>)
    <View compact={isMini} onMeta={isMini?undefined:...} .../>
```
Всё режимно-разное (шапка/навигация/подвал в full vs имя+кнопки-в-mini)
— ПОСЛЕ этой пары, вторым+ ребёнком; там смена тегов при переключении
безопасна (нет состояния, которое жалко потерять).

Два следствия конструкции:
- `IconMusicNote` для аудио был условным на `isMini && cls==="audio"` —
  это САМО сдвигало индекс `<View>` внутри обёртки между режимами (для
  аудио конкретно) — тот же класс бага в миниатюре. Условие теперь
  просто `cls==="audio"` (иконка в DOM всегда при аудио), видимость —
  `display:none` в full, не присутствие/отсутствие в дереве.
- `onMeta` передаётся `undefined` в mini (панель сведений там не нужна)
  — смена ПРОПА на уже смонтированном компоненте, не структуры дерева,
  ремонта не вызывает (в отличие от смены позиции/тега).

### `src/styles/custom.css` [C, точечная правка]

`.media-overlay-scrim` (div) → `.media-overlay::before` — DOM-узел
мешал бы быть стабильным "первым ребёнком" наравне с viewport/preview
(сдвигал бы его на позицию 1). `::before` не создаёт DOM-узла, не
участвует в позиционном diff'е детей вовсе; порядок покраски идентичен
(псевдо-элемент красится как логически первый ребёнок — та же
"подложка под всем остальным", что и раньше). CSS-содержимое 1-в-1,
плюс `content:""`.

### Верификация — реальный Preact, не unit-тест

Design-решение (алгоритмическая часть — стабильность позиции в дереве
у diff-алгоритма, не рутина): unit-тест НЕ написан — тот же прецедент,
что весь UI-слой этого модуля (нет jsdom-инфраструктуры в проекте,
вводить её ради одного теста — отдельное решение, не принято в рамках
довеска). Вместо этого — эмпирическая проверка РЕАЛЬНЫМ Preact (тем же
движком, что в проде): временная HTML-страница, отданная тем же Vite
dev-сервером (`test-repro.html` в корне репозитория — Vite резолвит
bare-import `preact`/`preact/hooks` из `node_modules` без правки
`vite.config.js`), с двумя мини-компонентами — БУКВАЛЬНОЙ старой формой
дерева (баг) и БУКВАЛЬНОЙ новой (фикс), общим дочерним `Marker`,
использующим `useEffect(() => {...; return () => {...}}, [])` (пустые
deps — фиксирует именно mount/unmount, НЕ ре-рендер: `console.log` в
теле функции-компонента ложно сработал бы на КАЖДЫЙ ре-рендер тоже,
это первая версия теста, отброшена после разбора). Клик "toggle mini/
full" на старой форме дал `UNMOUNT id=X` + `MOUNT id=Y` — баг
воспроизведён буквально, в обе стороны (`full→mini` и `mini→full`); та
же кнопка на новой форме — ноль сообщений в обе стороны. Файл удалён
после проверки, в git не попадал (не создавать по образцу постоянных
файлов проекта — он временный, вне `src/`, не тестовая сюита `tests/`).

## MEDIA-OVERLAY-UI.md — Этап 3 (жесты и анимация открытия)

Формализация — DESIGN.md "MEDIA-OVERLAY-UI.md, этап 3". Тесты
математики жеста — `tests/media-swipe-gesture.test.js` (14, все
зелёные, ДО правки `media-overlay.jsx`). Воркер не привлекался
(§3 spec: "Воркеру не отдавать ничего из этапа 3").

### `src/domain/media/swipe-gesture.js` [C, новый файл]

Чистые функции без DOM (тот же слой, что `playlist.js`/
`media-machine.js`, но НЕ автомат — паттерна transition() здесь нет,
это просто арифметика над dx/dy, не пространство состояний):
`resolveAxis(dx, dy)` → `"horizontal"|"vertical"|null` (порог 8px,
диагональ — больший по модулю компонент, `>=` даёт horizontal при
равенстве — детерминировано, не мигает); `elasticDx(dx, atEdge)` →
×0.3 на краю плейлиста; `horizontalCommit(dx, widthPx)` →
`"prev"|"next"|null` при пороге 16% ширины (`widthPx<=0` → null,
защита от деления на 0); `verticalPull(dy)` → `[0,1]` линейно на
260px, свайп вверх (`dy<0`) прижат к 0; `verticalCommit(dy)` →
`dy>110`. Решение о commit — ТОЛЬКО на `pointerup` (не в процессе
драга) для обеих осей — сознательное упрощение относительно
буквального "по достижении порога" в §3.1 про audio/video: срабатывание
ВНУТРИ драга потребовало бы флага "уже сработало в этом жесте" (риск
двойного mediaNext при продолжении движения после порога) — приёмка на
отпускании даёт тот же результат для типичного жеста ценой одного кадра
задержки, не срабатывает дважды по построению.

### `src/ui/signals/media-origin.js` [C, новый файл]

`setMediaOrigin(rect)` / `consumeMediaOrigin()` — модуль-`let`, НЕ
сигнал (не должен вызывать реактивных обновлений, читается ровно один
раз за сессию). `openMedia()` не меняет сигнатуру (медиа-подсистема,
"Правки media-machine.js/playlist.js/scope.js... не реализуются", а
добавление параметра в `openMedia` касалось бы контракта D, не только
UI-довеска) — геометрию источник клика кладёт СЮДА непосредственно
перед вызовом того колбэка, что в итоге вызовет `openMedia`.

Три точки записи (из шести мест вызова `openMedia`, см. §3.3 spec):
- `attachment-view.jsx`: общий helper `openWithOrigin(e, attachment,
  onOpen)` — `setMediaOrigin(e.currentTarget.getBoundingClientRect())`
  затем `onOpen(attachment)`; подключён во ВСЕХ трёх кликабельных
  превью (`ImageAttachment`, `MediaPreview` — audio-без-voice и video).
  Одна правка в ОДНОМ файле закрывает ТРИ места вызова `openMedia`
  (channel.jsx/chat.jsx/channel-chat.jsx `openAttachment` — все идут
  через `AttachmentView`), правка самих трёх экранов не нужна.
- `files.jsx`: `onDblClick` на `.file-row-name` — захват ТОЛЬКО при
  `entry.kind !== "dir"` (у навигации в папку своей сессии нет; если
  захватывать всегда, чужая геометрия папки пережила бы клик и была бы
  ошибочно подхвачена СЛЕДУЮЩИМ открытием медиа без своего захвата,
  напр. кнопкой класса).
- Кнопки класса (`media-buttons.jsx`, `openChatMediaClass`/
  `openFolderMediaClass`) геометрию НЕ пишут — по spec явно "обычное
  проявление" без анимации.

Самоочищение: `media-overlay.jsx` читает `consumeMediaOrigin()` (и
обнуляет) на КАЖДОМ переходе сессии `null -> not null`, независимо от
того, была запись или нет (`null` — валидный результат, просто нет
анимации). Не обнаруженный на практике устаревший край: если вызывающая
сторона записала origin, но её собственный код упал/вернулся раньше
`openMedia` (напр. `findRefPosition` вернул `-1`) — запись переживает
до следующего РЕАЛЬНОГО открытия и будет ошибочно использована им
(анимация "разлетится" из неправильной точки). Последствие чисто
косметическое (не крах, не потеря данных), вероятность мала
(рассинхрон scope/target) — осознанно не чинится в этом проходе.

### `src/ui/components/media/media-overlay.jsx` [C, крупная правка]

**Открытие/закрытие (§3.3).** Эффект с зависимостью `[!!session]`
(НЕ `[session]` — тот меняется на КАЖДЫЙ dispatch, `justOpened`
всё равно фильтрует по факту перехода `null->not null` через
`prevSessionExistedRef`, но `[!!session]` дешевле — не перезапускается
на next/prev/toggle). При `justOpened && display==="full"`:
`consumeMediaOrigin()`; если rect есть — WAAPI на
`.media-overlay-viewport` (`viewportRef`) от `translate(dx,dy)
scale(0.35)` + `opacity:0` к `translate(0,0) scale(1)` + `opacity:1`,
420мс, `cubic-bezier(0.22,0.61,0.36,1)` (литерал — WAAPI не читает CSS
custom properties), где `dx/dy` — разница центров rect'а источника и
текущего viewport'а (НЕ разница размеров — scale всегда буквально
0.35, как в spec, не пропорция размеров миниатюры). rect источника
сохраняется в `originRectRef` для симметричного закрытия. Если rect'а
нет (кнопка класса) — без WAAPI, обычное появление.

`handleClose()` заменяет прямые вызовы `closeMedia` на backdrop-click,
viewport-click-outside, кнопке закрытия и Escape (НЕ на commit свайпа
вниз — тот вызывает `closeMedia()` напрямую по буквальному тексту
§3.2, визуальное сжатие там уже отыграно `--media-pull` в реальном
времени во время драга, вторая анимация поверх избыточна). Если
`originRectRef.current` есть — WAAPI 200мс в обратную сторону
(`fill:"forwards"`, элемент всё равно размонтируется сразу после — не
на что "приземляться"), иначе просто `opacity:1→0`. `closeMedia()`
вызывается в `animation.finished.then(...).catch(() => {})` — не
раньше кадра, отмена анимации при досрочном размонтировании не роняет.
`prefers-reduced-motion: reduce` (проверка `matchMedia`, не CSS —
WAAPI не подчиняется глобальному CSS-глушителю анимаций из
`minimal.css`) — пропускает WAAPI целиком в обе стороны,
`closeMedia()`/появление сразу.

**Жесты (§3.1/§3.2).** `onPointerDown/Move/Up/Cancel` на КОРНЕ
`.media-overlay` (не только на viewport) — вертикальный pull-to-close
должен работать и над хромом/фоном, не только над кадром. Игнор
жестов, начавшихся на `e.target.closest("button, video, audio")` —
буквально по spec (перемотка/громкость нативных `controls` не должна
листать). `setPointerCapture` на `pointerdown`. Ось решает
`resolveAxis` (`swipe-gesture.js`) один раз за жест, дальше не
пересматривается (ref, не state — 60 событий `pointermove` в секунду
не должны вызывать ре-рендер компонента).

Вертикаль: `--media-pull` пишется НАПРЯМУЮ в `style` корневого DOM-узла
(`overlayRef.current.style.setProperty`), не через Preact state —
CSS-правила `--media-pull` уже читают её (Этап 1). На `pointerup`:
`verticalCommit(dy)` → `closeMedia()` напрямую; иначе анимированный
возврат в 0 (transition на `--media-pull`, класс `.is-settling-pull`
временный).

Горизонталь, `cls==="image"`: три слайда в `.media-overlay-track`
(`prevRef`/`currentRef`/`nextRef` — `stepInClass(playlist, position,
±1)` из `playlist.js`, НЕ полный `allocWindow`-бюджет — окно жеста и
окно ресурсов из `signals/media.js` НЕ обязаны совпадать 1-в-1;
`maxSpan` там и здесь равны (3), при типичном бюджете 16 МиБ окна на
практике совпадают, при их расхождении соседний слайд просто грузится
своим собственным `acquireMediaUrl` внутри `ImageViewer` — не
регрессия, просто чуть менее прогретый кэш). `elasticDx` на краях
(`rank===0` для `dx>0`/`rank===total-1` для `dx<0`) пишет `--drag-px`
на `trackRef` напрямую (та же причина, что `--media-pull`). На
`pointerup`: нет коммита → transition `--drag-px` к 0 (`.is-settling`);
есть коммит → transition к ПОЛНОЙ ширине viewport в сторону коммита
(не текущий `dx` — довод до конца, ощущение завершённого перелистывания
вместо обрыва на пороге), на `transitionend` СИНХРОННО: `mediaNext()`/
`mediaPrev()` (сдвигает `position`, пересчитывает `prevRef/nextRef`)
и мгновенный (`transition:none` на один кадр, класс `.is-dragging`
затем снят на следующем `requestAnimationFrame`) сброс `--drag-px` в 0
— тот же кадр, что и подмена refs, зрительного скачка нет (тот же
приём, что "бесшовная карусель"). `prefers-reduced-motion` — без
транзишна вовсе, `mediaNext`/`prev`+сброс сразу.

Горизонталь, `cls!=="image"` (И-B — ленты нет): во время драга — без
визуальной обратной связи (буквально по spec, там нет упоминания
трансформации кадра для audio/video). На `pointerup` с коммитом:
`mediaNext()`/`mediaPrev()` сразу, класс `.is-swapping` на
`.media-overlay-inner` (CSS `@keyframes` `opacity 0→1`, 200мс),
снимается по `animationend` (once) с таймерным фолбэком 220мс на
случай отменённой анимации.

Клик после драга: pointerup, где `resolveAxis` вернул НЕ `null`
(реальный жест состоялся), помечает `didDragRef.current = true`;
следующий синтетический `click` (браузер эмитит его после
`pointerup` даже над элементом, у которого есть `onClick`) —
общий `handleRootClick`/`handleViewportClick` проверяют флаг ПЕРВЫМ
действием, сбрасывают его и выходят БЕЗ `closeMedia()` — иначе любой
завершённый свайп (в т.ч. отменённый, ниже порога) закрывал бы
оверлей случайным кликом по фону.

**Клавиатура (§3.4).** В существующий `keydown`-эффект (уже ловит
`Escape` → `handleClose()`, был `closeMedia()` — правится тем же
эффектом) добавлены `ArrowLeft`→`mediaPrev`, `ArrowRight`→`mediaNext`,
`" "` (Space) → `preventDefault()` + `mediaToggle()` (без
`preventDefault` страница проскроллила бы под оверлеем — тот уже
`position:fixed`, но `document.body` мог бы всё равно принять скролл
чата под ним). Только при `display==="full"` — то же условие, что уже
было у эффекта.

### `src/styles/custom.css` [C, довесок]

`.media-overlay-track`/`.media-overlay-slide` — 3-панельная карусель
(классический приём: track `width:300%`, слайд `flex:0 0 33.3334%`,
база `translate3d(-33.3334%, 0, 0)` центрирует средний слайд, `+
var(--drag-px)` поверх). `.media-overlay-inner:has(.media-overlay-track)`
— `width/height:100%` (иначе `.media-overlay-inner` авто-сайзится по
контенту, 300%-ширины трек распёр бы его) — CSS `:has()`, тот же
уровень современности CSS, что уже везде в модуле (`oklch`,
`color-mix`, `backdrop-filter`). `@keyframes media-overlay-swap-fade`
— fade для audio/video. `.media-overlay-track.is-dragging{transition:
none}` / `.is-settling{transition:transform .42s var(--ease)}` —
классы переключает JS, не медиа-запрос.

## MEDIA-OVERLAY-UI.md — довесок к этапу 3: три причины ложного "второй вылет"/"откат"

Найдено внешней консультацией по исходникам (не живым отладчиком) в
ответ на баг-репорт пользователя (мышь, реальный десктоп). Все три
исправления — в уже существующих функциях, новых контрактов не
заводят, только меняют детали реализации:

1. **`finish()` (settleTrack) — force-reflow вместо `requestAnimationFrame`.**
   Снятие `is-dragging` после сброса `--drag-px` в 0 ОБЯЗАНО идти через
   `void el.offsetWidth` (синхронная фиксация пересчёта стиля), не
   `requestAnimationFrame` — тот выполняется в ТОМ ЖЕ проходе "update
   the rendering", что и animation-события, ДО пересчёта стиля, и
   снимал `transition:none` раньше, чем браузер хоть раз увидел
   применённым мгновенный сброс — итог: повторная анимация транзишна
   из старого значения в 0. Тот же приём уже был в `playSwapFade`,
   теперь и здесь.
2. **`key` на `.media-overlay-slide` — по абсолютной позиции в
   плейлисте**, не по индексу слота (0/1/2 без key). Без key Preact
   сопоставлял слайды позиционно: на next/prev все три `ImageViewer`
   получали ЧУЖОЙ `mediaRef`, их digest-стейт синхронно расходился с
   пропом — "Загрузка..." мигало у всех троих сразу, даже когда
   картинка секунду назад уже была отрисована соседним слайдом. Ключ —
   `session.position` (центр), `leftPos`/`rightPos` (соседи, `-1` →
   строковый `"gap-prev"`/`"gap-next"`, не пересекается с числовыми
   позициями) — Preact при сдвиге переставляет DOM-узлы вместе с их
   React/Preact-состоянием, создаёт заново только один (самый дальний,
   не видим в момент сброса).
3. **`g.widthPx` — от `innerRef`, не `viewportRef`.**
   `.media-overlay-viewport` несёт горизонтальный padding
   (`var(--space-l)` с каждой стороны, см. §1.3); фактическая ширина
   слайда — ширина `.media-overlay-inner` (без паддинга). Прежний
   промер завышал цель коммита (`±widthPx`) на ~2×`--space-l`.

Временная диагностика (`console.debug` в pointer-обработчиках,
`settleCallCounter`) подтвердила ДО фикса: диспетчеризация событий
чистая (один `mediaNext`/`mediaPrev` на жест, `didDragRef` гасит ровно
один клик, гонок/дублей на уровне JS нет) — баг целиком в
рендер-таймингах и геометрии, не в логике принятия решения. Убрана
после подтверждения.

## MEDIA-OVERLAY-UI.md — Этап 4 (плёнка миниатюр)

### `src/ui/signals/media.js` [C, новый экспорт]

```js
export function mediaGoTo(position) {
	dispatch("open", { cls: classOf(playlistRef.items[position].mime), position });
}
```

Переиспользует СУЩЕСТВУЮЩИЙ обработчик `open` (media-machine.js —
новый обработчик в автомат НЕ добавляется, spec §4 явно это
оговаривает) — НЕ вызывает `openMedia`/`buildPlaylist`: `playlistRef`
(модульный `let`) остаётся ТЕМ ЖЕ объектом, что уже был у открытой
сессии — `openMedia` пересобрал бы плейлист заново, это лишняя работа
и семантически неверно (сессия уже открыта на этом самом плейлисте,
§4: "openMedia не звать"). `dispatch` — тот же путь, что у всех
остальных экспортов (`mediaNext`/`mediaToggle`/...): пересчитывает
`allocWindow` под НОВУЮ позицию и зовёт `resourceOwner.sync` — окно
владения ресурсами уже корректно пересобирается для новой позиции
БЕСПЛАТНО, отдельного кода на "отпустить лишнее" писать не нужно (это
и есть механизм allocWindow/resourceOwner, отдельно проверенный в
`tests/media-machine.test.js`/`tests/media-resource-owner.test.js` —
довесок к этапу 4 не переизобретает эту проверку, только подтверждает
теми же средствами, что и `openMedia`, что `playlistRef` не
пересоздаётся: `mediaSession.value.playlist` — тот же объект
(`===`) до и после `mediaGoTo`).

Тест — `tests/ui-signals-media.test.js`, ДО реализации.

### `src/ui/components/media/media-overlay.jsx` [C, footer дополнен]

Плёнка — ТОЛЬКО `session.cls === "image" && total > 1` (тот же гейт,
что уже используется для стрелок `total > 1` — плёнка из одного кадра
бессмысленна). Источник позиций — `session.playlist.idx.image`
(`Int32Array`, спред в массив для `.map`), НЕ `stepInClass`/`allocWindow`
(те дают только окрестность текущей позиции, плёнка — ВЕСЬ класс
целиком). Миниатюра — `getMemoryCachedUrl(ref.digest)`
(`attachment-memory-cache.js`) — ДРУГОЙ кэш, чем у самого просмотра
(`acquireMediaUrl`/`media-url.js`, см. довесок к Этапу F/D)
— специально: спека требует "без сети и без расшифровки", а
`acquireMediaUrl` как раз умеет то и другое (стоило бы сети на каждую
непоказанную миниатюру). Если `undefined` (картинка не была показана
инлайн в чате в этой вкладке — типичный случай для файлов, открытых
через раздел "Файлы", там своего инлайн-кэша нет) — кнопка рендерится
БЕЗ `<img>` (пустой квадрат фона), НЕ вызывает `acquireMediaUrl` и не
показывает спиннер — буквально по DoD "не роняет компонент и не тянут
сеть".

Клик по миниатюре — `withDragGuard(() => mediaGoTo(pos))` (тот же
guard, что у стрелок/кнопок хрома этапа 3 — иначе клик, идущий сразу
после свайпа, случайно попавший на плёнку, тоже прыгнул бы). Активная
миниатюра — `aria-current="true"` (CSS уже делает `opacity/transform/
box-shadow` по этому атрибуту, довесок ничего не добавляет в CSS-стиле)
+ условный `ref` (`pos === session.position ? activeThumbRef :
undefined`) — Preact привязывает ref ТОЛЬКО к активной кнопке, эффект
`useEffect(() => activeThumbRef.current?.scrollIntoView({block:
"nearest", inline:"center"}), [session?.position])` докручивает её в
центр на КАЖДУЮ смену позиции (стрелки/клавиатура/клик по самой плёнке
— DoD явно требует только "при листании стрелками", но эффект,
завязанный на позицию, а не на источник перехода, покрывает это как
частный случай, не специальный код). `behavior` НЕ указан явно (не
"smooth") — по умолчанию берёт `scroll-behavior` из CSS, тот уже
отключается глобально под `prefers-reduced-motion: reduce`
(`minimal.css`) — не дублируем JS-проверку, что уже отдельно решили
на этапе 3 для WAAPI (там пришлось явно, там API другое; здесь —
достаточно CSS).

CSS-блок `.media-overlay-strip`/`.media-overlay-thumb` — буквально из
spec §4, применён напрямую (короткий, уже полностью специфицирован
текстом задачи — раунд-трип через воркер не даёт экономии токенов
здесь, транскрибирование дешевле вызова).

**Воркеру не отдавалось ничего в этом довеске** (spec §4: "не
отдавать mediaGoTo и проверку владения ресурсами"; JSX-разметка плёнки
и CSS решено написать напрямую — CSS уже дан текстом, JSX завязан на
свежий `mediaGoTo`).

## MEDIA-OVERLAY-UI.md — Этап 6 (мини-бар)

### `src/ui/components/media/{video-player,audio-player}.jsx` [C, новый проп]

`onTimeUpdate` — опционален (`?.`), проброшен на нативный
`onTimeUpdate` элемента: `onTimeUpdate?.(e.currentTarget.currentTime)`.
Тот же паттерн, что уже был у `onMeta` (стадия 2). Полный вид его не
передаёт (там время отдают нативные `controls`, spec §6: "Только в
мини-баре").

### `src/ui/components/media/media-overlay.jsx` [C]

`onMeta` для `<View>` теперь передаётся ВСЕГДА (было `isMini ?
undefined : ...`) — довеску этапа 6 нужна `duration` и в мини тоже;
смена уже установленного пропа на смонтированном компоненте не
переМонтирует его (тот же аргумент, что документирован для
и-A/mini-full). Новое `miniTime` (`useState(0)`, сброс эффектом на
`currentRef.digest`) + `onTimeUpdate={isMini ? setMiniTime : undefined}`.
Время в мини-баре — `${formatDuration(miniTime)} / ${formatDuration(meta.duration)}`,
показывается только при уже существующем `hasDuration` (тот же флаг,
что использует info-панель полного вида — переиспользован, не
задублирован).

Кнопки мини-бара — `class="media-overlay-btn"` (было — голый `<button>`
без класса, play/pause — текстовые `⏸`/`▶`) с иконками
`IconPlayerPlay`/`IconPlayerPause` (нарисованы ещё этапом 1 "впрок",
подключены только сейчас). `.media-mini-bar-preview` для аудио получает
модификатор `is-audio` (в JSX, только когда `isMini` — в full-режиме та
же строка class остаётся `"media-overlay-viewport"`, конфликта нет).

### `src/styles/custom.css` [C]

`.media-mini-bar`: `box-shadow` → `var(--shadow)`, `border-radius` →
`var(--radius-md)` (были литерал `rgba(0,0,0,.25)` и `--radius` — довесок
Этапа D писал "на скорую руку", этап 6 — плановая полировка теми же
токенами, что остальной хром). `@keyframes media-mini-bar-in` —
`translateY(10px) scale(.96)+opacity:0 → identity+opacity:1`, 0.3с
`var(--ease)`, играет через `animation` при каждом монтировании
(mount = переход `display!=="mini"` → `"mini"`, JSX не пересоздаёт сам
корневой `<div>`, но `animation` со свойством, не участвующим в
обычном рендер-цикле, переигрывает по CSS-правилам при смене
class-строки корня — здесь строка `class` меняется с `"media-overlay"`
на `"media-mini-bar row"` при каждом входе в mini, это и есть триггер).
`.media-mini-bar .media-overlay-btn` — контекстный оверрайд размера
(1.75rem/1rem вместо базовых 2.5rem/1.785rem, те рассчитаны на
полноэкранный хром — в мини-баре тесно), не отдельный класс: та же
кнопка, тот же `.icon`-ресет уже работает по наследуемому селектору
`.media-overlay-btn .icon`. `.media-mini-bar-preview` — 2.5rem→2.25rem.
`.media-mini-bar-preview.is-audio` — `background:var(--accent);
color:var(--accent-contrast)` (та же пара токенов, что кнопки-акценты
проекта).

### Проверено Chrome-автоматизацией

Аудио-файл (синтетический WAV) → открыт → свёрнут (клик по кнопкам
через JS, координатные клики в этой сессии дважды промахивались из-за
изменённого resize_window'ом viewport'а разных вкладок — не баг кода,
инструментальная особенность сессии). Подтверждено: `.media-mini-bar-
preview` получает класс `is-audio`, три кнопки на месте, разворот/
сворачивание работают в обе стороны. Отображение времени (`.media-
mini-bar-time`) НЕ подтверждено живьём — тестовый WAV не догрузил
`duration` (readyState завис на `HAVE_NOTHING`, `networkState:
LOADING`, без ошибки) ни в мини-баре, ни в полном виде тем же файлом
— то есть проблема в конкретном синтетическом файле/SW Range-мосте с
WAV, не в довеске этапа 6 (тот лишь читает уже существующий
`meta.duration`, тем же путём, что info-панель полного вида, которая
проверена ранее). Код-ревью механизма пройден, живой прогон с реально
воспроизводимым файлом (или на устройстве пользователя) остаётся
открытым пунктом.

## MEDIA-OVERLAY-UI-2.md — Этап 7 (автомат жеста)

Формализация — DESIGN.md "MEDIA-OVERLAY-UI-2.md, этап 7". Порядок
сессий из самой spec обязателен ("этап 7 — отдельная сессия целиком") —
этап сделан первым и целиком, без довесков этапов 8-11 в этом же заходе.

### 7.0 — два точечных фикса

Уже были применены довеском к этапу 3 в этой же кодовой базе
(`g.widthPx` от `innerRef`, force-reflow вместо `requestAnimationFrame`)
— переприменение не потребовалось, только сверка, что оба на месте.

### `src/domain/media/gesture-machine.js` [C, новый файл]

Автомат Мура (δ+λ), чистый, без DOM — тот же класс модуля, что
`media-machine.js`. Математика самого жеста (пороги/resistance) НЕ
дублируется — `gestureTransition` вызывает `resolveAxis`/
`horizontalCommit`/`verticalCommit`/`verticalPull` из уже существующего
`swipe-gesture.js` (тот не тронут, spec §7.4 это прямо запрещает).
Edge-clamp на краю плейлиста (было в `handleGesturePointerUp` довеском
к этапу 3) переехал ВНУТРЬ δ (`resolveHorizontalDir`) — теперь часть
таблицы переходов, не разбросанный по view-слою код.

Состояние `{name, axis, dx, dy, dir, gen}` — детали payload по событиям
и точная семантика `gen`/λ не были буквально в тексте spec, решения и
обоснование — в DESIGN.md. Коротко: `move` несёт УЖЕ посчитанные
относительные `{dx,dy}` (стартовую точку держит DOM-слой, не автомат);
`up` в DRAG_H несёт `{widthPx,rank,total}` для edge-clamp, в остальных
состояниях эти поля не читаются; `settleEnd` несёт `{gen}`, сверяется
СТРОГО внутри SETTLING (в остальных состояниях — игнор безусловно,
сверка не нужна — сам факт "уже не в SETTLING" достаточен).

`gestureOutput` — семантический (не пиксельный) выход: для DRAG_H
`dragPx` — сырой `state.dx` (уже пиксели, часть состояния честно); для
SETTLING `dragPx` — знаковый юнит `-1/0/1` по `dir`, НЕ пиксели
(`widthPx` — DOM-геометрия, не часть кортежа состояния, домножает
вызывающая сторона). `pull` — `verticalPull(state.dy)`, переиспользован,
не задублирован.

Тесты — `tests/media-gesture-machine.test.js` (34, ДО реализации
модуля): все клетки таблицы §7.2 явно, включая три новые (SETTLING.down/
cancel/settleEnd), тотальность на всех 25 парах состояние×событие,
сквозной сценарий "опоздавшая доводка старого поколения не завершает
новую" (И-H буквально), λ для каждого состояния.

### `src/ui/components/media/media-overlay.jsx` [C, крупная правка]

Пять прежних писателей classList/style (`pointerdown`, `settleTrack`,
`finish`, `rAF` внутри `finish`, `endGesture`) удалены целиком, заменены
на:
- `gestureStateRef` (ref, не state — синхронная запись несколько раз за
  один pointer-эвент) — состояние автомата;
- `pointerTrackRef`/`widthPxRef` — DOM-специфичная часть (pointerId,
  стартовая точка, измеренная ширина), сознательно вне чистого
  автомата;
- `dispatchGesture(event, payload)` — единственный диспетчер (аналог
  `dispatch()` в `signals/media.js`): вызывает чистый `gestureTransition`,
  на границе выхода из SETTLING применяет `mediaNext`/`mediaPrev`/
  `playSwapFade` (по `prev.dir`, СТРОГО на этой одной границе — не три
  разных кодовых пути, как раньше), на границе `DRAG_V.up→IDLE` с
  `verticalCommit(prev.dy)` — `closeMedia()`; НЕ трогает DOM сам;
- `applyGestureOutput(state, {instant})` — ЕДИНСТВЕННАЯ функция,
  пишущая `classList`/`style` для `is-dragging`/`is-settling`/
  `--drag-px`/`--media-pull` (И-G буквально: `grep -n classList` даёт
  ОДНУ функцию для этой четвёрки — `is-swapping` в `playSwapFade`
  отдельный, cls-специфичный механизм fade для audio/video, вне
  периметра И-G, тот про track/pull конкретно). `instant=true` (выход
  из SETTLING) — тот же force-reflow приём, что раньше был в `finish()`,
  теперь единственное место, где он нужен;
- `armSettleWatchers(gen)` — заводит `transitionend`+`timeout`-наблюдателей
  ОДНОЙ доводки; для `cls!=="image"` (нет track-элемента, И-B) доводка
  завершается СИНХРОННО в тот же тик (`dispatchGesture("settleEnd",...)`
  вызывается рекурсивно ИЗНУТРИ) — потребовало перенести вызов
  `armSettleWatchers` в dispatchGesture на шаг ПОСЛЕ `applyGestureOutput`,
  иначе рекурсивный вызов применил бы λ(IDLE) раньше родительского
  λ(SETTLING), и финальный DOM откатился бы на кадр назад (найдено при
  проектировании, не живой проверкой — см. DESIGN.md).

**Живая проверка Chrome-автоматизацией** (11 картинок + 2 аудио,
файлы): одиночный свайп next/prev; ДВОЙНОЙ БЫСТРЫЙ свайп подряд без
паузы — ровно +2 позиции, не потеряно и не проскочено (SETTLING.down
работает); свайп на краю плейлиста — пружинит точно на 0px, без
пустого кадра; тап по кнопке в шапке во время покоя — срабатывает;
вертикальный свайп — закрывает; audio-свайп (2 файла) — мгновенный
переход БЕЗ задержки (синхронный `settleEnd`, не 500мс-фолбэк).
Консоль чистая на всём протяжении. `grep -n classList` подтверждён
(11 вхождений, все в предусмотренных функциях).

Регрессия 1950/1950 (34 новых теста для автомата + 2 для mediaGoTo с
этапа 4), build стабильна.

## MEDIA-OVERLAY-UI-2.md — Этапы 8-9 (мини-бар, каскад)

### Архитектура (И-K) — решение через AskUserQuestion

Три варианта обсуждались для показа И full, И mini одновременно в DOM
без пересоздания единственного `<video>`/`<audio>` (И-A): дублировать
DOM-узел медиа, портал/телепорт, или дать РЕАЛЬНОМУ viewport'у самому
визуально сжаться FLIP'ом. Пользователь выбрал третий (рекомендованный)
вариант явно. Итог:
- `.media-overlay` — рендерит ПОЛНУЮ full-структуру ВСЕГДА, пока жива
  сессия; `data-display` переключает видимость (opacity/pointer-events
  через CSS), не монтирование;
- `.media-mini-bar-shell` — ОТДЕЛЬНЫЙ, тоже всегда смонтированный
  элемент; имя/кнопки/прогресс/время — БЕЗ видео/аудио внутри;
- реальный `.media-overlay-viewport` (несёт `<video>`/`<audio>`, video-
  only — у audio нет визуального кадра) в mini-режиме получает inline
  `position:fixed`+геометрию, ТОЧНО совпадающую с
  `.media-mini-bar-preview-slot` (`applyMiniViewportGeometry`,
  единственный писатель этой геометрии — И-G-стиль дисциплина);
- декоративные рамки каскада (`.media-fold-ghost`, три штуки) — ЧИСТО
  визуальный слой, НЕ несут содержимое, поверх настоящего кадра.

### `src/ui/components/media/media-overlay.jsx` [C, крупная правка]

Новые функции: `measureRect`/`measureNaturalViewportRect` (синхронный
FLIP-замер, снимает/возвращает inline-style без промежуточного paint),
`applyMiniViewportGeometry`/`clearMiniViewportGeometry` (video-only,
единственный писатель геометрии viewport'а в mini), `cancelFold` (§9.3
— отмена на "свернуть и сразу развернуть" и на unmount), `playFold`
(три декоративные рамки, WAAPI, реверс меняет очерёдность+
длительность+кривую — асимметрия §9.2), `playViewportFlip` (тот же
Invert-Play приём, что открытие/закрытие §3.3, но для самого viewport'а
между full-геометрией и mini-слотом), `handleMinimize`/`handleRestore`
(замер FROM-rect ДО вызова `mediaMinimize`/`mediaRestore`, т.к. И-I
меняет `session.display` мгновенно — TO-rect меряется уже в эффекте
ПОСЛЕ коммита), `handleProgressSeek` (пишет `el.currentTime` напрямую,
И-D — перемотка не через автомат).

Три найденных живой проверкой бага (см. PLAN.md/log.md "этапы 8-9" за
полным разбором первопричины):
1. `playFold`/`playViewportFlip` — `Animation.finished` иногда не
   резолвится (троттлинг фоновой/автоматизированной вкладки, playState
   уже "finished", промис — нет) → декоративные рамки зависали в DOM.
   Фикс: `setTimeout`-фолбэк с `done`-флагом (тот же приём, что
   `armSettleWatchers`/`playSwapFade`).
2. **`handleClose()` (этап 3.3, СТАРЫЙ код) имел ТОТ ЖЕ порок** — только
   `.finished.then(() => closeMedia())`, без фолбэка. Не декоративная
   мелочь: без вызова оверлей завис бы открытым НАВСЕГДА по клику
   "Закрыть"/фон/Escape. Тот же фолбэк добавлен. **Правило на будущее:
   любой единственный WAAPI `.finished.then(...)`, от которого зависит
   реальный переход состояния (не только чистка декора), обязан иметь
   `setTimeout`-фолбэк — в этом окружении/классе браузеров `.finished`
   ненадёжен.**
3. `.media-mini-bar-name-stem { min-width: 0 }` (безусловно, унаследовано
   из mockup'а 1-в-1) отменяет content-based авто-минимум flexbox под
   `overflow:visible` (`.is-marquee`) — JS-замер (`inner.scrollWidth -
   box.clientWidth`) ВСЕГДА видел 0, бегущая строка не включалась ни при
   какой длине имени. Фикс: `.is-marquee .name-stem { min-width: auto }`
   (спека flexbox: `min-width:auto` + `overflow:visible` ⇒ не сжимать
   ниже содержимого), reduced-motion override возвращает `min-width: 0`
   обратно (иначе имя торчит без анимации и без "…").

### `src/styles/custom.css` [C, крупная правка]

Полностью переверстан блок мини-бара по `mini-bar-mockup.html` (токены
1-в-1 совпали с проектными). Новые правила: `.media-mini-bar-shell` +
`[data-display="full"]` (opacity:0, И-K), `.media-mini-bar-head/-rank/
-row/-progress/-preview-slot(+is-audio, +[data-cls=video])/-eq(+keyframes)/
-name(-inner/-stem/-ext)+marquee(keyframes,is-marquee,reduced-motion)/
-time/-controls/-aux/-btn(+модификаторы)/-grab`, `.media-fold-layer`
(`pointer-events:none` — не перехватывает клики, подтверждено
статически) + `.media-fold-ghost`, `.media-overlay[data-display="mini"]`
(хром full гаснет через opacity, не display:none — И-K; сам viewport
остаётся кликабельным, разворот по тапу).

### Живая проверка Chrome-автоматизацией

FLIP-геометрия: после minimize `viewportRect` ТОЧНО совпал с
`previewSlotRect`. Ghost-cleanup: rapid minimize→restore — 0 рамок
после фикса (было: зависали на restore-направлении). `handleClose()`:
подтверждено — оверлей закрывается по клику "Закрыть" (было бы
неотличимо от рабочего без специальной диагностики — баг проявлялся
только под тем же троттлингом, что и рамки). Marquee-фикс проверен
ВРУЧНУЮ (репликация того же алгоритма — `min-width:0`→`auto` даёт
overflow=300px на 82-символьном имени вместо 0); живой прогон ЧЕРЕЗ
компонент не подтверждён в ЭТОЙ сессии — `document.hidden===true`
(вкладка фоновая для рендерера), `requestAnimationFrame` там не
срабатывает вовсе. Ограничение окружения, не кода — с активным табом
`rAF` штатно планируется на следующий кадр.

Регрессия 1950/1950, build стабильна.

## MEDIA-OVERLAY-UI-2.md — Этап 10 (повтор и автовоспроизведение)

### `src/domain/media/playlist.js` [C, новый экспорт]

```js
export function lastOfClass(pl, cls): number  // симметрично firstOfClass, -1 если класса нет
export function stepInClassRing(pl, position, delta): number
```

`stepInClassRing` — обёртка над `stepInClass` (тот НЕ меняется — spec
запрещает, он единственный источник честного "конца списка" для
`doEnded`): при -1 заворачивает на `firstOfClass`/`lastOfClass` того же
класса. Единственный элемент класса заворачивает сам на себя; класс
"other" (cls-индекс 3) — как и `stepInClass`, всегда -1, без исключений
(`firstOfClass`/`lastOfClass` уже защищены от `pl.idx["other"] ===
undefined`).

### `src/domain/media/media-machine.js` [C, крупная правка]

`EVENTS` дополнен `"setRepeat"`/`"setAutoplay"`. `doOpen` читает
`payload.repeat ?? "off"`/`payload.autoplay ?? true`, `play` теперь
`callActive ? "suspended" : autoplay ? "playing" : "paused"` (раньше
всегда `"playing"` при отсутствии звонка — behavior-breaking изменение,
но обратная совместимость обеспечена дефолтом `autoplay ?? true`, все
старые вызовы `doOpen` без `payload.autoplay` продолжают открываться
`"playing"`). `doSetRepeat`/`doSetAutoplay` — прямые сеттеры полей с
валидацией (`doSetRepeat` отклоняет значения вне `{off,all,one}`,
`doSetAutoplay` приводит к строгому `=== true`). `doEnded` — таблица
§10.2 буквально: `repeat==="one"` не двигает position; иначе обычный
`stepInClass`; на конце класса при `repeat==="all"` — `firstOfClass`;
иначе — пауза на месте (как было). `doNext`/`doPrev` выбирают
`stepInClassRing` вместо `stepInClass` при `state.repeat === "all"`.

### `src/ui/signals/media.js` [C, новый слой]

`mediaPrefs` — модульная переменная (НЕ сигнал — репид/autoplay не
часть UI-реактивности вне сессии, читаются только в момент диспетчинга
"open"), инициализируется из `localStorage["ugolok.media.prefs"]` через
`loadMediaPrefs()` (try/catch — недоступность `localStorage` в
node --test/приватном режиме тихо даёт дефолты `{repeat:"off",
autoplay:true}`, НЕ бросает). `saveMediaPrefs` симметрично тихая на
запись (квота/приватный режим). `openMedia`/`mediaGoTo` ОБА кладут
`mediaPrefs.repeat/autoplay` в payload события "open" — специально
одинаково: `mediaGoTo` **не** наследует режим от текущего
`mediaSession.value`, потому что "open" в δ — это сброс состояния, не
слияние (см. этап A), и без явной передачи через `mediaPrefs` прыжок
по миниатюре плёнки молча обнулил бы режим повтора пользователя.
`setRepeat(mode)`/`setAutoplay(value)` — пишут И в `mediaPrefs`+
storage, И диспетчат `"setRepeat"`/`"setAutoplay"` в текущую сессию.

### `src/ui/components/media/media-overlay.jsx` [C, правка]

`handleEnded()` — заменяет прямой `onEnded={mediaEnded}` у `<View>`
(§10.4): читает `mediaSession.peek()?.repeat === "one"` ДО вызова
`mediaEnded()` (после — состояние уже новое, δ его не меняет для
"one", но порядок чтения обязателен по духу spec), затем при
`repeat==="one"` сбрасывает `mediaElRef.current.currentTime = 0` и
вызывает `.play()` — `.catch(() => mediaToggle())` синхронизирует
сессию с реальным отказом браузера (та же дисциплина, что в
video-player.jsx/audio-player.jsx для обычного play()). `canGoPrev`/
`canGoNext` в мини-баре — `session.repeat === "all" || rank > 0|<total-1`
(full-режимные стрелки `.media-overlay-nav` и так никогда не были
disabled — они no-op на границе при `doNext`/`doPrev`, ring просто
делает их не-no-op). Кнопка повтора (`.media-mini-bar-btn.is-repeat`,
в `.media-mini-bar-aux`, НЕ рендерится при `cls==="image"` — §10.5) —
`handleRepeatCycle` циклит `off→all→one→off` через `setRepeat`; badge
"1" виден только при `repeat==="one"` (`hidden` атрибут).

### `src/ui/icons/repeat.jsx` [новый файл]

Контур 1-в-1 из `mini-bar-mockup.html` (`<path>`×2, stroke-based,
глобальное `.icon path{stroke-width:0.6}` применяется как обычно).

### i18n

4 новых ключа во всех 12 локалях (`media.player.repeatOff/repeatAll/
repeatOne/autoplay`) — `autoplay` зарезервирован под будущий UI-тумблер
настроек, этот этап такого тумблера не добавляет (spec его и не
описывает — только кнопку повтора, §10.5).

### Живая проверка Chrome-автоматизацией

2 синтетических mp3 через кнопку-фильтр "Аудио" на экране Файлов
(`openFolderMediaClass` — ОТДЕЛЬНАЯ функция от одиночного `openEntry`
на dblclick по строке файла, та строит playlist из ОДНОГО файла;
нужна для получения `total>1`). Кнопка повтора циклит корректно, badge
только на "one", aria-label меняется по `t("media.player.repeat*")`.
`repeat="all"`: обе кнопки-стрелки не заблокированы НИ на первом, НИ на
последнем треке; реальный клик "next" с последнего трека заворачивает
на первый. Синтетическое DOM-событие `ended` на `<audio>`: `repeat=
"one"` — position не сдвинулся, `currentTime` сброшен в 0, `play`
остался `"playing"`; `repeat="all"` на последнем треке — `ended`
перевёл на первый (через `doEnded`, независимая от `doNext` кодовая
дорожка — обе проверены отдельно). Persistence: `setRepeat("all")` в
одной сессии, `closeMedia()`, `openMedia()` заново (даже под НОВЫМ
аккаунтом браузерной вкладки в одной и той же live-сессии) — новая
сессия открылась уже с `repeat==="all"` (mediaPrefs пережил close).

Побочно найден (не относится к этапу 10, строка существовала раньше):
файл с нераспознанным MIME (`classOf` → `"other"`) роняет
`MediaOverlay` при рендере — `session.playlist.idx[session.cls]` даёт
`undefined` для `"other"` (в `idx` только audio/video/image), `.length`
бросает. `openEntry`/`openFolderMediaClass` (files.jsx) не фильтруют
"other"-класс перед `openMedia` на этом пути (`openFolderMediaClass`
фильтрует, `openEntry` — нет). Зафиксировано в log.md/PLAN.md, не
исправлено — вне скоупа MEDIA-OVERLAY-UI-2.md.

Регрессия 1976/1976 (см. log.md про независимо флапающий
room-session.test.js), build стабильна.

## MEDIA-OVERLAY-UI-2.md — Этап 11 (полоса перемотки полноэкранного вида)

### `src/styles/custom.css` [C, новый блок]

`.media-overlay-scrub`/`.media-overlay-scrub-track`(+`>span`/`i`/
`i::after`/`:hover i::after`) — из mockup'а, АДАПТИРОВАН: убран
`position:absolute; inset-inline:0; bottom:0` корневого блока (там
стоял независимо от `.media-overlay`), вместо этого — обычный flex-ряд,
рассчитанный на то, что его РОДИТЕЛЬ (`.media-overlay-bottom`) уже сам
`position:absolute` и уже сам подчиняется `[data-chrome="off"]`.
Причина: в проекте (в отличие от урезанного mockup'а) уже есть
полноценный footer с плёнкой миниатюр и панелью сведений — второй
независимый `position:absolute; bottom:0` элемент визуально
конфликтовал бы с ним (оба претендуют на нижнюю кромку с собственным
градиентным фоном).

### `src/ui/components/media/media-overlay.jsx` [C, правка]

Блок вставлен ПЕРВЫМ ребёнком `<footer class="media-overlay-bottom">`
(до плёнки/панели сведений), `{session.cls !== "image" && (...)}`.
Play/pause — тот же `mediaToggle`/`playing`, что и остальной хром
(обёрнут `withDragGuard`, как остальные кнопки full-режима). Времена/
прогресс — существующие `miniTime`/`miniDuration` (гоняются
`onTimeUpdate` независимо от display, см. этап 6/8 — НЕ заводилось
новое состояние). Клик по полосе — `onClick={handleProgressSeek}`
(функция из этапа 8, БЕЗ ИЗМЕНЕНИЙ — уже пишет `mediaElRef.current.
currentTime` с той же ratio-математикой и той же защитой на
`!Number.isFinite(duration)`).

### Живая проверка Chrome-автоматизацией

Рендерится для video (`data-cls="video"`), полностью ОТСУТСТВУЕТ в
DOM для image (`querySelector('.media-overlay-scrub')` → null).
Клик по полосе без валидной `duration` (синтетическое тестовое видео
не догружает `duration` в этом окружении, известное ограничение с
предыдущих этапов) — не бросает исключение, `handleProgressSeek`'s
guard отработал как задумано. Наследование chrome-fade подтверждено
через НАСТОЯЩИЙ `pointermove`-эвент (прямое дёрганье `data-chrome`
через JS Preact тут же откатывает обратно на следующем ре-рендере —
ожидаемо, не баг): `data-chrome="off"→"on"` даёт `.media-overlay-
bottom` (и вложенную полосу) `opacity:0→1`.

Регрессия 1976/1976, build стабильна.

## Медиа-подсистема — живой фидбек: 4 визуальных бага мини-бара

### `src/styles/custom.css` [C, точечные фиксы специфичности + слоя]

Глобальное правило (~строка 133) — ГРУППА `button:has(> .icon),
[type="button"]:has(> .icon)`. Реальная разметка везде даёт `<button
type="button">`, значит матчит ВТОРОЙ вариант группы — специфичность
(0,2,0) ([type="button"] считается как класс + :has(.icon) добавляет
ещё класс от своего аргумента), а не (0,1,1), как у первого варианта.
`.media-mini-bar-btn`/`.media-overlay-btn`/`.media-overlay-nav`
переведены на составной селектор `button[type="button"].класс`
(0,2,1) — тег+атрибут+класс, с явным запасом над обоими вариантами
группы. **Урок на будущее: при подсчёте специфичности
селектора-списка через запятую нужно смотреть НА ВСЕ варианты группы,
не только на первый — реальный элемент может матчить более
специфичный.**

`.media-overlay[data-display="mini"][data-cls="video"] { z-index:
191 }` — новое правило. `.media-overlay` и `.media-mini-bar-shell`
оба имели `z-index:190`; при равенстве в CSS побеждает порядок
появления в DOM, а `.media-mini-bar-shell` — ВТОРОЙ элемент JSX-
фрагмента (после `.media-overlay`) — его непрозрачный
`.media-mini-bar-preview-slot` рисовался ПОВЕРХ `<video>`,
"долетевшего" туда через FLIP (у самого viewport'а геометрия и
opacity были верны — искажения не было, было чистое перекрытие
слоями). 191 — выше плашки (190), ниже `.call-overlay` (200, этап 48).
video-only (audio и так гаснет через opacity, ей z-index не нужен).

### `src/ui/components/media/media-overlay.jsx` [C, правка]

Блок ноты/эквалайзера в `.media-mini-bar-preview-slot.is-audio`
переведён с безусловного `<>{IconMusicNote}{eq}</>` на тернарник по
`playing`: эквалайзер — только пока играет (CSS-комментарий рядом уже
и тогда называл его "ЕДИНСТВЕННОЙ индикацией звук идёт" — JSX этого не
соблюдал, недосмотр этапа 8), статичная нота — на паузе.

### Живая проверка Chrome-автоматизацией

Числовой замер `offsetX`/`offsetY` (центр SVG минус центр кнопки) по
ВСЕМ кнопкам `.media-mini-bar-btn`/`.media-overlay-btn` ДО фикса
(offsetX до 24px при zoom×3, `computed display: flex`, `padding: 0px
16px`) и ПОСЛЕ (offsetX/Y=0 у всех, `display: grid`, `padding: 0px`).
Скриншот эквалайзера без ноты при реальном `play()`. Для видео —
подтверждение в три шага: (1) `elementFromPoint` в центре видимой
области подтвердил, что верхний элемент — сам `<video>` (z-index-фикс
сработал); (2) `canvas.drawImage(video)` + `getImageData` дал чистый
синий пиксель `[0,0,255,255]` (контент декодируется верно); (3) со
скриншотом ДОЛГО не совпадало — программный `currentTime`-seek без
реального `play()` не всегда триггерит перерисовку кадра в
композиторе CDP-скриншота (известное ограничение автоматизации, не
баг кода) — после настоящего `play()`+`pause()` синий кадр стал
видимым и на скриншоте тоже.

Регрессия 1976/1976 (не считая независимо флапающего теста в
room-session.test.js), build стабильна.

## Медиа-подсистема — живой фидбек №2: цвета кнопок + баг repeat="one"

### `src/styles/custom.css` [C, точечные правки]

`.media-mini-bar-btn` — базовый `color` заменён с `var(--fg)` на
`var(--accent-contrast)`, `:hover` получил явный `color: var(--fg)`
(раньше цвет был статичен, менялся только фон). `.is-repeat[data-mode=
"all"/"one"]` — вместо `color: var(--accent)` (текст на прозрачном
фоне кнопки) теперь `background: var(--accent); color: var(--accent-
contrast);` + `:hover`-вариант — та же схема, что уже была у `.is-play`
(единственной на тот момент заливной кнопки). `.media-mini-bar-repeat-
badge` получил явный `color: var(--fg)` — иначе унаследовал бы новый
светлый цвет родительской кнопки и стал бы нечитаем на своём
собственном `var(--surface-raised)` фоне.

### `src/ui/components/media/{video-player,audio-player}.jsx` [C, критичный фикс]

**Баг**: `repeat="one"` на практике не перезапускал трек чисто —
живой фидбек описал это как "иконка play/pause хаотично меняется,
звук дёргается, воспроизведение обрывается и не начинается сначала".

**Причина**: HTML Living Standard, "reaches the end of the media
resource" — при естественном завершении воспроизведения браузер
СНАЧАЛА устанавливает `paused = true` и шлёт событие `pause`, и
ТОЛЬКО ПОТОМ шлёт `ended`. Существовавший `onPause={() => { if
(playing) onToggle(); }}` не различал эту "естественную" паузу
(часть алгоритма окончания) от РУЧНОЙ паузы пользователя — на каждом
конце трека ошибочно вызывал `onToggle()`, переключая `session.play`
на `"paused"` ДО того, как `handleEnded` (media-overlay.jsx, §10.4)
успевал прочитать `repeat==="one"` и перезапустить трек — гонка двух
независимых источников play/pause-состояния на одном DOM-элементе.
Для `repeat==="off"/"all"` эффект был почти незаметен (лишнее
переключение сразу перекрывалось следующим `doEnded`, который меняет
`play` в любом случае), но для `"one"` — где `play` и без того должен
остаться `"playing"` без изменений — повторялся НА КАЖДОМ цикле.

**Фикс**: `onPause={() => { if (playing && !el.ended) onToggle(); }}`
— `el.ended` уже `true` на момент естественного pause-события (это
предусловие самого алгоритма, специфицированное до шага "установить
paused"), отличает его от ручной паузы, где `ended` остаётся `false`.

### Живая проверка Chrome-автоматизацией

Реальный 30-секундный mp3, `repeat="one"`. Слежка за DOM-событиями
(`play`/`pause`/`ended`/`seeking`/`seeked`) через `addEventListener` +
`MutationObserver` на `aria-label` кнопки play/pause (косвенный
индикатор `session.play`, т.к. `aria-label` меняется вместе с
`playing`). Три подряд прогона естественного окончания трека
(`currentTime = duration - 0.4`, дождаться) дали ИДЕНТИЧНУЮ, чистую
последовательность `pause→ended→seeking→play→seeked` — БЕЗ единого
изменения `aria-label` (значит `session.play` ни разу не дёрнулся на
"paused" в процессе, ни на одном из трёх циклов).

Регрессия 1976/1976, build стабильна.
