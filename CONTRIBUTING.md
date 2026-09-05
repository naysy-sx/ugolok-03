# Участие

`main` всегда должен собираться. Шпаргалка на каждый день: `docs/workflow.md`. Подробности git — `docs/RUNBOOK.md`.

Долгоживущие ветки:

- `dev` — повседневная работа. Push сразу выкладывает `test.ugolok.tech`.
- `main` — проверенное из `dev`. На живой сайт само не едет.
- `prod` — ручной merge из `main`. Push выкладывает `ugolok.tech`.

Фичи — короткие ветки в `dev` (или PR в `dev`). Не коммитить в `prod` в обход `main`.

Не коммитить: `dist/`, `dist-updates/`, `*-db/`, `.env`, ключи, `node_modules/`.

Перед сдачей:

```bash
npm test              # верхний уровень + harness fake-relay/ws-bridge
npm run build
# или всё сразу:
./scripts/ci-check.sh
```

Служебные заметки разработки (не вход для контрибьютора) лежат в ветке `process` того же репозитория. Ветка публичная — это не секрет. `.gitignore` на `main` не спасёт от случайного merge `process` → `main`.
