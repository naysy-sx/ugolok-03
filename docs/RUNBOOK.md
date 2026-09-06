# Уголок v2 — runbook разворачивания

_Актуально на 2026-09-05, описывает dev/main/prod и локальную разработку на Mini._

SSOT по поднятию проекта с нуля и по работе с git. Цель: пересборка за 5 минут, а не за час.
Положить в `docs/RUNBOOK.md`.

---

## 0. Быстрый путь (если репозиторий уже есть)

Это и есть «5 минут». Работает ровно потому, что `package-lock.json` закоммичен.

```bash
git clone <repo> ugolok-03
cd ugolok-03
npm ci          # строго по локу — воспроизводимо (NF-18), не npm install
npm run dev     # http://localhost:5173
```

`npm ci`, а не `npm install`: `ci` ставит ровно то, что в локе, не трогает `package.json`, не плывут версии.

Проверки: `npm test` (`node --test tests/*.test.js tests/harness/*.test.js`), `npm run build`, либо `./scripts/ci-check.sh`.

Служебные заметки разработки живут в ветке `process` того же репозитория — это не вход для контрибьютора. Ветка публичная, не обещать секретность. `.gitignore` на `main` не блокирует merge `process` → `main`: при слиянии файлы вернутся.

Если `npm ci` ругнётся на `allow-scripts` (fsevents) — это норма, не ошибка, см. §5.

---

## 1. Требования окружения

| Что  | Версия                 | Зачем                                        |
| ---- | ---------------------- | -------------------------------------------- |
| Node | ≥ 22 (на чём собирали) | Vite 8 не стартует на старых мажорах         |
| npm  | ≥ 11.16                | даёт `allow-scripts` (supply-chain гейт, §5) |
| ОС   | macOS / Linux          | dev одинаков; `fsevents` — только macOS      |

Проверить: `node -v && npm -v`.

---

## 2. Стек (что и почему — кратко)

Runtime: `preact` + `@preact/signals` + `dexie` + `nostr-tools` + `@noble/{curves,hashes,ciphers}` + `@scure/{bip39,bip32}` + `comlink`.
MLS: `ts-mls` (+ его HPKE/PQ-substrate, см. §3 — это та боль, что съела час).
Dev: `vite` + `@preact/preset-vite` + `vite-plugin-singlefile`.

Артефакт деплоя — **два файла**: `index.html` (весь JS/CSS инлайном) + `service-worker.js`.

---

## 3. Полный bootstrap с нуля (если репозитория нет)

### 3.1 Каркас

```bash
mkdir ugolok-03 && cd ugolok-03
npm init -y

mkdir -p scripts docs bench public \
  src/core/{crypto,store,transport,sync,fsm} \
  src/domain/{identity,contacts,auth,messaging,attachments,content,events} \
  src/workers src/ui/{signals,components,screens} src/lib
touch \
  src/core/{crypto,store,transport,sync}/index.js \
  src/domain/{identity,contacts,auth,messaging,attachments,content,events}/index.js
```

### 3.2 Зависимости

```bash
# runtime
npm install preact @preact/signals dexie \
  nostr-tools @noble/curves @noble/hashes @noble/ciphers \
  @scure/bip39 @scure/bip32 comlink

# MLS + ВЕСЬ его peer-substrate, точными версиями (иначе ERESOLVE).
# ts-mls пинит свои крипто-зависимости намертво — ставим ровно то, что он хочет.
npm install --save-exact \
  ts-mls@2.0.0-rc.14 \
  @noble/ciphers@2.2.0 @noble/curves@2.2.0 @noble/post-quantum@0.6.1 \
  @hpke/chacha20poly1305@1.8.0 @hpke/dhkem-x448@1.8.0 \
  @hpke/hybridkem-x-wing@0.7.0 @hpke/ml-kem@0.3.0

# dev
npm install -D vite @preact/preset-vite vite-plugin-singlefile
```

> **Почему ts-mls отдельно и с peer-набором.** `ts-mls` объявляет точечные (не диапазонные) peer-зависимости на `@noble/*` и весь `@hpke/*` + `@noble/post-quantum`. Поставить только `ts-mls` → `ERESOLVE`. Версии выше — под линию `2.0.0-rc.14` (на ней сделан замер R6-8: 65 КБ, 785/785 IETF-векторов). Если решишь перейти на стабильную линию (`ts-mls@1.6.x`) — там **другой** peer-набор (ниже по `@noble`), и вектора надо прогнать заново (AC-MLS-VEC). Не смешивать линии.

### 3.3 `vite.config.js` — критичная правка

`@preact/preset-vite` под Vite 8 падает на `zimmerframe` (`No "exports" main defined`). Лечится одним флагом:

```js
preact({ devToolsEnabled: false }); // обход бага preset×Vite8×zimmerframe
```

Полный конфиг — в репозитории; ключевое: этот флаг обязателен, иначе `npx vite` не стартует. Цена флага — нет имён хуков в DevTools и авто-`preact/debug`. Варнинги вернуть дев-онли:

```js
// в src/main.jsx:
if (import.meta.env.DEV) import("preact/debug"); // в прод-бандл не попадёт
```

### 3.4 `package.json` — скрипты

```json
{
	"type": "module",
	"scripts": {
		"dev": "vite",
		"build": "vite build",
		"preview": "vite preview"
	}
}
```

Реальный релиз подставляет relay-список через env (дефолт зашит в `vite.config.js`):

```bash
BUILD_DEFAULT_RELAYS='["wss://relay.one","wss://relay.two"]' npm run build
```

---

## 4. Сборка и проверка деплоя

```bash
npm run build      # → dist/index.html + dist/service-worker.js
npm run preview    # поднимает собранный артефакт локально
```

В `preview` (не в `dev`!) проверяется SW-ветка: регистрация, `ugolok-cache-v<hash>` в DevTools → Application → Cache Storage, офлайн. **В dev Service Worker’а нет** — `emitServiceWorker` стоит на `apply:'build'`, это by design.

Релиз (NF-18): `git checkout <tag> && npm ci && npm run build`, затем `scripts/release-hash.sh` считает SHA-256 `index.html` и `service-worker.js` и подписывает суммы, если есть GPG-ключ. Канон поставки — `docs/delivery.md`, сверка — `docs/verify.md`. Каркас CI: `./scripts/ci-check.sh` (то же, что GitHub Actions).

---

## 5. Грабли этой сессии (быстрый разбор — если что-то «вдруг сломалось»)

| Симптом                                                                         | Причина                                                                                                | Что делать                                                                                                                                                   |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `No "exports" main defined … zimmerframe`, плагин `preact:transform-hook-names` | preset-vite × Vite 8 × zimmerframe@1.1.4 (только `import`-экспорт)                                     | `preact({ devToolsEnabled: false })` в конфиге. Не пинить zimmerframe руками                                                                                 |
| `ERESOLVE … peer @noble/ciphers` при установке ts-mls                           | ts-mls точечно пинит `@noble/*` и `@hpke/*`                                                            | поставить весь peer-набор из §3.2, **не** `--force`/`--legacy-peer-deps`                                                                                     |
| `npm warn allow-scripts … fsevents`                                             | npm 11.16+ требует одобрения install-скриптов                                                          | не срочно; решить перед CI: `npm approve-scripts fsevents` (быстрый watcher) или `npm deny-scripts fsevents` (минимум поверхности). Коммитить `allowScripts` |
| Тема (фон/цвета) пропала, текст на прозрачном                                   | `light-dark()`/`color-mix()` фреймворка не поддержаны движком (нужен Safari 17.5+/Chrome 123+/FF 120+) | решение по полу A-01: поднять минимум ИЛИ retrofit-фолбэки в minimal.css. `build.target` это НЕ чинит (это ось JS)                                           |
| Диагностика зелёная, но SW «пропущено (dev)»                                    | dev-сервер SW не эмитит (apply:'build')                                                                | норма; проверять SW в `npm run preview`                                                                                                                      |
| Болтается «Загрузка…» сиблингом внизу                                           | Preact `render` не чистит контейнер, плейсхолдер остаётся                                              | `document.getElementById('app').replaceChildren()` перед `render`                                                                                            |

Эти шесть строк — и есть разница между «5 минут» и «час».

---

## 6. Работа с git

Ты solo, и публичная история — часть стратегии (видимая работа под OpenSats/HRF). Значит **`main` — это витрина: всегда собирается, всегда зелёный**. Из этого всё и следует.

### 6.1 Когда заводить ветку

Заводи ветку, когда работа **многокоммитная и может оставить дерево незелёным посередине**:

- старт фазы или спайка из плана (`phase-3-encryption`, `spike-mls`);
- рискованный рефактор;
- любое исследование, про которое не знаешь, выгорит ли (по сути все «спайки осуществимости»).

**Не** заводи короткую ветку, коммить прямо в `dev`, когда правка одношаговая. На живой сайт она попадёт только через `main` → `prod`.

Именование: `phase-N-<тема>`, `spike-<тема>`, `fix/<тема>`, `chore/<тема>`. Префикс несёт смысл при беглом взгляде на историю.

### 6.2 Когда пушить в `main`

Правило одно: **повседневный push — в `dev`**. Он сразу на `test.ugolok.tech`.

- После проверки на тесте: merge `dev` → `main`.
- Заливка на живой сайт: вручную merge `main` → `prod` и push `prod`.
- В `prod` в обход `main` не коммитить.

Ветки держи короткими (часы–дни) и удаляй после мёржа. Долгоживущая расходящаяся ветка у solo-разработчика смысла не имеет — только merge-боль.

### 6.3 Стиль мёржа (форк, выбери один)

- **Squash-merge** → один чистый коммит на фичу в `main`, линейная читаемая история. Лучше для публичной/грантовой оптики. _Рекомендую для solo._
- **Merge-commit** → сохраняет внутренние коммиты фазы и её границу. Полезно, если хочешь видеть, как шёл спайк.

Любой вариант — закрывай **границы фаз тегами** (см. ниже), тогда история читается даже при squash.

### 6.4 Теги и релизы (завязано на NF-18)

- Тег на завершении фазы: `git tag v0.1.0-phase1` — якорь плана, к которому можно вернуться. Это **не** релиз клиента.
- Релиз клиента = annotated tag **`vX.Y.Z`** (три числа, semver) на зелёном `main`. Пока продукт нестабилен — `0.Y.Z`. Подробности: `docs/delivery.md`, `docs/versioning.md`.
- Сборка релиза: тег → `git checkout <tag>` → `./scripts/ci-check.sh` → `./scripts/release-pack.sh`. Ручная подпись на Mini: `scripts/release-hash.sh` (GPG, если ключ есть). Хеши `index.html` и `service-worker.js` публикуются (`docs/verify.md`).
- Окружения: `dev` → `test.ugolok.tech`, `prod` → `ugolok.tech`. `main` — проверенное, без автовыкладки.

### 6.5 Гигиена коммитов

Сообщения короткие, в настоящем времени, «зачем», не только «что». Ссылайся на ID из плана (`F-CS-04`, `AC-11`, `R6-8`) — связывает git с твоим SSOT и decision-логами.

### 6.6 `.gitignore` — минимум

```gitignore
node_modules/
dist/
.DS_Store
*.log
.env
.env.*
```

**Коммитить обязательно** (не игнорировать): `package-lock.json` (NF-18, без него `npm ci` бессмысленен) и поле `allowScripts` в `package.json` (supply-chain политика, §5). **Никогда не коммитить**: nsec/приватные ключи, `.env` с секретами, реальные relay-эндпоинты если они чувствительны.

### 6.7 CI

Каркас есть: `.github/workflows/ci.yml` на PR и push в `main` гоняет `scripts/ci-check.sh` (Node 22). Релиз по тегу `vX.Y.Z` — `.github/workflows/release.yml`. Заготовки Forgejo — `.forgejo/workflows/`. Как гонять руками на Mini — `docs/local-cicd.md`.

`npm ci` в CI вызывается с `--ignore-scripts`; в `package.json` зафиксировано `"allowScripts": { "fsevents": false }`. Solo-исключение мелких зелёных коммитов прямо в `main` сохраняется (§6.1).

`npm test` в `package.json` — `node --test tests/*.test.js tests/harness/*.test.js`. То же, что гоняет `ci-check.sh`. На этой версии Node `node --test tests` (каталог) не рекурсирует, а пытается загрузить модуль `tests`.

### 6.8 Модель доверия деплоя

`push` в `dev` — это исполнение кода на боевой VPS, не просто «залить статику».

Forgejo-раннер (лейбл `ugolok`) стоит на той же машине, что и живой `ugolok.tech`. У джобы `deploy-test`/`deploy-prod` (`scripts/deploy-env.sh`) есть:

- запись в `/var/www/ugolok-test` и `/var/www/ugolok` (rsync `--delete`);
- доступ к docker-сокету (`docker run`, `docker compose up -d` для `deploy/island*/`);
- `sudo -n /opt/ugolok/bin/apply-caddy.sh` — с этапа 1 ограничен режимом `site` для test-выкладки (трогает только один site-файл в `/etc/caddy/sites/`, не общий `Caddyfile`); режим `full` (перезапись общего `Caddyfile`) доступен только из prod-выкладки.

**Факт, не смягчаемый sudoers**: пользователь раннера (`ugolok`) состоит в группе `docker`. Членство в `docker` — это root без пароля на хосте (`docker run -v /:/host ... chroot /host`), а не «доступ к контейнерам». Ограничения в `/etc/sudoers.d/ugolok-deploy` сужают только путь `sudo apply-caddy.sh` — они не убирают и не могут убрать этот более широкий путь к root через сам docker-сокет, потому что docker-группа не идёт через sudo вообще. Иными словами: **любая джоба на `dev` уже имеет root на боевой машине** — `sudoers` не граница безопасности, а документация одного намеренно разрешённого маршрута.

Из этого следует:

- 2FA на аккаунте `git.ugolok.tech`, из-под которого пушат в `dev`/`main`/`prod`, обязательна — компрометация аккаунта = RCE на проде.
- PR из форков через Forgejo Actions не должны запускать джобы с доступом к секретам/раннеру `ugolok` без ручного approve (Forgejo: «Require approval for fork pull request workflows» — проверить в админке, см. `docs/environments.md`).
- Любая правка `scripts/deploy-env.sh`/`scripts/apply-caddy.sh` — это правка того, что выполняется с правами раннера на проде; ревьюить как прод-код, не как «просто скрипт сборки».
- Осознанный выбор для текущего масштаба (один разработчик) — принять этот факт, а не городить отдельного непривилегированного пользователя-раннера с root-wrapper'ом для `docker compose up` (это отдельная задача на полдня и заметно сложнее в отладке). Пересмотреть, если появится второй человек с доступом к репозиторию/CI.

### 6.9 Живая проверка полного цикла (2026-09-06)

После хардненинга CI/CD (этапы 1-7, `PROCESS-DOCS/VPS/TZ-cicd-hardening.md`) прогнали весь путь на реальной, но безобидной правке — заголовок и подзаголовок главной (`src/ui/i18n/locales/ru.json`, `hero.title`/`hero.lead`) — специально как дымовой тест самого пайплайна, а не ради текста:

`dev` (ci-check зелёный локально → push → `deploy-test.yml` зелёный → текст обновился на test.ugolok.tech) → ff-only merge в `main` (`ci.yml` зелёный) → ff-only merge в `prod` (`deploy-prod.yml` зелёный, ~3.5 мин) → текст обновился на живом ugolok.tech.

Прошло без ручного вмешательства на всех трёх переходах. Единственная накладка — визуальная (не деплойная): на test и на проде сразу после hard-reload новый текст был не виден, пока не сбросился кэш браузера/service-worker — это ожидаемо и не признак проблемы деплоя.

### 6.10 Внешний аудит безопасности VPS (2026-09-06) — что сделано, что остаётся [VPS]

Независимый аудит нашёл живой токен раннера, случайно попавший целиком в текстовый дамп (regex ловил `TOKEN=`/`TOKEN:`, не `"token":` в JSON) — **токен считается скомпрометированным и должен быть перевыпущен**, это не задача этого репозитория, а разовое действие оператора на самой VPS (см. ниже).

Сделано в этом репозитории (код, применяется через обычный деплой):

- `deploy/caddy/Caddyfile` — admin API Caddy переведён на unix-сокет (`admin unix//run/caddy/admin.sock`); дефолтный `127.0.0.1:2019` без аутентификации был бы доступен любому локальному процессу, включая `coturn` с `network_mode: host`.
- `deploy/caddy/prod.caddy`, `deploy/caddy/test.caddy` — добавлен `Strict-Transport-Security` во все `header {}` блоки.
- `deploy/island/coturn.conf.example` — `denied-peer-ip` на приватные сети/loopback/облачную metadata/собственный публичный IP + `total-quota`/`user-quota`/`max-bps`. Без этого держатель публичных TURN-кредов (раздаются без проверки личности, этап 6) мог попросить coturn проксировать его в `169.254.169.254` (cloud metadata) или на `127.0.0.1:2019` (тот же Caddy admin API — второй путь к той же дыре).
- §6.8 выше — явно задокументирован факт «раннер в группе `docker` = root на хосте, `sudoers` этого не меняет» (был неявным допущением).
- Память сборочного контейнера поднята с `1200m`/`1700m` до `2g`/`3g` — на VPS фактически 4 ГБ, не 2 (старое предположение из `TZ-ugolok-vps-grok-terminal.md` устарело).

Остаётся оператору вручную на самой VPS — **не автоматизировано умышленно**, каждый пункт требует принятия решения на месте, а не слепого выполнения:

1. **Срочно**: перевыпустить токен раннера (Forgejo: Site administration → Actions → Runners → удалить `ugolok-vps`; на VPS `sudo systemctl stop forgejo-runner && sudo rm /var/lib/ugolok/runner/.runner`, зарегистрировать заново новым токеном) и удалить `~/ugolok-audit.txt`.
2. `sudo reboot` в спокойное окно — ядро с обновлениями ждёт перезагрузки с 3 сентября (`unattended-upgrades` не перезагружает сам).
3. Выяснить, что такое `beadmin` (`/etc/sudoers.d/90-beadmin`, NOPASSWD, процесс на `127.0.0.1:8080`) — похоже на агента хостера; если это не хостер — тревога.
4. Бэкапы `/var/lib/ugolok/relay`, `/var/lib/ugolok/blossom`, `/var/lib/forgejo` — сейчас существуют в одном экземпляре на одной машине. Отдельная задача (нужно решить: S3-совместимое хранилище или SSH на Mini; `docker compose pause`/`strfry export` для консистентности LMDB на время снятия копии) — не откладывать на месяц, но и не делать второпях вместе с остальным списком.
5. Проверить, закрыта ли регистрация в Forgejo: `sudo grep -E 'DISABLE_REGISTRATION|REQUIRE_SIGNIN_VIEW|ENABLE_OPENID_SIGNUP' /var/lib/forgejo/gitea/conf/app.ini`.
6. Раннер слушает `*:40713`/`*:42441` (свой cache-сервер) — `ufw` их не пускает наружу, но лучше явно привязать к `127.0.0.1` в `config.yml` раннера.
7. `docker system prune` раз в месяц (сейчас 2 ГБ build-кэша + 1.6 ГБ неиспользуемых образов) — вручную или таймером, по вкусу оператора.
8. `/root/.ssh/authorized_keys` при `PermitRootLogin no` безвреден, но можно убрать, чтобы не путать будущего себя.
