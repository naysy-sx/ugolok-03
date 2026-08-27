# CHANNEL-V2 — ТЗ на переработку экрана канала и починку профилей

Адресат: Claude Code (Sonnet), репозиторий `ugolok-03`.
Тип работы: рефакторинг UI + четыре точечные правки в слое данных.
Референс вёрстки: `PROCESS-DOCS/REDESIGN/CHANNEL-V2.html` (положи туда файл,
который пришёл вместе с этим ТЗ, если его там ещё нет).

---

## 0. Как читать это ТЗ

Разделы **A** (данные) и **B–G** (вёрстка) независимы. A можно делать первым
и мержить отдельно — он ничего не ломает в UI.

Три уровня обязательности:

- **ДОЛЖНО** — сделать буквально. Отклонение = задача не принята.
- **МОЖНО** — способ на твоё усмотрение, важен результат.
- **РАЗВИЛКА** — есть выбор без явно лучшего варианта. Указан выбор по
  умолчанию. Если решишь иначе — напиши почему в отчёте, не молча.

**Не задавай вопросов там, где ТЗ даёт ответ.** Если ТЗ ответа не даёт и
догадка меняет поведение — остановись и спроси, не изобретай.

### Что нельзя трогать

- `src/ui/components/message-bubble.jsx` и всё, что относится к личному
  чату (`src/ui/screens/chat.jsx`). Там сейчас идёт отдельная работа по MLS.
- `src/domain/**` — кроме одного файла, явно названного в задаче A1.
- Правило `.app-layout .header-actions h1` в `custom.css` (`--step-2`,
  `color: var(--accent)`). В макете заголовок нейтральный и меньше — это
  упрощение демо-файла, а не требование. Решение по цвету и размеру
  заголовка принято пользователем раньше и здесь не пересматривается.
- Существующие тесты в `tests/`. Если правка ломает тест — чини правку или
  приходи с объяснением, но не правь тест «чтобы прошёл».

### Регламент

`PROCESS-DOCS/REGLAMENT.md` обязателен. Практически это значит:

1. Раскладка — только композиционными классами (`.stack` / `.row` / `.bar` /
   `.reel` / `.grid` / `.layer` / `.grow` / `.rigid` / `.box` / `.scroller` /
   `.truncate`) в JSX, параметры через `--gap` / `--align` / `--pad` /
   `--lines` инлайн-стилем.
2. `margin` на компоненте запрещён. Зазор даёт родитель через `--gap`.
   Если в разметке ниже нужен «разный зазор между разными парами» — это
   сигнал, что нужна дополнительная обёртка, а не margin (см. задачу E2,
   там это разобрано на примере).
3. Медиазапросов в компонентах нет. Адаптив — `@container`. Контекст уже
   объявлен на `.content-wrapper` и `.slices-zone` (`container-type:
   inline-size`, `custom.css`), собственный `container-type` не заводи.
4. Логические свойства: `inline-size`, `block-size`, `padding-inline-start`,
   `border-block-end`, `margin-inline`. Не `width` / `left` / `border-bottom`.
5. Числа — из токенов (`--space-*`, `--step-*`, `--radius*`). Исключения:
   `1px` для линий, `50%` для круга, `1` для `flex`. Размеры аватаров —
   отдельный случай: в `custom.css` уже зашиты сырые `rem`
   (`.cmt__ava: 2.125rem`, `.post__ava: 2.75rem`). Переиспользуй **ровно
   эти же значения**, новых размеров не вводи.
6. Структурных селекторов (`.card > div > span`) нет. Селекторы состояния
   (`:hover`, `[aria-selected]`, `:has()`) — можно, они уже используются.

### Куда писать CSS

Всё новое — в `src/styles/custom.css`, одним блоком в конце файла, под
заголовком-баннером в стиле остальных секций этого файла:

```
/* ================================================================== *
 *  CHANNEL-V2 — экран канала: шапка, полоса вкладок, лента, запись,   *
 *  общий чат, модерация, настройки. ТЗ: PROCESS-DOCS/REDESIGN/        *
 *  CHANNEL-V2-TASK.md. Референс: CHANNEL-V2.html.                     *
 * ================================================================== */
```

Правила, которые ТЗ просит **изменить**, правь на месте — не дублируй в
конце файла. `minimal.css` не трогай вообще.

### Комментарии в коде

В этом проекте принято объяснять в комментарии **почему**, а не что. Держи
эту традицию: у каждой нетривиальной правки — одна-две строки о причине.
Особенно там, где ТЗ отменяет прежнее решение (задачи A1, E1, C3) — там
комментарий обязателен, иначе следующий читатель откатит правку обратно.

---

# ЧАСТЬ A — почему в общем чате коды вместо имён

## Диагноз

`ContactIdentity` (`src/ui/screens/contacts.jsx:50`) рисует
`profile?.name || shortPubkey(pubkey)` и первую букву имени вместо картинки.
Инициалы и `npub1…` — это не отдельный режим, это фолбэк пустого
`profiles.value[pubkey]`. Пусто он бывает по четырём независимым причинам.
Каждой достаточно самой по себе, поэтому чинить надо все четыре.

## A1. Профиль часто не публикуется вовсе

Файл: `src/domain/identity/profile.js`, функция `ensureProfilePublished`
(около строки 143).

Сейчас флаг `profileAutoPublished: true` пишется в keystore **до** попытки
`publish`, а `catch` только пишет в консоль. Один неудачный connect при
регистрации — и `kind:0` не уйдёт уже никогда, пока человек сам не откроет
«Профиль» и не сохранит био или аватар. У читателя на релее просто нет
события, из которого взять имя.

**ДОЛЖНО.** Флаг ставится только после успешной публикации:

```js
export async function ensureProfilePublished(ownerPubkey, login, privKey, publish) {
  const record = await db.table('keystore').get(ownerPubkey);
  if (record?.profileAutoPublished) return;
  try {
    const current = await getProfile(ownerPubkey);
    const event = buildProfileEvent(privKey, {
      name: login,
      about: current.bio || undefined,
      picture: current.avatarUrl || undefined,
    });
    const result = await publish(event);
    // Флаг — ПОСЛЕ подтверждения релея, не до попытки. Прежний порядок
    // (флаг вперёд, ретраев нет) означал: единственный неудачный первый
    // connect навсегда оставлял пользователя без kind:0, и все остальные
    // видели его как npub. Цена ретрая — одно kind:0 на connect, пока
    // публикация не пройдёт; это дешевле, чем безымянный аккаунт навсегда.
    if (result?.ok) {
      await db.table('keystore').update(ownerPubkey, { profileAutoPublished: true });
    }
  } catch (e) {
    console.warn('ensureProfilePublished: не удалось опубликовать профиль', e);
  }
}
```

Комментарий в шапке функции («повторных попыток при сбое сознательно нет»)
ДОЛЖНО переписать — он теперь описывает отменённое решение.

Отметь смену решения в `PROCESS-DOCS/CONTRACTS.md` одной строкой.

## A2. Отрицательный ответ кэшируется на всю сессию

Файл: `src/ui/signals/contacts.js`.

`ensureProfilesFetched` (строка 271) пропускает всё, что уже лежит в
`profiles.value`, — включая записанный туда `null` («спрашивали, не
нашли»). Чат канала (`channel-chat.jsx:154`) вызывает только её. Личный чат
и контакты вызывают ещё и `refreshProfiles` (`chat.jsx:117`,
`contacts.jsx:128`), которая перезапрашивает безусловно. Отсюда и берётся
«в личке имя есть, в канале нет».

Наивная починка — «убрать пропуск закэшированных» — **запрещена**:
`fetchProfiles` это одноразовый REQ+EOSE, а `refresh()` компонента привязан
к `messagingActivity`, то есть дёргается на каждое новое сообщение. Получится
REQ на релей по числу авторов окна на каждое сообщение. Нужен повтор с
остыванием.

**ДОЛЖНО.** Добавь в `src/ui/signals/contacts.js` рядом с `refreshProfiles`:

```js
// Профиль, которого нет на релее, кэшируется как null (см.
// ensureProfilesFetched) — и больше не запрашивается никогда. Для контактов
// это лечится refreshProfiles на открытии экрана, для авторов канала лечить
// было нечем: они не контакты, экран у них общий с лентой.
// Здесь — середина: null перезапрашивается, но не чаще раза в минуту на
// pubkey, иначе refresh() по messagingActivity превратится в поток REQ.
const PROFILE_RETRY_MS = 60_000;
const lastProfileAttempt = new Map();

export function resetProfileRetryState() {
  lastProfileAttempt.clear();
}

// force — «экран только что открыли»: остывание игнорируется, но уже
// известные профили всё равно не перезапрашиваются (их обновляет живая
// подписка, refreshLiveProfileSubscription).
export async function ensureProfilesFresh(pubkeys, fetchProfilesFn, { force = false } = {}) {
  const now = Date.now();
  const need = pubkeys.filter((pk) => {
    if (profiles.value[pk]) return false;
    if (force) return true;
    return now - (lastProfileAttempt.get(pk) ?? 0) >= PROFILE_RETRY_MS;
  });
  if (need.length === 0) return;
  for (const pk of need) lastProfileAttempt.set(pk, now);
  await refreshProfiles(need, fetchProfilesFn);
}
```

**ДОЛЖНО.** Вызвать `resetProfileRetryState()` в `connect()`
(`src/ui/signals/transport.js`) рядом с `hydrateProfilesFromCache` —
переподключение это повод попробовать заново, не дожидаясь минуты.

**ДОЛЖНО.** Точки вызова `ensureProfilesFresh` вместо
`ensureProfilesFetched`:

| Файл | Место | force |
|---|---|---|
| `components/channel-chat.jsx` | в `refresh()`, по авторам окна | `false` |
| `components/channel-chat.jsx` | новый `useEffect` на `[ownerPubkey, channelId]`, по авторам окна | `true` |
| `components/channel-post-page.jsx` | в `refreshComments()` | `false` |
| `components/channel-post-page.jsx` | в `loadPost()`, по автору поста + авторам дерева | `true` |
| `components/moderation-panel.jsx` | в `refresh()`, по `reporterPubkey`/`targetPubkey`/`banned` | `true` |

Про `moderation-panel.jsx`: сейчас он вообще не запрашивает профили, поэтому
в списке жалоб npub стоял всегда, даже когда профиль был доступен. Это
отдельный симптом той же болезни.

`ensureProfilesFetched` **остаётся** и продолжает использоваться там, где
уже используется. Не заменяй её глобально.

## A3. Живая подписка не покрывает авторов канала

Файл: `src/ui/signals/transport.js`, `refreshLiveProfileSubscription`
(около строки 1083).

`subscribe("live-profiles", [{ authors: [ownerPubkey, ...contacts.value], kinds: [0] }])` —
автор чата канала обычно не контакт. Его `kind:0`, появившись на релее
позже, до UI не долетит: сработает только следующий явный запрос.

**ДОЛЖНО.** Ввести множество «наблюдаемых» pubkey и подмешивать его в
`authors`. В `src/ui/signals/contacts.js`:

```js
// Живая подписка kind:0 раньше знала только про контакты. Авторы канала
// контактами не являются — их обновлённый профиль не приезжал никогда.
// Ограничение сверху — на фильтр релея: authors неограниченной длины
// стрельнёт по лимитам strfry раньше, чем принесёт пользу.
const MAX_WATCHED_PROFILES = 256;
const watchedProfilePubkeys = new Set();

export function watchProfiles(pubkeys) {
  let added = false;
  for (const pk of pubkeys) {
    if (watchedProfilePubkeys.has(pk)) continue;
    watchedProfilePubkeys.add(pk);
    added = true;
  }
  while (watchedProfilePubkeys.size > MAX_WATCHED_PROFILES) {
    // Set сохраняет порядок вставки — выбывает самый давний.
    watchedProfilePubkeys.delete(watchedProfilePubkeys.values().next().value);
  }
  return added;
}

export function listWatchedProfiles() {
  return [...watchedProfilePubkeys];
}
```

В `transport.js`:

- фильтр становится
  `authors: [...new Set([ownerPubkey, ...contacts.value, ...listWatchedProfiles()])]`;
- экспортируй `refreshLiveProfileSubscription` (если ещё не экспортирована),
  чтобы её можно было позвать после `watchProfiles`.

Вызывать `watchProfiles(authors)` + переподписку ДОЛЖНО из тех же трёх
компонентов, что в A2, рядом с `force: true`-вызовом. Если `watchProfiles`
вернула `false` — переподписку не дёргай.

**РАЗВИЛКА.** Это самая рискованная из четырёх правок: она меняет форму
живого фильтра, который держится всё время работы приложения. По умолчанию —
делать. Если после неё в диагностике видно рост отвергнутых REQ, откати
только A3: A1/A2/A4 работают и без неё, просто без живого обновления.

## A4. Профили авторов не переживают перезагрузку

Файл: `src/ui/signals/contacts.js`, `applyProfileUpdates` (строка 243).

`await db.table("contactProfiles").put(...)` стоит под условием
`contacts.value.includes(pk)`. Значит профили авторов канала в
`contactProfiles` не попадают, `hydrateProfilesFromCache` их не
восстанавливает, и каждый холодный старт начинается с npub — даже когда
профиль был получен пять минут назад.

**ДОЛЖНО.** Персистить любой полученный профиль, не только контактов, и
отличать наблюдаемые записи от контактных, чтобы их можно было чистить:

1. Добавить в запись поле `watched: 1 | 0` и `seenAt: <unix seconds>`.
   Оба — **plaintext**-поля (по ним идёт чистка и индекс), то есть внести
   их в `CONTACT_PROFILES_PLAINTEXT_FIELDS`
   (`src/core/store/table-fields.js`).
2. Новая версия схемы в `src/core/store/database.js` (следующая за 28):
   `contactProfiles: "[ownerPubkey+contactPubkey], ownerPubkey, [ownerPubkey+watched+seenAt]"`.
   Миграция апгрейдом: существующим строкам проставить `watched: 0`,
   `seenAt: 0` — это контакты, они не чистятся.
3. В `applyProfileUpdates` убрать условие `contacts.value.includes(pk)` из
   ветки записи, вместо него вычислять `watched = contacts.value.includes(pk) ? 0 : 1`
   и `seenAt = Math.floor(Date.now() / 1000)`.
4. Новая функция `trimWatchedProfiles(ownerPubkey, keep = 500)`: удаляет
   записи с `watched: 1` сверх `keep` самых свежих по `seenAt`. Звать один
   раз из `connect()` после `hydrateProfilesFromCache`.

`hydrateProfilesFromCache` менять не нужно — она читает по `ownerPubkey` и
подхватит новые строки сама.

## A5. Приёмка части A

Тесты в `tests/` (`node --test`), новый файл `tests/profile-resolution.test.js`:

1. `ensureProfilePublished` при `publish` → `{ok: false}` **не** ставит флаг;
   повторный вызов пробует опубликовать снова. При `{ok: true}` — ставит,
   повторный вызов молчит.
2. `ensureProfilesFresh` не запрашивает pubkey, по которому в
   `profiles.value` лежит объект.
3. `ensureProfilesFresh` запрашивает pubkey с `null` в кэше; сразу
   повторённый вызов **не** запрашивает; с `force: true` — запрашивает.
4. `applyProfileUpdates` для не-контакта пишет строку в `contactProfiles`
   с `watched: 1`; для контакта — с `watched: 0`.
5. `trimWatchedProfiles` оставляет ровно `keep` самых свежих `watched: 1` и
   не трогает ни одной `watched: 0`.

Ручная проверка (запиши результат в отчёт):

- Зарегистрировать аккаунт при выключенном релее, включить релей, сделать
  reconnect → в чужом клиенте появляется имя, а не npub.
- Открыть чат канала с автором без профиля, опубликовать этому автору
  `kind:0`, подождать → имя появляется без перезагрузки страницы (это
  проверка A3; если A3 откачена — появляется после переоткрытия вкладки).
- Перезагрузить страницу офлайн → имена авторов канала на месте (A4).

---

# ЧАСТЬ B — каркас экрана канала

## B1. Состояние вкладки: один источник, не два

Файл: `src/ui/screens/channel.jsx`.

Сейчас активная вкладка живёт в локальном `useState("posts")`, а `place.subTab`
обновляется только в обратную сторону через `useEffect`. Клик по вкладке
`place` не трогает вообще. Следствие: переход по уведомлению работает, а
«назад» после смены вкладки — нет, и глубокая ссылка на вкладку не
воспроизводится.

**ДОЛЖНО.** Убрать `useState` для `tab` и синхронизирующий `useEffect`
целиком. Вместо них:

```js
import { place, goTo, openChannel } from "../signals/place.js";

const target = place.value;
const onThisChannel = target.kind === "channel" && target.id === channelId;
const tab = onThisChannel ? (target.subTab ?? "posts") : "posts";

// Смена вкладки — полная замена места (goTo, не merge): postId/commentId
// намеренно сбрасываются, иначе уход в «Настройки» и возврат в «Посты»
// молча выкинул бы на страницу записи, открытой до этого.
function setTab(next) {
  goTo({ kind: "channel", id: channelId, subTab: next });
}
```

Условие `onPostPage` оставь как есть.

**ДОЛЖНО.** Проверить `src/ui/signals/notification-nav.js` и `screens/today.jsx`
— они зовут `openChannel(id, {subTab})`. После правки ничего менять не
требуется, но убедись, что `subTab: undefined` по-прежнему даёт «Посты».

## B2. Screen: три новых слота в шапке

Файл: `src/ui/components/screen.jsx`.

Нужно уместить в закреплённой шапке аватар канала, подзаголовок (роль,
число подписчиков, дата) и раскрывающийся блок «О канале». Сейчас в шапке
только `breadcrumb` + `h1` + `actions`.

**ДОЛЖНО.** Добавить три необязательных пропа. Все три `undefined` по
умолчанию → разметка ровно та же, что сейчас, остальные экраны не задеты.

```jsx
export default function Screen({
  breadcrumb, title, subtitle, lead, headerExtra,
  actions, slices, footer, feed, children,
}) {
```

Шапка:

```jsx
<header class="section-header rigid stack box"
        style={{ "--gap": "var(--space-2xs)", "--pad": "var(--space-m)" }}>
  <div class="header-actions row" style={{ "--gap": "var(--space-s)", "--align": "center" }}>
    {breadcrumb && (
      <button type="button" class="back-button row" /* … без изменений … */ />
    )}
    {lead}
    {/* Обёртка нужна только чтобы подзаголовок встал ПОД заголовком, а не
        рядом с ним в общем ряду. .grow — чтобы .action-buttons
        (margin-inline-start:auto) по-прежнему уезжала вправо. */}
    <div class="screen-title grow stack" style={{ "--gap": "0" }}>
      <h1 id={titleId}>{title}</h1>
      {subtitle}
    </div>
    {actions && (
      <div class="action-buttons row" /* … без изменений … */>{actions}</div>
    )}
  </div>
  {headerExtra}
</header>
```

CSS:

```css
/* Заголовок и подзаголовок — колонка внутри ряда шапки. min-inline-size:0
   обязателен: без него длинное имя канала распирает ряд и выталкивает
   кнопки действий за край. Тот же приём, что уже стоит на h1. */
.screen-title {
	min-inline-size: 0;
}
```

**ВНИМАНИЕ.** Правило `.app-layout .header-actions h1` (`--step-2`,
`color: var(--accent)`) остаётся как есть — h1 просто переезжает на уровень
глубже, селектор потомка это переживает. Проверь глазами на «Журнале» и
«Контактах», что там ничего не сдвинулось.

## B3. Вкладки и срезы — в закреплённую полосу

Сейчас `<nav class="tabs">` рендерится внутри `children`, то есть внутри
`.content-wrapper.scroller`, и уезжает вверх при прокрутке. Одновременно
`MediaButtons` живут в слоте `slices` — то есть две полосы, из которых одна
закреплена, а другая нет.

В `custom.css` уже лежит готовая поддержка нужного варианта — правила
`.slices-zone:has(.tabs)`, `.slices-zone .tabs`, `.slices-zone .tab`
(строки 1587–1597). Они были написаны и ни разу не использованы.

**ДОЛЖНО.** В `channel.jsx` передавать в `slices` **одну** ноду — полосу с
вкладками слева и срезами справа:

```jsx
slices={
  <div class="ch-bar bar" style={{ "--gap": "var(--space-s)", "--align": "stretch" }}>
    <nav class="tabs reel grow" role="tablist" aria-label={t("channel.tabsAriaLabel")}>
      <button type="button" class="tab" role="tab" aria-selected={tab === "posts"}
              onClick={() => setTab("posts")}>{t("channel.tabs.posts")}</button>
      <button type="button" class="tab" role="tab" aria-selected={tab === "chat"}
              onClick={() => setTab("chat")}>{t("channel.tabs.chat")}</button>
      {isOwner && (
        <button type="button" class="tab" role="tab" aria-selected={tab === "moderation"}
                onClick={() => setTab("moderation")}>{t("channel.tabs.moderation")}</button>
      )}
      {isOwner && (
        <button type="button" class="tab" role="tab" aria-selected={tab === "settings"}
                onClick={() => setTab("settings")}>{t("channel.tabs.settings")}</button>
      )}
    </nav>
    <div class="ch-bar__slices bar rigid" style={{ "--gap": "var(--space-3xs)", "--align": "center" }}>
      {tab === "posts" ? <MediaButtons counts={postsSlicesCounts()} onOpen={handleOpenPostsSlice} />
       : tab === "chat" ? <MediaButtons counts={chatSlices.counts} onOpen={chatSlices.onOpen} />
       : null}
    </div>
  </div>
}
```

`.reel` (а не `.row`) на вкладках — их четыре, у владельца на узком экране
они не должны переноситься на вторую строку, должны прокручиваться.

CSS:

```css
/* Вкладки слева, срезы справа — одна закреплённая полоса вместо двух
   (вкладки раньше жили в прокручиваемом контенте и уезжали вверх). */
.ch-bar {
	justify-content: space-between;
	min-inline-size: 0;
}
/* .reel даёт прокрутку — полосу прокрутки под вкладками прячем, она тут
   визуальный мусор: вкладок максимум четыре и они видны почти всегда. */
.tabs.reel {
	scrollbar-width: none;
}
.tabs.reel::-webkit-scrollbar {
	display: none;
}
.ch-bar .tab {
	white-space: nowrap;
}
/* Срезы прижаты к нижней границе полосы, на одну линию с подчёркиванием
   активной вкладки. */
.ch-bar__slices {
	padding-block-end: var(--space-2xs);
}
```

**ДОЛЖНО.** Убрать `<nav class="tabs">` из `children` в `channel.jsx`.

## B4. Шапка канала — из ленты в шапку экрана

`ChannelHead` (`src/ui/components/channel-feed.jsx`) сейчас первый блок
внутри прокрутки: аватар, кикер, описание и всплывашка с правилами. Он
уезжает при прокрутке, а на телефоне съедает первый экран целиком. Плюс
`.rules-panel` сделана на `position: absolute` + `top`/`right` — и физические
свойства, и наложение через `absolute` вместо `.layer`.

**ДОЛЖНО.** Переписать `ChannelHead` в три экспортируемые части, которые
`channel.jsx` разложит по слотам `Screen`:

```jsx
// channel-feed.jsx

export function ChannelLead({ channelRow }) {
  return <ChannelAvatarThumb channel={channelRow} small />;
}

export function ChannelSubtitle({ channelRow }) {
  return (
    <p class="ch-kicker truncate" style={{ "--lines": "1" }}>
      {kickerLabel(channelRow.role)}
      {channelRow.updatedAt
        ? ` · ${t("channel.updatedLabel", { date: formatDateTime(channelRow.updatedAt) })}`
        : ""}
    </p>
  );
}

// Раскрытие вместо всплывающей панели: панель была на position:absolute с
// физическими top/right, закрывалась по клику вне (два глобальных слушателя
// на document) и перекрывала первый пост. Раскрытие ничего не перекрывает,
// живёт в закреплённой шапке и не требует ни одного слушателя.
export function ChannelAbout({ channelRow }) {
  const [open, setOpen] = useState(false);
  if (!channelRow.description && !channelRow.rules) return null;
  return (
    <div class="stack" style={{ "--gap": "var(--space-2xs)" }}>
      <button type="button" class="ch-about-toggle self-start"
              aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {t("channel.aboutToggle")}
      </button>
      {open && (
        <dl class="ch-about box stack" style={{ "--gap": "var(--space-s)", "--pad": "var(--space-s)" }}>
          {channelRow.description && (
            <div class="stack" style={{ "--gap": "var(--space-3xs)" }}>
              <dt>{t("channels.create.descriptionLabel")}</dt>
              <dd>{channelRow.description}</dd>
            </div>
          )}
          {channelRow.rules && (
            <div class="stack" style={{ "--gap": "var(--space-3xs)" }}>
              <dt>{t("channels.create.rulesLabel")}</dt>
              <dd>{channelRow.rules}</dd>
            </div>
          )}
        </dl>
      )}
    </div>
  );
}
```

`ChannelHead` как единый компонент **удалить**, вместе с `popRef`,
`useEffect` со слушателями `mousedown`/`keydown` и классами `.rules-pop`,
`.rules-panel`, `.ch-head` в `custom.css`.

CSS:

```css
.ch-about-toggle {
	background: none;
	border: 0;
	padding: 0;
	color: var(--muted);
	font-size: var(--step--2);
	text-align: start;
	text-decoration: underline;
	text-underline-offset: 0.18em;
}
.ch-about-toggle:hover {
	color: var(--fg);
	background: none;
}
.ch-about {
	background-color: var(--surface);
	border: var(--border-width) solid var(--border);
	border-radius: var(--radius);
	font-size: var(--step--1);
}
.ch-about dt {
	color: var(--muted);
	font-size: var(--step--2);
	text-transform: uppercase;
	letter-spacing: 0.06em;
}
/* Правила канала пишут списком в несколько строк — переносы значимы. */
.ch-about dd {
	margin-inline-start: 0;
	white-space: pre-wrap;
}
```

Сборка в `channel.jsx`:

```jsx
<Screen
  breadcrumb={{ label: t("nav.channels"), onBack: () => openChannel(null) }}
  title={channelRow.name || t("channels.card.untitled")}
  lead={<ChannelLead channelRow={channelRow} />}
  subtitle={<ChannelSubtitle channelRow={channelRow} />}
  headerExtra={<ChannelAbout channelRow={channelRow} />}
  actions={/* см. B5 */}
  slices={/* см. B3 */}
  footer={/* см. E4 и G4 */}
  feed={tab === "posts" || tab === "chat"}
>
```

## B5. Действия раздела в шапке

**ДОЛЖНО.** В `actions` — «Новая запись» (только владелец, только на
вкладке «Посты») и `ActionsMenu` с остальным:

```jsx
actions={
  <>
    {isOwner && tab === "posts" && (
      <button type="button" class="btn--primary" onClick={() => setComposerOpen(true)}>
        <IconPencil /> {t("channel.writePostButton")}
      </button>
    )}
    <ActionsMenu label={t("channel.channelActionsAria", { name: channelRow.name })}>
      {isOwner && (
        <button type="button" onClick={() => setTab("settings")}>
          <IconGear /> {t("channel.tabs.settings")}
        </button>
      )}
      <button type="button" onClick={handleCopyLink}>
        <IconCopy /> {t("channel.copyLinkButton")}
      </button>
    </ActionsMenu>
  </>
}
```

`showComposer` переезжает из `ChannelPostsTab` в `channel.jsx` (кнопка
теперь в шапке, а форма — в контенте), передаётся вниз пропами
`composerOpen` / `onComposerClose`.

`handleCopyLink` — `navigator.clipboard.writeText` с внутренней ссылкой на
канал плюс тост через `pushToast` (`signals/toasts.js`). Если готового
формата ссылки в проекте нет — **МОЖНО** этот пункт пропустить и оставить в
меню только «Настройки»; тогда не выдумывай формат.

---

# ЧАСТЬ C — вкладка «Посты»

Файлы: `src/ui/components/channel-feed.jsx`, `src/ui/components/feed-item.jsx`.

## C1. Сетка карточки ленты

Сейчас `.feed-item` — `grid-template-columns: 5.2rem minmax(0,1fr) auto` и
ни одного медиазапроса или контейнерного запроса. На 380 px первая колонка
(вид записи и время) съедает место у заголовка, а правая колонка при этом
держит превью, счётчик и реакции в столбик.

**ДОЛЖНО.** Две колонки: контент и превью. Вид записи и время — строкой
над заголовком. Счётчики — строкой под текстом.

```jsx
<button type="button" class="feed-item" onClick={onOpen}>
  <span class="feed-meta row" style={{ "--gap": "var(--space-2xs)", "--align": "baseline" }}>
    {unread && <span class="feed-unread" aria-label={t("channel.feedUnreadAria")} />}
    <span class="feed-kind">{t(`recordKind.${kind}`)}</span>
    <time class="feed-time" dateTime={isoOf(post.createdAt)}>{formatDateTime(post.createdAt)}</time>
  </span>

  {hasRealTitle
    ? <h3 class="feed-title">{title}</h3>
    : <p class="feed-title feed-title--synthetic truncate" style={{ "--lines": "3" }}>{title}</p>}

  {excerpt ? <p class="feed-excerpt truncate" style={{ "--lines": "2" }}>{excerpt}</p> : null}

  {hasChips && (
    <span class="feed-chips row" style={{ "--gap": "var(--space-3xs)" }}>
      <DueChip post={post} />
      {(post.tags ?? []).map((tag) => (
        <span class="rec-chip rec-chip--tag" key={tag}>{tag}</span>
      ))}
    </span>
  )}

  <span class="feed-foot row" style={{ "--gap": "var(--space-s)", "--align": "center" }}>
    <span class="feed-count">{t("channel.feedCommentCount", { count: commentCount ?? 0 })}</span>
    {reacts ? <span class="feed-reacts">{reacts}</span> : null}
  </span>

  {visual && <FeedThumb attachment={visual} />}
</button>
```

CSS:

```css
/* Было «5.2rem | 1fr | auto» без единого медиа- или контейнерного запроса:
   на узкой колонке фиксированные 5.2rem под вид записи отнимали место у
   заголовка. Вид и время переехали в строку над заголовком. */
.feed-item {
	display: grid;
	grid-template-columns: minmax(0, 1fr) auto;
	grid-template-areas:
		"meta    thumb"
		"title   thumb"
		"excerpt thumb"
		"chips   thumb"
		"foot    thumb";
	column-gap: var(--space-s);
	row-gap: var(--space-3xs);
	inline-size: 100%;
	text-align: start;
	background: none;
	border: 0;
	border-block-end: var(--border-width) solid var(--border);
	border-radius: 0;
	padding-block: var(--space-s);
	padding-inline: var(--space-2xs);
	color: inherit;
	font: inherit;
	box-shadow: none;
}
.feed-item:hover {
	background-color: color-mix(in oklch, var(--surface-raised) 55%, transparent);
}
.feed-item:active {
	transform: none;
}
.feed-meta    { grid-area: meta; }
.feed-title   { grid-area: title; }
.feed-excerpt { grid-area: excerpt; }
.feed-chips   { grid-area: chips; }
.feed-foot    { grid-area: foot; }
.feed-thumb   { grid-area: thumb; align-self: start; }

.feed-kind,
.feed-time {
	color: var(--muted);
	font-size: var(--step--2);
}
.feed-kind {
	font-weight: var(--weight-bold);
	letter-spacing: 0.08em;
	text-transform: uppercase;
}
.feed-unread {
	inline-size: var(--space-2xs);
	block-size: var(--space-2xs);
	border-radius: 50%;
	background-color: var(--accent);
	flex: none;
}
.feed-title {
	font-size: var(--step-1);
	font-weight: var(--weight-bold);
	font-family: var(--font-body);
	line-height: 1.3;
	margin-block: 0;
}
.feed-excerpt {
	color: var(--muted);
	font-size: var(--step--1);
	margin-block: 0;
}
.feed-count,
.feed-reacts {
	color: var(--muted);
	font-size: var(--step--2);
}
.feed-thumb {
	inline-size: 4rem;
	block-size: 4rem;
	border-radius: var(--radius-sm);
	object-fit: cover;
	background-color: var(--surface);
	border: var(--border-width) solid var(--border);
}
/* Контейнер объявлен на .content-wrapper (custom.css) — здесь только
   запрос. Медиазапрос был бы неверен: рядом стоит сайдбар, ширина окна
   и ширина колонки — разные величины. */
@container (max-inline-size: 30rem) {
	.feed-thumb {
		inline-size: 3rem;
		block-size: 3rem;
	}
	.feed-title {
		font-size: var(--step-0);
	}
}
```

## C2. Заметка не притворяется статьёй

Файл: `src/ui/components/feed-item.jsx`, функция `feedText`.

Сейчас для заметки без заголовка функция режет текст на 90-м символе и
отдаёт обрубок как `title`, который рисуется `<h3>` жирным. Это и есть
«жирные обрубки» в ленте.

**ДОЛЖНО.** `feedText` возвращает третье поле:

```js
function feedText(post) {
  const kind = kindOf(post);
  const bodyPreview = toPreviewText(post.text, { profile: "rich", maxLength: 180 });
  if (kind === "article" && post.title) return { title: post.title, excerpt: bodyPreview, synthetic: false };
  if (kind === "link") return { title: post.title || post.linkUrl || "", excerpt: bodyPreview, synthetic: false };
  const plain = toPreviewText(post.text, { profile: "rich", maxLength: 400 });
  if (!plain) return { title: t(`recordKind.${kind}`), excerpt: "", synthetic: true };
  const nl = plain.indexOf("\n");
  // Первая строка короткого текста — настоящий заголовок, автор его так и
  // написал. Обрубок посреди фразы заголовком не является: рисуем его
  // обычным текстом в три строки, не жирным <h3> на 90 символов.
  if (nl > 0 && nl <= 90) return { title: plain.slice(0, nl), excerpt: plain.slice(nl + 1).trim(), synthetic: false };
  return { title: plain, excerpt: "", synthetic: true };
}
```

`synthetic: true` → тег `<p>` и класс `feed-title--synthetic`:

```css
/* Не заголовок, а начало текста — не должен выглядеть как заголовок. */
.feed-title--synthetic {
	font-size: var(--step-0);
	font-weight: 400;
}
```

Обрезку делает `.truncate` с `--lines: 3`, не `slice` — так не режется
слово посреди.

## C3. Разделители по дням

**ДОЛЖНО.** Между группами постов разных дат — разделитель. Группировка
считается в `ChannelPostsTab` из уже загруженного `posts`, дополнительных
запросов не нужно.

Разметка — не `margin`, а вложенность: список дней это `.stack`, внутри
каждого дня — свой `.stack` из карточек.

```jsx
<div class="stack" style={{ "--gap": "var(--space-m)" }}>
  {groupByDay(posts).map(({ dayLabel, items }) => (
    <section key={dayLabel} class="stack" style={{ "--gap": "0" }}>
      <h2 class="day-sep bar" style={{ "--gap": "var(--space-s)", "--align": "center" }}>
        {dayLabel}
      </h2>
      {items.map((post) => <FeedItem key={post.id} post={post} /* … */ />)}
    </section>
  ))}
</div>
```

`groupByDay` **МОЖНО** положить в новый `src/ui/group-by-day.js` — он
понадобится и чату (задача E3), дублировать не надо. Ярлык дня:
«Сегодня» / «Вчера» / дата через `Intl.DateTimeFormat(currentLocale.value)`.

CSS:

```css
/* Одна линия слева и справа от подписи — тот же разделитель в ленте и в
   чате, поэтому класс общий и живёт не в секции ленты. */
.day-sep {
	color: var(--muted);
	font-size: var(--step--2);
	font-family: var(--font-body);
	font-weight: 400;
	margin-block: 0;
	padding-block: var(--space-s);
	position: sticky;
	inset-block-start: 0;
	background-color: var(--bg);
	z-index: 1;
}
.day-sep::before,
.day-sep::after {
	content: "";
	flex: 1;
	block-size: 1px;
	background-color: var(--border);
}
```

## C4. Пустое состояние

Сейчас `{posts.length === 0 && <p style="color: var(--muted)">…</p>}`.

**ДОЛЖНО.** Заменить на осмысленное пустое состояние с действием:

```jsx
<div class="empty stack" style={{ "--gap": "var(--space-2xs)", "--align": "center" }}>
  <h2>{t("channel.emptyPostsTitle")}</h2>
  <p>{isOwner ? t("channel.emptyPostsOwnerHint") : t("channel.emptyPostsGuestHint")}</p>
  {isOwner && (
    <button type="button" class="btn--primary" onClick={onOpenComposer}>
      <IconPencil /> {t("channel.writePostButton")}
    </button>
  )}
</div>
```

```css
.empty {
	color: var(--muted);
	text-align: center;
	padding-block: var(--space-xl);
	padding-inline: var(--space-s);
}
.empty h2 {
	color: var(--fg);
	font-size: var(--step-1);
	font-family: var(--font-body);
	margin-block: 0;
}
.empty p {
	font-size: var(--step--1);
	margin-block: 0;
}
```

Тот же `.empty` переиспользуй в чате (нет сообщений) и в модерации (нет
жалоб) — свои классы под каждое пустое место не заводи.

---

# ЧАСТЬ D — страница записи

Файл: `src/ui/components/channel-post-page.jsx`.

## D1. Автор записи

Автора на странице записи нет вообще. При этом `.post__ava`,
`.post__ava-fallback`, `.post__author` в `custom.css` есть и с этапа 69
лежат мёртвыми — об этом честно написано в комментарии
`src/ui/components/post-card.jsx:57`.

**ДОЛЖНО.** Строка автора первым элементом статьи, действия — туда же
справа (сейчас `ActionsMenu` висит ниже текста за распоркой `<span class="grow" />`,
что читается как случайность):

```jsx
<div class="post-byline bar" style={{ "--gap": "var(--space-s)", "--align": "center" }}>
  {author.avatar
    ? <img src={author.avatar} alt="" class="post__ava rigid" />
    : <div aria-hidden="true" class="post__ava post__ava-fallback rigid row"
           style={{ "--align": "center", justifyContent: "center" }}>
        {(author.name || "?").trim().charAt(0).toUpperCase()}
      </div>}
  <div class="stack grow" style={{ "--gap": "0" }}>
    <span class={author.isNpub ? "post__author post__author--npub" : "post__author"}>{author.name}</span>
    <span class="post-page__meta">
      {t(`recordKind.${kind}`)} · {formatDateTime(post.createdAt)}
      {post.status === "archived" ? ` · ${t("postCard.archivedLabel")}` : ""}
    </span>
  </div>
  {isOwner && <ActionsMenu label={/* как сейчас */}>{/* пункты как сейчас */}</ActionsMenu>}
</div>
```

`author` — из `commentAuthorInfo(post.authorPubkey)` (`channel-shared.jsx`).

**ДОЛЖНО.** Расширить `commentAuthorInfo`, чтобы вызывающий код мог
отличить настоящее имя от npub-заглушки — сейчас это неразличимо:

```js
export function commentAuthorInfo(pubkey) {
  const profile = profiles.value[pubkey];
  const name = profile?.name?.trim();
  // isNpub — «профиль не пришёл, показываем ключ». Раньше вызывающий код
  // этого не знал и красил npub как обычное имя, из-за чего строка авторов
  // читалась как набор ошибок.
  return { name: name || shortPubkey(pubkey), avatar: profile?.picture, isNpub: !name };
}
```

Строку `<span class="post-page__meta">` из старого места удалить —
дублировать не надо.

```css
.post-byline {
	min-inline-size: 0;
}
/* Ключ вместо имени — моноширинно и тише, чтобы не путать с никнеймом.
   Тот же приём, что .contact-identity-npub. */
.post__author--npub {
	font-family: var(--font-mono);
	font-weight: 400;
	font-size: var(--step--1);
	color: var(--muted);
}
```

## D2. Композитор комментария наверху

Сейчас `CommentComposer` стоит под заголовком «Комментарии», но выше
дерева — это правильно и остаётся. **ДОЛЖНО** только добавить ему
`placeholder` через уже существующий ключ
`channel.commentComposer.placeholder` (если он не пробрасывается) и убрать
из `cmt-head` дублирующий счётчик, если он повторяет `t("channel.commentsTitle")`.

## D3. Тело записи

**ДОЛЖНО.** Убрать «схлопывание» первого и последнего отступа руками, если
оно где-то сделано инлайном, и объявить один раз:

```css
/* Глобальный p{margin-block: var(--space-m)} (minimal.css) иначе добавляет
   отступ сверху первому абзацу — родитель уже дал зазор через --gap. */
.post-page__body > :first-child,
.cmt__text > :first-child,
.chat-msg__text > :first-child {
	margin-block-start: 0;
}
.post-page__body > :last-child,
.cmt__text > :last-child,
.chat-msg__text > :last-child {
	margin-block-end: 0;
}
```

## D4. Дерево комментариев

Разметку `CommentNode` **ДОЛЖНО** оставить как есть — она уже нормальная.
Три точечные правки:

1. Имя-npub красить через `author.isNpub` тем же классом, что в D1
   (переиспользуй `.post__author--npub`, но применяй к `.cmt__name` —
   значит нужен отдельный `.cmt__name--npub` с тем же телом; вынеси общее
   тело в один селектор через запятую, не дублируй свойства).
2. `.is-target-comment` (подсветка комментария из уведомления) сейчас в
   `custom.css` не описана вовсе, хотя класс ставится. Добавить:
   ```css
   /* Комментарий, на который привёл переход из уведомления. outline, не
      border: рамка сдвинула бы соседей на свою толщину. */
   .is-target-comment > .cmt__box {
   	outline: 2px solid var(--accent);
   	outline-offset: var(--space-3xs);
   	border-radius: var(--radius-sm);
   }
   ```
3. Кнопка «Показать ещё комментарии» — `.btn--ghost` по центру, а не
   слева в потоке.

---

# ЧАСТЬ E — общий чат

Файл: `src/ui/components/channel-chat.jsx`.

## E1. Композитор — в подвал экрана

Сейчас `ChatComposer` — последний элемент прокручиваемой ленты. В длинном
чате до поля ввода надо доскроллить. У `Screen` есть неиспользуемый слот
`footer` ровно для этого.

**ДОЛЖНО.** `ChannelChat` перестаёт рендерить композитор сам и получает
проп `onComposerChange`, через который отдаёт готовую ноду наверх — тем же
приёмом, каким уже отдаёт `onSlicesChange`. `channel.jsx` кладёт её в
`footer` Screen'а.

**РАЗВИЛКА.** Альтернатива — вынести `ChatComposer` из `channel-chat.jsx` в
отдельный файл и собирать его прямо в `channel.jsx`, а `ChannelChat`
оставить только лентой. Это чище (не гоняем JSX через колбэк), но требует
поднять наверх `refresh()` и рейт-лимитер. По умолчанию — второй вариант,
`src/ui/components/channel-composer.jsx`, потому что `onSlicesChange` уже
доказал, что колбэк-с-нодой плохо читается.

Разметка композитора:

```jsx
<form class="composer stack" onSubmit={handleSubmit} style={{ "--gap": "var(--space-2xs)" }}>
  {error && <p role="alert" style={{ color: "var(--bad)" }}>{error}</p>}
  {(tray.items.length > 0 || tray.errors.length > 0) && (
    <AttachmentTray /* … без изменений … */ />
  )}
  <label class="visually-hidden" for="channel-chat-text">{t("channelChat.messageLabel")}</label>
  <div class="composer__field bar" style={{ "--gap": "var(--space-2xs)", "--align": "end" }}>
    <textarea id="channel-chat-text" ref={textareaRef} class="grow"
              value={text} maxLength={MESSAGE_MAX_LENGTH} rows={1}
              placeholder={t("channelChat.placeholder")}
              onInput={(e) => setText(e.currentTarget.value)} />
    <div class="composer__tools bar rigid" style={{ "--gap": "var(--space-3xs)", "--align": "center" }}>
      {allowAttachments && (<>
        <input ref={fileInputRef} type="file" multiple style={{ display: "none" }} onChange={/* … */} />
        <button type="button" class="message-compose-tool-btn"
                onClick={() => fileInputRef.current?.click()}
                aria-label={t("chat.window.attachFileAria")}><IconPaperclip /></button>
        <button type="button" class="message-compose-tool-btn"
                onClick={() => setFilePickerOpen(true)}
                aria-label={t("channelChat.attachFromStorageAria")}><IconFolder /></button>
      </>)}
      <button type="submit" class="btn--primary" disabled={/* как сейчас */}>
        <IconSend /> {busy ? t("channel.commentComposer.sendingButton") : t("common.send")}
      </button>
    </div>
  </div>
</form>
```

`MarkdownFormatToolbar` из композитора чата **ДОЛЖНО** убрать: в
закреплённом подвале постоянная панель форматирования занимает третью строку
ради того, чем в чате почти не пользуются. Разметка при отправке
по-прежнему разбирается — только кнопки убираются. В композиторе поста
(`PostComposer`) панель остаётся.

```css
/* Поле ввода растёт с текстом, но не выше трети экрана: закреплённый
   подвал не должен съедать ленту. */
.composer textarea {
	min-block-size: 2.6rem;
	max-block-size: 9rem;
	inline-size: 100%;
	resize: vertical;
}
.composer__field {
	min-inline-size: 0;
}
.message-compose-tool-btn {
	inline-size: 2.25rem;
	block-size: 2.25rem;
	padding: 0;
	display: grid;
	place-items: center;
	background: none;
	border-color: transparent;
	color: var(--muted);
	border-radius: var(--radius);
}
.message-compose-tool-btn:hover {
	background-color: var(--surface);
	color: var(--fg);
}
```

Когда `canWrite === false` — в подвал идёт `<p class="readonly-notice">`,
а не пустой подвал:

```css
.readonly-notice {
	color: var(--muted);
	font-size: var(--step--1);
	text-align: center;
	margin-block: 0;
}
```

## E2. Сообщения группируются по автору

Сейчас каждое сообщение — `<li>` с полной шапкой (`ContactIdentity` 2.5rem +
дата + `ModerationActions`) и `MessageBubble` под ней. Пять сообщений подряд
от одного человека — пять аватаров и пять имён. Плюс кнопки модерации видны
всегда у каждого чужого сообщения.

**ДОЛЖНО.** Новый компонент `src/ui/components/channel-message.jsx`.
`MessageBubble` **не трогать** — он общий с личным чатом. Вложения рисуй
тем же способом, что и он: `planBubbleAttachments` из
`./bubble-attachment-plan.js` + `BubbleAttachmentCluster` / `BubbleFileChips`
из `./bubble-attachment-cluster.jsx`.

Группировка — структурой, не отступами (`margin` запрещён):

```jsx
// Список групп: между группами большой зазор.
<ul class="chat-log stack" role="list" style={{ "--gap": "var(--space-s)" }}>
  {groups.map((group) => (
    <li key={group.id} class="chat-group stack" style={{ "--gap": "var(--space-3xs)" }}>
      {/* Внутри группы — маленький. Разный зазор = разная вложенность,
          а не margin на первом элементе. */}
      {group.messages.map((m, i) => (
        <ChannelMessage key={m.id} message={m} showAuthor={i === 0} /* … */ />
      ))}
    </li>
  ))}
</ul>
```

Правило группировки: подряд идущие сообщения одного `authorPubkey`, у
которых разрыв по `createdAt` меньше `CHAT_GROUP_GAP_SECONDS = 300`.

Одно сообщение:

```jsx
<article class={`chat-msg${isOwn ? " chat-msg--own" : ""}`}>
  {showAuthor
    ? (author.avatar
        ? <img src={author.avatar} alt="" class="chat-msg__ava" />
        : <div aria-hidden="true" class="chat-msg__ava chat-msg__ava-fallback">
            {(author.name || "?").trim().charAt(0).toUpperCase()}
          </div>)
    /* Пустая ячейка держит колонку — без неё продолжение группы уехало бы
       влево под аватар. */
    : <div class="chat-msg__ava-slot" aria-hidden="true" />}

  <div class="chat-msg__body stack" style={{ "--gap": "var(--space-3xs)" }}>
    {showAuthor && (
      <header class="chat-msg__head row" style={{ "--gap": "var(--space-2xs)", "--align": "baseline" }}>
        <span class={author.isNpub ? "chat-msg__name chat-msg__name--npub" : "chat-msg__name"}>
          {author.name}
        </span>
        {isChannelOwner && <span class="chat-msg__badge">{t("channel.kicker.owner")}</span>}
        <time class="chat-msg__time">{formatTime(message.createdAt)}</time>
        {!isOwn && (
          <span class="chat-msg__actions">
            <ActionsMenu label={t("channel.comment.moreActionsAria", { name: author.name })}>
              <ModerationActions /* без compact — иконки+текст внутри меню */ />
            </ActionsMenu>
          </span>
        )}
      </header>
    )}
    {message.text && <div class="chat-msg__text"><MarkdownView source={message.text} profile="lite" /></div>}
    {/* вложения — planBubbleAttachments, как в MessageBubble */}
  </div>
</article>
```

`ModerationActions` в чате канала **ДОЛЖНО** вызывать **без** пропа
`compact`: `compact`-вариант рисует иконки прямо в строке, а мы прячем их в
`ActionsMenu` — так же, как это сделано в комментариях. Если после этого
`compact` нигде не используется — удали ветку и класс `.msg-mod-actions`.

```css
.chat-log,
.chat-group {
	list-style: none;
	margin-block: 0;
	padding-inline-start: 0;
}
/* Колонка аватара — та же ширина, что у комментариев (.cmt__ava), чтобы
   чат и обсуждение читались как один язык, а не два разных списка. */
.chat-msg {
	display: grid;
	grid-template-columns: 2.125rem minmax(0, 1fr);
	column-gap: var(--space-2xs);
	align-items: start;
}
.chat-msg__ava,
.chat-msg__ava-slot {
	inline-size: 2.125rem;
	block-size: 2.125rem;
}
.chat-msg__ava {
	aspect-ratio: 1;
	object-fit: cover;
	border-radius: var(--radius);
	border: var(--border-width) solid var(--border);
	background-color: var(--surface);
	font-size: 0.85rem;
}
.chat-msg__ava-fallback {
	display: grid;
	place-items: center;
	color: var(--muted);
	font-weight: var(--weight-bold);
}
.chat-msg__name {
	font-weight: var(--weight-bold);
	font-size: var(--step--1);
}
.chat-msg__name--npub,
.cmt__name--npub {
	font-family: var(--font-mono);
	font-weight: 400;
	font-size: var(--step--2);
	color: var(--muted);
}
.chat-msg__badge {
	font-size: var(--step--2);
	color: var(--accent);
	border: var(--border-width) solid currentColor;
	border-radius: var(--radius-full);
	padding-inline: var(--space-3xs);
}
.chat-msg__time {
	color: var(--muted);
	font-size: var(--step--2);
}
.chat-msg__text {
	overflow-wrap: anywhere;
}
/* Своё сообщение отличается цветом имени, не выключкой вправо: в общем
   чате важнее «кто сказал», чем «я или не я», и правая колонка ломала бы
   единую сетку аватаров. */
.chat-msg--own .chat-msg__name {
	color: var(--accent-2);
}
/* Действия появляются по наведению — иначе кнопка модерации висит у
   каждого чужого сообщения и перебивает текст. */
.chat-msg__actions {
	margin-inline-start: auto;
	opacity: 0;
}
.chat-msg:hover .chat-msg__actions,
.chat-msg:focus-within .chat-msg__actions {
	opacity: 1;
}
@media (hover: none) {
	.chat-msg__actions {
		opacity: 1;
	}
}
```

`@media (hover: none)` здесь допустим: это не про ширину экрана, а про
`prefers`-класс возможностей ввода — регламент разрешает (§3 п.2). Тот же
приём уже стоит у `.cmt__reply`.

## E3. Разделители дней и «показать более ранние»

**ДОЛЖНО.** Тот же `groupByDay` из C3, тот же `.day-sep`. Кнопка «Показать
более ранние» — над лентой, `.btn--ghost`, по центру:

```jsx
{hasMore && (
  <div class="row" style={{ "--align": "center", justifyContent: "center" }}>
    <button type="button" class="btn--ghost" onClick={handleLoadMore}>
      {t("chat.window.loadOlderButton")}
    </button>
  </div>
)}
```

## E4. Прокрутка

Сейчас `bottomRef.current?.scrollIntoView({ block: "end" })` прокручивает
`.content-wrapper` — но в нём же лежал и `ChannelHead`, и вкладки, и
композитор. После B3/B4/E1 в нём остаётся только лента, так что поведение
станет правильным само.

**ДОЛЖНО** дополнительно:

1. Повесить `.anchored` (композиционный класс, `overflow-anchor: auto`) на
   `.content-wrapper` для вкладки чата — прокрутка держится низа при
   подгрузке. Проп на `Screen` для этого не заводи: **МОЖНО** передать
   через уже существующий `feed` (он и так рендерит `role="feed"`) или
   добавить `anchored` булевым пропом. По умолчанию — булев проп `anchored`.
2. `handleLoadMore` сохраняет позицию: перед `setMessages` запомни
   `scrollHeight`, после отрисовки верни `scrollTop += (newHeight - oldHeight)`.
   Сейчас подгрузка старых сообщений выбрасывает пользователя наверх.

---

# ЧАСТЬ F — модерация

Файл: `src/ui/components/moderation-panel.jsx`.

Сейчас это три несвязанных `.stack` подряд (статистика, «топ игнорируемых»,
«заблокированные», «отчёты»), `ContactIdentity` на 2.5rem внутри строки
«От: …», просмотренная жалоба гасится `opacity: 0.7` — вместе с текстом
самой жалобы, то есть падает контраст ровно того, что модератор читает.

## F1. Статистика

```jsx
<div class="mod-stats row" style={{ "--gap": "var(--space-2xs)" }}>
  <div class={`mod-stat box grow${stats.unviewed > 0 ? " mod-stat--alert" : ""}`}
       style={{ "--pad": "var(--space-s)" }}>
    <span class="mod-stat__n">{stats.unviewed}</span>
    <span class="mod-stat__l">{t("moderation.statUnviewed")}</span>
  </div>
  <div class="mod-stat box grow" style={{ "--pad": "var(--space-s)" }}>
    <span class="mod-stat__n">{stats.total}</span>
    <span class="mod-stat__l">{t("moderation.statTotal")}</span>
  </div>
  <div class="mod-stat box grow" style={{ "--pad": "var(--space-s)" }}>
    <span class="mod-stat__n">{banned.length}</span>
    <span class="mod-stat__l">{t("moderation.statBanned")}</span>
  </div>
</div>
```

```css
.mod-stat {
	flex-basis: 8rem;
	background-color: var(--surface);
	border: var(--border-width) solid var(--border);
	border-radius: var(--radius);
}
.mod-stat__n {
	display: block;
	font-size: var(--step-2);
	font-weight: var(--weight-bold);
	font-family: var(--font-display);
	line-height: 1;
	font-variant-numeric: tabular-nums;
}
.mod-stat__l {
	color: var(--muted);
	font-size: var(--step--2);
}
.mod-stat--alert {
	border-color: var(--warn-edge);
	background-color: var(--warn-surface);
}
.mod-stat--alert .mod-stat__n {
	color: var(--warn);
}
```

## F2. Фильтр вместо трёх списков подряд

**ДОЛЖНО.** Один список жалоб с фильтром-чипами. «Топ игнорируемых»
становится значением фильтра, а не отдельной секцией. Локальное состояние
`filter` из `"unviewed" | "all" | "report" | "ignore"`, по умолчанию
`"unviewed"`.

```jsx
<div class="mod-filters reel" style={{ "--gap": "var(--space-3xs)", "--align": "center" }}>
  <button type="button" class="mod-filter" aria-pressed={filter === "unviewed"}
          onClick={() => setFilter("unviewed")}>
    {t("moderation.filterUnviewed", { count: stats.unviewed })}
  </button>
  {/* … остальные три … */}
</div>
```

```css
.mod-filter {
	font-size: var(--step--1);
	padding-block: var(--space-3xs);
	padding-inline: var(--space-xs);
	border-radius: var(--radius-full);
	background: none;
	border: var(--border-width) solid var(--border);
	color: var(--muted);
	white-space: nowrap;
}
.mod-filter[aria-pressed="true"] {
	background-color: var(--surface-raised);
	color: var(--fg);
	border-color: var(--fg);
}
```

## F3. Карточка жалобы

```jsx
<li class={`mod-report box stack${r.viewed ? " mod-report--viewed" : ""}`}
    style={{ "--gap": "var(--space-2xs)", "--pad": "var(--space-s)" }}>
  <div class="mod-report__top row" style={{ "--gap": "var(--space-2xs)", "--align": "center" }}>
    <span class="mod-report__reason">{t(REASON_LABEL_KEYS[r.reason] ?? r.reason)}</span>
    {!r.viewed && <span class="mod-report__new">{t("moderation.newLabel")}</span>}
    <time class="chat-msg__time grow" style={{ textAlign: "end" }}>{formatDateTime(r.createdAt)}</time>
  </div>

  <div class="mod-report__flow row" style={{ "--gap": "var(--space-2xs)", "--align": "center" }}>
    <span>{t("moderation.fromLabel")}</span>
    <IdentityInline pubkey={r.reporterPubkey} />
    <IconArrowRight aria-hidden="true" />
    <IdentityInline pubkey={r.targetPubkey} />
  </div>

  {/* RAW, не MarkdownView — сохраняем прежнее решение: модератор обязан
      видеть исходник, рендер разметки позволил бы спрятать содержимое. */}
  <blockquote class="mod-report__quote">{r.contentText}</blockquote>

  <div class="mod-report__acts row" style={{ "--gap": "var(--space-2xs)" }}>
    {!r.viewed && <button type="button" onClick={/* markReportViewed */}>{t("moderation.markViewedButton")}</button>}
    {!banned.includes(r.targetPubkey) && (
      <button type="button" class="btn--ghost btn--danger" disabled={busy}
              onClick={() => handleBan(r.targetPubkey)}>{t("moderation.banButton")}</button>
    )}
  </div>
</li>
```

```css
.mod-report {
	border: var(--border-width) solid var(--border);
	border-radius: var(--radius);
	/* Непрочитанное отличается полосой слева, а не opacity: прежний
	   opacity:0.7 гасил и текст жалобы — то есть ровно то, что модератор
	   читает. Контраст важнее эффекта «потускнело». */
	border-inline-start: 3px solid var(--warn);
	background-color: var(--surface);
}
.mod-report--viewed {
	border-inline-start-color: var(--border);
	background: none;
}
.mod-report__reason {
	font-weight: var(--weight-bold);
	font-size: var(--step--1);
}
.mod-report__new {
	font-size: var(--step--2);
	color: var(--accent-contrast);
	background-color: var(--accent);
	border-radius: var(--radius-full);
	padding-inline: var(--space-2xs);
}
/* Текст жалобы — чужой и, возможно, враждебный: моноширинно и в рамке,
   чтобы его нельзя было спутать с интерфейсом. */
.mod-report__quote {
	margin-block: 0;
	margin-inline: 0;
	padding-block: var(--space-2xs);
	padding-inline-start: var(--space-s);
	border-inline-start: 2px solid var(--border);
	white-space: pre-wrap;
	overflow-wrap: anywhere;
	font-family: var(--font-mono);
	font-size: var(--step--2);
}
.mod-report__flow {
	color: var(--muted);
	font-size: var(--step--2);
	min-inline-size: 0;
}
```

## F4. Компактная строка личности

**ДОЛЖНО.** Новый компонент `IdentityInline` — в `moderation-panel.jsx` или
рядом. `ContactIdentity` (2.5rem аватар + имя + био блоком) в списке жалоб
неуместен: в строке «от X к Y» это два блока по 40 px и два био.

```jsx
export function IdentityInline({ pubkey }) {
  const author = commentAuthorInfo(pubkey);
  return (
    <span class="identity-inline bar" style={{ "--gap": "var(--space-3xs)", "--align": "center" }}>
      {author.avatar
        ? <img src={author.avatar} alt="" class="identity-inline__ava" />
        : <span aria-hidden="true" class="identity-inline__ava identity-inline__ava-fallback">
            {(author.name || "?").trim().charAt(0).toUpperCase()}
          </span>}
      <span class={author.isNpub
        ? "identity-inline__name identity-inline__name--npub truncate"
        : "identity-inline__name truncate"} style={{ "--lines": "1" }}>{author.name}</span>
    </span>
  );
}
```

```css
.identity-inline {
	min-inline-size: 0;
}
.identity-inline__ava {
	inline-size: 1.6rem;
	block-size: 1.6rem;
	aspect-ratio: 1;
	flex: none;
	object-fit: cover;
	border-radius: var(--radius-sm);
	border: var(--border-width) solid var(--border);
	background-color: var(--surface);
}
.identity-inline__ava-fallback {
	display: grid;
	place-items: center;
	font-size: var(--step--2);
	font-weight: var(--weight-bold);
	color: var(--muted);
}
.identity-inline__name {
	font-weight: var(--weight-bold);
	color: var(--fg);
	font-size: var(--step--1);
}
.identity-inline__name--npub {
	font-family: var(--font-mono);
	font-weight: 400;
	font-size: var(--step--2);
	color: var(--muted);
}
```

## F5. Заблокированные

**ДОЛЖНО.** Список чипов, у каждого — кнопка снятия. Если снятия бана в
домене нет (`domain/content/moderation.js` — проверь) — кнопку **не рисуй**
и не выдумывай функцию, просто оставь список; напиши в отчёте, что снятие
не реализовано.

```css
.mod-banned {
	list-style: none;
	margin-block: 0;
	padding-inline-start: 0;
}
.mod-banned li {
	border: var(--border-width) solid var(--bad-edge);
	background-color: var(--bad-surface);
	border-radius: var(--radius-full);
	padding-block: var(--space-3xs);
	padding-inline: var(--space-2xs);
}
```

---

# ЧАСТЬ G — настройки канала

Файл: `src/ui/screens/channel.jsx`, компонент `ChannelSettingsForm`.

Сейчас это одна сплошная форма: название, описание, правила, `<input
type="file">` без превью, чекбокс в ряду, `<fieldset>` со списком групп,
кнопки «Сохранить»/«Отмена» посреди страницы и «Удалить канал» чуть ниже,
в той же форме, отделённое одной линией.

## G1. Три группы полей

**ДОЛЖНО.** Разбить на три `<fieldset class="set-group">` с легендами и
пояснениями. Зазор между ними — родительский `--gap`, не `margin`:

```jsx
<form class="set-form stack" onSubmit={handleSave} style={{ "--gap": "var(--space-l)" }}>
  <fieldset class="set-group stack" style={{ "--gap": "var(--space-s)" }}>
    <legend>{t("channel.settings.groupAppearance")}</legend>
    <p class="set-group__hint">{t("channel.settings.groupAppearanceHint")}</p>
    {/* аватар (G2), название, описание, правила */}
  </fieldset>

  <fieldset class="set-group stack" style={{ "--gap": "var(--space-s)" }}>
    <legend>{t("channel.settings.groupRules")}</legend>
    <p class="set-group__hint">{t("channel.settings.groupRulesHint")}</p>
    {/* переключатель «вложения в чате» (G3) */}
  </fieldset>

  <fieldset class="set-group stack" style={{ "--gap": "var(--space-s)" }}>
    <legend>{t("channel.settings.visibilityLabel")}</legend>
    <p class="set-group__hint">{t("channels.create.visibilityHint")}</p>
    {/* список групп (G3) */}
  </fieldset>

  {/* опасная зона (G5) */}
</form>
```

```css
.set-form {
	max-inline-size: 44rem;
}
/* Разделительная линия принадлежит группе, зазор — родителю. */
.set-group {
	border: 0;
	margin-inline: 0;
	padding-inline: 0;
	padding-block: 0;
	border-block-start: var(--border-width) solid var(--border);
	padding-block-start: var(--space-l);
}
.set-group:first-of-type {
	border-block-start: 0;
	padding-block-start: 0;
}
.set-group > legend {
	padding-inline: 0;
	font-weight: var(--weight-bold);
	font-size: var(--step-0);
}
.set-group__hint {
	color: var(--muted);
	font-size: var(--step--1);
	margin-block: 0;
}
```

## G2. Поле с превью и счётчиком

```jsx
<div class="avatar-field bar" style={{ "--gap": "var(--space-s)", "--align": "center" }}>
  {avatarPreviewUrl
    ? <img src={avatarPreviewUrl} alt="" class="avatar-field__preview rigid" />
    : <div aria-hidden="true" class="avatar-field__preview avatar-field__preview--empty rigid">
        {(name || "?").trim().charAt(0).toUpperCase()}
      </div>}
  <div class="stack grow" style={{ "--gap": "var(--space-3xs)" }}>
    <div class="row" style={{ "--gap": "var(--space-2xs)" }}>
      <button type="button" onClick={() => avatarInputRef.current?.click()}>
        {t("channel.settings.chooseAvatarButton")}
      </button>
    </div>
    <small class="field__foot">{avatarError || t("channel.settings.avatarHint")}</small>
  </div>
</div>
```

`<input type="file">` **ДОЛЖНО** спрятать (`style={{ display: "none" }}`) и
открывать кнопкой — как это уже сделано в композиторах. Превью — из
`URL.createObjectURL(avatarFile)`, не забудь `URL.revokeObjectURL` в
`useEffect`-cleanup.

Текстовые поля — с живым счётчиком, потому что `maxLength` молча обрезает и
человек не понимает, почему текст перестал вводиться:

```jsx
<div class="field stack" style={{ "--gap": "var(--space-3xs)" }}>
  <label for="edit-channel-name">{t("channels.create.nameLabel")}</label>
  <input id="edit-channel-name" type="text" value={name} maxLength={NAME_MAX_LENGTH}
         onInput={(e) => setName(e.currentTarget.value)} required />
  <div class="field__foot bar" style={{ "--gap": "var(--space-s)" }}>
    <span class="grow">{t("channel.settings.nameHint")}</span>
    <span class={`field__count${name.length >= NAME_MAX_LENGTH ? " field__count--over" : ""}`}>
      {name.length} / {NAME_MAX_LENGTH}
    </span>
  </div>
</div>
```

```css
.field > label {
	font-size: var(--step--1);
	font-weight: var(--weight-bold);
}
.field input,
.field textarea {
	inline-size: 100%;
}
.field__foot {
	color: var(--muted);
	font-size: var(--step--2);
}
.field__count {
	font-variant-numeric: tabular-nums;
	white-space: nowrap;
}
.field__count--over {
	color: var(--bad);
}
.avatar-field__preview {
	inline-size: 4.5rem;
	block-size: 4.5rem;
	aspect-ratio: 1;
	object-fit: cover;
	border-radius: var(--radius);
	border: var(--border-width) solid var(--border);
	background-color: var(--surface);
}
.avatar-field__preview--empty {
	display: grid;
	place-items: center;
	color: var(--muted);
	font-size: var(--step-1);
	font-weight: var(--weight-bold);
}
```

## G3. Переключатели вместо голых чекбоксов

Сейчас чекбокс «разрешить вложения» — это `<input>` и `<label>` в `.row`.
Что именно включается и чем это грозит — нигде не сказано.

```jsx
<label class="opt">
  <input type="checkbox" checked={allowChatAttachments}
         onChange={(e) => setAllowChatAttachments(e.currentTarget.checked)} />
  <span class="stack" style={{ "--gap": "var(--space-3xs)" }}>
    <span class="opt__t">{t("channels.create.allowChatAttachmentsLabel")}</span>
    <span class="opt__d">{t("channel.settings.allowChatAttachmentsHint")}</span>
  </span>
</label>
```

Список групп — те же `.opt`, каждая в рамке, выбранная подсвечена:

```css
.opt {
	display: grid;
	grid-template-columns: auto minmax(0, 1fr);
	gap: var(--space-s);
	align-items: start;
	cursor: pointer;
}
.opt input {
	inline-size: 1.1rem;
	block-size: 1.1rem;
	margin-block-start: 0.25rem;
	margin-inline: 0;
	accent-color: var(--accent);
}
.opt__t {
	font-weight: var(--weight-bold);
	font-size: var(--step--1);
}
.opt__d {
	color: var(--muted);
	font-size: var(--step--2);
}
.group-list {
	list-style: none;
	margin-block: 0;
	padding-inline-start: 0;
}
.group-list .opt {
	align-items: center;
	padding-block: var(--space-2xs);
	padding-inline: var(--space-s);
	border: var(--border-width) solid var(--border);
	border-radius: var(--radius);
}
.group-list .opt:has(input:checked) {
	border-color: var(--accent);
	background-color: color-mix(in oklch, var(--accent) 8%, transparent);
}
```

## G4. Сохранение — в подвал, с состоянием формы

**ДОЛЖНО.** Кнопки «Сохранить»/«Отменить» уходят в слот `footer` Screen'а
вместе с индикатором изменений. Форма считает «грязность» сравнением с
исходными значениями:

```js
const dirty =
  name !== (channelRow.name || "") ||
  description !== (channelRow.description || "") ||
  rules !== (channelRow.rules || "") ||
  allowChatAttachments !== (channelRow.allowChatAttachments ?? true) ||
  avatarFile !== null ||
  !sameSet(selectedGroupIds, originalGroupIds);
```

```jsx
<div class="save-bar bar" style={{ "--gap": "var(--space-s)", "--align": "center" }}>
  <span class={`save-bar__state grow${dirty ? " save-bar__state--dirty" : ""}`}>
    {busy ? t("common.saving") : dirty ? t("channel.settings.dirtyNotice") : t("channel.settings.savedNotice")}
  </span>
  <button type="button" class="btn--ghost" onClick={onSaved} disabled={busy}>{t("common.cancel")}</button>
  <button type="submit" form={formId} class="btn--primary" disabled={busy || !dirty || name.length === 0}>
    {busy ? t("common.saving") : t("common.save")}
  </button>
</div>
```

Кнопка живёт вне `<form>` — свяжи её атрибутом `form={formId}`, где
`formId` из `useId()`. Так подвал остаётся подвалом Screen'а, а сабмит
по-прежнему работает и с клавиатуры.

```css
.save-bar__state {
	color: var(--muted);
	font-size: var(--step--1);
}
.save-bar__state--dirty {
	color: var(--warn);
}
```

## G5. Опасная зона

**ДОЛЖНО.** Удаление вынести из формы в отдельный блок в конце, с
объяснением последствий. `window.confirm` заменить на двухшаговое
подтверждение внутри блока: первый клик раскрывает поле, куда надо ввести
имя канала, второй — удаляет. Нативный `confirm` для необратимой операции
слишком лёгок — половина людей жмёт «ОК» не читая.

```jsx
<section class="danger-zone box" style={{ "--pad": "var(--space-s)" }}>
  <div class="stack grow" style={{ "--gap": "var(--space-3xs)" }}>
    <h3>{t("channel.settings.deleteTitle")}</h3>
    <p>{t("channel.settings.deleteExplain")}</p>
  </div>
  {confirming ? (
    <div class="stack" style={{ "--gap": "var(--space-2xs)" }}>
      <label for={`${instanceId}-confirm`}>
        {t("channel.settings.deleteTypeName", { name: channelRow.name })}
      </label>
      <input id={`${instanceId}-confirm`} type="text" value={confirmText}
             onInput={(e) => setConfirmText(e.currentTarget.value)} />
      <div class="row" style={{ "--gap": "var(--space-2xs)" }}>
        <button type="button" class="btn--ghost" onClick={() => setConfirming(false)}>
          {t("common.cancel")}
        </button>
        <button type="button" class="danger-zone__go" disabled={busy || confirmText !== channelRow.name}
                onClick={handleDelete}>
          <IconTrash /> {t("channel.settings.deleteButton")}
        </button>
      </div>
    </div>
  ) : (
    <button type="button" class="danger-zone__go rigid" onClick={() => setConfirming(true)}>
      <IconTrash /> {t("channel.settings.deleteButton")}
    </button>
  )}
</section>
```

```css
.danger-zone {
	display: grid;
	grid-template-columns: minmax(0, 1fr) auto;
	gap: var(--space-s);
	align-items: center;
	border: var(--border-width) solid var(--bad-edge);
	background-color: var(--bad-surface);
	border-radius: var(--radius);
}
.danger-zone h3 {
	font-size: var(--step--1);
	font-family: var(--font-body);
	margin-block: 0;
}
.danger-zone p {
	color: var(--muted);
	font-size: var(--step--2);
	margin-block: 0;
}
.danger-zone__go {
	background: none;
	border-color: var(--bad);
	color: var(--bad);
	font-weight: var(--weight-bold);
}
.danger-zone__go:hover:not(:disabled) {
	background-color: var(--bad);
	color: var(--accent-contrast);
}
@container (max-inline-size: 30rem) {
	.danger-zone {
		grid-template-columns: minmax(0, 1fr);
	}
}
```

---

# ЧАСТЬ H — i18n

Новые ключи **ДОЛЖНО** добавить в `src/ui/i18n/locales/ru.json` и `en.json`.
Остальные десять локалей фолбэчатся на `ru` (`t()` в `signals/i18n.js`), так
что они не блокируют задачу — заведи отдельный пункт в отчёте.

```
channel.aboutToggle
channel.channelActionsAria          {{name}}
channel.copyLinkButton
channel.linkCopiedToast
channel.feedUnreadAria
channel.emptyPostsTitle
channel.emptyPostsOwnerHint
channel.emptyPostsGuestHint
channel.settings.groupAppearance
channel.settings.groupAppearanceHint
channel.settings.groupRules
channel.settings.groupRulesHint
channel.settings.chooseAvatarButton
channel.settings.avatarHint
channel.settings.nameHint
channel.settings.allowChatAttachmentsHint
channel.settings.dirtyNotice
channel.settings.savedNotice
channel.settings.deleteTitle
channel.settings.deleteExplain
channel.settings.deleteTypeName     {{name}}
channelChat.placeholder
channelChat.emptyTitle
channelChat.emptyHint
moderation.statUnviewed
moderation.statTotal
moderation.statBanned
moderation.filterUnviewed           {{count}}
moderation.filterAll                {{count}}
moderation.filterReports
moderation.filterIgnores
moderation.emptyTitle
moderation.emptyHint
```

Правила текста: активный залог, предложение с заглавной, без точки в
кнопках и ярлыках. Кнопка называется тем же словом, что и результат
(«Сохранить» → «Сохранено», не «Изменения применены»). Пустое состояние
объясняет, что сделать, а не сообщает об отсутствии.

Удалить как больше не используемые (проверь грепом, что нигде не остались):
`channel.rulesChip`, `moderation.topIgnoredTitle`, `moderation.totalReports`,
`moderation.reportsTitle`, `moderation.bannedTitle`.

---

# ЧАСТЬ I — приёмка

Чеклист. Каждый пункт проверяется руками, в отчёте — «да/нет» и что видел.

**Каркас**

1. Вкладки видны при любой прокрутке ленты и чата.
2. Шапка канала (аватар, имя, роль) видна при любой прокрутке.
3. «О канале» раскрывается и сворачивается, ничего не перекрывая.
4. При смене вкладки адрес места (`place.value`) меняется; кнопка «назад»
   браузера/интерфейса возвращает на предыдущую вкладку.
5. Прокручиваемая зона ровно одна: в DOM внутри `.content-section` ровно
   один элемент с `.scroller`.
6. На «Журнале», «Контактах», «Файлах», «Профиле» шапка выглядит ровно как
   до правки (это проверка на регресс `Screen`).

**Посты**

7. На колонке 380 px заголовок записи занимает всю ширину минус превью.
8. Заметка без заголовка выводится обычным текстом, а не жирным обрубком.
9. Даты группируются, подпись дня липнет к верху при прокрутке.
10. Пустой канал показывает пустое состояние с кнопкой, а не серую строку.

**Запись**

11. Автор записи виден: аватар, имя, под ним вид и дата.
12. Автор без профиля показан моноширинным npub, визуально отличимым от
    имени.
13. Меню действий записи — справа в строке автора, не под текстом.
14. Переход по уведомлению на комментарий подсвечивает его рамкой.

**Чат**

15. Поле ввода видно всегда, без прокрутки, при любой длине истории.
16. Пять сообщений подряд от одного автора рисуют один аватар и одно имя.
17. Кнопка модерации появляется по наведению, на тач-устройстве видна
    всегда.
18. «Показать более ранние» не выбрасывает наверх: сообщение, на которое
    смотрели, остаётся на месте.
19. Новое сообщение прокручивает ленту вниз, но не трогает шапку и вкладки.

**Модерация**

20. Просмотренная жалоба читается так же хорошо, как новая (никакого
    `opacity` на тексте).
21. Строка «от X к Y» помещается в одну строку на 380 px.
22. Фильтр переключает список без перезапроса из базы на каждый клик.

**Настройки**

23. «Сохранить» видно всегда; неактивно, пока ничего не изменено.
24. Индикатор показывает «есть несохранённые изменения» сразу после первого
    ввода.
25. Удаление требует ввести имя канала; кнопка неактивна, пока имя не
    совпало.
26. Превью аватара появляется сразу после выбора файла, до загрузки.

**Регламент**

27. `grep -nE "margin(-top|-bottom|-left|-right)?:" src/styles/custom.css`
    в новом блоке — только `margin-block: 0`, `margin-inline: 0` и
    `margin-inline-start: auto`.
28. `grep -n "@media" src/styles/custom.css` в новом блоке — только
    `(hover: none)` и `prefers-*`. Всё остальное — `@container`.
29. `grep -nE "(width|height|left|right|top|bottom):" src/styles/custom.css`
    в новом блоке — пусто (кроме `inset-block-start` у `.day-sep`).
30. Ни одного нового `position: absolute`.

**Регресс**

31. `npm test` (или `node --test tests/`) зелёный.
32. Сборка проходит, размер бандла вырос не больше чем на 8 KB gzip.
    Если больше — покажи, за счёт чего.

---

# ЧАСТЬ J — порядок работ

Шесть коммитов, каждый самостоятельно рабочий. Не сваливай в один.

1. **A1–A5** — профили. Отдельно, до вёрстки. Тесты обязательны.
2. **B1–B2** — состояние вкладки + слоты `Screen`. Здесь же прогони пункт
   приёмки 6 (регресс других экранов) — дальше он проверяться не будет.
3. **B3–B5, C1–C4** — полоса вкладок, шапка канала, лента.
4. **D1–D4** — страница записи.
5. **E1–E4** — чат.
6. **F1–F5, G1–G5, H** — модерация, настройки, тексты.

После каждого коммита — короткая запись в `PROCESS-DOCS/log.md` в принятом
там телеграфном стиле.

## Что писать в отчёте

- Пункты приёмки: «да/нет» + что видел глазами.
- Каждое место, где ты отступил от ТЗ, и почему.
- Каждое место, где ТЗ противоречило коду (я мог ошибиться в номере строки
  или в имени функции — репозиторий менялся).
- **Отдельным разделом: что ты сделал, но не уверен, что это правильно.**
  Этот раздел важнее остальных. Пустым он быть не должен.

## Чего делать не надо

- Не «заодно» рефакторить соседние экраны. Только то, что в ТЗ.
- Не переименовывать существующие классы, если ТЗ не просит: `custom.css`
  325 KB, поиск по имени класса — основной способ в нём ориентироваться.
- Не добавлять зависимостей. Ни одной.
- Не заводить анимаций сверх `opacity` и `transform` на hover.
- Не трогать `minimal.css`.
