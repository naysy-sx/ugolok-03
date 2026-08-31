# UserCard — универсальная карточка человека

Одна вёрстка вместо трёх (`ContactIdentity` + собственная разметка предпросмотра
«Знакомств» + разнобой в списках «Контактов»). Семь мест применения, один словарь
классов, ни одного повторения ширины аватара в разметке.

## Что кладём в проект

| Файл | Куда |
|---|---|
| `user-card.jsx` | `src/ui/components/user-card.jsx` |
| `user-card.css` | вставить блоком в `src/styles/custom.css` — рядом с секцией «Карточка строки», строка ~5715 |
| `user-card-demo.html` | никуда, это стенд: открыть в браузере, потянуть пунктирные рамки за угол |

## Как устроена сетка

```
Широкий контейнер (> 26rem)          Узкий (< 26rem)
┌────────┬──────────┬─────────┐      ┌──────────────────────┐
│ who: аватар + имя │ actions │      │ who                  │
│      + био        │         │      ├──────────────────────┤
├────────┼──────────┤         │      │ extra                │
│        │ extra    │         │      ├──────────────────────┤
├────────┴──────────┴─────────┤      │ meta                 │
│ meta                        │      ├──────────────────────┤
└─────────────────────────────┘      │ actions              │
                                     └──────────────────────┘
```

Три решения, на которых всё держится:

1. **`who` — один прямоугольник, и он же кликабельная зона.** Аватар, имя и био
   лежат в `subgrid`, поэтому колонка аватара у них общая с карточкой: `extra`
   (список каналов) стоит во второй дорожке карточки и автоматически выровнен
   ровно под био. Ширина аватара нигде не повторяется — ни числом, ни токеном.
   Прежние две вёрстки разъезжались именно потому, что каждая считала этот отступ
   сама.
2. **Аватар не растягивается за био.** `grid-row: 1 / -1` + `align-self: start` —
   высоту карточки задаёт содержимое, а не подсчёт строк биографии в JavaScript.
3. **Порог складывания меряется по контейнеру, не по экрану.** `container-type`
   объявлен на обёртке `.ucard-shell` (её рисует сам компонент), а не на `.ucard`:
   self-referencing `@container` для layout-свойств самого контейнера браузер
   молча игнорирует — этот баг в проекте уже ловили на `.section-header`.

## Пропсы

| Проп | Значение | Зачем |
|---|---|---|
| `as` | `"div"` (по умолчанию) / `"li"` | тег обёртки; внутри `<ul>` — `"li"` |
| `variant` | `"row"` (по умолчанию) / `"panel"` | строка плотного списка / самостоятельная карточка |
| `accent` | boolean | тёплый угловой свет + штриховка справа |
| `avatarUrl` | string | нет — рисуется буква-заглушка |
| `name`, `nameIsNpub`, `badge` | | `nameIsNpub` — моноширинный, не жирный; `badge` — довесок вроде `[3]` |
| `bio`, `bioLines` | string, number | `bioLines` включает обрезку (`.truncate`) |
| `extra` | JSX | под био: `<ul class="ucard-list stack">` каналов и т.п. |
| `actions` | JSX | кнопки справа (узко — своей строкой под карточкой) |
| `meta` | JSX | нижняя строка: чипы групп, «+ в группу» |
| `onOpen`, `openLabel` | fn, string | есть `onOpen` → зона `who` становится `<button>`; `openLabel` обязателен |

Модификаторы вида — `variant` + `accent`, ничего больше руками на `.ucard`
навешивать не нужно. Размер аватара — `--ucard-avatar` (токен шкалы отступов),
переопределяется на модификаторе одной строкой.

## Семь мест

### 1. discovery.jsx, предпросмотр «Как вас увидят другие» (строка ~302)

Вся `<article class="stack box contact-info--decorated">` вместе с вложенными
`figure`/`div.contact-info` заменяется на:

```jsx
<UserCard
	variant="panel"
	accent
	avatarUrl={previewAvatarUrl}
	name={previewName}
	bio={draft.showBio ? previewBio : undefined}
	extra={
		draftChannels.length > 0 ? (
			<ul class="ucard-list stack" style={{ "--gap": "var(--space-2xs)" }}>
				{draftChannels.map((c) => (
					<li key={c.id}>
						<strong>{c.name}</strong>
						{c.description && <>: {c.description}</>}
						{draft.showRules && c.rules && <p class="panel__hint">{c.rules}</p>}
					</li>
				))}
			</ul>
		) : (
			<p class="panel__hint">{t("discovery.summaryNoChannelsPart")}</p>
		)
	}
/>
```

### 2. discovery.jsx, лента «Знакомств» (строка ~585)

`<li class="contact-row stack">` + `contact-row-main` + `ContactIdentity` +
`contact-row-actions` схлопываются в один вызов. Данные по-прежнему свои
(`card`, не `profiles.value`) — компонент презентационный, источники не связывает.

```jsx
<UserCard
	as="li"
	key={card.pubkey}
	variant="panel"
	accent
	avatarUrl={profiles.value[card.pubkey]?.picture}
	name={profiles.value[card.pubkey]?.name || shortPubkey(card.pubkey)}
	nameIsNpub={!profiles.value[card.pubkey]?.name}
	bio={profiles.value[card.pubkey]?.about}
	extra={card.channels.length > 0 && (
		<div class="stack" style={{ "--gap": "var(--space-2xs)" }}>
			{/* .ch-card как был */}
		</div>
	)}
	actions={
		<>
			<span class="panel__hint">{t("discovery.timeRemainingBadge", { time: formatCountdown(remainingSeconds) })}</span>
			<button type="button" disabled={busy} onClick={() => handleToggleDiscoveryCard(card.pubkey)} aria-pressed={sent}>
				{sent ? t("discovery.requestSentButton") : t("discovery.sendRequestButton")}
			</button>
			<ActionsMenu label={/* как было */}>…</ActionsMenu>
		</>
	}
/>
```

Форма жалобы (`reportingPubkey === card.pubkey`) — отдельным `<li>` под карточкой
или в `meta`; в `actions` ей тесно.

Список-родитель: `<ul class="ucard-list stack" style={{ "--gap": "var(--space-s)" }}>`.

### 3. contacts.jsx, «Контакты» (строка ~473)

```jsx
<UserCard
	as="li"
	key={pubkey}
	variant="row"
	avatarUrl={profiles.value[pubkey]?.picture}
	name={profiles.value[pubkey]?.name || shortPubkey(pubkey)}
	nameIsNpub={!profiles.value[pubkey]?.name}
	bio={profiles.value[pubkey]?.about}
	bioLines={2}
	onOpen={() => openChat(pubkey)}
	openLabel={t("contacts.openChatAria", { name: displayName })}
	actions={<>{/* Позвонить + ActionsMenu как было */}</>}
	meta={<>{/* чипы групп + AddToGroupControl как было */}</>}
/>
```

`PermissionEditor` при развороте — отдельным `<li>` следом, а не внутри карточки:
редактор прав шире карточки и не её часть.

### 4–7. Входящие / отправленные / отклонённые / заблокированные

То же самое, но без `onOpen` и без `meta` — только `actions` со своими кнопками.
Список-родитель везде: `<ul class="ucard-list ucard-list--divided stack">`.

## Что удалить из custom.css после миграции

`.contact-identity`, `.contact-identity-btn`, `.contact-identity-npub`,
`.contact-identity--card`, `.contact-info--decorated`, `.contact-avatar--lg`,
`.contact-avatar-figure`, `.contact-row`, `.contact-row-list`,
`.contact-row-expandable`, `.contact-row-actions`, `@container (max-width: 26em)`
для `.call-txt`.

**`.contact-avatar` не трогать** — на нём висит аватар канала в `.ch-card`
(discovery.jsx, строка ~613), это другая дорожка.

`ContactIdentity` остаётся жить для chat.jsx (2 места) и settings.jsx (1 место):
там это строка личности внутри чужой кнопки и внутри `SetRow`, а не карточка —
UserCard дал бы вложенную кнопку в кнопке. Переезд этих трёх мест — отдельная
задача, если вообще нужна.

## Запись для MOLECULES.md

### `.ucard` (+ `__who`, `__avatar`, `__photo`, `__name`, `__bio`, `__extra`, `__actions`, `__meta`, `--row`, `--panel`, `--accent`, `.ucard-shell`, `.ucard-list`)

Карточка человека: аватар + имя + био как один кликабельный прямоугольник,
под ним зона произвольного содержимого (каналы), справа действия, снизу чипы.
Сетка — `grid-template-areas` + `subgrid` на `who`, поэтому колонка каналов
выровнена под био без повторения ширины аватара. Порог складывания —
`@container ucard (max-width: 26rem)` и `17rem`, контейнер объявлен на обёртке
`.ucard-shell` (компонент рисует её сам). `--row` — строка плотного списка,
`--panel` — самостоятельная карточка, `--accent` — тёплый угловой свет
(VISUAL.md, «лампа») плюс штриховка у правого края.

Используется: `discovery.jsx` (2), `contacts.jsx` (5).

## Проверка по чеклисту REGLAMENT.md §7

- `margin` — только `margin: 0` на `<figure>` и `margin-block: 0` на `<ul>`, оба сброса UA-стилей;
- `@media` — ни одного, только `@container`;
- `position: absolute` — ни одного;
- числа вне токенов — ни одного (`--border-width` для штриховки, `1fr`/`-1` — единицы сетки);
- логические свойства — везде, кроме отсутствующих `overflow-inline/block` (их тут нет);
- `.grow` не используется вдоль главной оси карточки: дорожка `minmax(0, 1fr)` делает то же самое и уже несёт нулевой минимум;
- компонент не знает, где стоит: обёртку-контейнер рисует сам, наружу требует только `<ul class="ucard-list">` там, где он `<li>`.
