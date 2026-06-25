# Уголок v2 — runbook разворачивания

SSOT по поднятию проекта с нуля и по работе с git. Цель: пересборка за 5 минут, а не за час.
Положить в `docs/RUNBOOK.md`.

---

## 0. Быстрый путь (если репозиторий уже есть)

Это и есть «5 минут». Работает ровно потому, что `package-lock.json` закоммичен.

```bash
git clone <repo> ugolok-2-project
cd ugolok-2-project
npm ci          # строго по локу — воспроизводимо (NF-18), не npm install
npm run dev     # http://localhost:5173
```

`npm ci`, а не `npm install`: `ci` ставит ровно то, что в локе, не трогает `package.json`, не плывут версии. Это и есть «воспроизводимая сборка» из задачи 1.10.

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
mkdir ugolok-2-project && cd ugolok-2-project
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

Релиз (NF-18): `git checkout <tag> && npm ci && npm run build`, затем `scripts/release-hash.sh` считает и подписывает хеш `index.html`, инструкция сверки — `docs/verify.md`.

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

**Не** заводи ветку, коммить прямо в `main`, когда правка **одношаговая и оставляет `main` зелёным**: опечатка, доковка, мелкий фикс, бамп зависимости, который собирается.

Именование: `phase-N-<тема>`, `spike-<тема>`, `fix/<тема>`, `chore/<тема>`. Префикс несёт смысл при беглом взгляде на историю.

### 6.2 Когда пушить в `main`

Правило одно: **в `main` уходит только то, что зелёное** — `npm run build` проходит И выполнены DoD-чеки этой единицы работы.

- WIP / сломанное / «на ночь сохранить» → пушишь в **свою ветку** (бэкап, никому не мешает), не в `main`.
- Готовое и зелёное → мёржишь ветку в `main`.
- Локально коммить часто (дешёвые чекпойнты), пушить ветку — по желанию; в `main` — только по готовности единицы.

Ветки держи короткими (часы–дни) и удаляй после мёржа. Долгоживущая расходящаяся ветка у solo-разработчика смысла не имеет — только merge-боль.

### 6.3 Стиль мёржа (форк, выбери один)

- **Squash-merge** → один чистый коммит на фичу в `main`, линейная читаемая история. Лучше для публичной/грантовой оптики. _Рекомендую для solo._
- **Merge-commit** → сохраняет внутренние коммиты фазы и её границу. Полезно, если хочешь видеть, как шёл спайк.

Любой вариант — закрывай **границы фаз тегами** (см. ниже), тогда история читается даже при squash.

### 6.4 Теги и релизы (завязано на NF-18)

- Тег на завершении фазы: `git tag v0.1.0-phase1` — якорь, к которому можно вернуться и воспроизвести.
- Реальный релиз: тег → `git checkout <tag>` → `npm ci` → `npm run build` → `scripts/release-hash.sh`. Тег + лок = воспроизводимость; хеш `index.html` публикуется и подписывается (`docs/verify.md`).

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

### 6.7 На будущее (когда появится CI)

`main` защищается прогоном: `npm run build` + вектора ts-mls (AC-MLS-VEC) + `strict-allow-scripts=true` (любой неодобренный install-скрипт роняет сборку). Тогда «зелёный main» из дисциплины превращается в гарантию.
