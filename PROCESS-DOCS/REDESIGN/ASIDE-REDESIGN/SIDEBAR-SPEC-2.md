# ТЗ-2: боковая панель — переработка верха, списка и нижнего блока

Эталон: `PROCESS-DOCS/REDESIGN/aside-final.html` (положи туда приложенный файл
до начала работы). Расхождения между эталоном и этим текстом решаются в пользу
**этого текста**.

Это продолжение `SIDEBAR-SPEC.md`, чьи изменения уже в ветке (коммит 24d35ee).
Всё, что там сделано, остаётся в силе; ниже — только правки поверх.

---

## 0. Правило, которое действует и здесь

`minimal.css` лежит в `@layer`, `custom.css` — вне слоёв, поэтому побеждает
**посвойственно**. Любое свойство, которое класс не объявил, молча приходит из
`@layer elements`.

> **Для каждого элемента с классом выпиши все свойства, которые
> `@layer elements` задаёт его тегу, и объяви их явно — даже если значение
> совпадает.**

Особенно `button` (`background`, `color`, `border`, `padding`, `font`),
`summary` (`list-style`, `cursor`, `font-weight`), `p`, `ul`, `input`.

Раскладка — только существующими композиционными классами
(`stack` / `bar` / `grow` / `rigid` / `scroller` / `truncate`). Новых
композиционных классов не заводить. Параметры — переменными.

---

## 1. Что меняется, коротко

1. Поиск занимает всю ширину; колокольчик и «плюс» из строки поиска убраны.
2. Меню учётной записи переезжает с многоточия на имя с шевроном.
3. Ключ показан строкой `npub1…`; порядок в карточке — имя → биография → ключ.
4. Журнал становится пунктом меню учётной записи; на имени зажигается точка.
5. В строках списка — точка непрочитанного на аватаре, сумма в заголовке группы.
6. Флажок закрепления заменён звездой.
7. «Знакомства» — постоянная первая строка списка.
8. Внизу панели — «Добавить контакт» вместо «плюса», рядом «Быстрая связь».
9. Пустой список показывает приглашение вместо пустоты.

---

## 2. Файлы

| Файл | Что делаем |
|---|---|
| `src/ui/components/account-card.jsx` | меню на имени, порядок блоков, строка ключа, пункт «Журнал» |
| `src/ui/components/nav-groups.jsx` | строка поиска, «Знакомства», звезда, точки непрочитанного, пустое состояние |
| `src/ui/screens/contacts.jsx` | вынести секцию «Обзор» в отдельный экран, автофокус поля добавления |
| `src/ui/screens/discovery.jsx` | **новый** — экран «Знакомства» |
| `src/ui/router.js` | маршрут `discovery`, поле `focus` у `contacts` |
| `src/app.jsx` | нижний блок панели, передача `unreadJournalCount` в карточку |
| `src/ui/signals/notifications.js` | пер-элементные счётчики непрочитанного |
| `src/styles/custom.css` | основной объём |
| `src/ui/i18n/locales/*.json` | новые ключи (12 файлов) |

---

## 3. Карточка учётной записи

### 3.1 Порядок и структура

Было: портрет → строка `имя + иконка ключа + троеточие` → биография.
Стало: портрет → `имя ▾` → биография → строка ключа.

Обоснование порядка, чтобы оно не потерялось: имя и биография — одно
высказывание человека о себе, читаются подряд. Ключ к этому высказыванию не
относится, это техническая деталь и действие; врезаясь между именем и
биографией, он рвал фразу пополам.

### 3.2 Меню на имени

Многоточие удаляется полностью. Триггером становится имя с шевроном.

Обоснование: подобрать иконку для «меню учётной записи» нельзя в принципе —
это не действие с предметом, а набор разнородных пунктов. Имя уже стоит на
экране, ничего не стоит дополнительно и само сообщает область действия меню.

```jsx
<details class="account-menu" ref={menuRef} onClick={handleMenuClick}>
	<summary aria-label={t("account.menuAria")}>
		<span class="account-trigger">
			<strong class="account-name truncate" title={login || id}>
				{login || id.slice(0, 16) + "…"}
			</strong>
			{unreadJournalCount > 0 && <span class="unread-dot" aria-hidden="true" />}
			<span class="account-chev" aria-hidden="true"><IconChevronDown /></span>
		</span>
	</summary>
	<div class="menu-pop stack" style={{ "--gap": "0" }}>…</div>
</details>
```

Внимание: `<summary>` не должен получать класс `icon-btn` — он больше не
кнопка-иконка. Внутренний `<span class="account-trigger">` нужен затем, чтобы
подложка при наведении обнимала имя, а не всю ширину карточки.

`.menu-pop` у этого меню прижимается к **левому** краю
(`inset-inline-start: 0`), а не к правому: триггер теперь слева.

### 3.3 Пункт «Журнал» в меню

Колокольчик из строки поиска убирается. Вместо него — пункт в меню
учётной записи, второй группой, со счётчиком справа. Когда
`unreadJournalCount > 0`, на триггере рядом с именем горит точка.

Обоснование: журнал — лента тех же событий, о которых уже сообщают точки в
списке чатов. Человек узнавал о новом дважды.

`unreadJournalCount` теперь нужен в `account-card.jsx` — прокинь его из
`app.jsx` тем же путём, что сейчас идёт в `NavGroups`.

### 3.4 Строка ключа

```jsx
<button type="button" class="account-key" onClick={handleCopyKey} title={t("account.copyKeyAria")}>
	<span class="grow truncate">{shortNpub(id)}</span>
	<IconCopy />
</button>
```

`shortNpub` — `npubEncode(id)`, обрезанный до вида `npub1q8v…f30d`
(первые 9 символов, многоточие, последние 4). Обрезка **по фиксированному
числу символов здесь допустима**, потому что npub — bech32, алфавит
фиксированной ширины, и это не текст произвольной длины. Полный ключ
кладётся в буфер целиком.

Моноширинное начертание обязательно: оно отличает ключ от логина строкой выше
и не даёт спутать одно с другим.

---

## 4. Строка поиска

```jsx
<div class="sidebar-row">
	<label class="visually-hidden" for={searchId}>{t("shell.searchLabel")}</label>
	<div class="file-search-field">
		<IconMagnifyingGlass aria-hidden="true" />
		<input id={searchId} type="search" placeholder={t("shell.searchPlaceholder")} … />
	</div>
</div>
```

Поле занимает всю ширину строки. `.bar` вокруг больше не нужен — в строке
один элемент. Компонент `AddMenu` **удалить целиком**: оба его пункта вели на
экран, где нужная кнопка уже существует (это записано в комментарии к нему в
текущем коде), то есть меню экономило ноль нажатий.

---

## 5. Список

### 5.1 «Знакомства» первой строкой

Постоянный пункт над группой «Люди», внутри `.pane__body`, но до первой
группы:

```jsx
<ul class="stack" style={{ "--gap": "1px" }}>
	<li class="discover-row">
		<button type="button" class="discover" onClick={() => goTo({ kind: "discovery" })}>
			<span class="discover-mark"><IconCompass /></span>
			<span class="stream__name">{t("shell.discoverHeading")}</span>
		</button>
	</li>
</ul>
```

**Иконку лупы не использовать** — лупа занята поиском строкой выше, и два
значения одного значка на одном экране путают. Нужен компас либо два силуэта
рядом; заведи новый файл в `src/ui/icons/`.

Раздел сейчас живёт секцией `DiscoverySection` внутри `contacts.jsx`
(комментарий там говорит, что она переехала из `discovery.jsx`). Верни её в
отдельный экран `src/ui/screens/discovery.jsx` и заведи маршрут
`{ kind: "discovery" }`. В `contacts.jsx` секция при этом убирается —
дублировать не нужно.

Название раздела в интерфейсе — **«Знакомства»**, не «Обзор». «Обзор» звучит
как сводка или статистика и не сообщает, что там люди.

### 5.2 Непрочитанное

В строке — точка на аватаре, число не показываем. В заголовке группы — сумма
по группе.

Обоснование: при ширине панели 16rem счётчик в строке отнимает у имени около
четверти ширины, а число по конкретному чату полезно только при выборе, что
читать первым. «Где вообще есть новое» точка сообщает так же надёжно.
Побочная выгода: у свёрнутой группы сумма остаётся видна.

Данные. `notifications.js` уже считает суммы (`unreadMessagesCount`,
`unreadChannelsCount`), но не по элементам. Добавь сигналы-карты:

```js
export const unreadByContact = signal({});  // { pubkey: count }
export const unreadByChannel = signal({});  // { channelId: count }
```

Заполняй их в тех же `refreshUnread*Count`, что уже обходят все контакты и
каналы, — второго прохода по БД не нужно, только сохранение промежуточных
значений вместо их выбрасывания.

`StreamItem` получает проп `unread` (число) и ставит `has-unread` на
`<li>` плюс `<span class="ava-dot">` внутрь аватара, когда `unread > 0`.

Заголовок группы получает `<span class="group-count">` с суммой, когда она
больше нуля. Для «Людей» это `unreadMessagesCount`, для каналов —
`unreadChannelsCount`; если суммы по «Моим каналам» и «Подпискам» нужны
раздельно, посчитай их так же, разделив по спискам в
`refreshUnreadChannelsCount`.

### 5.3 Звезда вместо флажка

`PinToggle` переименовать в `FavToggle`, класс `.pin-toggle` — в
`.fav-toggle`. Глиф `⚑`/`⚐` заменить на SVG-звезду: контурная в покое,
залитая и золотая во включённом состоянии.

Обоснование: флажок читается как «пометить» или «пожаловаться» — жест из
почты и модерации. Звезда во всех знакомых человеку приложениях означает
«избранное», а группа так и называется.

**Проверь по коду смысл действия.** Если оно поднимает элемент наверх списка,
а не помечает как важный, то правильнее булавка, а группу честнее назвать
«Закреплённые» — тогда напиши мне, прежде чем менять глиф.

### 5.4 Пустое состояние

Когда все три группы пусты, вместо пустой области:

```jsx
<div class="empty">
	<h3>{t("shell.emptyTitle")}</h3>
	<p>{t("shell.emptyBody")}</p>
	<button type="button" class="act act--primary" onClick={() => goTo({ kind: "discovery" })}>
		<IconCompass /> {t("shell.emptyAction")}
	</button>
</div>
```

Блок исчезает навсегда после появления первого контакта или канала — поэтому
он может быть заметным, обжившийся человек его не увидит.

---

## 6. Низ панели

```jsx
<div class="pane__bottom stack" style={{ "--gap": "var(--space-3xs)" }}>
	<button type="button" class="act act--primary" onClick={() => goTo({ kind: "contacts", focus: "add" })}>
		<IconPersonAdd /> {t("shell.addContact")}
	</button>
	<button type="button" class="quick" onClick={() => goTo({ kind: "quick" })}>…</button>
</div>
```

**Ключевое требование к «Добавить контакт»:** кнопка обязана привести человека
прямо к полю ввода ключа, а не на экран, где надо нажать ещё одну кнопку.
Иначе повторится история с «Написать» — та же бесполезность под другой
надписью.

Реализация без нового паттерна: у `place` вида `contacts` появляется поле
`focus`. `contacts.jsx` в `useEffect` при `place.value.focus === "add"`
вызывает `.focus()` на поле npub и прокручивает его в видимую область.
Модальный `<dialog>` не заводить — в проекте его нет ни в одном месте, и
ради одной кнопки вводить фокус-ловушку и подложку не стоит.

На узком экране (`max-width: 47.99em`) нажатие закрывает выезжающую панель —
это уже требование из первого ТЗ, проверь, что оно выполняется и здесь.

---

## 7. CSS

Всё — в `src/styles/custom.css`, в раздел сайдбара.

```css
/* ── карточка: меню на имени ─────────────────────────────────── */
.account-menu {
	position: relative;
	display: block;
	margin-block-start: var(--space-2xs);
	border: 0;
	border-radius: 0;
	padding: 0;
}
.account-menu > summary {
	list-style: none;
	cursor: pointer;
	font-weight: var(--weight-normal);
	padding: 0;
	margin-block-end: 0;
}
.account-menu > summary::-webkit-details-marker { display: none; }
.account-menu[open] > summary { margin-block-end: 0; }

/* подложка обнимает имя, а не всю ширину карточки */
.account-trigger {
	display: flex;
	align-items: center;
	gap: var(--space-3xs);
	padding: var(--space-3xs) var(--space-2xs);
	margin-inline-start: calc(-1 * var(--space-2xs));
	border-radius: var(--radius-sm);
	transition: background-color var(--transition-speed) var(--transition-ease);
}
.account-menu > summary:hover .account-trigger,
.account-menu > summary:focus-visible .account-trigger {
	background-color: color-mix(in oklch, var(--accent), transparent 92%);
}
.account-name {
	font-size: var(--step-0);
	font-weight: var(--weight-bold);
	line-height: 1.3;
	color: var(--fg);
}
.account-chev {
	flex: none;
	display: grid;
	color: var(--muted);
	transition: transform var(--transition-speed) var(--ease),
		color var(--transition-speed) var(--transition-ease);
}
.account-menu > summary:hover .account-chev { color: var(--accent); }
.account-menu[open] .account-chev { transform: rotate(180deg); color: var(--accent); }
.unread-dot {
	flex: none;
	inline-size: 0.4rem;
	block-size: 0.4rem;
	border-radius: 50%;
	background-color: var(--accent);
	margin-inline-start: var(--space-3xs);
}
/* триггер слева — меню прижимается к левому краю, не к правому */
.account-menu .menu-pop {
	inset-inline-start: 0;
	inset-inline-end: auto;
}

/* ── биография и ключ ────────────────────────────────────────── */
.account-bio {
	margin-block-start: var(--space-3xs);
	padding-inline: var(--space-3xs);
	font-size: var(--step--1);
	line-height: 1.4;
	color: var(--muted);
}
.account-key {
	display: flex;
	align-items: center;
	gap: var(--space-2xs);
	inline-size: 100%;
	text-align: start;
	margin-block-start: var(--space-2xs);
	margin-inline-start: calc(-1 * var(--space-2xs));
	padding: var(--space-3xs) var(--space-2xs);
	background: none;
	border: 0;
	border-radius: var(--radius-sm);
	color: var(--muted);
	font-family: var(--font-mono);
	font-size: var(--step--2);
	line-height: 1.4;
	opacity: 0.85;
	cursor: pointer;
	transition: background-color var(--transition-speed) var(--transition-ease),
		color var(--transition-speed) var(--transition-ease),
		opacity var(--transition-speed) var(--transition-ease);
}
.account-key:hover,
.account-key:focus-visible {
	background-color: color-mix(in oklch, var(--accent), transparent 92%);
	color: var(--fg);
	opacity: 1;
}
.account-key svg { flex: none; opacity: 0.7; }
.account-key:hover svg { opacity: 1; color: var(--accent); }

/* ── поиск во всю ширину ─────────────────────────────────────── */
.file-search-field {
	display: flex;
	align-items: center;
	gap: var(--space-2xs);
	inline-size: 100%;
	padding-inline: var(--space-xs);
	padding-block: var(--space-2xs);
	background-color: var(--surface);
	border: var(--border-width) solid var(--border);
	border-radius: var(--radius-sm);
	color: var(--muted);
}
.file-search-field:focus-within { border-color: var(--accent); }
.file-search-field input {
	flex: 1 1 auto;
	background: none;
	border: none;
	outline: none;
	padding: 0;
	color: var(--fg);
	font-size: var(--step--1);
}

/* ── «Знакомства» ────────────────────────────────────────────── */
.discover-row {
	border-radius: var(--radius-sm);
	transition: background-color var(--transition-speed) var(--transition-ease);
}
.discover-row:hover { background-color: color-mix(in oklch, var(--accent), transparent 92%); }
.discover-row.is-active {
	background-color: color-mix(in oklch, var(--accent), transparent 88%);
	box-shadow: inset 2px 0 0 var(--accent);
}
.discover {
	display: flex;
	align-items: center;
	gap: var(--space-2xs);
	inline-size: 100%;
	text-align: start;
	background: none;
	border: none;
	padding: var(--space-3xs);
	color: var(--fg);
	font-size: var(--step--1);
	line-height: 1.35;
	cursor: pointer;
}
.discover-mark {
	flex: none;
	inline-size: var(--avatar-s);
	block-size: var(--avatar-s);
	display: grid;
	place-items: center;
	border-radius: var(--radius-sm);
	border: var(--border-width) solid transparent;
	color: var(--accent);
	background-color: color-mix(in oklch, var(--accent), transparent 88%);
}

/* ── непрочитанное ───────────────────────────────────────────── */
.has-unread .stream__name { font-weight: 500; color: var(--fg); }
.ava-dot {
	position: absolute;
	inset-block-start: -3px;
	inset-inline-end: -3px;
	inline-size: 0.55rem;
	block-size: 0.55rem;
	border-radius: 50%;
	background-color: var(--accent);
	box-shadow: 0 0 0 2px var(--bg);
}
/* .stream-ava должен стать позиционирующим родителем */
.stream-ava { position: relative; }
.group-count {
	margin-inline-start: var(--space-2xs);
	min-inline-size: 1.35em;
	padding-inline: 0.35em;
	text-align: center;
	font-size: var(--step--2);
	line-height: 1.55;
	font-weight: 500;
	letter-spacing: normal;
	text-transform: none;
	border-radius: var(--radius-full);
	background-color: var(--accent);
	color: var(--bg);
}

/* ── звезда избранного ───────────────────────────────────────── */
.fav-toggle {
	flex: none;
	background: none;
	border: none;
	padding: var(--space-3xs) var(--space-2xs);
	color: var(--muted);
	line-height: 0;
	opacity: 0.2;
	cursor: pointer;
	transition: opacity var(--transition-speed) var(--transition-ease),
		color var(--transition-speed) var(--transition-ease);
}
.stream-row:hover .fav-toggle,
.fav-toggle:focus-visible { opacity: 1; }
.fav-toggle[aria-pressed="true"] { opacity: 1; color: var(--gold); }

/* ── подписанные строки-действия внизу ───────────────────────── */
.act {
	display: flex;
	align-items: center;
	gap: var(--space-2xs);
	inline-size: 100%;
	text-align: start;
	padding: var(--space-2xs) var(--space-xs);
	background: none;
	border: var(--border-width) solid transparent;
	border-radius: var(--radius-sm);
	color: var(--fg);
	font-size: var(--step--1);
	line-height: 1.35;
	cursor: pointer;
	transition: background-color var(--transition-speed) var(--transition-ease),
		border-color var(--transition-speed) var(--transition-ease);
}
.act:hover { background-color: color-mix(in oklch, var(--accent), transparent 92%); }
.act svg { color: var(--muted); }
.act:hover svg { color: var(--accent); }
.act--primary {
	border-color: var(--border);
	background-color: color-mix(in oklch, var(--accent), transparent 94%);
}
.act--primary:hover { border-color: var(--accent); }

/* ── пустое состояние списка ─────────────────────────────────── */
.empty {
	margin-block-start: var(--space-m);
	padding: var(--space-s);
	border: var(--border-width) dashed var(--border);
	border-radius: var(--radius);
	text-align: center;
	background-image: radial-gradient(120% 90% at 50% 0%, color-mix(in oklch, var(--accent), transparent 92%), transparent 65%);
}
.empty h3 { font-size: var(--step-0); font-weight: 500; line-height: 1.3; margin: 0; }
.empty p { font-size: var(--step--2); color: var(--muted); line-height: 1.4; margin-block-start: var(--space-3xs); }
.empty .act { margin-block-start: var(--space-s); justify-content: center; }
```

**Удалить**: `.pin-toggle` (заменён на `.fav-toggle`), `.journal-bell-btn`,
`.nav-badge`, если после удаления колокольчика они больше нигде не
используются — проверь `grep`.

**Новый токен** в `minimal.css`, `@layer tokens`:

```css
--gold: light-dark(oklch(0.62 0.12 85), oklch(0.8 0.13 85));
--font-mono: ui-monospace, "SF Mono", "JetBrains Mono", monospace;
```

Если `--font-mono` в проекте уже есть — используй существующий, не заводи
второй.

---

## 8. Новые ключи локализации

Во все двенадцать файлов `src/ui/i18n/locales/*.json`.

| Ключ | ru |
|---|---|
| `shell.discoverHeading` | Знакомства |
| `shell.addContact` | Добавить контакт |
| `shell.emptyTitle` | Пока пусто |
| `shell.emptyBody` | Никого нет в списке. Загляните в «Знакомства» — там люди, которые сами открыты для общения. |
| `shell.emptyAction` | Открыть знакомства |
| `account.menuJournal` | Журнал |
| `account.favAdd` | В избранное |
| `account.favRemove` | Убрать из избранного |

Удалить, если больше не используются: `shell.addMenuAria`,
`shell.addMenuCompose`, `shell.addMenuCreateChannel`, `shell.journalBellAria`.
Ключи `sidebarCard.*` для пунктов меню остаются как есть.

---

## 9. Чего НЕ делать

* Не заводить вкладки в панели — обсуждалось и отклонено: на узком экране
  панель временная, вкладка внутри временного слоя удваивает режимность.
* Не показывать число непрочитанных в строках списка — только точку.
* Не вешать на портрет ничего, кроме перехода в «Профиль».
* Не возвращать «плюс» и колокольчик в строку поиска.
* Не заводить второй `.scroller` на пути `shell → sidebar → лист`.
* Не делать «Знакомства» акцентной кнопкой со счётчиком новых анкет: точка
  непрочитанного уже означает «тебе написал живой человек», и размывать это
  значение анкетами незнакомцев нельзя.
* Не подгонять высоту чего-либо подсчётами в JavaScript.

---

## 10. Приёмка

1. `grep -r "AddMenu\|journal-bell\|pin-toggle\|IconDotsHorizontal" src/` — пусто.
2. Поле поиска занимает всю ширину строки, плейсхолдер «Поиск по чатам и
   каналам» помещается целиком при ширине панели 16rem.
3. Меню открывается нажатием на имя, шеврон поворачивается, меню прижато к
   левому краю и не выходит за границу панели.
4. Порядок в карточке сверху вниз: портрет, имя, биография, ключ.
5. Ключ моноширинный, вид `npub1q8v…f30d`; в буфер попадает полный npub.
6. При непрочитанном в журнале рядом с именем горит точка, в меню у пункта
   «Журнал» стоит число.
7. «Знакомства» — первая строка списка, ведёт на отдельный экран, иконка не
   лупа.
8. У чата с непрочитанным точка на аватаре и более плотное начертание имени;
   числа в строке нет.
9. В заголовке группы стоит сумма непрочитанного; при сворачивании группы она
   остаётся видна.
10. Звезда: приглушена в покое, загорается при наведении на строку, золотая и
    постоянная во включённом состоянии.
11. Нажатие «Добавить контакт» приводит на экран контактов с уже
    сфокусированным полем ключа. На ширине 480 px панель при этом закрывается.
12. На чистой учётной записи вместо пустого списка виден блок приглашения; он
    исчезает после появления первого контакта.
13. Обе темы: точки непрочитанного и звезда различимы, обводка точки не
    сливается с фоном.
14. `prefers-reduced-motion: reduce` — шеврон не поворачивается, точка на
    портрете не дышит.
15. `npm test` проходит.

Порядок коммитов: (1) поиск и удаление `AddMenu`, (2) карточка — меню на
имени, порядок, ключ, журнал, (3) список — звезда, точки, суммы,
(4) «Знакомства» и экран, (5) низ панели и пустое состояние.
