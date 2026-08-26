# ТЗ: редизайн стартового экрана (Unlock) + device-level endpoints

**Проект:** ugolok-03  
**Экран:** `src/ui/screens/unlock.jsx` (`step === "main"` и связанные шаги создания)  
**Статус:** к реализации  
**Референс UX/UI:** `UNLOCK-REDESIGN-reference.html` (лежит рядом с этим файлом; также `ugolok-start-redesign.html`)

---

## 0. Цель

Пересобрать **стартовую страницу** так, чтобы:

1. Человек за 2 секунды понимал главное действие: **Войти** или **Создать**.
2. Было видно, **к каким сервисам** клиент подключится (Relay / Blossom / TURN), с возможностью подставить свои URL **до логина**.
3. После вставки URL приложение **сразу** проверяло доступность и скорость.
4. Вёрстка максимально использовала **уже существующие** композиционные классы и CSS-токены проекта. Новые классы — только если существующие не покрывают поведение.
5. Все новые строки прошли через i18n (проект мультиязычный: 13 локалей).
6. Поведение покрыто **не меньше чем 10 автотестами** (`node --test`).

Это **интеграция в существующий проект**, не замена дизайн-системы и не «вклеить готовый HTML как есть».

---

## 1. Что нельзя ломать

- Потоки `step`: `loading` | `db-error` | `main` | `create-generate` | `create-confirm` | `import-mnemonic` | `import-key` | `advanced-password` | `done`.
- Логика `login` / `encryptAndStore` / `decryptPrivateKey` / `setRememberedAccountId` / применение темы до `navigate("/main")`.
- `Quick` («Быстрая связь») и `HelpContent` — фичи остаются, меняется только **место в иерархии** на стартовом экране.
- Редактор Relay/Blossom в **залогиненном** профиле (`settings.jsx` / `addRelayUrl` / `addBlossomUrl` и т.д., этап 58–60) — не ломать. Стартовый экран работает **до** аккаунта.
- Регламент раскладки: `PROCESS-DOCS/REGLAMENT.md` (`.screen` `.stack` `.row` `.bar` `.switch` `.box` и т.д.).
- Бюджет бандла и singlefile-сборку не раздувать (без новых зависимостей).

---

## 2. Референс — как читать HTML

Файл `UNLOCK-REDESIGN-reference.html` — **эталон поведения и иерархии**, не эталон CSS.

Из него взять:

- Иерархию: hero короткий → одна карточка «Войти | Создать» → блок «Подключение» (свёрнут) → «Быстрая связь» вторично → «Другие способы» в `<details>`.
- Прогрессивное раскрытие endpoints.
- Live-статус: idle / checking / ok / bad + latency.
- Wizard создания с обязательной фразой (основной путь «Создать» больше не должен быть «быстрой регистрацией без seed»).

Из него **не** переносить:

- Свои `--bg/#13181B`, `--accent/#FB4F14` и прочие цвета референса как новые глобальные токены.
- Свои `.card` / `.btn-primary` / `.modes`, если в проекте уже есть эквивалент (`.box`, голый `button` из `@layer elements`, `.btn`, `.btn--ghost`, `.auth-widget`, `.auth-layout`).
- Демо-бар сценариев внизу страницы — это только для прототипа.

Палитра референса (тепло, уют, безопасность) — **ориентир эмоции**. Реализуется существующими токенами (`--bg`, `--fg`, `--muted`, `--accent`, `--good`, `--bad`, `--warn`, `--surface`, `--surface-raised`, `--border`, `--good-surface`, `--bad-surface`, `--radius*`, `--space-*`, `--step-*`, `--font-mono`). Не вводить параллельную палитру на одном экране.

---

## 3. UX-контракт стартового экрана (`step === "main"`)

### 3.1. Состояния первого экрана

Два режима карточки (взаимоисключающие вкладки):

| Режим | Когда по умолчанию | Содержание |
|---|---|---|
| `login` | есть хотя бы один локальный аккаунт | список аккаунтов + пароль выбранного |
| `create` | аккаунтов нет | форма ника + пароля + подтверждения |

Переключение вкладок не сбрасывает введённые поля без нужды.

### 3.2. Hero

Короткий, человеческий, без имён протоколов.

- Заголовок: «Свой закрытый мессенджер» (ключ `unlock.main.hero.title`)
- Подзаголовок: «Тёплый угол для своих. Переписка и звонки — без чужих серверов.» (`unlock.main.hero.lead`)

Убрать с первого экрана упоминания Nostr / MLS / «без центрального сервера» в технической формулировке. Техника — в справке.

### 3.3. Навигация шапки

Текущие три пункта `Главная | Быстрая связь | Справка` как равный топ-nav — убрать.

- Логотип / имя приложения слева.
- Справка — вторичная текстовая ссылка/кнопка (не конкурирует с Войти/Создать).
- «Быстрая связь» — отдельная спокойная карточка **под** основной формой, после разделителя «или». При клике — как сейчас `mainView === "temp-chat"` (виджеты аккаунтов скрываются, остаётся Quick).

Кнопку шапки «Создать пространство» удалить: она дублирует вкладку «Создать».

### 3.4. Создание пространства (основной путь)

Сейчас `handleRegisterSubmit` генерирует мнемонику, кладёт в keystore и сразу идёт в `step === "done"` **без показа фразы**. Это меняется.

Основной путь «Создать»:

1. Ник + пароль + подтверждение (валидации как сейчас: логин не пустой, пароль ≥ 8, совпадение).
2. Показать фразу (`create-generate`) — **обязательно**.
3. Подтверждение фразы (`create-confirm`) — если этот шаг уже реализован, оставить; если нет в текущем UI-потоке main-формы — включить его в основной путь.
4. `done` → вход.

«Другие способы» (свёрнутый `<details>`):

- Создать с показом фразы — можно оставить как прямой вход в `openAdvanced("create")`, если основной путь уже показывает фразу (тогда это тот же поток, не плодить третий).
- Войти по мнемонике → `import-mnemonic`
- Войти по ключу (nsec) → `import-key`

Пустой список аккаунтов: текст **не** должен говорить «справа» (на мобилке сайдбара справа нет). Например: «Пока нет локальных аккаунтов — создайте первый.»

### 3.5. Возвращающийся пользователь

- Список аккаунтов. Последний (`getRememberedAccountId`) визуально помечен («недавний») и выбран по умолчанию.
- Клик по аккаунту раскрывает/переключает форму пароля и **ставит фокус** в поле пароля.
- Ошибка неверного пароля — `role="alert"`, как сейчас.

### 3.6. Блок «Подключение» (новое)

Свёрнут по умолчанию (`<details>`).

**Сводка (видно всегда):**

- Заголовок: «Подключение»
- Бейдж общего статуса: «локальный остров» / «все сервисы в порядке» / «проверяем…» / «есть недоступные»
- Одна строка: `Relay · Blossom · TURN · {короткий host:port relay}`

**Внутри:**

Три независимых поля:

| Сервис | Смысл | Примеры URL |
|---|---|---|
| Relay | WebSocket, события | `ws://127.0.0.1:7777`, `wss://…` |
| Blossom | HTTP, файлы | `http://127.0.0.1:8080`, `https://…` |
| TURN/STUN | ICE, звонки | `turn:127.0.0.1:3478`, `turns:…`, допускается и `stun:…` |

Под каждым полем: статус + latency («отклик 12 мс») или текст ошибки.

Кнопка «Вернуть адреса по умолчанию» сбрасывает к build-time константам из `src/config.js`.

Простой пользователь блок не открывает — и это нормально. Технарь открывает и правит URL.

---

## 4. Поведение endpoints (новое устройство логики)

### 4.1. Источник правды до логина

До логина нет `ownerPubkey` / `dbKey` — **нельзя** писать в зашифрованную `uiSettings`.

Нужен device-level слой (новый модуль):

`src/domain/settings/bootstrap-endpoints.js`

Хранилище: `localStorage`, ключ `ugolok.bootstrapEndpoints.v1`.

Форма значения:

```js
{
  relayUrl: string,     // один URL для стартового коннекта
  blossomUrl: string,
  iceServers: Array<{ urls: string, username?: string, credential?: string }>
}
```

Чтение:

1. Если в localStorage валидная запись — она.
2. Иначе — build-time:
   - `BUILD_DEFAULT_RELAYS[0]`
   - `BUILD_DEFAULT_BLOSSOM_SERVERS[0]`
   - `BUILD_DEFAULT_ICE_SERVERS`

Запись — сразу при успешном parse URL (после blur/debounce), не ждать логина.

Сброс к дефолтам — удаляет запись или перезаписывает build-time значениями.

Модуль не импортирует UI, Preact, Dexie.

### 4.2. После логина

Не ломать мультирелейный список этапа 58.

Правило:

- Стартовый экран задаёт **bootstrap-коннект этого устройства** (куда стучаться, чтобы войти и подтянуть settings).
- После `login()` транспорт по-прежнему читает `loadUiSettings().relayUrls`. Если у аккаунта ещё нет локальных settings (`hasLocalUiSettings === false`), **инициализировать** `relayUrls` / `blossomUrls` / ICE из bootstrap-endpoints, затем `saveUiSettings` как сейчас делает первый проход.
- Если settings уже есть — не перетирать список relay аккаунта молча. Bootstrap остаётся device-override только для **самого первого** коннекта до загрузки settings.

Если в проекте ICE ещё не лежит в `uiSettings` — не выдумывать kind-событие. Device-level `iceServers` достаточно для стартового экрана и звонков с этого устройства. Зафиксировать это в комментарии модуля.

### 4.3. Валидация URL

Принимать и нормализовать:

- Relay: `ws://` или `wss://`. Обрезать пробелы. Пустая строка — ошибка, не записывать.
- Blossom: `http://` или `https://`, без хвостового `/` (или с — но канонизировать одинаково).
- TURN: `turn:` / `turns:` / `stun:` / `stuns:`. Username/credential для дефолтного localhost оставить как в dev (`ugolok` / `ugolok-dev`), для чужого URL — `urls` без кредлов, если пользователь их не ввёл.

Невалидный URL → статус `bad`, текст «не похоже на адрес …», health-check не запускать.

### 4.4. Health-check

Новый модуль без UI:

`src/core/transport/endpoint-health.js`

```js
export async function probeRelay(url, { timeoutMs = 2500 } = {}): Promise<{ ok: boolean, ms: number | null, error?: string }>
export async function probeBlossom(url, { timeoutMs = 2500 } = {}): Promise<{ ok: boolean, ms: number | null, error?: string }>
export async function probeIce(iceServers, { timeoutMs = 3000 } = {}): Promise<{ ok: boolean, ms: number | null, error?: string }>
```

Правила:

- **Relay:** открыть `WebSocket`, замерить время до `onopen`. На `onerror` / timeout — `{ ok: false }`. Сокет сразу закрыть. Не слать REQ/EVENT.
- **Blossom:** `fetch(url, { method: "GET", signal })` с abort по timeout. 2xx–4xx считать «сервер жив» (404 на корне у Blossom нормален). Сетевой отказ / abort — `ok: false`.
- **TURN/STUN:** создать `RTCPeerConnection({ iceServers })`, `createDataChannel`, `createOffer` + `setLocalDescription`, ждать первого ICE candidate **или** `iceGatheringState === "complete"`. Если за timeout нет ни одного candidate — `ok: false`. Затем `close()`. Не требовать успешного allocate на внешнем TURN (в браузере это ненадёжно без creds) — цель: «адрес парсится и ICE-движок не падает сразу».
- Модуль должен работать в Node-тестах через подмену глобалов (`WebSocket`, `fetch`, `RTCPeerConnection`) — не трогать jsdom/playwright обязательно.

UI:

- Debounce ввода 300–400 мс.
- Пока ждём — статус `checking` («проверка…»).
- Успех — «доступен» + «отклик N мс». Пороги только для цвета текста (токены `--good` / `--warn` / `--bad`): &lt;50 / &lt;150 / иначе.
- Ошибка — «не отвечает» + короткая подсказка («проверьте адрес и что сервис запущен»).
- Общий бейдж сводки: все ok / любой bad / любой checking / иначе idle.

Не блокировать «Войти» / «Создать», если health bad — пользователь может быть офлайн и всё равно открыть локальный аккаунт. Предупреждение достаточно.

---

## 5. Вёрстка: что использовать из проекта

### 5.1. Композиция (REGLAMENT.md) — обязательно

Оболочка стартового экрана: `.screen` (страница может расти и скроллиться).

Внутри:

- шапка: `.bar`
- основная колонка: `.stack` с `--gap: var(--space-m)` / `--space-l`
- вкладки Войти/Создать: `.bar` или существующие nav-кнопки
- список аккаунтов: `.stack`
- поля формы: существующие `.form-group` / `.stack` + `label` + `input` как в текущем `unlock.jsx`
- блок подключения: `.stack` + `.box` (уже есть у `.auth-widget`)

Не вводить `.flex` / `.container` / ad-hoc grid, если задачу закрывает `.stack` / `.bar` / `.switch`.

Текущий `.auth-layout` grid можно упростить: стартовый экран больше не «hero слева + сайдбар справа». Одна узкая колонка по центру (`--measure` уже есть в токенах) ближе к референсу и лучше на мобилке. Если `.auth-layout` остаётся — не разъезжаться на 3440px (уже решено через `--container` / `--app-max-width`).

На экране Quick (`mainView === "temp-chat"`) сохранить нынешнее поведение `.auth-layout:has(.quick-room)` / скрытие сайдбара.

### 5.2. Оформление — существующие токены и классы

Использовать:

- `--bg` `--fg` `--muted` `--accent` `--accent-contrast` `--border` `--surface` `--surface-raised`
- `--good` `--bad` `--warn` и их `--*-surface` / `--*-edge`
- `--space-3xs` … `--space-xl`
- `--radius` `--radius-sm` `--radius-lg`
- `--font-mono` для URL
- `.box` `--pad`
- `.btn` `.btn--ghost` `.btn-link` `.btn-block` (если есть) / `button` элементного слоя
- `.eyebrow` `.visually-hidden`
- `.auth-widget` / `.auth-widget-subtitle` можно переиспользовать для блока подключения и «других способов»

Новые классы — **только** для того, чего нет:

- статус-бейдж health (`ok|bad|checking`) — если нельзя честно собрать из `--good-surface` + `--good` на маленьком `span`. Имя: например `.endpoint-status`, `.endpoint-status--ok`. Класс оформления, без раскладки.
- моноширинный input URL — достаточно `style={{ fontFamily: "var(--font-mono)" }}` или один утилитарный класс, если его ещё нет.

Запрещено копировать из референса пачку `.card .mode-btn .svc .pill .demo-bar`.

Инлайновые `style={{ "--gap": "var(--space-m)" }}` в JSX — это принятый в проекте способ, сохранять.

### 5.3. A11y

- Вкладки Войти/Создать: `role="tablist"` / `tab` / `aria-selected`.
- Ошибки: `role="alert"`.
- Блок подключения: `aria-label`, у `<details>` понятный `summary`.
- Поля URL: `<label>` или `aria-label`.
- Фокус в пароль после выбора аккаунта.
- Не делать кликабельными `div`.

---

## 6. i18n

Файлы: `src/ui/i18n/locales/{ru,en,es,de,ja,fr,pt,it,nl,pl,tr,zh}.json`.

`t()` / `t(..., { appName, min, ms, host })` — как сейчас. Плейсхолдеры `{{name}}`.

### 6.1. Обновить существующие ключи

| Ключ | Было (смысл) | Стало |
|---|---|---|
| `unlock.main.hero.title` | длинный технический заголовок | «Свой закрытый мессенджер» |
| `unlock.main.hero.lead` | Nostr + MLS | «Тёплый угол для своих. Переписка и звонки — без чужих серверов.» |
| `unlock.main.accountsWidget.empty` | «создайте первый справа» | без указания стороны |
| `unlock.main.footer.tagline` | по желанию короче | «{{appName}} — приватный мессенджер.» можно оставить |
| `unlock.main.navHome` / `navTempChat` / `navAriaLabel` | топ-nav | если пункты исчезают — ключи либо удалить везде, либо переиспользовать для новой иерархии. Пустых ключей в коде быть не должно. |

### 6.2. Новые ключи (минимум)

Добавить во **все 13** локалей. Русский — исходник, остальные — полноценный перевод, не транслит.

```
unlock.main.modes.login
unlock.main.modes.create
unlock.main.recentBadge
unlock.main.orDivider
unlock.main.quickCard.title          // «Быстрая связь»
unlock.main.quickCard.subtitle       // «Комната без аккаунта · по ссылке или коду»
unlock.main.helpLink
unlock.main.connection.title
unlock.main.connection.summaryLocal
unlock.main.connection.summaryOk
unlock.main.connection.summaryChecking
unlock.main.connection.summaryBad
unlock.main.connection.intro
unlock.main.connection.relayLabel
unlock.main.connection.blossomLabel
unlock.main.connection.turnLabel
unlock.main.connection.relayPlaceholder
unlock.main.connection.blossomPlaceholder
unlock.main.connection.turnPlaceholder
unlock.main.connection.statusIdle
unlock.main.connection.statusChecking
unlock.main.connection.statusOk
unlock.main.connection.statusBad
unlock.main.connection.latency       // «отклик {{ms}} мс»
unlock.main.connection.hintBad
unlock.main.connection.hintIdle
unlock.main.connection.resetDefaults
unlock.main.connection.invalidRelay
unlock.main.connection.invalidBlossom
unlock.main.connection.invalidTurn
unlock.main.create.continue          // «Продолжить» к фразе
```

Не хардкодить русские/английские строки в JSX.

После правок: ни одного `console.warn('i18n: отсутствует перевод…')` на ru и en при проходе по всем новым ключам. Остальные локали — тоже заполнить в том же PR.

---

## 7. Файлы, которые ожидаются к изменению

**Скорее да:**

- `src/ui/screens/unlock.jsx` — главная сборка экрана
- `src/styles/custom.css` — точечные правила стартового экрана (не раздувать)
- `src/ui/i18n/locales/*.json` — все 13
- `src/domain/settings/bootstrap-endpoints.js` — **новый**
- `src/core/transport/endpoint-health.js` — **новый**
- `src/ui/signals/transport.js` — только точка чтения bootstrap relay до settings (минимально)
- `tests/bootstrap-endpoints.test.js` — **новый**
- `tests/endpoint-health.test.js` — **новый**
- при необходимости тонкий UI-тест логики unlock (без playwright, чистые функции), если вынесешь parse/validate из JSX

**Скорее нет:**

- `vite.config.js` (дефолты build-time — отдельная задача; здесь только *чтение* `BUILD_DEFAULT_*`)
- `src/config.js`
- крипто, MLS, Dexie schema
- `settings.jsx` редактор relay после логина — кроме случая, если нужно явно подписать «после логина источник — uiSettings»

Вынести из `unlock.jsx` куски подключения в `src/ui/components/connection-endpoints.jsx` (или рядом), если файл и так большой. Не раздувать god-component.

---

## 8. Тесты — минимум 10

Команда: `npm test` (это `node --test tests/*.test.js`).  
Стиль как в `tests/ui-settings.test.js`: `node:test` + `node:assert/strict`, без новых раннеров.

Обязательный набор (можно больше, меньше 10 — не сдавать):

1. `readBootstrapEndpoints`: нет localStorage → значения из `BUILD_DEFAULT_*` (мокнутые или реальные из config).
2. `writeBootstrapEndpoints` + повторный `read` → round-trip.
3. `resetBootstrapEndpoints` → снова build-time дефолты.
4. Запись отбрасывает пустой/мусорный relay URL, не портит предыдущее валидное значение.
5. Канонизация: пробелы по краям срезаются, хвостовой `/` у Blossom нормализуется предсказуемо.
6. `probeRelay`: мок `WebSocket`, `onopen` через 10мс → `{ ok: true, ms >= 0 }`.
7. `probeRelay`: timeout / `onerror` → `{ ok: false, ms: null }`.
8. `probeBlossom`: fetch 404 → `{ ok: true }` (сервер жив).
9. `probeBlossom`: fetch reject / abort → `{ ok: false }`.
10. `probeIce`: мок `RTCPeerConnection`, кандидат пришёл → `{ ok: true }`.
11. `probeIce`: timeout без кандидатов → `{ ok: false }`.
12. Валидаторы схем: `http://` не принимается как relay; `ws://` не принимается как blossom.

Пункты 1–5 и 6–12 можно разнести по двум файлам. Итого ≥ 10 `test(...)`.

Не ходить в реальную сеть в unit-тестах.

Если затронут `loadUiSettings` «первый раз после логина подставляет bootstrap» — отдельный тест в `tests/ui-settings.test.js` или рядом. Не ломать существующие тесты этого файла.

---

## 9. Критерии приёмки

- [ ] Стартовый экран: одна колонка, вкладки Войти/Создать, без дубля «Создать пространство» в шапке.
- [ ] Hero без Nostr/MLS.
- [ ] «Быстрая связь» вторична, Quick по-прежнему открывается.
- [ ] Основной путь создания показывает фразу восстановления до `done`.
- [ ] Блок «Подключение» свёрнут, показывает дефолтные URL из config/localStorage.
- [ ] Смена URL дебаунсится, статус и ms обновляются.
- [ ] «Вернуть по умолчанию» работает.
- [ ] Перезагрузка страницы сохраняет изменённые URL (localStorage).
- [ ] Войти/Создать не блокируются красным health.
- [ ] Новые строки только через `t(...)`, ключи есть во всех 13 локалях.
- [ ] Новые CSS-классы минимальны; раскладка через REGLAMENT.
- [ ] `npm test` зелёный, новых тестов ≥ 10, старые не красные.
- [ ] `npm run build` собирается.

---

## 10. Порядок работы

1. Модули `bootstrap-endpoints.js` + `endpoint-health.js` + тесты.
2. i18n-ключи во все локали.
3. Компонент блока подключения + встройка в `unlock.jsx`.
4. Перекомпоновка main-экрана (вкладки, hero, quick, details).
5. Основной путь создания → показ фразы.
6. Тонкая связка transport/settings при первом логине.
7. Прогон `npm test`, ручной проход ru-экрана: пустое устройство / есть аккаунт / плохой URL / сброс.

Не коммитить `dist/`. Не добавлять README ради README.

---

## 11. Приложение: карта эмоции (не технический долг)

Экран должен ощущаться как **свой тёплый угол**, не как админка self-host.

Делается иерархией и текстом, не новой палитрой:

- мало объектов, много воздуха (`--space-l` между блоками);
- акцент только на primary-кнопке входа/создания;
- статусы сервисов спокойные (бейджи `--good/--bad`), не «дашборд мониторинга»;
- ни одного протокола в hero.

Референс-HTML смотреть именно за этим ритмом.
