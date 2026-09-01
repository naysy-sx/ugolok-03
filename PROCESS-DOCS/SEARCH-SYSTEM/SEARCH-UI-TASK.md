# Экран «Результаты поиска». Техническое задание на вёрстку

**Редакция 1.** Реализует интерфейсную часть `SEARCH-SPEC.md` (§3.7, §5, §6) по утверждённому макету `search-results-mockup.html`.

**Границы задачи.** Только экран: разметка, стили, состояния, клавиатура, локализация. Движок поиска (`domain/search/`), источники, обход, схема БД — **не здесь**, это `SEARCH-SPEC.md` §10, этапы И1–И3.1. Экран строится против контракта состояния и временной заглушки; когда движок появится, в экране не меняется ничего.

**Макет.** `search-results-mockup.html` в корне репозитория. Он самодостаточный и содержит выдержки из `minimal.css`/`custom.css` — **их копировать не надо**, они уже в проекте. Копируется только блок, отбитый комментарием «НОВОЕ».

---

## 0. Указания оркестратору

Задача почти целиком `[W]`: контракт готов, макет готов, алгоритмики нет. Два исключения помечены `[C]` в §10.

Три места, где работник почти наверняка сделает не то, если не остановить заранее:

1. **Подсветка через `dangerouslySetInnerHTML`.** Запрещено (§3.4). Подсветка собирается из массива отрезков и рендерится обычным JSX.
2. **Захардкоженные данные прямо в JSX.** Экран обязан читать только сигнал состояния (§3.1). Заглушка живёт в отдельном файле и удаляется одной строкой импорта.
3. **Свои классы поверх существующих компонентов.** Шапка, карточки, лента, кнопки — переиспользуются как есть. Новые классы только те, что перечислены в §5, префикс `.sr-`.

---

## 1. Что строим

Экран, на который попадают из поля сайдбара по Enter. Показывает результаты глобального поиска, разбитые на группы по типу записи: контакты, каналы, сообщения, посты, комментарии, чат каналов.

Четыре состояния: идёт поиск, готово, ничего не найдено, поиск прерван.

---

## 2. Закрытые решения

| № | Решение | Отклонено | Основание |
|---|---|---|---|
| 1 | Экран строится на общем `Screen` из `components/screen.jsx` | своя вёрстка шапки | шапка, зоны, прокручиваемая область и `aria-labelledby` там уже решены для тринадцати экранов |
| 2 | Разобранный запрос — фишками, в **одну строку** с заголовком | подзаголовком под заголовком | вторая полоса высоты в закреплённой шапке дороже; фишки уезжают в прокрутку, заголовок не сжимается |
| 3 | Полоса хода поиска и перемычка групп — в слот `slices` | свои закреплённые блоки | `slices-zone` уже стоит вне области прокрутки и уже снимает границу у шапки через `:has(+ .slices-zone)` — липкость не нужна вовсе |
| 4 | Контейнер для адаптивности — `.content-section` c именем `screen` | новый контейнер на своей обёртке | шапка и зона срезов лежат **вне** `children`, своя обёртка их не покроет |
| 5 | Счётчик группы говорит «показано N» | «найдено N» | `SEARCH-SPEC.md` §3.4: при досрочном прекращении обхода общего числа не существует |
| 6 | Подсветка — массив отрезков, рендер обычным JSX | `dangerouslySetInnerHTML` | текст сообщений — пользовательский ввод; вставка HTML тут не нужна ни для чего |
| 7 | Данные приходят из сигнала, заглушка отдельным файлом | временные данные внутри экрана | иначе подключение движка означает переписывание экрана |

---

## 3. Контракты

### 3.1 Состояние: `src/ui/signals/search.js`

Форма из `SEARCH-SPEC.md` §3.6, дополненная тем, что нужно отрисовке:

```js
searchState = signal({
  runId: 0,
  query: "",                 // зафиксированный по Enter, НЕ то, что в поле
  parts: [],                 // разобранные части, для подсветки и фишек
  status: "idle",            // "idle" | "running" | "done" | "cancelled"
  currentSource: null,       // ключ читаемого сейчас источника, для полосы хода
  groups: [],                // см. ниже, в порядке показа
})
```

Группа:

```js
{
  type: "contact" | "channel" | "message" | "post" | "comment" | "channelMessage",
  hits: [...],               // записи, форма зависит от type, см. §4.3
  exhausted: boolean,        // false -> показывается «Показать ещё»
  running: boolean,          // источник ещё читается
}
```

Экран **только читает** этот сигнал. Никаких обращений к Dexie, к `dbKeySig`, к доменным модулям из `search.jsx`.

### 3.2 Заглушка: `src/ui/screens/search.stub.js`

Экспортирует `runStubSearch(query)`, которая наполняет `searchState` с искусственными задержками: сначала контакты и каналы, потом остальное, `status` переходит `running → done`. Данные — из макета.

Файл помечен в шапке комментарием, что он удаляется на этапе И3 `SEARCH-SPEC.md` вместе с одной строкой импорта в `search.jsx`.

### 3.3 Навигация: `src/ui/signals/place.js`

Добавляется `openSearch(query)` рядом с существующими `openChat`/`openChannel`, вид места `{ kind: "search", query }`. В `src/app.jsx` — строка диспетчеризации по образцу соседних и `"search"` в `KNOWN_KINDS`.

### 3.4 Подсветка: `src/ui/search-highlight.js`

```js
buildSnippet(text, parts, { radius = 90 }) -> Array<{ text, mark: boolean, ellipsis?: boolean }>
```

Чистая функция, без зависимостей. Возвращает **отрезки**, а не строку с разметкой. Находит первое вхождение любой части, вырезает окрестность, помечает вхождения всех частей.

Обрезка обязательна: совпадение в четвёртом абзаце длинного поста иначе не попадёт в видимый кусок, и строка выдачи будет выглядеть нерелевантной. Обрезанные края обозначаются отрезком с `ellipsis: true`.

**Временная мера, требующая правки позже.** Нормализация здесь дублируется в упрощённом виде. Когда появится `src/domain/search/matching.js` (этап И1 `SEARCH-SPEC.md`), `buildSnippet` обязан перейти на `normalize` оттуда, иначе подсветка и сопоставление разойдутся на диакритике: движок найдёт запись по `еще`, а подсветка не найдёт в ней `ещё`. Поставить это отдельным пунктом в приёмку И1.

---

## 4. Разметка

### 4.1 Каркас

`Screen` вызывается со слотами:

- `breadcrumb` — `{ label, onBack }`, возврат в предыдущее место.
- `title` — фрагмент из подписи и фишек, обёрнутый в `<span class="sr-title-line">` (§4.2).
- `slices` — фрагмент: полоса хода поиска (только при `status === "running"`) и перемычка групп.
- `actions` — одна кнопка `.icon-btn` с `IconCross`.
- `children` — тело выдачи.
- `feed` — `true`.

`subtitle` **не используется**: запрос стоит в одной строке с заголовком.

### 4.2 Заголовок в одну строку

```jsx
<span class="sr-title-line">
  <span class="sr-title-label">
    <span class="sr-title-long">{t("search.titleLong")}</span>
    <span class="sr-title-short">{t("search.titleShort")}</span>
  </span>
  <span class="sr-parts reel grow">
    {parts.map((p, i) => (
      <>
        {i > 0 && <span class="sr-parts-and">{t("search.and")}</span>}
        <span class="sr-part">{p}</span>
      </>
    ))}
  </span>
</span>
```

Фрагмент попадает внутрь существующего `<h1 class="screen-title__text">`. Строка в flex-ряд переключается через `:has()` (§5) — правки `screen.jsx` не требуется.

Фишки — не украшение. Это единственное место, где человек узнаёт, что пробел означает «И», а не поиск фразы; без него первый же запрос из двух слов, ничего не нашедший, читается как поломка.

### 4.3 Строка результата — три вида

**Контакт и канал** — существующая карточка, без единого нового класса:

```jsx
<li class="ucard-shell">
  <div class="ucard ucard--row" tabindex="-1" data-hit>
    <button class="ucard__who" type="button" onClick={…}>
      <figure class="ucard__avatar">…</figure>
      <span class="ucard__name"><Snippet … /></span>
      <span class="ucard__bio"><Snippet … /></span>
    </button>
  </div>
</li>
```

Обёртка `.ucard-shell` обязательна: она регистрирует контейнер `ucard`, и карточка получает уже написанные в проекте пороги 26rem и 17rem бесплатно. Без обёртки карточка на телефоне не сложится.

**Пост** — существующая `.feed-item` со слотами `meta`/`title`/`excerpt`.

**Сообщение, комментарий, чат канала** — новая `.sr-hit`. Не `.chat-msg`: тот заточен под пузырь в ленте (свои и чужие, группировка по дню), здесь нужна плоская строка с указанием, **где** запись лежит.

Порядок в шапке строки — кто, где, когда. «Где» стоит раньше времени намеренно: в глобальной выдаче три реплики «ок, сделаю» из разных чатов иначе неразличимы.

У комментария перед текстом идёт `.sr-quote` — обрезанная цитата родителя, иначе непонятно, к чему он.

### 4.4 Группа

```jsx
<section class="sr-group stack" id={`g-${type}`}>
  <header class="sr-group-head bar">
    <Icon />
    <h2 class="section-label">{t(`search.group.${type}`)}</h2>
    <span class="sr-group-count">{t("search.shown", { n })}</span>
    {running && <span class="spinner" aria-hidden="true" />}
  </header>
  <ul class="ucard-list …">…</ul>
  {!exhausted && <button class="btn btn--ghost btn--sm load-more">{t("search.more")}</button>}
</section>
```

Пустые группы не рендерятся вовсе.

Значки групп — из `src/ui/icons/`: контакты `person`, каналы `globe`, сообщения `chat-bubble`, посты `reader`, комментарии `format-quote`, чат каналов `people`.

### 4.5 Пустые состояния

**Ничего не найдено** — `.empty.sr-nothing`: заголовок, строка пояснения и список из четырёх подсказок. Третья подсказка обязательна и звучит так: поиск идёт по подстроке, поэтому «работа» не найдёт «рабочий». Это настоящая граница модели, человек упрётся в неё сам — дешевле сказать заранее.

**Прерван** — заголовок, пояснение, что показано только успевшее, и кнопка продолжения.

### 4.6 Тело выдачи

```jsx
<div class="sr-body stack">…</div>
```

Собственного отступа не имеет: `.content-wrapper` внутри `Screen` уже даёт `--pad: var(--space-m)`. Ограничение `--measure` намеренное — снипет читают построчно, и растянутая на весь экран строка читается хуже, чем в чате, где слева есть аватар-якорь.

---

## 5. CSS

Всё дописывается в конец `src/styles/custom.css` отдельной секцией с шапкой-комментарием, ссылающейся на этот документ. Новых токенов нет ни одного.

**Одна правка существующего правила** — `.content-section` получает имя контейнера:

```css
.content-section {
	height: 100%;
	overflow: hidden;
	container: screen / inline-size;   /* было: container-type: inline-size */
}
```

Безопасно: безымянные `@container`-запросы, которых в проекте больше десятка, сопоставляются с ближайшим предком-контейнером **независимо от имени**. Имя ничего не отбирает, оно только даёт возможность адресоваться прицельно.

Новый блок целиком:

```css
/* ================================================================== *
 *  SEARCH — экран «Результаты поиска». ТЗ: SEARCH-UI-TASK.md.        *
 *  Макет: search-results-mockup.html.                                *
 * ================================================================== */

/* Заголовок и разобранный запрос в одну строку. Переключение через
   :has() — правки общего screen.jsx не требуется, тот же приём, что
   .section-header:has(+ .slices-zone) выше. */
.screen-title__text:has(.sr-title-line) {
	overflow: visible;
	white-space: normal;
}
.sr-title-line {
	display: flex;
	align-items: center;
	gap: var(--space-s);
	min-inline-size: 0;
}
.sr-title-label { flex: none; }
.sr-title-short { display: none; }

/* Фишки частей запроса: подпись не сжимается, фишки уезжают в прокрутку.
   При семи частях строка не разваливается и не отъедает вторую полосу
   высоты закреплённой шапки. */
.sr-parts {
	--gap: var(--space-2xs);
	--align: center;
	min-inline-size: 0;
	padding-block: var(--space-3xs);
	scrollbar-width: none; /* полоса прокрутки съела бы ритм шапки */
}
.sr-parts::-webkit-scrollbar { display: none; }
.sr-part {
	flex: none;
	background-color: var(--accent);
	color: var(--accent-contrast);
	border-radius: var(--radius-full);
	padding: 2px var(--space-xs);
	font-size: var(--step--1);
	font-weight: var(--weight-bold);
	white-space: nowrap;
}
.sr-parts-and {
	flex: none;
	color: var(--muted);
	font-size: var(--step--2);
	text-transform: uppercase;
	letter-spacing: 0.08em;
}

/* Полоса хода поиска. Живёт в .slices-zone, поэтому без своего фона и
   границы — зона уже даёт и то, и другое. Исчезает по готовности. */
.sr-status {
	font-size: var(--step--1);
	color: var(--muted);
	padding-block-end: var(--space-2xs);
}

/* Перемычка групп. Липкость не нужна: .slices-zone стоит вне области
   прокрутки. flex:none на кнопках — иначе .reel сжимает их, и счётчик
   налезает на подпись. */
.sr-jump-btn {
	flex: none;
	display: inline-flex;
	align-items: center;
	gap: var(--space-2xs);
	background-color: var(--surface);
	border: var(--border-width) solid transparent;
	border-radius: var(--radius-full);
	padding: var(--space-3xs) var(--space-2xs) var(--space-3xs) var(--space-s);
	font-size: var(--step--1);
	color: var(--muted);
	white-space: nowrap;
	cursor: pointer;
	transition:
		background-color var(--transition-speed) var(--transition-ease),
		color var(--transition-speed) var(--transition-ease);
}
.sr-jump-btn:hover { background-color: var(--surface-raised); color: var(--fg); }
.sr-jump-btn[aria-current="true"] {
	background-color: var(--surface-raised);
	color: var(--fg);
	border-color: var(--border);
}
.sr-jump-btn .icon { font-size: 1.1em; flex: none; }
.sr-jump-label { flex: none; }
/* Счётчик отделён от подписи формой, а не только зазором — при любом
   числе знаков ширина держится, цифры табличные. */
.sr-jump-n {
	flex: none;
	font-variant-numeric: tabular-nums;
	font-size: var(--step--2);
	line-height: 1.4;
	color: var(--muted);
	background-color: var(--bg);
	border-radius: var(--radius-full);
	padding-inline: var(--space-2xs);
	min-inline-size: 1.75em;
	text-align: center;
}

/* Тело выдачи. Своего padding нет — .content-wrapper уже даёт --pad. */
.sr-body {
	--gap: var(--space-xl);
	max-inline-size: var(--measure);
	margin-inline: auto;
}

.sr-group { --gap: var(--space-s); scroll-margin-block-start: var(--space-m); }
.sr-group-head {
	--gap: var(--space-2xs);
	--align: baseline;
	padding-block-end: var(--space-2xs);
	border-block-end: var(--border-width) solid var(--border);
}
.sr-group-head .icon { font-size: var(--step-1); color: var(--muted); align-self: center; }
.sr-group-count { color: var(--muted); font-size: var(--step--1); font-variant-numeric: tabular-nums; }

/* Строка попадания: сообщение, комментарий, чат канала. */
.sr-hit {
	display: grid;
	grid-template-columns: auto minmax(0, 1fr);
	column-gap: var(--space-s);
	row-gap: var(--space-3xs);
	inline-size: 100%;
	text-align: start;
	background: none;
	border: var(--border-width) solid transparent;
	border-radius: var(--radius);
	padding: var(--space-xs) var(--space-2xs);
	font: inherit;
	color: inherit;
	cursor: pointer;
	transition: background-color var(--transition-speed) var(--transition-ease);
}
.sr-hit:hover,
.sr-hit:focus-visible { background-color: var(--surface); }
.sr-hit-ava {
	grid-column: 1;
	grid-row: 1 / -1;
	align-self: start;
	inline-size: var(--avatar-s);
	block-size: var(--avatar-s);
	border-radius: var(--radius-sm);
	border: var(--border-width) solid var(--border);
	background-color: var(--surface);
	display: grid;
	place-items: center;
	font-size: var(--step--1);
	font-weight: var(--weight-bold);
	color: var(--muted);
}
/* Кто -> где -> когда. «Где» раньше времени: в глобальной выдаче
   одинаковые снипеты из разных чатов иначе неразличимы. */
.sr-hit-head { grid-column: 2; --gap: var(--space-2xs); --align: baseline; font-size: var(--step--1); }
.sr-hit-who { font-weight: var(--weight-bold); color: var(--fg); }
.sr-hit-where { color: var(--muted); display: inline-flex; align-items: center; gap: var(--space-3xs); }
.sr-hit-where .icon { font-size: 0.9em; }
.sr-hit-time {
	color: var(--muted);
	margin-inline-start: auto;
	font-variant-numeric: tabular-nums;
	white-space: nowrap;
}
.sr-hit-text { grid-column: 2; overflow-wrap: anywhere; }

/* Подсветка. <mark> в проекте больше нигде не используется. Фон
   приглушённый: при трёх частях запроса в одной строке ярких пятен
   становится слишком много. */
.sr-hit mark,
.feed-excerpt mark,
.ucard__bio mark,
.ucard__name mark,
.sr-quote mark {
	background-color: color-mix(in oklch, var(--gold) 35%, transparent);
	color: inherit;
	border-radius: var(--radius-sm);
	padding-inline: 0.15em;
	font-weight: var(--weight-bold);
}
.sr-ellipsis { color: var(--muted); }

/* Цитата родителя у комментария — без неё непонятно, к чему он. */
.sr-quote {
	border-inline-start: 2px solid var(--border);
	padding-inline-start: var(--space-2xs);
	color: var(--muted);
	font-size: var(--step--1);
	margin-block-end: var(--space-3xs);
}

/* Пустая выдача: не констатация, а разбор — что не сработало и что
   попробовать. */
.sr-nothing { max-inline-size: 44ch; margin-inline: auto; }
.sr-nothing-title { font-size: var(--step-1); font-weight: var(--weight-bold); margin-block-end: var(--space-2xs); }
.sr-nothing-list {
	--gap: var(--space-3xs);
	text-align: start;
	color: var(--muted);
	font-size: var(--step--1);
	margin-block-start: var(--space-s);
}
.sr-nothing-list li { padding-inline-start: var(--space-s); position: relative; }
.sr-nothing-list li::before { content: "→"; position: absolute; inset-inline-start: 0; color: var(--muted); }

/* Курсор клавиатуры отделён от :hover — мышь и клавиатура не спорят за
   одну подсветку. */
.sr-hit[data-cursor="true"],
.ucard[data-cursor="true"],
.feed-item[data-cursor="true"] {
	background-color: var(--surface);
	border-color: var(--accent);
	border-radius: var(--radius);
}

.sr-kbd {
	display: inline-block;
	font-size: var(--step--2);
	font-family: var(--font-mono);
	border: var(--border-width) solid var(--border);
	border-radius: var(--radius-sm);
	padding: 0 0.35em;
	color: var(--muted);
	background-color: var(--surface);
}

/* ---- Адаптивность: контейнер экрана, не окно ---------------------- *
 *  Карточки контактов и каналов адаптируются САМИ — у .ucard-shell
 *  свой контейнер и свои пороги, уже написанные выше в этом файле.
 * ------------------------------------------------------------------ */

/* 46rem — ниже него --measure уже не достигается, и поля вокруг ленты
   становятся дороже самого текста. */
@container screen (max-width: 46rem) {
	.sr-body { --gap: var(--space-l); }
	.sr-hit { padding-inline: var(--space-3xs); }
}

/* 34rem — колонка времени начинает драться за место с «где». Время
   уходит на свою строку: оно нужно для опознания, но последним. */
@container screen (max-width: 34rem) {
	.sr-hit {
		grid-template-areas: "ava head" "ava text" ".  time";
		row-gap: var(--space-3xs);
	}
	.sr-hit-ava { grid-area: ava; }
	.sr-hit-head { grid-area: head; flex-wrap: wrap; }
	.sr-hit-text { grid-area: text; }
	.sr-hit-time { grid-area: time; margin-inline-start: 0; font-size: var(--step--2); }
	.sr-hit-where { min-inline-size: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.feed-item {
		grid-template-columns: minmax(0, 1fr);
		grid-template-areas: "meta" "title" "excerpt" "foot" "thumb";
	}
	.feed-thumb { justify-self: start; }
}

/* 26rem — телефон в один столбец. Шесть подписей в перемычку не влезают
   ни при какой вёрстке; значок с числом опознаётся с одного взгляда.
   Подпись остаётся у текущей группы — иначе неясно, где ты. */
@container screen (max-width: 26rem) {
	.sr-title-long { display: none; }
	.sr-title-short { display: inline; }
	.sr-jump-btn { padding-inline: var(--space-2xs); }
	.sr-jump-label {
		/* Не display:none — подпись нужна вспомогательным технологиям. */
		position: absolute;
		inline-size: 1px;
		block-size: 1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}
	.sr-jump-btn[aria-current="true"] .sr-jump-label {
		position: static;
		inline-size: auto;
		block-size: auto;
		clip-path: none;
	}
	.sr-hit-ava { display: none; }
	.sr-hit {
		grid-template-columns: minmax(0, 1fr);
		grid-template-areas: "head" "text" "time";
	}
}
```

---

## 6. Клавиатура и доступность

- `↑`/`↓` перемещают курсор по всем результатам сквозь границы групп. Обработчик вешается на корень экрана, не на `document`, и не срабатывает, когда фокус в поле ввода.
- Подвижный `tabindex`: у элемента под курсором `0`, у остальных `-1`. `Enter` открывает, `Escape` закрывает экран.
- Перемычка — `<nav>` с `aria-label`. Активная кнопка помечается `aria-current="true"`, обновляется через `IntersectionObserver` по видимой группе.
- Полоса хода поиска — `aria-live="polite"`: смена читаемого источника проговаривается, а не остаётся немой.
- Подсказка о клавишах внизу выдачи показывается только при `status === "done"`.
- `role="feed"` даёт `Screen` через проп, руками не выставлять.

---

## 7. Локализация

Ключи под `search.*` в двенадцати файлах `src/ui/i18n/locales/`. Русская и английская — настоящий перевод, остальные десять — ключи по принятому в проекте порядку.

Минимальный набор: `titleLong`, `titleShort`, `and`, `shown`, `more`, `cancel`, `reading` (с подстановкой имени источника), `group.contact`, `group.channel`, `group.message`, `group.post`, `group.comment`, `group.channelMessage`, `nothing.title`, `nothing.lead`, `nothing.tip1`–`tip4`, `cancelled.title`, `cancelled.lead`, `cancelled.resume`, `keysHint`, `closeAria`, `jumpAria`.

Никакой склейки строк из кусков — счётчик и имя источника подставляются параметрами.

---

## 8. И0: блокирующие проверки

Факты, не вердикты.

**П-1. `Screen`.** Показать полный список пропсов и то, во что рендерится `title`. Нужно убедиться, что фрагмент внутри `<h1>` допустим и что `slices` — обычный контейнер без ограничений на содержимое.

**П-2. `.content-section`.** Показать все правила для этого класса и все безымянные `@container`-запросы в `custom.css` с указанием, какой контейнер для каждого является ближайшим предком. Если хоть один сейчас разрешается в `.content-section` — привести его, чтобы убедиться, что именование ничего не ломает.

**П-3. `place.js`.** Показать полный текст: форму места, список видов, как устроены существующие `openChat`/`openChannel`.

**П-4. `nav-groups.jsx`.** Показать код поля поиска и локальное состояние строки. Нужно для §10, задача 3.2 — там строка поля и зафиксированный запрос обязаны остаться разными значениями.

**П-5. Значки.** Показать, что файлы `person`, `globe`, `chat-bubble`, `reader`, `format-quote`, `people` существуют в `src/ui/icons/` и экспортируют компонент по общему образцу.

---

## 9. Задачи

| № | Задача | Марш. | Готово, когда |
|---|---|---|---|
| 1.1 | `signals/search.js` — сигнал по §3.1 | `[W]` | форма совпадает с `SEARCH-SPEC.md` §3.6 |
| 1.2 | `screens/search.stub.js` — заглушка по §3.2 | `[W]` | все четыре состояния воспроизводятся |
| 1.3 | `search-highlight.js` — `buildSnippet` | `[C]` | тесты: совпадение в начале, в середине длинного текста, несколько частей, части внахлёст, части нет вовсе |
| 2.1 | CSS-блок §5 в `custom.css` | `[W]` | скопирован дословно, включая комментарии |
| 2.2 | `container: screen / inline-size` на `.content-section` | `[C]` | после правки все существующие экраны выглядят как до неё |
| 3.1 | `screens/search.jsx` — каркас, шапка, группы, строки | `[W]` | совпадает с макетом при трёх ширинах |
| 3.2 | Enter и строка-подсказка в `nav-groups.jsx` | `[W]` | локальная строка поля и `place.query` не смешаны |
| 3.3 | `place.js`, `app.jsx`, `KNOWN_KINDS` | `[W]` | переход работает в обе стороны |
| 3.4 | Клавиатура и `aria` по §6 | `[W]` | обход стрелками сквозь группы, фокус виден |
| 3.5 | Переходы из строк выдачи в места записей | `[W]` | каждый тип ведёт куда следует |
| 3.6 | Локализация §7 | `[W]` | двенадцать файлов |

---

## 10. Чего делать не нужно

- `dangerouslySetInnerHTML` где бы то ни было.
- Обращаться из экрана к Dexie, `dbKeySig` или доменным модулям.
- Показывать общее число найденного.
- Делать перемычку липкой: она вне области прокрутки.
- Заводить свои классы для карточек контактов, каналов и постов.
- Добавлять новые токены в `minimal.css`.
- Городить `position: sticky` и `z-index` — в макете их нет ни одного намеренно.
- Ставить обработчик клавиш на `document`.

---

## 11. Приёмка

1. Все четыре состояния видны и переключаются заглушкой.
2. При ширине колонки 46, 34 и 26rem экран складывается по §5 — проверяется сужением окна и открытием на телефоне, а не только инструментами разработчика.
3. Карточка контакта на 26rem складывается сама, своих правил под неё не написано.
4. Обход стрелками проходит все результаты по кругу, фокус виден, при фокусе в поле ввода стрелки экран не трогают.
5. Ни один текст не собран склейкой строк.
6. Заглушка удаляется правкой одной строки импорта, и экран после этого не падает, а показывает `idle`.
