# Как мы работаем с git

_Актуально на 2026-09-05, описывает git-поток dev → main → prod._

Репозиторий: https://git.ugolok.tech/naysy/ugolok  
Локальная копия: эта папка (`git clone` заново не нужен, если уже есть).

`origin` = Forgejo. Повседневная ветка — **`dev`**.

## Три места, где смотреть

| Где | Что это |
|---|---|
| `localhost` после `npm run dev` | твои правки, ещё никуда не уехали |
| https://test.ugolok.tech | то, что запушено в `dev` — сюда зови тестовую группу |
| https://ugolok.tech | только ветка `prod` |

На тесте **другие** аккаунты, чем на живом сайте: отдельный relay и Blossom.

## Каждый день

```bash
git checkout dev
npm run dev          # смотришь у себя, обычно http://localhost:5173
# правки, коммиты
git push origin dev  # через минуту-две смотришь test.ugolok.tech
```

Очередь сборки: https://git.ugolok.tech/naysy/ugolok/actions

## Если на тесте ок

```bash
git checkout main
git merge --ff-only dev
git push origin main
```

## Живой сайт (только когда решил выкатить)

```bash
git checkout prod
git merge --ff-only main
git push origin prod
```

Потом снова `git checkout dev`.

В `prod` не пушь «чтобы проверить» — это уже живой сайт. Тренировка и тестовая группа — только `dev` → https://test.ugolok.tech
