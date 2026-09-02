# ТЗ: обслуживание витрины и гигиена инфраструктуры «Уголок»

Версия ТЗ: 1.1 (правка по сверке с репозиторием `main` @ `fa4587e`)  
Дата: 2026-09-02  
Адресат: агент в терминале (Grok / аналог)  
Репозиторий: https://github.com/naysy-sx/ugolok-03  
Машина: Apple Mac Mini M2  
Не пушить, пока в сессии нет явной просьбы. Origin не менять. DNS/VPS не трогать.

Отличие от 1.0 — в конце файла (§9). Суть этапа та же: витрина и гигиена, не новая фича клиента.

---

## 0. Зачем

Публичный `main` уже содержит каркас CI/CD и docs поставки. Это не ломать.

Сейчас репозиторий как open-source витрина сырой:

- нет `README.md` и нет `LICENSE` самого проекта (есть только `LICENSES.md` про Phosphor);
- в корне торчат AI-кухня (`CLAUDE.md`, `worker.sh`, `.claude/`, `PROCESS-DOCS/` на 8.5 МБ) и спайки;
- `package.json` / `package-lock.json`: имя `ugolok-2-project`, версия `1.0.0`, пустые description/author, лицензия `ISC` без файла;
- в `docs/RUNBOOK.md` и `docs/verify.md` каталог клонирования всё ещё называется `ugolok-2-project`;
- `scripts/ci-check.sh` прячет флак `tests/room-session.test.js` (И9) повтором **всей** сюиты;
- `npm test` = `node --test tests/*.test.js` (184 файла); `tests/harness/*.test.js` (5 файлов) в сюиту не входят;
- три пути инфраструктуры уже намекаются в `deploy/README.md`, но таблица с «этапом 63», в корневом README её нет (корневого README нет вообще).

Цель этапа: чужой человек открывает GitHub и понимает, что это, как запустить и куда не лезть. CI либо стабилен, либо честно падает на одном тесте, а не маскирует гонку.

Это обслуживание текущей базы, не новая фича клиента. **Код домена (`src/domain/**`) не менять.**

---

## 1. Факты репозитория (не выдумывать иное)

Проверено по `origin/main` (`fa4587e`, единственная удалённая ветка; тегов нет).

- Клиент: Preact + signals, Dexie, Vite + singlefile. Артефакт: `dist/index.html` + `dist/service-worker.js`.
- Тесты продукта: `npm test` → `node --test tests/*.test.js` (ровно 184 файла в `tests/`, не рекурсивно).
- Под `tests/harness/` лежат ещё пять `*.test.js`:
  - `fake-relay.test.js` — юнит, без сети;
  - `ws-bridge.test.js` — реальный сокет, таймауты ~2 с;
  - `device.test.js` — интеграция, `{ timeout: 30000 }`;
  - `m1-repro.test.js`, `m3-repro.test.js` — репро, `{ timeout: 30000 }`.
  Рядом хелперы без суффикса `.test.js` (`device.js`, `fake-relay.js`, `ws-bridge.js`, `scenario.js`, шимы) — в сюиту не попадают ни при каком глобе.
- Есть `tests/cicd-scripts.test.js`: проверяет текст `ci-check.sh` и соседних скриптов. Сейчас **не** требует блока `if ! npm test`. Меняешь скрипт — прогони этот тест; править его только если он реально покраснеет.
- CI: `.github/workflows/ci.yml` + `release.yml`, копии в `.forgejo/workflows/`. **Проектный Node = 22** (`node-version: "22"`, `"engines": { "node": ">=22" }`). Сообщение коммита «экшены на Node 24» — про runtime самих `actions/checkout@v5` / `setup-node@v6`, не про версию приложения. Не поднимать проектный Node до 24.
- Источник истины CI: `scripts/ci-check.sh`. Сейчас: `npm ci --ignore-scripts`, повтор всего `npm test` при падении, build, лимит gzip `1304 KB` = 1335296 байт. Комментарий указывает на флак И9 (два `createRoom({openMode:true})`, оба «проигрывают»).
- Подпись релиза: `scripts/release-hash.sh` / `release-pack.sh`. GitHub Release **жёстко** идёт с `SKIP_GPG=1`; в список файлов релиза `.asc` не кладётся. `release-pack.sh` сам ставит `SKIP_GPG=1` при `CI=true`. Секрет `GPG_PRIVATE_KEY` в workflow **не подключён**, хотя `docs/local-cicd.md` его упоминает.
- Документы поставки уже есть: `docs/delivery.md`, `environments.md`, `versioning.md`, `config.md`, `local-cicd.md`, `RUNBOOK.md`, `self-hosting.md`, `verify.md`. Не переписывать канон поставки.
- `server/strfry/whitelist.json` = `["*"]`. Это dev/LAN allow-all, уже описано в `docs/self-hosting.md` и комментарии `strfry.conf`. Не менять дефолт.
- `agent/` — Go-инсталлятор своего инстанса + `agent/compose/`. Это **продукт**, не кухня воркера.
- `deploy/` на месте: `compose.yml`, `README.md`, Caddy/env examples. `web` живой, relay/blossom = `FIXME`. В `deploy/README.md` уже есть таблица трёх путей — её унифицировать, не дублировать.
- Коммиты в истории — короткие, на русском. Новые так же.
- Поля: `"engines": { "node": ">=22" }`, `"allowScripts": { "fsevents": false }`.
- Лимит бандла — текущий `ci-check`: **1304 KB gzip**. Исторические 280 КБ / формулировку «~190–250 KB» из `CLAUDE.md` не использовать.
- Удалённых веток кроме `main` нет. Ветку `process` создавать в этой сессии.
- `FEATURE-SPECS/` и `FILES-DOCS/` — продуктовые спеки, остаются на `main`. В `FEATURE-SPECS/DISCOVERY.md` есть вход в кухню (`PROCESS-DOCS/*`, «конвенция CLAUDE.md») — нейтрализовать ссылки, текст спеки не переписывать.

---

## 2. Цели

1. Витрина open-source: README, LICENSE, понятный корень.
2. AI-процессные файлы не лежат в рабочем дереве `main`.
3. CI не маскирует флак повтором всей сюиты.
4. Решение по harness-тестам зафиксировано в команде `npm test` и в docs.
5. Одна фраза про три пути инфраструктуры (LAN scripts / agent compose / deploy skeleton).
6. `npm test` и `npm run build` зелёные без сюитного retry.

---

## 3. Вне скоупа

- Покупка VPS, DNS, публичный TLS, смена origin на Forgejo.
- Capacitor / почта / загрузчик обновлений в UI.
- Переписывание мессенджера, комнат, крипто, UI-регламента.
- Любые правки `src/domain/**` (включая «минимальный патч» гонки И9 в `room-session.js`).
- Генеральная зачистка комментариев по всему `src/`.
- Переписывание `PROCESS-DOCS/CONTRACTS.md`, `PLAN.md`, `log.md`.
- `git filter-repo` / force-push / переписывание истории. Старые коммиты с кухней остаются.
- Удаление или слияние `agent/` и `deploy/` в один compose.
- Сборка Docker-образов strfry/blossom на darwin/arm64.
- Смена лицензионной политики (не выбирать MIT/AGPL «на вкус»). Файл `LICENSE` = то, что уже заявлено в `package.json`: **ISC**.
- Добавление ESLint/Prettier на весь репозиторий.
- Удаление Playwright из devDependencies (бенчи его импортируют).
- Dependabot, CodeQL, защита веток на GitHub — только упомянуть в отчёте, не настраивать без доступа.
- Настройка секрета `GPG_PRIVATE_KEY` в Actions.
- Пуш.

---

## 4. Инварианты

1. `npm test` и `npm run build` проходят без повторного запуска всей сюиты.
2. `npm run dev` концептуально не сломан (Vite-плагины на месте).
3. Каркас CI/CD и контракты `version.json` / `config.json` / `dist-updates/` не откатывать.
4. `scripts/release-hash.sh` ручной путь с GPG на Mini жив.
5. `server/*/setup.sh` и `run.sh` на месте.
6. `agent/` не удалять и не переносить в process-ветку.
7. `FEATURE-SPECS/` и `FILES-DOCS/` остаются на `main` (спеки продукта).
8. Новые пользовательские docs — по-русски.
9. Секреты не коммитить. `package-lock.json` не выкидывать (имя пакета в нём — обновить вместе с `package.json`).
10. Не пушить.
11. Проектный Node остаётся 22.

---

## 5. Что сделать

### 5.1. Витрина

Создать `README.md` в корне (русский, коротко):

- что такое «Уголок» (замкнутый Nostr-остров, LAN, не публичная сеть Nostr);
- требования: Node ≥ 22;
- быстрый старт: `npm ci` / `npm run dev` → `http://localhost:5173`;
- тесты и сборка: `npm test`, `npm run build`, `./scripts/ci-check.sh`;
- self-host LAN: `docs/self-hosting.md`;
- поставка/релизы: `docs/delivery.md`;
- проверка сборки: `docs/verify.md`;
- инсталлятор инстанса: каталог `agent/` (одна ссылка, без пересказа);
- чего в этом репозитории нет: публичный интернет из коробки, магазин приложений.

Без слов «воркер», «Ollama», «этап 53», без ссылок на `PROCESS-DOCS/` и `CLAUDE.md`.

Создать `LICENSE` с текстом ISC. Copyright не выдумывать ФИО: `Copyright (c) 2026 naysy-sx`. `LICENSES.md` про Phosphor оставить; убрать из него ссылку на `PROCESS-DOCS/REDESIGN/ICONS/...` (заменить на факт: иконки собираются `scripts/gen-icons.mjs` из `@phosphor-icons/core`).

Создать короткий `CONTRIBUTING.md`:

- зелёный `main`, PR для многокоммитных работ, solo-исключение мелких коммитов как в RUNBOOK;
- не коммитить `dist/`, `dist-updates/`, `*-db/`, `.env`;
- как прогнать проверки;
- не предлагать новые долгоживущие ветки `test`/`prod`.

`package.json`:

- `"name": "ugolok"`;
- `"description"` одна строка по сути README;
- `author` не выдумывать (оставить пустым);
- `"version"` не бампать — канон версии git-тег, это уже в `docs/versioning.md`;
- `"license": "ISC"` оставить;
- то же имя `"ugolok"` проставить в корневом пакете `package-lock.json` (два места: верх и `packages[""]`), лок не регенерировать с нуля.

Попутно заменить каталог-пример `ugolok-2-project` на `ugolok-03` в `docs/RUNBOOK.md` и `docs/verify.md` (это имя папки после `git clone` репозитория, не npm-имя).

### 5.2. Убрать AI-кухню с витрины `main`

С рабочего дерева `main` убрать (git rm; содержимое не выкидывать в /dev/null без копии):

- `CLAUDE.md`
- `worker.sh`
- `.claude/`
- `PROCESS-DOCS/` целиком

Куда деть:

1. Создать ветку `process` **от текущего main до удаления**.
2. На `process` эти пути остаются.
3. Вернуться на `main`, удалить пути из дерева.
4. В `.gitignore` на `main` добавить эти пути, чтобы случайно не вернуть как неотслеживаемые.
5. В `docs/RUNBOOK.md` один абзац: служебные заметки разработки живут в ветке `process` того же репозитория, это не вход для контрибьютора. Ветка публичная — не обещать секретность.

Не мержить `process` в `main`. Не делать orphan.  
`.gitignore` **не** защищает от merge `process` → `main`: при слиянии файлы вернутся, потому что они tracked на той ветке. Защита — дисциплина, не ignore.

После удаления починить битые ссылки **на пользовательской витрине `main`**. Обязательный список (не весь `src/`):

| Файл | Что сделать |
|---|---|
| `docs/self-hosting.md` | убрать «CLAUDE.md: НЕ публичный интернет» — сказать своими словами; «CONTRACTS.md/этап 34» → «настройка сохраняется на устройстве» |
| `docs/verify.md` | см. §5.7; плюс `cd ugolok-03` |
| `docs/RUNBOOK.md` | абзац про ветку `process`; `ugolok-03` вместо `ugolok-2-project` |
| `docs/local-cicd.md` | команда теста; не обещать секрет `GPG_PRIVATE_KEY` в Actions, его нет в workflow |
| `server/README.md` | убрать «см. CLAUDE.md» и отсылку к CONTRACTS.md/log.md этапа 16; оставить суть (клиент = два файла, strfry и как prod, и как тест) |
| `LICENSES.md` | убрать путь в PROCESS-DOCS |
| `FEATURE-SPECS/DISCOVERY.md` | убрать инструкцию «положить в PROCESS-DOCS/…», «конвенция CLAUDE.md», журнал log.md. Спеку не переписывать |
| `deploy/README.md` | унифицировать таблицу §5.6, вычистить «этап 63» |

`rg PROCESS-DOCS|CLAUDE.md|worker.sh` по `docs/`, `server/README.md`, `README.md`, `LICENSES.md`, `FEATURE-SPECS/`, `deploy/` — после правок должно быть пусто (или только историческое упоминание «ветка process»).

Комментарии в `src/**`, `tests/**`, `server/strfry/whitelist-plugin.mjs`, `server/blossom/config.yml` **не трогать** в этом этапе: после удаления каталога это мёртвые указатели внутри кода, не вход витрины.

`PROCESS-DOCS/REGLAMENT.md` уходит вместе с каталогом. Не копировать его на main.

### 5.3. Корень

- `spike-prosemirror.html`, `spike-prosemirror.js` → `scripts/` (рядом с уже лежащими `room-spike-*.mjs` / `p-spike-bench.mjs`). Отдельный каталог `scripts/spikes/` не обязателен. В README не рекламировать. Ничто из `src/` их не импортирует.
- `design-system.html` → `ASSETS-SOURCE/design-system.html`.
- Не трогать `index.html`, `service-worker.js`, `vite.config.js` ради красоты корня.

### 5.4. Флак И9 и `ci-check.sh`

Тест: `tests/room-session.test.js`, имя «И9: два конкурирующих createRoom(openMode)». Симптом, уже записанный в скрипте: оба участника гонки «проигрывают», хотя контракт — ровно один. Код сравнения — `getRaceOutcome()` в `src/domain/rooms/room-session.js`. **Этот файл не менять.**

Порядок:

1. Прочитать тест и `getRaceOutcome`. Не рефакторить комнаты.
2. Попытаться сделать **только тест** детерминированным: порядок `pump`/flush, дождаться публикации обоих указателей до сравнения, убрать лишнюю гонку с реальным временем. Минимальный патч теста.
3. Прогнать этот файл много раз (`node --test tests/room-session.test.js`) — не меньше 10 повторов подряд.
4. Если за разумное время не стабилизируется: оставить тест, повесить retry **только на него** (`{ retry: N }` у `node:test`, N ≤ 3) и короткий комментарий в тесте почему. Сюитный повтор в `ci-check.sh` всё равно снять.
5. `scripts/ci-check.sh`: один прогон `npm test`, без `if ! npm test`. Комментарий про флак убрать или заменить фактом («И9: retry только в тесте» / «И9 стабилизирован правкой теста»).
6. `tests/cicd-scripts.test.js` править, только если покраснеет.

Не глотать падение сюиты. Не увеличивать `rounds` вслепую до сотен. Не трогать `src/domain/rooms/**`.

### 5.5. Harness-тесты

Предпочтительная команда (рекурсивный набор Node test runner, без молчаливых `*.test.js`):

```text
node --test tests
```

Это подхватит `tests/*.test.js` и `tests/harness/*.test.js`, не подхватит хелперы `device.js` / `fake-relay.js` / `oklch-contrast.js`. Эквивалент двух глобов `tests/*.test.js tests/harness/*.test.js` допустим, если так привычнее; тогда в docs явно написать оба глоба.

Если `m1-repro` / `m3-repro` / `device` краснят CI или неустойчивы:

- переименовать из `*.test.js` в `*.repro.mjs` (или оставить в harness без суффикса `.test.js`);
- в `docs/local-cicd.md` одна строка, как прогнать вручную:
  `node --test tests/harness/m1-repro.mjs tests/harness/m3-repro.mjs tests/harness/device.test.js`
- `fake-relay.test.js` и `ws-bridge.test.js` оставить в сюите.

Не оставлять файлы `*.test.js`, которые сюита молча игнорирует.

В `docs/local-cicd.md` **добавить** строку, что `npm test` = команда из `package.json` (сейчас документ говорит только про `ci-check.sh`). В `docs/RUNBOOK.md` голую команду `npm test` тоже не обещать иначе, чем она есть.

### 5.6. Три пути инфраструктуры — только текст

В README и в начале `deploy/README.md` **одна и та же** таблица (в deploy таблица уже есть — заменить формулировки, не вставлять вторую):

| Путь | Роль сейчас |
|---|---|
| `server/*/setup.sh` + `run.sh` | главный LAN-путь на Mini |
| `agent/compose/` | Docker-бандл своего инстанса (инсталлятор) |
| `deploy/compose.yml` | скелет будущего VPS, не замена двум верхним |

Не склеивать файлы. Не запускать compose в этом ТЗ как обязательный критерий. Слова «этап 63» из пользовательских docs убрать.

### 5.7. Docs: GPG и whitelist

`docs/verify.md`:

- уже есть оговорка «если ключа нет, релиз может выйти без `.asc`» — оставить;
- явно добавить: текущий GitHub Release собирается с `SKIP_GPG=1`, файла `SHA256SUMS.asc` в релизе может не быть; проверка подписи — только когда `.asc` приложен. Не обещать, что каждый тег уже подписан.
- шаг «собрать самому»: `cd ugolok-03`, не `ugolok-2-project`.

`docs/local-cicd.md`: не утверждать, что в Actions есть секрет `GPG_PRIVATE_KEY`. Факт: workflow всегда вызывает pack с `SKIP_GPG=1`. Подпись — ручной путь на Mini (`scripts/release-hash.sh`).

`docs/self-hosting.md`: дефолт `whitelist.json = ["*"]` оставить; предупреждение «LAN, не интернет» уже есть внизу — поднять короткое предупреждение ближе к шагу про whitelist, не раздувать документ. Дефолтный файл не менять.

Убрать с `main` ссылки в пользовательских docs на процессные файлы воркера.

### 5.8. Комментарии

Только в файлах, которые и так меняете: убрать «этап N / задача M / воркер», оставить инвариант. Отдельного прохода по `src/` нет.

---

## 6. Порядок работ

1. Прочитать отсутствие README, `package.json`, `package-lock.json` (поле name), `.gitignore`, `scripts/ci-check.sh`, `tests/cicd-scripts.test.js`, `tests/room-session.test.js` (И9), `docs/delivery.md`, `docs/self-hosting.md`, `docs/verify.md`, `docs/local-cicd.md`, `docs/RUNBOOK.md`, `server/README.md`, `deploy/README.md`, `LICENSES.md`.
2. Ветка `process` с копией кухни, затем очистка `main` + `.gitignore`.
3. README, LICENSE, CONTRIBUTING, правки `package.json` + имя в lock, `ugolok-03` в docs.
4. Перенос спайков и `design-system.html`.
5. Починить ссылки витрины после удаления PROCESS-DOCS (список §5.2).
6. И9 (только тест) + снятие сюитного retry + cicd-тест если покраснел.
7. Команда `npm test` + решение по repro.
8. Таблица трёх путей, verify/self-hosting/local-cicd.
9. Прогнать `npm test` и `npm run build`. Если среда позволяет — `./scripts/ci-check.sh` без второго круга сюиты.
10. Коммиты.

Коммиты: 3–6 логических, сообщения на русском. Пример нарезки:

1. унести процессные файлы в `process`, вычистить `main`;
2. витрина README/LICENSE/CONTRIBUTING + package name;
3. корень (спайки, design-system) + docs-ссылки;
4. тест И9 + ci-check;
5. команда test / harness.

Не один коммит «всё сразу». Не пушить.

---

## 7. Приёмка

- [ ] На `main` в корне есть `README.md`, `LICENSE` (ISC), `CONTRIBUTING.md`.
- [ ] На `main` нет `CLAUDE.md`, `worker.sh`, `.claude/`, `PROCESS-DOCS/`.
- [ ] Есть ветка `process` с этими файлами (историю `main` не переписывали).
- [ ] `agent/`, `FEATURE-SPECS/`, `FILES-DOCS/`, CI-каркас на `main`.
- [ ] `package.json` `name` = `ugolok`, то же имя в `package-lock.json`, команда `test` покрывает то, что задумано в §5.5.
- [ ] `scripts/ci-check.sh` гоняет `npm test` один раз.
- [ ] И9 либо стабилен правкой теста, либо retry только на этом тесте. `src/domain/rooms/**` не изменён.
- [ ] Нет висящих `*.test.js` вне сюиты без решения в docs.
- [ ] README и `deploy/README.md` объясняют три пути одной таблицей.
- [ ] `docs/verify.md` не утверждает, что каждый GitHub Release подписан GPG.
- [ ] В `docs/`, `server/README.md`, `LICENSES.md`, `FEATURE-SPECS/`, корневом README нет входа в `PROCESS-DOCS/` / `CLAUDE.md` / `worker.sh`.
- [ ] `npm test` и `npm run build` прогнаны (если среда дала).
- [ ] Проектный Node в workflow и `engines` по-прежнему 22.

---

## 8. Отчёт агента

Вернуть человеку:

1. Список созданных/изменённых/удалённых с `main` файлов.
2. Что лежит в ветке `process`.
3. Что прогнано командами (включая сколько раз гоняли И9).
4. Стабилизирован И9 (правкой теста) или только изолирован retry.
5. Какие harness-тесты вошли в сюиту, какие переименованы в repro.
6. Что сознательно не сделано.
7. Напоминание: ветка `process` в публичном репо всё ещё видна через `git fetch --all`; это витрина, не секрет. `.gitignore` на `main` не спасёт от случайного merge.

Не предлагать новую архитектуру мессенджера.

---

## 9. Что было неточно в ТЗ 1.0

Факты, которые 1.0 угадал верно: нет README/LICENSE; кухня в корне; 184 теста верхнего уровня; лимит 1304 KB; whitelist `["*"]`; `agent/` — продукт; Node проекта 22; сюитный retry в `ci-check.sh`; ISC уже заявлен.

Исправления:

1. **`deploy/` существует** (`compose.yml`, README, примеры). На GitHub его легко не заметить в длинном корне, но удалять/заводить заново не нужно.
2. **Проектный Node ≠ runtime Actions.** Коммит `fa4587e` («экшены на Node 24») обновил версии *actions*, не `node-version`. В workflow по-прежнему `"22"`.
3. **`tests/cicd-scripts.test.js` не проверяет сюитный retry** — только наличие `npm test`. Править его заранее не обязательно.
4. **`package-lock.json` тоже называется `ugolok-2-project`.** Имя надо синхронизировать, лок не выкидывать. В RUNBOOK/verify каталог клона — `ugolok-03`.
5. **`deploy/README.md` уже содержит таблицу трёх путей** с «этапом 63». Унифицировать, не копировать вторую.
6. **`docs/local-cicd.md` и `docs/RUNBOOK.md` не содержат команды `npm test`.** Её нужно добавить, не «сверить».
7. **Пользовательские входы в кухню шире `docs/`:** `server/README.md`, `LICENSES.md`, `FEATURE-SPECS/DISCOVERY.md`. 1.0 их почти не назвал.
8. **`docs/verify.md` уже допускает релиз без `.asc`**, но не говорит, что GitHub Actions сейчас *всегда* делает `SKIP_GPG=1` и не прикладывает `.asc`. `local-cicd.md` ошибочно намекает на секрет `GPG_PRIVATE_KEY`.
9. **И9: не трогать домен.** В 1.0 допускался «минимальный патч» протокола; это уже код приложения. Только тест + retry + снятие сюитного повтора.
10. **Команда теста.** Надёжнее `node --test tests` (раннер сам берёт `*.test.js` рекурсивно), чем два шелл-глоба. Оба варианта ок на Mini/ubuntu.
11. **`.gitignore` не блокирует merge ветки `process`.** Это нужно написать в RUNBOOK и в отчёте.
12. **Спайки.** В `scripts/` уже лежат `room-spike-*.mjs`; отдельный `scripts/spikes/` не обязателен.
13. **LICENSE copyright.** В 1.0 не сказано, чьё имя писать. Не выдумывать author в package.json; в LICENSE — `naysy-sx`, как владелец GitHub.
