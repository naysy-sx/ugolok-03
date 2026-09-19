# ТЗ: обслуживание витрины и гигиена инфраструктуры «Уголок»

Версия ТЗ: 1.0  
Дата: 2026-09-02  
Адресат: агент в терминале (Grok / аналог)  
Репозиторий: https://github.com/naysy-sx/ugolok-03  
Машина: Apple Mac Mini M2  
Не пушить, пока в сессии нет явной просьбы. Origin не менять. DNS/VPS не трогать.

---

## 0. Зачем

Публичный `main` уже содержит каркас CI/CD и docs поставки. Это не ломать.

Сейчас репозиторий как open-source витрина сырой:

- нет `README.md` и нет `LICENSE` самого проекта;
- в корне торчат AI-кухня (`CLAUDE.md`, `worker.sh`, `.claude/`, `PROCESS-DOCS/` на 8.5 МБ) и спайки;
- `package.json`: имя `ugolok-2-project`, версия `1.0.0`, пустые description/author, лицензия `ISC` без файла;
- `scripts/ci-check.sh` прячет флак `tests/room-session.test.js` (И9) повтором **всей** сюиты;
- `npm test` не видит `tests/harness/*.test.js`;
- два compose (`deploy/` и `agent/compose/`) без одной фразы «что главное» на витрине.

Цель этапа: чужой человек открывает GitHub и понимает, что это, как запустить и куда не лезть. CI либо стабилен, либо честно падает на одном тесте, а не маскирует гонку.

Это обслуживание текущей базы, не новая фича клиента.

---

## 1. Факты репозитория (не выдумывать иное)

- Клиент: Preact + signals, Dexie, Vite + singlefile. Артефакт: `dist/index.html` + `dist/service-worker.js`.
- Тесты продукта: `npm test` → сейчас ровно `node --test tests/*.test.js` (184 файла).
- Под `tests/harness/` лежат ещё `*.test.js`: `fake-relay.test.js`, `ws-bridge.test.js`, `device.test.js`, `m1-repro.test.js`, `m3-repro.test.js`. В сюиту не входят. Часть — интеграция с timeout 30с.
- Есть `tests/cicd-scripts.test.js`: проверяет текст `ci-check.sh` и соседних скриптов. Меняешь скрипт — поправь этот тест.
- CI: `.github/workflows/ci.yml` + `release.yml`, копии в `.forgejo/workflows/`. Node **22**, `permissions` уже стоят. Источник истины: `scripts/ci-check.sh`.
- В `ci-check.sh` сейчас: `npm ci --ignore-scripts`, повтор всего `npm test` при падении, build, лимит gzip `1304 KB` = 1335296 байт. Комментарий указывает на флак И9 (два `createRoom({openMode:true})`, оба «проигрывают»).
- Подпись релиза: `scripts/release-hash.sh` / `release-pack.sh`. GitHub Release идёт с `SKIP_GPG=1`.
- Документы поставки уже есть: `docs/delivery.md`, `environments.md`, `versioning.md`, `config.md`, `local-cicd.md`, `RUNBOOK.md`, `self-hosting.md`, `verify.md`. Не переписывать канон поставки.
- `server/strfry/whitelist.json` = `["*"]`. Это dev/LAN allow-all, уже описано в `docs/self-hosting.md` и комментарии `strfry.conf`. Не менять дефолт.
- `agent/` — Go-инсталлятор своего инстанса + `agent/compose/`. Это **продукт**, не кухня воркера.
- `deploy/compose.yml` — скелет будущего VPS, `web` живой, relay/blossom = `FIXME`.
- Коммиты в истории — короткие, на русском. Новые так же.
- Поля: `"engines": { "node": ">=22" }`, `"allowScripts": { "fsevents": false }`.
- Лимит бандла — текущий `CLAUDE.md` / ci-check: **1304 KB gzip**. Исторические 280 КБ не использовать.

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
- Генеральная зачистка комментариев по всему `src/`.
- Переписывание `PROCESS-DOCS/CONTRACTS.md`, `PLAN.md`, `log.md`.
- `git filter-repo` / force-push / переписывание истории. Старые коммиты с кухней остаются.
- Удаление или слияние `agent/` и `deploy/` в один compose.
- Сборка Docker-образов strfry/blossom на darwin/arm64.
- Смена лицензионной политики (не выбирать MIT/AGPL «на вкус»). Файл `LICENSE` = то, что уже заявлено в `package.json`: **ISC**.
- Добавление ESLint/Prettier на весь репозиторий.
- Удаление Playwright из devDependencies (бенчи его импортируют).
- Dependabot, CodeQL, защита веток на GitHub — только упомянуть в отчёте, не настраивать без доступа.
- Пуш.

Сомнение в правке `src/domain/rooms/**` сверх фикса И9 → не трогать домен, изолировать тест.

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
9. Секреты не коммитить. `package-lock.json` не выкидывать.
10. Не пушить.

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

Создать `LICENSE` с текстом ISC (как в `package.json`). `LICENSES.md` про Phosphor оставить.

Создать короткий `CONTRIBUTING.md`:

- зелёный `main`, PR для многокоммитных работ, solo-исключение мелких коммитов как в RUNBOOK;
- не коммитить `dist/`, `dist-updates/`, `*-db/`, `.env`;
- как прогнать проверки;
- не предлагать новые долгоживущие ветки `test`/`prod`.

`package.json`:

- `"name": "ugolok"`;
- `"description"` одна строка по сути README;
- `author` не выдумывать;
- `"version"` не бампать — канон версии git-тег, это уже в `docs/versioning.md`;
- `"license": "ISC"` оставить.

### 5.2. Убрать AI-кухню с витрины `main`

С рабочего дерева `main` убрать (git rm, содержимое не выкидывать в /dev/null без копии):

- `CLAUDE.md`
- `worker.sh`
- `.claude/`
- `PROCESS-DOCS/` целиком

Куда деть:

1. Создать (или обновить) ветку `process` **от текущего main до удаления**.
2. На `process` эти пути остаются.
3. Вернуться на `main`, удалить пути из дерева.
4. В `.gitignore` на `main` добавить эти пути, чтобы случайно не вернуть.
5. В `docs/RUNBOOK.md` один абзац: служебные заметки разработки живут в ветке `process` того же репозитория, это не вход для контрибьютора. Ветка публичная — не обещать секретность.

Не мержить `process` в `main`. Не делать orphan, если это ломает перенос файлов — обычная ветка проще.

После удаления починить битые ссылки **на main**: `rg PROCESS-DOCS|CLAUDE.md|worker.sh` по `docs/`, `README`, комментариям, которые правите. В `docs/self-hosting.md` убрать отсылку «CLAUDE.md: НЕ публичный интернет» — сказать то же своими словами. Ссылку «CONTRACTS.md/этап 34» в self-hosting заменить на нейтральное «настройка сохраняется на устройстве».

`PROCESS-DOCS/REGLAMENT.md` уходит вместе с каталогом. Не копировать его на main в этом этапе.

### 5.3. Корень

- `spike-prosemirror.html`, `spike-prosemirror.js` → `scripts/spikes/` (или удалить, если по коду видно, что спайк мёртв и ничто не импортирует). В README не рекламировать.
- `design-system.html` → `ASSETS-SOURCE/design-system.html`.
- Не трогать `index.html`, `service-worker.js`, `vite.config.js` ради красоты корня.

### 5.4. Флак И9 и `ci-check.sh`

Тест: `tests/room-session.test.js`, имя содержит «И9: два конкурирующих createRoom(openMode)». Симптом, уже записанный в скрипте: оба участника гонки «проигрывают», хотя контракт — ровно один.

Порядок:

1. Прочитать тест и ближайший код гонки (`getRaceOutcome`, сравнение id/suffix). Не рефакторить комнаты.
2. Попытаться сделать тест детерминированным: порядок pump/таймеров, дождаться публикации обоих указателей до сравнения, убрать лишнюю гонку с реальным временем. Минимальный патч.
3. Прогнать этот тест много раз локально (`node --test tests/room-session.test.js`) — хотя бы 10 повторов подряд.
4. Если за разумное время (без переписывания протокола) не стабилизируется: оставить тест, повесить retry **только на него** (`{ retry: N }` у `node:test`, N ≤ 3) и коротко написать в комментарии теста почему. Сюитный повтор в `ci-check.sh` всё равно снять.
5. `scripts/ci-check.sh`: один прогон `npm test`, без `if ! npm test`. Комментарий про флак убрать или заменить фактом («И9 стабилизирован так-то»).
6. Обновить `tests/cicd-scripts.test.js`, если он начнёт ждать старый повтор.

Не глотать падение сюиты. Не увеличивать rounds вслепую до сотен.

### 5.5. Harness-тесты

Изменить `package.json` `test` так, чтобы входили и корень `tests/`, и harness:

```text
node --test tests/*.test.js tests/harness/*.test.js
```

Если `m1-repro` / `m3-repro` / `device` оказываются ручными репро и краснят CI:

- переименовать из `*.test.js` в `*.repro.mjs` (или оставить в harness без суффикса `.test.js`);
- в `docs/local-cicd.md` одна строка, как прогнать вручную;
- `fake-relay.test.js` и `ws-bridge.test.js` оставить в сюите.

Не оставлять файлы `*.test.js`, которые сюита молча игнорирует.

Проверить `docs/RUNBOOK.md` / `docs/local-cicd.md`: команда теста совпадает с `package.json`.

### 5.6. Три пути инфраструктуры — только текст

В README и в начале `deploy/README.md` одинаковая таблица:

| Путь | Роль сейчас |
|---|---|
| `server/*/setup.sh` + `run.sh` | главный LAN-путь на Mini |
| `agent/compose/` | Docker-бандл своего инстанса (инсталлятор) |
| `deploy/compose.yml` | скелет будущего VPS, не замена двум верхним |

Не склеивать файлы. Не запускать compose в этом ТЗ как обязательный критерий.

### 5.7. Docs: GPG и whitelist

`docs/verify.md`: явно, что GitHub Release **сейчас** может быть без `SHA256SUMS.asc` (в Actions `SKIP_GPG=1`). Проверка подписи — когда `.asc` приложен. Не обещать, что каждый тег уже подписан.

`docs/self-hosting.md`: дефолт `whitelist.json = ["*"]` оставить; предупреждение «LAN, не интернет» уже есть внизу — поднять короткое предупреждение ближе к шагу про whitelist, не раздувать документ. Дефолтный файл не менять.

Убрать с `main` ссылки в пользовательских docs на процессные файлы воркера.

### 5.8. Комментарии

Только в файлах, которые и так меняете: убрать «этап N / задача M / воркер», оставить инвариант. Отдельного прохода по `src/` нет.

---

## 6. Порядок работ

1. Прочитать README-отсутствие, `package.json`, `.gitignore`, `scripts/ci-check.sh`, `tests/cicd-scripts.test.js`, `tests/room-session.test.js` (И9), `docs/delivery.md`, `docs/self-hosting.md`, `docs/verify.md`, `docs/local-cicd.md`.
2. Ветка `process` с копией кухни, затем очистка `main` + `.gitignore`.
3. README, LICENSE, CONTRIBUTING, правки `package.json`.
4. Перенос спайков и `design-system.html`.
5. Починить ссылки в docs после удаления PROCESS-DOCS.
6. И9 + снятие сюитного retry + правка cicd-теста.
7. Глоб `npm test` + решение по repro.
8. Таблица трёх путей, verify/self-hosting.
9. Прогнать `npm test` и `npm run build`. Если среда позволяет — `./scripts/ci-check.sh` без второго круга сюиты.
10. Коммиты.

Коммиты: 3–6 логических, сообщения на русском. Пример нарезки:

1. унести процессные файлы в `process`, вычистить `main`;
2. витрина README/LICENSE/CONTRIBUTING + package name;
3. корень (спайки, design-system) + docs-ссылки;
4. тест И9 + ci-check;
5. glob harness.

Не один коммит «всё сразу». Не пушить.

---

## 7. Приёмка

- [ ] На `main` в корне есть `README.md`, `LICENSE` (ISC), `CONTRIBUTING.md`.
- [ ] На `main` нет `CLAUDE.md`, `worker.sh`, `.claude/`, `PROCESS-DOCS/`.
- [ ] Есть ветка `process` с этими файлами (историю `main` не переписывали).
- [ ] `agent/`, `FEATURE-SPECS/`, `FILES-DOCS/`, CI-каркас на `main`.
- [ ] `package.json` `name` = `ugolok`, команда `test` покрывает то, что задумано в §5.5.
- [ ] `scripts/ci-check.sh` гоняет `npm test` один раз.
- [ ] И9 либо стабилен, либо retry только на этом тесте.
- [ ] Нет висящих `*.test.js` вне сюиты без решения в docs.
- [ ] README/deploy объясняют три пути инфраструктуры.
- [ ] `docs/verify.md` не утверждает, что каждый GitHub Release подписан GPG.
- [ ] `npm test` и `npm run build` прогнаны (если среда дала).
- [ ] В пользовательских docs на `main` нет входа в журнал воркера.

---

## 8. Отчёт агента

Вернуть человеку:

1. Список созданных/изменённых/удалённых с `main` файлов.
2. Что лежит в ветке `process`.
3. Что прогнано командами (включая сколько раз гоняли И9).
4. Стабилизирован И9 или только изолирован retry.
5. Какие harness-тесты вошли в сюиту, какие переименованы в repro.
6. Что сознательно не сделано.
7. Напоминание: ветка `process` в публичном репо всё ещё видна через `git fetch --all`; это витрина, не секрет.

Не предлагать новую архитектуру мессенджера.
