# log.md

Телеграфный журнал вызовов воркера. Формат: `#N — задача — вердикт`.

## Этап 1. Каркас проекта

1. `src/ui/nav-items.js` (NAV_ITEMS, DEFAULT_ACTIVE) — зелёный с первого раза, 4/4 теста прошли.
2. `src/ui/screens/diagnostics.jsx` — перенос диагностики из main.jsx 1:1 — принято по чтению (публичный контракт), совпадает с исходником.
3. `src/ui/screens/placeholder.jsx` — принято по чтению, соответствует контракту.
4. `src/main.jsx` — shell (aside nav + content) — брак: `import NAV_ITEMS, { DEFAULT_ACTIVE }` (default-импорт от named-export). Исправлено точечно вручную (Edit, 1 строка) без повторного вызова воркера — правка тривиальна и однозначна.
5. `index.html` — заголовок `<title>` вручную приведён в соответствие (был "Уголок — диагностика", стал "Уголок") — не app-код, конфиг.

Регрессия: `npm test` (4/4), `npm run build` (ok, 12.06 KB gzip index.html).
Интеграция: `npm run dev` + Playwright (headless Chromium) — все 6 пунктов навигации переключают контент, `aria-current` эксклюзивен, один `<main>` на экран, консоль без ошибок. Скриншоты: /tmp/stage1-{default,diagnostics,contacts}.png.
Адверсарный заход: обход всех 6 пунктов подряд + двойной клик по одному и тому же пункту — без ошибок и дублей `<main>`.

Замечание (не блокер): активный пункт nav визуально не отличается от неактивных (только `aria-current` в DOM, без CSS-стилизации) — PLAN.md этого не требует явно, отложено.

## Этап 2. Service Worker + конфиг

Воркер не вызывался: `service-worker.js` и `src/config.js` уже существовали (написаны до принятия skill, без CONTRACTS.md/тестов) и оказались корректны — формализованы задним числом вместо пересоздания.

1. `tests/config.test.js` (написан Claude, не воркером) — 2/2 зелёные с первого прогона на существующем `src/config.js`.
2. `src/ui/screens/diagnostics.jsx` — точечная ручная правка (2 строки): дублирующий inline-фоллбэк заменён на импорт из `src/config.js`. Тривиально и однозначно, по прецеденту этапа 1.
3. `vite.config.js` (`emitServiceWorker`) — точечная ручная правка (1 строка): `.replaceAll(str, buildHash)` → `.replaceAll(str, () => buildHash)`, найдено на адверсарном заходе (см. ниже).

Регрессия: `npm test` (6/6), `npm run build` × неоднократно (дефолтный hash из `git rev-parse`, override hash/relays через env, adversarial hash с `$`).
Интеграция: Playwright (headless Chromium, `vite preview` на `dist/`) — install создаёт `ugolok-cache-v{HASH}`, офлайн-reload отдаёт закешированный `index.html` из cache-first фоллбэка.
Адверсарный заход: пересборка с другим `BUILD_HASH` при активной вкладке → старый кэш удалён на `activate`, новый создан, `controllerchange` вызвал авто-`reload()` (смонтировано с этапа 1); `BUILD_HASH` со спецсимволами `/?#` — собралось нормально; `BUILD_HASH='a$&b$$c'` — вскрыл баг `.replaceAll` (см. п.3 выше), исправлен и перепроверен.

Правка контракта этапа 1: CONTRACTS.md ошибочно приписывал `main.jsx` вывод `BUILD_HASH`/`DEFAULT_RELAYS` "в шапке" — это поведение `diagnostics.jsx`. Текст исправлен, код не менялся.
