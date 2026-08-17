# MEDIA-OVERLAY-UI.md — визуальная переработка просмотрщика вложений

Довесок к этапу D медиа-подсистемы. Логика сессии (`media-machine.js`,
`playlist.js`, `signals/media.js`) **не меняется ни в одном этапе ниже**.
Меняются только `media-overlay.jsx`, три вида, `custom.css` и локали.

Базовый коммит: `484290c`.

---

## 0. Инварианты, которые нельзя нарушить

Проверять на каждом этапе — они уже оплачены живыми проверками, повторно
ловить их дорого.

**И-A. `<View>` остаётся смонтированным.** Форма дерева `div > div > View`
одна и та же для `full` и `mini`; смена `display` меняет только обвязку.
Любая правка, при которой Preact пересоздаёт `<video>`/`<audio>`, обрывает
воспроизведение — это уже ловили в Firefox/Zen.

**И-B. Лента слайдов — только для `cls === "image"`.** Для `audio`/`video`
`allocWindow` отдаёт ровно один digest: соседей нет в памяти, рисовать их
нечем. Свайп там — жест, вызывающий `mediaNext`/`mediaPrev`, переход —
перекрёстное затухание на месте.

**И-C. Порядок z-index не трогать.** `.media-overlay` 190 < `.call-overlay`
200 < `.top-corner-actions` 300. Конфликт с шапкой решается скрытием шапки
(этап 1), не поднятием оверлея.

**И-D. `doSeek` не дорабатывать.** Перемотка внутри трека — свойство
DOM-элемента, не состояния сессии. Свой ползунок пишет в `el.currentTime`.

**И-E. Картинка не сворачивается и не ставится на паузу** (`doMinimize`,
`doToggle` возвращают состояние без изменений при `cls === "image"`).
Кнопки «свернуть» и «пуск» для картинок не рендерить вовсе — не
`disabled`, а отсутствуют.

**И-F. Регламент раскладки.** Раскладка — классами слоя `composition`
(`.bar`, `.stack`, `.layer`, `.grow`, `.rigid`, `.truncate`, `.reel`) в
JSX; в `custom.css` только цвет, размер, тень, движение. Параметры — через
`--gap`/`--pad` на элементе, не через классы-модификаторы.

---

## Этап 1 — каркас и хром, без новой логики

Цель: то же поведение, что сейчас, но выглядит как продукт. Ничего не
двигается, не прячется, не свайпится.

### 1.1 Разметка `media-overlay.jsx`, ветка `full`

Заменить текущее `div.media-overlay > div.media-overlay-inner +
div.media-overlay-controls` на:

```
div.media-overlay                    (role=dialog, aria-modal, onClick=closeMedia)
  div.media-overlay-scrim            (подложка, aria-hidden)
  div.media-overlay-viewport         (onClick с проверкой e.target — закрытие по фону)
    div.media-overlay-inner          (onClick stopPropagation) -> <View>
  header.media-overlay-top.bar
    div.media-overlay-title.stack.grow
      span.truncate                  (mediaRef.name)
      small                          ("{rank+1} из {total} · {класс} · {размер}")
    div.media-overlay-acts.bar.rigid
      button.media-overlay-btn       (сведения, только если есть что показать)
      button.media-overlay-btn       (свернуть, только если canMinimize)
      button.media-overlay-btn.is-close (закрыть)
  button.media-overlay-nav.is-prev   (только если total > 1)
  button.media-overlay-nav.is-next   (только если total > 1)
  footer.media-overlay-bottom        (появляется на этапе 2; на этапе 1 — пусто)
```

Стрелки `‹ ›` из строки контролов уходят к краям экрана. Символы `‹ › ⤡ ⤢
⏸ ▶` заменить на иконки проекта: `chevron-left.jsx`, `chevron-right.jsx`,
`cross.jsx`. Для «свернуть» и «пуск/пауза» иконок в наборе нет — нарисовать
в том же стиле, что `phone-call.jsx` и `bell.jsx` (viewBox `0 0 15 15`,
`fill="currentColor"`, `width/height="1em"`, `class="icon"`): файлы
`src/ui/icons/minimize.jsx`, `player-play.jsx`, `player-pause.jsx`,
`info-circle.jsx`.

### 1.2 Скрытие шапки приложения

В `media-overlay.jsx` эффект: при `session?.display === "full"` ставить
`document.documentElement.dataset.mediaFull = "1"`, в очистке — удалять.
Зависимость `[session?.display]`. В `custom.css`:

```css
html[data-media-full] .top-corner-actions {
	opacity: 0;
	pointer-events: none;
}
```

Причина в комментарии к правилу: `.top-corner-actions` — z-index 300, выше
`.media-overlay` (190); поднимать оверлей нельзя, он сознательно ниже
`.call-overlay` (200).

### 1.3 CSS

Заменить блок `custom.css` строки 2283–2355 целиком на:

```css
/* ================================================================== *
 *  Просмотрщик вложений (media-overlay.jsx) — довесок к этапу D.     *
 *  Оверлей ВСЕГДА тёмный независимо от темы приложения: color-scheme *
 *  здесь форсирует тёмную ветвь всех light-dark() внутри. Причина не *
 *  вкусовая — светлая рамка вокруг фотографии смещает восприятие её  *
 *  собственных цветов; так устроены все просмотрщики, от Google      *
 *  Photos до Telegram. z-index НИЖЕ .call-overlay (200) и НИЖЕ       *
 *  .top-corner-actions (300) — см. html[data-media-full] выше.       *
 * ================================================================== */
.media-overlay {
	position: fixed;
	inset: 0;
	z-index: 190;
	color-scheme: dark;
	color: var(--fg);
	/* --media-pull — доля жеста "потянуть вниз, чтобы закрыть" (этап 3).
	   На этапе 1 всегда 0; переменная объявлена сразу, чтобы правила
	   ниже не переписывались повторно. */
	--media-pull: 0;
}

/* Подложка: не нейтральный rgba(0,0,0,.85), а тот же тёплый угол света,
   что у .message-list — окно принадлежит приложению, а не браузеру. */
.media-overlay-scrim {
	position: absolute;
	inset: 0;
	background:
		radial-gradient(110% 80% at 100% 0%, color-mix(in oklch, var(--accent), transparent 86%), transparent 55%),
		oklch(0.13 0.018 var(--hue) / 0.94);
	backdrop-filter: blur(18px) saturate(120%);
	opacity: calc(1 - var(--media-pull) * 0.85);
}

.media-overlay-viewport {
	position: absolute;
	inset: 0;
	display: flex;
	align-items: center;
	justify-content: center;
	overflow: hidden;
	padding: var(--space-2xl) var(--space-l) calc(var(--space-2xl) + var(--space-l));
	transform: translateY(calc(var(--media-pull) * 180px)) scale(calc(1 - var(--media-pull) * 0.12));
	border-radius: calc(var(--media-pull) * var(--radius-lg));
}

.media-overlay-inner {
	max-inline-size: 100%;
	max-block-size: 100%;
}

/* Хром: две полосы с растяжкой градиента в прозрачность — читаемость
   текста поверх произвольного кадра без сплошной плашки. */
.media-overlay-top,
.media-overlay-bottom {
	position: absolute;
	inset-inline: 0;
	z-index: 2;
	--gap: var(--space-s);
	transition:
		opacity 0.28s var(--ease-io),
		transform 0.28s var(--ease-io);
}

.media-overlay-top {
	inset-block-start: 0;
	align-items: flex-start;
	padding: var(--space-s) var(--space-m);
	padding-block-start: max(var(--space-s), env(safe-area-inset-top));
	background: linear-gradient(oklch(0.12 0.02 var(--hue) / 0.75), transparent);
}

.media-overlay-title span {
	font-size: var(--step-0);
	font-weight: var(--weight-bold);
}

.media-overlay-title small {
	color: var(--muted);
	font-variant-numeric: tabular-nums;
}

.media-overlay-acts {
	--gap: var(--space-3xs);
}

/* Не .icon-btn: тот 2.25rem и рассчитан на светлую поверхность
   (color:var(--fg), подсветка фоном --surface). Здесь кнопка лежит на
   произвольном кадре — нужна своя подложка при наведении и больший
   тач-таргет. */
.media-overlay-btn {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	flex: none;
	inline-size: 2.5rem;
	block-size: 2.5rem;
	padding: 0;
	border: 0;
	border-radius: var(--radius-full);
	background: transparent;
	color: var(--fg);
	font-size: 1.05rem;
	cursor: pointer;
	transition:
		background-color var(--transition-speed) var(--transition-ease),
		transform var(--transition-speed) var(--ease);
}

.media-overlay-btn:hover {
	background-color: color-mix(in oklch, var(--fg), transparent 88%);
}

.media-overlay-btn:active {
	transform: scale(0.92);
}

.media-overlay-btn.is-close:hover {
	background-color: color-mix(in oklch, var(--bad), transparent 55%);
}

/* Стрелки разнесены к краям экрана (приём Lity) — на десктопе угол/кромка
   экрана берётся мышью тривиально. На тач-устройствах кромка занята
   системными жестами и недостижима большим пальцем: там стрелок нет
   вовсе, листание свайпом (этап 3). */
.media-overlay-nav {
	position: absolute;
	inset-block-start: 50%;
	translate: 0 -50%;
	z-index: 2;
	inline-size: 2.75rem;
	block-size: 4.5rem;
	border: 0;
	border-radius: var(--radius-md);
	background: oklch(0.16 0.02 var(--hue) / 0.45);
	backdrop-filter: blur(8px);
	color: var(--fg);
	font-size: 1.25rem;
	cursor: pointer;
	opacity: 0;
	transition:
		opacity 0.25s var(--ease),
		background-color var(--transition-speed) var(--transition-ease);
}

.media-overlay:hover .media-overlay-nav {
	opacity: 1;
}

.media-overlay-nav:focus-visible {
	opacity: 1;
}

.media-overlay-nav:hover {
	background: oklch(0.16 0.02 var(--hue) / 0.75);
}

.media-overlay-nav.is-prev {
	inset-inline-start: var(--space-2xs);
}

.media-overlay-nav.is-next {
	inset-inline-end: var(--space-2xs);
}

.media-overlay-nav[disabled] {
	opacity: 0 !important;
	pointer-events: none;
}

@media (pointer: coarse) {
	.media-overlay-nav {
		display: none;
	}
}

.media-overlay-bottom {
	inset-block-end: 0;
	flex-direction: column;
	padding: var(--space-l) var(--space-m) var(--space-s);
	padding-block-end: max(var(--space-s), env(safe-area-inset-bottom));
	background: linear-gradient(transparent, oklch(0.12 0.02 var(--hue) / 0.8) 42%);
}
```

Мини-бар (`.media-mini-bar*`, строки 2316–2355) на этапе 1 не трогать —
он переделывается на этапе 6.

### 1.4 Локали

Новые ключи в `media.player`: `info` («Сведения»), `close` уже есть как
`common.close`. Новый узел `media.info` заводится на этапе 2. Ключ
`trackOf` дополнить: строка в шапке собирается из `trackOf`, названия
класса (`media.buttons.*` не годится — там «Изображения» с заглавной для
кнопки; завести `media.classNames.{audio,video,image}` в родительном:
«аудио», «видео», «изображения») и уже существующего форматирования
размера (`attachment.units.*`, `formatFileSize` из `attachment-view.jsx` —
экспортирована, импортировать, не дублировать).

Ключи добавить во **все 12 локалей**, не только `ru.json`.

**Воркеру можно отдать:** 1.3 (CSS целиком, механическая замена блока),
1.4 (локали), новые файлы иконок по образцу существующих.
**Воркеру не отдавать:** 1.1, 1.2 — правка JSX рядом с И-A.

### DoD этапа 1

- [ ] Открытие картинки/видео/аудио из чата, поста, канала, файлов — без регрессий
- [ ] Кнопка «закрыть» не перекрывается переключателем темы и бургером
- [ ] После закрытия и после сворачивания `data-media-full` снят с `<html>`
- [ ] Для картинки нет кнопки «свернуть»
- [ ] Стрелок нет при `total === 1`
- [ ] Тема приложения переключается — оверлей остаётся тёмным
- [ ] Смена `--accent-hue` в настройках не ломает подложку

---

## Этап 2 — авто-скрытие хрома и панель сведений

### 2.1 Авто-скрытие

Локальное состояние `chromeVisible` в `media-overlay.jsx` (не в автомате —
это чистая эргономика показа, состояние сессии про неё не знает).
Показывать на `pointermove`/`pointerdown`/`focusin` по оверлею, прятать
таймером 2800 мс. Не прятать, пока панель сведений закреплена. Атрибут
`data-chrome="on|off"` на корне.

```css
.media-overlay[data-chrome="off"] .media-overlay-top,
.media-overlay[data-chrome="off"] .media-overlay-bottom,
.media-overlay[data-chrome="off"] .media-overlay-nav {
	opacity: 0;
	pointer-events: none;
}

.media-overlay[data-chrome="off"] .media-overlay-top {
	transform: translateY(-0.875rem);
}

.media-overlay[data-chrome="off"] .media-overlay-bottom {
	transform: translateY(1rem);
}
```

Таймер очищать в возврате эффекта. При `prefers-reduced-motion: reduce`
переходы уже погашены глобальным override в `minimal.css` — отдельной
ветки не надо.

### 2.2 Панель сведений

Три уровня: в шапке всегда имя и «2 из 7 · изображения · 2,4 МБ»; при
наведении на нижнюю полосу панель раскрывается; кнопка «i» закрепляет её
(единственный способ на тач-устройствах).

Источники полей — важно, что не всё доступно:

| Поле | Откуда | Есть сейчас |
|---|---|---|
| Имя, размер, MIME | `MediaRef` | да |
| SHA-256 | `MediaRef.digest`, первые 4 и последние 4 символа | да |
| Разрешение | `img.naturalWidth/Height`, `video.videoWidth/Height` | только для текущего, после загрузки |
| Длительность | `el.duration` по `loadedmetadata` | только для текущего, после загрузки |
| Отправитель, дата | нигде | нет, см. этап 5 |

Виды поднимают факты наверх колбэком `onMeta({ width, height, duration })`
из обработчиков `onLoadedMetadata` / `onLoad`. Состояние — локальное в
`media-overlay.jsx`, сбрасывать при смене `mediaRef.digest`. В автомат не
класть.

Раскрытие — приём `grid-template-rows: 0fr -> 1fr`, он анимируется, в
отличие от `height: auto`:

```css
.media-overlay-info {
	display: grid;
	grid-template-rows: 0fr;
	transition: grid-template-rows 0.34s var(--ease);
}

.media-overlay-bottom:hover .media-overlay-info,
.media-overlay[data-info="on"] .media-overlay-info {
	grid-template-rows: 1fr;
}

.media-overlay-info > div {
	overflow: hidden;
	min-block-size: 0;
}

.media-overlay-meta {
	--gap: var(--space-3xs);
	flex-wrap: wrap;
	padding-block-end: var(--space-2xs);
}

/* Не .chip: тот на var(--surface) и рассчитан на светлый фон. */
.media-overlay-meta span {
	padding: 3px var(--space-2xs);
	border-radius: var(--radius-full);
	background: color-mix(in oklch, var(--fg), transparent 90%);
	font-size: var(--step--1);
	white-space: nowrap;
	font-variant-numeric: tabular-nums;
}

.media-overlay-meta span b {
	font-weight: var(--weight-normal);
	color: var(--muted);
	margin-inline-end: var(--space-3xs);
}
```

Новый узел локалей `media.info`: `size`, `type`, `resolution`, `duration`,
`hash`. Значения — подписи полей («Размер», «Тип», «Разрешение»,
«Длительность», «SHA-256»).

**Воркеру можно отдать:** CSS обоих подпунктов, ключи локалей.
**Воркеру не отдавать:** таймер и колбэк метаданных.

### DoD этапа 2

- [ ] Хром уходит через 2,8 с бездействия, возвращается на движение мыши
- [ ] Хром не уходит при закреплённой панели
- [ ] Таймер не течёт при быстром next/prev и при закрытии
- [ ] Разрешение и длительность появляются после загрузки, не мигают «—» после
- [ ] При next/prev старые значения не показываются рядом с новым файлом
- [ ] С клавиатуры Tab доводит до всех кнопок, фокус виден

---

## Этап 3 — жесты и анимация открытия

Самый рискованный этап. Отдельный коммит, отдельная живая проверка на
телефоне.

### 3.1 Свайп по горизонтали

Pointer Events, не Touch Events — одна реализация на мышь и палец.
`setPointerCapture` на `pointerdown`, ось определяется после порога 8 px и
дальше не меняется до `pointerup`. Игнорировать нажатия, начавшиеся на
`button` или на нативных `controls` — иначе перемотка видео превратится в
листание (проверять `e.target.closest("button, video, audio")`).

Порог срабатывания: 16 % ширины окна. Меньше — возврат на место.

Для `cls === "image"` — лента: контейнер `.media-overlay-track` с тремя
слайдами из окна `allocWindow` (`l..r`), `translate3d`, во время
перетаскивания `transition: none`, после — `0.42s var(--ease)`. На краях
плейлиста сопротивление: смещение умножается на 0.3.

Для `audio`/`video` — И-B: ленты нет, свайп по достижении порога просто
зовёт `mediaNext`/`mediaPrev`, `.media-overlay-inner` получает класс на
время перехода и делает `opacity 0 -> 1` за 0.2 с. `<View>` при этом не
пересоздаётся (И-A) — меняется только `mediaRef`.

### 3.2 Свайп вниз — закрытие

Если ось вертикальная и `dy > 0` — писать `--media-pull` = `min(1, dy/260)`
на корень. Правила из этапа 1 уже читают эту переменную: подложка гаснет,
окно уезжает и скругляется. Отпустили при `dy > 110` — `closeMedia()`,
иначе `--media-pull` в 0 с переходом.

Свайп вверх не задействовать — оставить свободным.

### 3.3 Открытие из миниатюры

`openMedia` уже вызывается из шести мест; ни одно из них не передаёт
геометрию. Добавлять параметр в сигнатуру автомата нельзя (И-0: логика не
меняется). Вместо этого — модуль `src/ui/signals/media-origin.js`: обычный
`let`, куда вызывающая сторона перед `openMedia` кладёт
`event.currentTarget.getBoundingClientRect()`, и который оверлей читает
один раз при монтировании и обнуляет.

Анимация — Web Animations API на `.media-overlay-viewport`, от смещения и
`scale(0.35)` к единице, 420 мс, `cubic-bezier(0.22, 0.61, 0.36, 1)` (это
`--ease`, в WAAPI переменные не читаются — литерал). Если геометрии нет
(открытие кнопкой класса из `media-buttons.jsx`) — обычное проявление.

Закрытие — зеркально, 200 мс, но `closeMedia()` вызывать **после**
`animation.finished`, иначе состояние уйдёт раньше кадра. Обязательно
`.catch(() => {})` — анимация отменяется, если оверлей размонтируют
раньше.

### 3.4 Клавиатура

`Escape` уже обработан. Добавить `ArrowLeft`/`ArrowRight` → `mediaPrev`/
`mediaNext`, `Space` → `mediaToggle` с `preventDefault` (иначе прокрутка
страницы под оверлеем). Только при `display === "full"`.

**Воркеру не отдавать ничего из этапа 3.**

### DoD этапа 3

- [ ] Свайп листает на реальном телефоне, а не только в эмуляции
- [ ] Перемотка нативного `<video>` пальцем работает, не превращается в листание
- [ ] Свайп вниз закрывает; на полпути отпустил — вернулось
- [ ] Ось не «перескакивает» на диагональном движении
- [ ] Быстрый свайп на краю плейлиста не оставляет ленту смещённой
- [ ] Открытие из миниатюры и открытие кнопкой класса оба выглядят прилично
- [ ] Закрытие во время анимации открытия не роняет консоль
- [ ] Аудио продолжает играть при листании (И-A не сломан)

---

## Этап 4 — плёнка миниатюр, только для изображений

`thumbnails.js` работает только с `image/*` (это зафиксировано
комментарием в самом модуле), а в чате картинки уже расшифрованы и лежат в
`attachment-memory-cache.js` — `getMemoryCachedUrl(digest)` отдаёт готовый
URL без сети и без расшифровки. Значит плёнка для класса `image`
достаётся почти бесплатно.

Для `audio` и `video` плёнки нет: превью не существует, а тащить кадр из
видео — отдельный механизм, который явно вынесен за рамки. Там в нижней
полосе остаётся только панель сведений.

Плёнка строится по `playlist.idx.image` — это `Int32Array` позиций,
переход по клику: `openMedia` не звать (сессия уже открыта), а
дёргать `mediaNext`/`mediaPrev` нужное число раз нельзя — это N переходов
автомата. Нужен новый экспорт `mediaGoTo(position)` в `signals/media.js`,
который зовёт `dispatch("open", { cls, position })` — событие `open` уже
умеет ставить произвольную позицию, новый обработчик в автомат не
добавляется. Проверить, что `resourceOwner.sync` при этом отпускает
лишнее.

```css
.media-overlay-strip {
	--gap: var(--space-3xs);
	scrollbar-width: none;
	padding-block: 2px;
}

.media-overlay-strip::-webkit-scrollbar {
	display: none;
}

.media-overlay-thumb {
	flex: none;
	inline-size: 3.25rem;
	block-size: 3.25rem;
	padding: 0;
	border: 0;
	border-radius: var(--radius);
	overflow: hidden;
	cursor: pointer;
	opacity: 0.5;
	transition:
		opacity 0.25s var(--ease),
		transform 0.25s var(--ease),
		box-shadow 0.25s var(--ease);
}

.media-overlay-thumb:hover {
	opacity: 0.85;
}

.media-overlay-thumb[aria-current="true"] {
	opacity: 1;
	transform: translateY(-2px);
	box-shadow: 0 0 0 2px var(--accent);
}

.media-overlay-thumb img {
	inline-size: 100%;
	block-size: 100%;
	object-fit: cover;
}
```

Плёнка — `.reel` из слоя composition (уже даёт `overflow-x: auto`).
Активная миниатюра — `scrollIntoView({ block: "nearest", inline: "center" })`.

**Воркеру можно отдать:** CSS.
**Воркеру не отдавать:** `mediaGoTo` и проверку владения ресурсами.

### DoD этапа 4

- [ ] Плёнка есть у картинок, отсутствует у аудио и видео
- [ ] Миниатюры, которых нет в памяти, не роняют компонент и не тянут сеть
- [ ] Переход по клику не увеличивает число удерживаемых ресурсов
- [ ] Активная миниатюра сама доезжает до центра при листании стрелками

---

## Этап 5 — необязательный: отправитель и дата

Только если решишь, что поля нужны. Иначе этап целиком выкинуть.

`collectChatScope(messages)` уже имеет `message` под рукой; добавить в
`sourceMeta` поля `authorPubkey` и `createdAt` рядом с `msgId`. То же для
`collectPostScope`. Осторожно: `findRefPosition` сравнивает `sourceMeta`
**по значению** через `sourceMetaEquals`, перебирая объединение ключей —
вызывающая сторона строит `sourceMeta` заново, и если она построит его без
новых полей, сравнение перестанет находить позицию. То есть править надо
**обе** стороны одновременно: и сборщик, и все шесть мест вызова
`findRefPosition`. Это и есть цена этапа; она заметно выше, чем кажется.

Имя отправителя резолвить тем же способом, что в баблах чата, — не тащить
новый источник.

### DoD этапа 5

- [ ] Открытие по клику попадает в правильную позицию во всех шести местах вызова
- [ ] Файлы (`collectFolderScope`) не сломались — там ни автора, ни даты нет

---

## Этап 6 — мини-бар

Перерисовать `.media-mini-bar` в ту же плотность, что остальной хром:
превью 2.25rem, имя в одну строку, три кнопки `.media-overlay-btn`
уменьшенного размера, тень `--shadow` вместо литерального
`rgba(0,0,0,.25)`, скругление `--radius-md`, появление —
`transform: translateY(10px) scale(.96)` + `opacity` за 0.3 с `var(--ease)`.

Для аудио вместо пустой рамки — иконка ноты на подложке акцента (сейчас
`IconMusicNote` лежит внутри `.media-mini-bar-preview` без фона).
Мини-бар остаётся `role="status"` и остаётся ниже `.call-overlay`.

Показывать время: `el.currentTime / el.duration` через тот же колбэк
`onMeta`, что на этапе 2, плюс `onTimeUpdate`. Только в мини-баре —
в полном виде за это отвечают нативные `controls`.

**Воркеру можно отдать целиком**, кроме проводки `onTimeUpdate`.

---

## Что сознательно не делается

- Свои контролы вместо нативных `controls` у `<video>`. Нативные некрасивы,
  но дают перемотку, громкость, скорость, картинку-в-картинке, субтитры и
  полноэкранный режим бесплатно и доступно. Своя панель — отдельный
  разговор после того, как остальное встанет.
- Зум и панорамирование картинки. Просится, но конфликтует с горизонтальным
  свайпом: понадобится различать один и два пальца, а это уже полноценный
  жестовый слой.
- Миниатюра кадра видео. Требует своего механизма поверх Range-моста.
- Инерция после свайпа. Учёт скорости добавляет ещё один параметр к порогу
  срабатывания; сперва проверить, что хватает порога по расстоянию.
- Правки `media-machine.js`, `playlist.js`, `scope.js` (кроме этапа 5) и
  `media-url.js`. Если этап требует их тронуть — этап спроектирован неверно,
  остановись и скажи.

---

## Порядок сессий Claude Code

Этапы 1–2 можно в одной сессии (`/clear` между ними). Этап 3 — только
отдельная сессия целиком, он занимает всё внимание. Этапы 4 и 6 — вместе.
Этап 5 — отдельно и только по решению.

После каждого этапа: `git commit` с отметкой в DoD-чеклисте, как ты уже
делаешь для этапов A–F.
