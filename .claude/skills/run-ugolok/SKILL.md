---
name: run-ugolok
description: Собрать, запустить и подвигать веб-приложение "Уголок" (Preact SPA, мессенджер на nostr). Использовать, когда просят запустить приложение, поднять dev-сервер, собрать index.html, сделать скриншот UI, зарегистрировать/залогинить тестовый аккаунт или иначе живьём проверить экран.
---

"Уголок" — Preact SPA (Vite + vite-plugin-singlefile, сборка в один
`index.html`). Для агента: поднять `npm run dev` и водить headless
Chromium через Playwright — chromium-cli в этом окружении не
установлен, а `playwright` уже в devDependencies с закешированными
браузерами, так что отдельный `npx playwright install` обычно не
нужен. Драйвер — `.claude/skills/run-ugolok/driver.mjs`, REPL: команды
текстом через stdin, по одной в строке.

Все пути ниже — относительно корня репозитория (`ugolok-2-project/`,
единственный юнит, `package.json` в корне).

## Предпосылки

Проверено на macOS (Darwin), не на headless Linux — если будете
запускать в Linux-контейнере, `xvfb-run` может понадобиться для
Playwright, здесь не потребовался.

```bash
npm install
npx playwright install chromium   # обычно no-op — браузер уже в кеше
```

## Сборка (опционально — для смоук-теста достаточно dev-сервера)

```bash
npm run build     # -> index.html + service-worker.js, зелёная сборка (784 модуля)
```

## Запуск (путь агента)

Dev-сервер — фоном, с опросом порта (не `sleep`):

```bash
npm run dev &
i=0; until curl -sf http://localhost:5173 >/dev/null || [ $i -ge 30 ]; do sleep 1; i=$((i+1)); done
```

Остановка — через порт, не `kill %1` (npm-обёртка не форвардит
SIGTERM дочернему vite):

```bash
lsof -ti:5173 -sTCP:LISTEN | xargs -r kill
```

Драйвер — REPL, команды подаются через heredoc в stdin (без tmux —
здесь не нужен, страница не Electron-окно, а обычная вкладка):

```bash
node .claude/skills/run-ugolok/driver.mjs <<'EOF'
launch
wait-text Create a new space
register agenttester Ag3ntTesterPass!
wait-text Journal
ss main-screen
quit
EOF
```

Скриншоты падают в `/tmp/ugolok-shots/` (переопределить —
`SCREENSHOT_DIR`). Для интерактивной отладки — тот же файл под
`tmux new-session`/`send-keys`/`capture-pane` (как в электрон-примере
из `run-skill-generator`), просто без `xvfb-run` (это не Electron/GUI).

### Команды драйвера

| команда | что делает |
|---|---|
| `launch` | открыть новый Chromium, перейти на `BASE_URL#/main` |
| `reload` | НАСТОЯЩАЯ перезагрузка страницы (не `launch` — тот же профиль/IndexedDB, старые аккаунты видны) |
| `ss [имя]` | скриншот -> `SCREENSHOT_DIR/<имя>.png` |
| `fill <css-sel> <текст>` | вписать значение в поле (настоящий ввод, не `eval`) |
| `click <css-sel>` | клик по селектору |
| `click-text <текст>` | клик по кнопке/ссылке/вкладке с таким текстом |
| `type <текст>` / `press <клавиша>` | ввод с клавиатуры |
| `wait <css-sel>` | дождаться селектора, таймаут 15с |
| `wait-text <текст>` | дождаться текста где угодно на странице |
| `eval <js>` | выполнить JS на странице, напечатать JSON |
| `text [css-sel]` | напечатать `innerText` (без селектора — всего `body`) |
| `register <login> <password>` | ПОЛНЫЙ цикл создания аккаунта (см. Gotchas) |
| `login <login> <password>` | вход в уже существующий (в этом же профиле) аккаунт |
| `eval-module <путь> <js>` | динамический импорт модуля приложения (signals) — управление роутингом напрямую, когда нет UI-пути к экрану |
| `quit` | закрыть браузер, выйти |

## Запуск (человеческий путь)

```bash
npm run dev   # откроет обычный dev-сервер, зайти на http://localhost:5173 в браузере
```

## Тесты

```bash
npm test   # node --test tests/*.test.js
```

Ожидаемо: все тесты `tests/*.test.js` зелёные. `node --test` без
аргументов (полная регрессия) дополнительно подхватывает 3 теста из
`server/strfry/strfry-src/` (вендорный relay) — они падают независимо
от изменений в приложении, это не регрессия.

## Gotchas

- **Аккаунта на "чистой машине" нет — есть только регистрация.**
  `unlock.jsx`'s "Создать" ведёт через 4 экрана (никнейм+пароль ->
  показ мнемоники -> повторный ввод мнемоники для подтверждения ->
  готово), и мнемонику нужно пронести между экранами. REPL-команды
  через stdin состояние друг с другом не делят (каждая строка —
  отдельный вызов), поэтому весь цикл сделан ОДНОЙ составной командой
  `register` внутри driver.mjs, а не последовательностью
  `click`/`fill` в SKILL.md.
- **`page.goto()` на тот же URL с тем же `#hash` не перезагружает
  документ.** Chromium трактует это как same-document навигацию (как
  простой переход по якорю) — JS-состояние SPA остаётся как есть,
  экран логина не появится даже "после выхода". Для настоящей
  перезагрузки — `page.reload()` (команда `reload` в driver.mjs), не
  повторный `goto`.
- **Локаль по умолчанию — английская**, не русская: headless Chromium
  без явной настройки `--lang` берёт `en-US`, интерфейс рендерится по
  `en.json`. Тексты в SKILL.md/driver.mjs — английские неймы кнопок
  ("Continue", "I've saved the phrase", "Sign in"), не русские
  ("Продолжить", "Войти").
- **Пайпленный (не-TTY) stdin ломает наивный `readline`-REPL.** Node
  отдаёт ВСЕ буферизованные строки событием `'line'` сразу, не
  дожидаясь завершения async-обработчика предыдущей — без явной FIFO-
  очереди `launch` и следующая `ss` гонялись бы одновременно, и `ss`
  падала на ещё не открытом браузере. driver.mjs сериализует команды
  через `Promise`-очередь.
- **`sleep N` вместо опроса порта — плохая идея**, тем более на этом
  проекте: `npm run dev` попутно поднимает локальный strfry-relay
  (`server/strfry/`), и первый запрос к `localhost:5173` может
  прийти раньше, чем Vite реально слушает порт. Опрос `curl -sf`
  надёжнее фиксированной паузы.
- **macOS не имеет `timeout`/`gtimeout` из коробки** (это GNU
  coreutils, не входит в BSD-userland). Команды выше используют
  ручной цикл опроса (`i=0; until ... || [ $i -ge N ]; do sleep 1;
  i=$((i+1)); done`) вместо `timeout N bash -c '...'` — переносимо
  и на Linux, и на macOS.
- **Второй `npm run dev` на другом порту не роняет первый** (и
  наоборот) — `vite.config.js`'s локальные relay/Blossom/TURN-плагины
  (`devRelayPlugin`/`devBlossomPlugin`/`devTurnPlugin`) при занятом
  порту (7777/8080/…) просто пишут warning в лог и не трогают сам
  Vite-сервер. Если видите `unable to listen on port 7777` в выводе —
  это ожидаемо при двух параллельных dev-серверах, не баг.

## Troubleshooting

- **`ss` делает скриншот с текстом "Checking..."**: экран инициализации
  локальной БД (`unlock.checking`) — асинхронный, до появления формы
  логина/регистрации нужно `wait-text Create a new space` (или
  `wait-text Sign in`), а не скриншотить сразу после `launch`.
- **`click-text "Sign in" -> NOT_FOUND` сразу после `register`**: вы,
  скорее всего, всё ещё залогинены в только что созданный аккаунт —
  экран unlock не покажется без настоящей перезагрузки (`reload`, не
  `launch`/`goto`, см. Gotchas).
- **`ERROR: page.evaluate: TypeError: Cannot read properties of null
  (reading 'click')` из `login`**: никнейм не найден в списке
  аккаунтов на вкладке "Sign in" — либо опечатка в имени, либо вы всё
  ещё на экране "Journal" (см. предыдущий пункт).
