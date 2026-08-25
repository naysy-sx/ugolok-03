# ТЗ: перевод всех иконок на Phosphor

**Куда положить файл:** `PROCESS-DOCS/REDESIGN/ICONS-PHOSPHOR.md`
**Сверочный лист:** `icons-phosphor.html` (даётся отдельно, в сборку не идёт —
там текущая иконка и предлагаемая замена стоят рядом)

---

## 0. Правила работы для исполнителя

1. **Не импровизируй.** Ниже — полный текст скрипта-генератора и таблица
   соответствия. Ни одного имени иконки не подбирай «на глаз»: если
   нужного файла нет в ассетах, скрипт обязан упасть с явной ошибкой, а
   не подставить похожий.
2. **Не расширяй область работы.** Смысл иконок не меняется: где стояла
   корзина — будет корзина Phosphor. Заменить «неудачную» иконку другой
   по смыслу — отдельное решение, не эта задача (§8 п.1).
3. **Порядок этапов строгий:** §2 → §3 → §4 → §5 → §6 → §7.
   После каждого — `npm run build`, бандл не должен вырасти.
4. Комментарии в коде — на русском, объясняют ПРИЧИНУ.

---

## 1. Что сейчас и почему это надо чинить

В `src/ui/icons/` 71 файл, импортируемых из 115 мест. Набор собран из
трёх источников:

- 57 файлов с `viewBox="0 0 15 15"` — Radix Icons и самописные под них;
- 13 файлов с `viewBox="0 0 24 24"` — Feather и надёрганное из разных
  наборов;
- 1 файл с `viewBox="0 0 16 16"`;
- 22 файла обводочные (`stroke`), 55 заливные (`fill`) — часть файлов
  смешивает и то и другое внутри себя.

Три разных сетки, две разных техники рисования и три разных
геометрических стиля в одном интерфейсе — их видно рядом в любой панели
действий. Плюс исторический след: в `custom.css` (строка ~42) стоит
комментарий про удалённое правило `.icon path { stroke-width: .6 }`,
из-за которого три иконки (`cross`, `nav-prev`, `minimize`) пришлось
рисовать через `<line>`/`<polyline>`/`<rect>`, обходя `<path>` стороной.
Единый набор эту категорию проблем закрывает целиком.

---

## 2. Способ подключения: генератор, а не зависимость

**Не устанавливай `@phosphor-icons/react`.** Это runtime-зависимость на
девять тысяч компонентов ради семидесяти одного; даже при исправном
tree-shaking она тащит в сборку обёртки, контекст и типы, а проект держит
бюджет бандла.

Вместо этого:

1. `npm i -D @phosphor-icons/core` — это **только SVG-ассеты**, никакого
   исполняемого кода. Ставится в `devDependencies`, в бандл не попадает.
2. Одноразовый скрипт `scripts/gen-icons.mjs` читает таблицу
   соответствия и генерирует `src/ui/icons/*.jsx` из настоящих
   ассетов.
3. Сгенерированные `.jsx` **коммитятся в репозиторий**. Зависимость
   нужна только для повторной генерации; сборка от неё не зависит.

Формат ассетов Phosphor (проверено на реальном файле, не по памяти):

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" fill="currentColor"><path d="..."/></svg>
```

То есть начертание `regular` — **заливные пути**, `fill="currentColor"`
уже на корне, один `<path>`, никаких `stroke-width`. Это существенно
упрощает дело: вся возня с толщиной обводки, из-за которой в проекте
появились `<line>`-обходы, отпадает сама.

Файлы других начертаний называются с суффиксом: `assets/fill/star-fill.svg`,
`assets/bold/star-bold.svg`.

---

## 3. Выбор начертания

**Основное начертание — `regular`, для всего набора без исключений.**

**`fill` — только для состояния «включено/выбрано»** и только там, где
такое состояние есть на самом деле. В проекте это:

| Иконка | Где | Зачем `fill` |
|---|---|---|
| `star` | `.fav-toggle` (избранное) | залитая звезда = в избранном, контурная = нет |
| `bell` | уведомления канала, если есть состояние вкл/выкл | то же |

Больше нигде. Если по ходу работы покажется, что «здесь тоже пригодилось
бы залитое» — не добавляй, напиши в отчёте.

Начертания `thin`, `light`, `bold`, `duotone` **не используются вовсе.**
Смысл перехода на один набор в том, чтобы вариантов стало меньше, а не
больше.

---

## 4. Базовый компонент

Создай `src/ui/icons/icon.jsx`:

```jsx
// Единственное место, где живёт обвязка <svg> для всех иконок проекта.
// До перехода на Phosphor эти семь атрибутов были скопированы в 71 файл
// по отдельности — и разъехались: три разных viewBox, где-то fill="none"
// на корне, где-то нет, где-то забыт aria-hidden.
//
// class="icon" — часть публичного контракта оформительского слоя:
// на него завязаны .icon-btn .icon (flex:none + min-width, фикс
// flex-автоминимума для SVG) и глобальное button:has(> .icon)
// (inline-flex + gap + padding-inline). Менять имя класса нельзя.
//
// props идут ПОСЛЕ всех атрибутов — вызывающий может переопределить
// любой, включая class и aria-hidden (иконка в роли единственного
// содержимого кнопки иногда должна быть озвучена).
export default function Icon({ path, ...props }) {
	return (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			viewBox="0 0 256 256"
			fill="currentColor"
			width="1em"
			height="1em"
			aria-hidden="true"
			class="icon"
			{...props}
		>
			<path d={path} />
		</svg>
	);
}
```

Сгенерированные иконки выглядят так (пример того, что должен выдать
скрипт):

```jsx
// Phosphor Icons (MIT) — funnel, начертание regular.
// Сгенерировано scripts/gen-icons.mjs. Руками не править: правка
// потеряется при следующей генерации. Менять — в таблице соответствия
// внутри скрипта.
import Icon from "./icon.jsx";

const PATH = "M230.6,49.53A15.81,15.81,0,0,0,216,40H40A16,16,0,0,0,28.19,66.76l.08.09L96,139.17V216a16,16,0,0,0,24.87,13.32l32-21.34A16,16,0,0,0,160,194.66V139.17l67.74-72.32.08-.09A15.8,15.8,0,0,0,230.6,49.53ZM40,56h0Zm106.18,74.58A8,8,0,0,0,144,136v58.66L112,216V136a8,8,0,0,0-2.16-5.47L40,56H216Z";

export default function IconFunnel(props) {
	return <Icon path={PATH} {...props} />;
}
```

Имена компонентов и имена файлов **не меняются ни на один символ** —
`funnel.jsx` остаётся `funnel.jsx`, `IconFunnel` остаётся `IconFunnel`.
Иначе пришлось бы править 115 мест импорта, и это была бы совсем другая
задача по риску.

---

## 5. Скрипт `scripts/gen-icons.mjs`

```js
// Одноразовый (и повторяемый) генератор иконок из ассетов Phosphor.
// Запуск: node scripts/gen-icons.mjs
//
// Почему генератор, а не рукописные файлы: 71 иконка × 2 начертания —
// это ровно тот объём, где ручное копирование path'ов гарантированно
// даёт опечатку, которую никто не заметит, пока иконка не окажется на
// экране. Скрипт ещё и проверяет, что каждое имя реально существует в
// наборе, — подстановки "похожей" иконки быть не может.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ASSETS = "node_modules/@phosphor-icons/core/assets";
const OUT = "src/ui/icons";

// файл проекта -> имя иконки в Phosphor. Порядок алфавитный, чтобы diff
// генерации был читаемым.
const MAP = {
	"activity-log": "notebook",
	"arrow-left": "arrow-left",
	bell: "bell",
	calendar: "calendar-blank",
	"chat-bubble": "chat-circle",
	check: "check",
	"chevron-down": "caret-down",
	"chevron-left": "caret-left",
	"chevron-right": "caret-right",
	compass: "compass",
	copy: "copy",
	"corner-back": "arrow-u-up-left",
	cross: "x",
	"dots-horizontal": "dots-three",
	"dots-vertical": "dots-three-vertical",
	"envelope-closed": "envelope",
	eraser: "eraser",
	exit: "sign-out",
	eye: "eye",
	"file-text": "file-text",
	flag: "flag",
	folder: "folder",
	"format-bold": "text-b",
	"format-code": "code",
	"format-heading": "text-h",
	"format-italic": "text-italic",
	"format-link": "link",
	"format-list": "list-bullets",
	"format-quote": "quotes",
	funnel: "funnel",
	gear: "gear",
	globe: "globe",
	"help-circle": "question",
	"image-icon": "image",
	"info-circle": "info",
	key: "key",
	"lock-closed": "lock",
	"log-out": "sign-out",
	"magnifying-glass": "magnifying-glass",
	microphone: "microphone",
	minimize: "arrows-in-simple",
	moon: "moon",
	"music-note": "music-note",
	"nav-next": "caret-right",
	"nav-prev": "caret-left",
	paperclip: "paperclip",
	pencil: "pencil-simple",
	people: "users",
	"person-add": "user-plus",
	person: "user",
	"phone-call": "phone",
	"player-pause": "pause",
	"player-play": "play",
	plus: "plus",
	power: "power",
	"quick-room-people": "users-three",
	reader: "article",
	"repeat-once": "repeat-once",
	repeat: "repeat",
	restore: "arrow-counter-clockwise",
	send: "paper-plane-tilt",
	server: "hard-drives",
	shield: "shield-check",
	"speaker-loud": "speaker-high",
	star: "star",
	stop: "stop",
	sun: "sun",
	trash: "trash",
	"user-badge": "identification-badge",
	"video-camera": "video-camera",
	"voice-broadcast": "broadcast",
};

// Залитое начертание — только там, где есть состояние "включено".
// Даёт дополнительный файл <имя>-fill.jsx рядом с обычным.
const FILLED = ["star", "bell"];

function componentName(stem) {
	return "Icon" + stem.split(/[-_]/).map((p) => p[0].toUpperCase() + p.slice(1)).join("");
}

function readPath(phosphorName, weight) {
	const suffix = weight === "regular" ? "" : `-${weight}`;
	const file = join(ASSETS, weight, `${phosphorName}${suffix}.svg`);
	if (!existsSync(file)) {
		throw new Error(`нет ассета: ${file} — проверь имя в MAP по https://phosphoricons.com/`);
	}
	const svg = readFileSync(file, "utf8");
	// Ассеты Phosphor — один <path> внутри <svg fill="currentColor">.
	// Если формат когда-нибудь изменится (несколько путей, <circle>),
	// падаем громко, а не молча теряем часть рисунка.
	const paths = [...svg.matchAll(/<path[^>]*\sd="([^"]+)"/g)].map((m) => m[1]);
	if (paths.length !== 1) {
		throw new Error(`${file}: ожидался ровно один <path>, найдено ${paths.length}`);
	}
	if (/<(circle|rect|line|polyline|polygon|ellipse)\b/.test(svg.replace(/<rect[^>]*fill="none"[^>]*\/>/g, ""))) {
		throw new Error(`${file}: в ассете есть фигуры кроме <path> — базовый Icon их не отрисует`);
	}
	return paths[0];
}

function emit(stem, phosphorName, weight) {
	const d = readPath(phosphorName, weight);
	const fileStem = weight === "regular" ? stem : `${stem}-${weight}`;
	const name = weight === "regular" ? componentName(stem) : componentName(stem) + "Fill";
	const body = `// Phosphor Icons (MIT) — ${phosphorName}, начертание ${weight}.
// Сгенерировано scripts/gen-icons.mjs. Руками не править: правка
// потеряется при следующей генерации. Менять — в таблице MAP скрипта.
import Icon from "./icon.jsx";

const PATH =
\t"${d}";

export default function ${name}(props) {
\treturn <Icon path={PATH} {...props} />;
}
`;
	writeFileSync(join(OUT, `${fileStem}.jsx`), body);
	return fileStem;
}

const written = [];
for (const [stem, phosphorName] of Object.entries(MAP)) {
	written.push(emit(stem, phosphorName, "regular"));
}
for (const stem of FILLED) {
	written.push(emit(stem, MAP[stem], "fill"));
}
console.log(`сгенерировано ${written.length} файлов`);
```

Добавь в `package.json`:

```json
"scripts": {
	"gen:icons": "node scripts/gen-icons.mjs"
}
```

---

## 6. Что делать после генерации

### 6.1. Проверить, что ничего не потерялось

```
ls src/ui/icons/*.jsx | wc -l      # должно быть 71 + icon.jsx + 2 fill = 74
npm run build                       # должен пройти
grep -rn "viewBox=\"0 0 15 15\"\|viewBox=\"0 0 24 24\"\|viewBox=\"0 0 16 16\"" src/
```

Последняя команда должна вернуть **пусто**. Если что-то осталось — значит
файл не попал в `MAP`; допиши его туда, не правь руками.

### 6.2. Проверить размер бандла

`npm run build` до и после, сравнить. Ожидание: **бандл слегка
уменьшится.** Пути Phosphor длиннее радиксовых, но исчезает обвязка
`<svg>`, повторённая 71 раз, и уходят `<circle>`/`<line>`/`<polyline>`
из самописных. Если бандл вырос больше чем на 3 КБ gzip — остановись и
напиши об этом в отчёте, не продолжай.

### 6.3. Оптический размер — проверить живьём, не на глаз по коду

У Radix Icons рисунок занимает почти всю сетку 15×15. У Phosphor вокруг
рисунка в сетке 256 есть заметное поле. При одинаковом `width: 1em`
иконка Phosphor будет читаться **мельче** прежней — примерно на десятую
часть.

Не подгоняй это заранее. Сначала собери, посмотри вживую в
`.icon-btn`, в кнопке с текстом и в заголовке панели. Если мелко —
единственная правка, в `custom.css`, рядом с существующими правилами
`.icon`:

```css
/* Phosphor рисует в сетке 256 с полем вокруг рисунка, Radix рисовал
   почти в край 15×15 — при одинаковом 1em иконка стала оптически
   мельче. Поднимаем кегль иконки, а не переопределяем size в 74
   файлах. Значение подобрано живьём, не расчётом. */
.icon {
	inline-size: 1.15em;
	block-size: 1.15em;
}
```

Точное число подбери сам по виду. Это ровно тот случай, который
`MOLECULES.md` описывает в «граблях» п.5: пороги и размеры проверяются на
реальном экране до того, как уходят в код.

### 6.4. Убрать след старого правила

В `custom.css` рядом со строкой ~42 лежит комментарий на 10 строк про
удалённое `.icon path { stroke-width: .6 }` и про то, что из-за него
`cross`/`nav-prev`/`minimize` пришлось рисовать через `<line>`/
`<polyline>`/`<rect>`. Комментарий сохраняет ценную историю, но три
названных файла теперь заливные, и оговорка про них устарела.

Сократи комментарий до двух предложений: что правило было, чем било и
что снято. Ссылки на конкретные файлы убери — их больше нет в том виде.

### 6.5. Лицензия

Phosphor Icons распространяется по MIT — атрибуция обязательна. Создай
или дополни `LICENSES.md` в корне репозитория:

```
## Phosphor Icons

Иконки интерфейса — Phosphor Icons, лицензия MIT.
https://github.com/phosphor-icons/core
Copyright (c) 2023 Phosphor Icons

<полный текст лицензии MIT из node_modules/@phosphor-icons/core/LICENSE>
```

Если в файле уже есть блок про Radix Icons или Feather — **не удаляй
его.** Прежние иконки были в сборках, которые уже раздавались; запись об
этом остаётся, с пометкой, что набор заменён и с какой версии.

---

## 7. Приёмка

Отчитайся по каждому пункту явным «да»/«нет»:

- [ ] `npm run gen:icons` отрабатывает без ошибок и повторный запуск даёт
      побайтово те же файлы (генерация детерминирована)
- [ ] `npm test` — зелёный
- [ ] `npm run build` — проходит, бандл не вырос больше чем на 3 КБ gzip
      (указать цифры до и после)
- [ ] `grep -rn "viewBox=\"0 0 15 15\"\|viewBox=\"0 0 24 24\"\|viewBox=\"0 0 16 16\"" src/` — пусто
- [ ] `grep -rn "<line\|<polyline\|<circle\|<rect" src/ui/icons/` — пусто
- [ ] `grep -rn "stroke-width\|strokeWidth" src/ui/icons/` — пусто
- [ ] Ни один файл в `src/ui/icons/` не переименован, ни одно имя
      компонента не изменилось; `grep -rn "from \"../icons/" src/` даёт
      столько же попаданий, сколько до работы
- [ ] `LICENSES.md` содержит блок Phosphor с полным текстом MIT
- [ ] Визуально проверены и названы в отчёте: панель действий любого
      экрана, `.icon-btn` в списке контактов, кнопка с иконкой и текстом,
      заголовок панели в «Настройках», панель форматирования редактора
- [ ] Указано, понадобилась ли правка `.icon` из §6.3 и какое значение
      выбрано

---

## 8. Открытые вопросы — НЕ реализовывать

1. **Смысловые замены.** Таблица меняет только рисунок, не значение.
   Например `activity-log → notebook` для «Журнала» и
   `server → hard-drives` для раздела серверов — это ближайшие аналоги, а
   не обязательно лучший выбор. Сверочный лист `icons-phosphor.html`
   существует именно для того, чтобы пользователь посмотрел и сказал, где
   поменять. Своей инициативой не менять.
2. **Дубликаты в наборе.** После сведения к Phosphor три пары указывают
   на одну и ту же иконку: `exit` и `log-out` → `sign-out`,
   `chevron-right` и `nav-next` → `caret-right`, `chevron-left` и
   `nav-prev` → `caret-left`. Слить их в один файл — правка мест
   импорта, отдельная задача. Сейчас оставить как есть: два файла с
   одинаковым содержимым дешевле, чем 30 правок вызовов в этой же
   задаче.
3. **`duotone` для состояний.** Phosphor даёт двухтоновое начертание,
   которым принято показывать «активно» вместо залитого. Может оказаться
   уместнее `fill` для избранного и уведомлений — но это решение о
   языке интерфейса, не о миграции.
4. **Иконки в маркетинговых страницах и `design-system.html`** — если
   там встречаются старые SVG, их эта задача не трогает.
