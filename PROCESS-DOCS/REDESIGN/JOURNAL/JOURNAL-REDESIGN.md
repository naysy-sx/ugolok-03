# ТЗ: переработка экрана «Журнал» (вариант Е)

**Куда положить файл:** `PROCESS-DOCS/REDESIGN/JOURNAL-REDESIGN.md`
**Референс-макет:** `journal-E.html` (даётся отдельно, в сборку не идёт)
**Статус:** к исполнению целиком, без творческой переработки.

---

## 0. Правила работы для исполнителя

Прочитай этот раздел до конца, прежде чем открывать хоть один файл.

1. **Не импровизируй.** Ниже приведён ПОЛНЫЙ текст нового `journal.jsx` и
   точные CSS-блоки. Вставляй их как есть. Если тебе кажется, что можно
   лучше — не надо; сначала доделай по ТЗ, замечания вынеси отдельным
   списком в конце отчёта.
2. **Не расширяй область работы.** Файлы, которые разрешено менять,
   перечислены в §1. Ничего за их пределами не трогай.
3. **Регламент раскладки обязателен** — `PROCESS-DOCS/REGLAMENT.md`.
   Ключевое: композиционные классы (`.stack/.row/.bar/.reel/.grow/.rigid/
   .truncate/.box/.scroller/.stick`) отвечают за раскладку, классы проекта
   — только за вид; ни `margin` на компонентах, ни чисел вне токенов, ни
   `@media` вне оболочки, ни физических свойств (`left/right/width/height`)
   — только логические (`inline-size`, `padding-inline-start` и т.д.).
4. **Порядок этапов строгий:** §3 → §4 → §5 → §6 → §7. После каждого
   этапа запускай `npm test` и убеждайся, что тесты зелёные.
5. **Ничего не удаляй «заодно».** Список того, что удаляется, — закрытый,
   он в §2.
6. Комментарии в коде проекта — на русском, в том же телеграфном стиле,
   что уже есть в файлах. Новые комментарии пиши так же: объясняй
   ПРИЧИНУ, а не пересказывай код.

---

## 1. Файлы, которые разрешено менять

| Файл | Что с ним |
|---|---|
| `src/ui/screens/journal.jsx` | заменяется целиком (текст в §5) |
| `src/ui/signals/journal.js` | добавляется одна функция (§4) |
| `src/ui/icons/funnel.jsx` | **новый файл** (§3) |
| `src/styles/custom.css` | точечные правки (§6) |
| `src/ui/i18n/locales/*.json` (все 12) | ключи (§7) |
| `tests/journal-signals.test.js` | два новых теста (§8) |

Всё остальное — не трогать.

---

## 2. Что удаляется (закрытый список)

Из `journal.jsx`:

- пагинация целиком: константа `PAGE_SIZE`, состояние `page`, вычисления
  `totalPages` / `clampedPage` / `pageEntries`, эффект с `prevLengthRef`,
  вся разметка `<nav class="pager">`;
- фильтр по календарной дате: состояние `jumpDate`, `handleJumpToDate`,
  `handleShowAll`, вычисления `oldestDay` / `newestDay` / `filteredEntries`,
  разметка `<label class="date-field">` и кнопки «Показать всё»;
- импорты `IconChevronLeft`, `IconChevronRight`.

Из `custom.css`:

- правила `.pager` и `.pager__status`;
- правила `.date-field` и `.date-field input`.

Из всех 12 файлов локализации — ключи:
`journal.pagerAriaLabel`, `journal.pageStatus`, `journal.showAll`,
`journal.selectDate`, `journal.jumpToDate`, `journal.emptyDate`,
`journal.empty`.

> Все семь ключей используются ТОЛЬКО в `journal.jsx` — проверено grep'ом,
> удаление ничего больше не задевает. Тест `tests/i18n.test.js` требует
> идентичного набора ключей во всех 12 файлах, поэтому удалять и добавлять
> нужно **во всех двенадцати**, иначе тест упадёт.

**Кнопка «Сегодня» (`journal.dueButton`, переход `goTo({kind:"today"})`)
НЕ удаляется и не переносится.** Она остаётся ровно там, где стоит
сейчас — в `actions` компонента `Screen`. Да, по смыслу это навигация в
другой раздел, а не действие над «Журналом»; это отдельное решение, оно
вне этой задачи.

---

## 3. Новый файл: `src/ui/icons/funnel.jsx`

Создать с этим содержимым, дословно:

```jsx
// Фильтр по категории записей "Журнала" — воронка. Самодельный контур в
// том же стиле, что заливные Radix-иконки проекта (viewBox 0 0 15 15,
// fill="currentColor", размер в em) — в наборе Radix Icons воронки нет.
export default function IconFunnel(props) {
	return (
		<svg viewBox="0 0 15 15" fill="none" xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" aria-hidden="true" class="icon" {...props}>
			<path
				d="M1.5 3h12a.5.5 0 0 1 .38.82L9.5 9.06V13a.5.5 0 0 1-.72.45l-2-1A.5.5 0 0 1 6.5 12V9.06L2.12 3.82A.5.5 0 0 1 2.5 3z"
				fill="currentColor"
			/>
		</svg>
	);
}
```

---

## 4. `src/ui/signals/journal.js` — одна новая функция

Добавить в конец файла (`markJournalEntryRead` уже импортирован в шапке
файла — проверь, что он есть в списке импортов, и если нет, добавь):

```js
// Точечное "прочитано" на одной записи — обратимая альтернатива
// разрушительному markAllRead: помечает read БЕЗ навигации (в отличие от
// openJournalEntry, который делает и то, и другое). Нужно вкладке "Новое":
// человек разбирает список, не уходя с экрана.
export async function markOneRead(ownerPubkey, dbKey, entryId) {
	await markJournalEntryRead(entryId);
	await refreshJournal(ownerPubkey, dbKey);
}
```

Ничего другого в этом файле не менять.

---

## 5. `src/ui/screens/journal.jsx` — полная замена

Замени содержимое файла целиком на текст ниже. Не «примени изменения» —
именно замени.

```jsx
import { useEffect, useState, useId } from "preact/hooks";
import { currentUser, dbKeySig } from "../signals/auth.js";
import { journalEntries, refreshJournal, openJournalEntry, markAllRead, markOneRead } from "../signals/journal.js";
import { messagingActivity } from "../signals/chats.js";
import { loadUiSettings } from "../../domain/settings/ui-settings.js";
import { dueBadgeCount, refreshDueBadge } from "../signals/today.js";
import { goTo } from "../signals/place.js";
import { useDetailsMenu } from "../hooks/use-details-menu.js";
import Screen from "../components/screen.jsx";
import IconEnvelopeClosed from "../icons/envelope-closed.jsx";
import IconReader from "../icons/reader.jsx";
import IconChatBubble from "../icons/chat-bubble.jsx";
import IconPeople from "../icons/people.jsx";
import IconPhoneCall from "../icons/phone-call.jsx";
import IconLockClosed from "../icons/lock-closed.jsx";
import IconPerson from "../icons/person.jsx";
import IconCheck from "../icons/check.jsx";
import IconFunnel from "../icons/funnel.jsx";
import IconChevronDown from "../icons/chevron-down.jsx";
import { t, tPlural, currentLocale } from "../signals/i18n.js";

// Этап 50 (CONTACTS-FSM.md §7) — категория -> подпись + иконка + оттенок
// чипа (VISUAL.md v2, Claude Opus: "разные типы записи узнаются по цвету
// иконки, не только по тексту"). Тон — не декоративный произвол: lamp
// (акцент) для прямого личного контакта (сообщения/звонки), draught
// (акцент-компаньон) для социального/обратной связи (ответы/контакты),
// bad для модерации (предупреждающий смысл), muted для остального.
//
// labelKey — форма ЕДИНСТВЕННОГО числа ("Сообщение"), она больше нигде не
// выводится в строке записи (см. ниже, категорию несёт иконка), но остаётся
// как подпись для screen reader'а. filterLabelKey — собирательная форма
// ("Сообщения") для чипа/пункта меню фильтра: это разные грамматические
// формы, один ключ на оба места дал бы кривой текст хотя бы в одном из них.
const CATEGORY_META = {
	messages: { labelKey: "journal.category.messages", filterLabelKey: "journal.filter.messages", Icon: IconEnvelopeClosed, tone: "lamp" },
	channels: { labelKey: "journal.category.channels", filterLabelKey: "journal.filter.channels", Icon: IconReader, tone: "muted" },
	replies: { labelKey: "journal.category.replies", filterLabelKey: "journal.filter.replies", Icon: IconChatBubble, tone: "draught" },
	contacts: { labelKey: "journal.category.contacts", filterLabelKey: "journal.filter.contacts", Icon: IconPeople, tone: "draught" },
	calls: { labelKey: "journal.category.calls", filterLabelKey: "journal.filter.calls", Icon: IconPhoneCall, tone: "lamp" },
	moderation: { labelKey: "journal.category.moderation", filterLabelKey: "journal.filter.moderation", Icon: IconLockClosed, tone: "bad" },
	inbox: { labelKey: "journal.category.inbox", filterLabelKey: "journal.filter.inbox", Icon: IconPerson, tone: "muted" },
};

// Порядок категорий в фильтре — фиксированный, от самого частого и личного
// к самому редкому и служебному. НЕ Object.keys(CATEGORY_META) и не
// сортировка по счётчику: порядок, скачущий от количества записей, ломает
// мышечную память (вчера "Звонки" были третьими, сегодня пятые).
const FILTER_ORDER = ["messages", "inbox", "replies", "contacts", "calls", "channels", "moderation"];

// Лента раскрывается ПО ДНЯМ, а не по числу записей. Пагинация страницами
// была снята вместе с классом багов, который она порождала: "страница" —
// статичный индекс в список, растущий сверху, поэтому новая запись сдвигала
// весь массив и та же страница показывала другие записи (реальный баг,
// найденный пользователем живьём, лечился костылём prevLengthRef). У дня
// такого свойства нет: календарный день — устойчивый ключ, новая запись
// попадает в свой день и ничего не сдвигает.
const INITIAL_DAYS = 3;
const DAYS_STEP = 1;

// Только время — дата уже вынесена в заголовок группы дня (jgroup__date),
// повторять её в каждой строке избыточно (VISUAL.md v2: .jtime "21:16").
function formatEntryTime(ms) {
	return new Date(ms).toLocaleTimeString(currentLocale.value, { hour: "2-digit", minute: "2-digit" });
}

// Ключ календарного дня в ЛОКАЛЬНОМ времени (не UTC) — обязан совпадать с тем,
// что показывает formatEntryTime (тоже локальное время), иначе группировка
// "разъедется" с отображением около полуночи в не-UTC поясах.
function dayKey(ms) {
	const d = new Date(ms);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function formatDaySeparator(ms) {
	return new Date(ms).toLocaleDateString(currentLocale.value, { day: "2-digit", month: "long", year: "numeric" });
}

// "Сегодня · 24 августа" вместо голой даты для двух ближайших дней —
// человек читает ленту сверху, и первые две группы почти всегда именно
// эти. Точка отсчёта берётся В МОМЕНТ РЕНДЕРА: если приложение оставили
// открытым через полночь, подпись обновится на следующей перерисовке, не
// раньше. Сознательное упрощение — таймер ради подписи не заводим.
function dayLabel(ms) {
	const now = Date.now();
	const key = dayKey(ms);
	const absolute = formatDaySeparator(ms);
	if (key === dayKey(now)) return `${t("journal.today")} · ${absolute}`;
	if (key === dayKey(now - 86400000)) return `${t("journal.yesterday")} · ${absolute}`;
	return absolute;
}

// Группировка по календарному дню — стабильный порядок (список уже
// отсортирован по occurredAt по убыванию), каждая группа — отдельная
// <section> с собственным заголовком (a11y: список читается как оглавление
// по дням, не плоской лентой).
function groupByDay(entries) {
	const groups = [];
	let current = null;
	for (const entry of entries) {
		const key = dayKey(entry.occurredAt);
		if (!current || current.key !== key) {
			current = { key, entries: [] };
			groups.push(current);
		}
		current.entries.push(entry);
	}
	return groups;
}

// titleKey/bodyKey (записи ПОСЛЕ этапа 64) рендерятся t()'ом в ТЕКУЩЕЙ
// локали читателя; записи без ключа (старый формат) показывают уже
// сохранённый title/body как есть — они навсегда остаются на русском
// (пользователь подтвердил, без миграции).
function entryText(entry) {
	return {
		title: entry.titleKey ? t(entry.titleKey, entry.titleParams) : entry.title,
		body: entry.bodyKey ? t(entry.bodyKey, entry.bodyParams) : entry.body,
	};
}

// Строка записи. Категория БОЛЬШЕ НЕ дублируется словом в начале заголовка
// (было "Сообщение: Ирина Соколова"): её несёт цветная иконка слева, а
// слово съедало ровно то место, где на телефоне должна быть суть — .jtitle
// обрезался многоточием на середине имени. Для screen reader'а подпись
// категории осталась, в .visually-hidden.
function JournalItem({ entry, onOpen, onMarkRead }) {
	const meta = CATEGORY_META[entry.category];
	const Icon = meta?.Icon ?? IconPerson;
	const categoryLabel = meta ? t(meta.labelKey) : entry.category;
	const { title, body } = entryText(entry);

	return (
		<li class="jitem" data-read={entry.read || undefined}>
			<button type="button" class="jitem__link" onClick={onOpen}>
				<span class={`jtype jtype--${meta?.tone ?? "muted"} row`} style={{ alignItems: "center", justifyContent: "center" }} aria-hidden="true">
					<Icon />
				</span>
				<span class="jbody stack" style={{ "--gap": "2px" }}>
					<span class="visually-hidden">{categoryLabel}</span>
					<span class="jtitle truncate" style={{ "--lines": "2" }}>
						{title}
					</span>
					{body && (
						<span class="jmeta truncate" style={{ "--lines": "1" }}>
							{body}
						</span>
					)}
				</span>
				<span class="jside stack" style={{ "--gap": "var(--space-3xs)", alignItems: "flex-end", justifyContent: "center" }}>
					<span class="jtime">{formatEntryTime(entry.occurredAt)}</span>
					{!entry.read && <span class="jdot" aria-label={t("journal.unreadDot")} />}
				</span>
			</button>
			{!entry.read && onMarkRead && (
				<button type="button" class="icon-btn jread" onClick={onMarkRead} aria-label={t("journal.markOneRead")} title={t("journal.markOneRead")}>
					<IconCheck />
				</button>
			)}
		</li>
	);
}

// Фильтр по категории существует в ДВУХ видах одновременно в DOM, а
// показывается всегда ровно один — выбор делает @container по ширине
// .slices-zone (custom.css), не JS: узкому контейнеру достаётся
// выпадающее меню, широкому — ряд чипов, где весь набор категорий со
// счётчиками виден без открывания. Состояние (`value`) у обоих общее,
// дублируется только разметка.
function CategoryFilter({ value, counts, total, onChange }) {
	const { ref, handleMenuClick } = useDetailsMenu();
	const activeMeta = value ? CATEGORY_META[value] : null;
	const ActiveIcon = activeMeta?.Icon ?? IconFunnel;
	const activeLabel = activeMeta ? t(activeMeta.filterLabelKey) : t("journal.filter.all");
	const activeCount = value ? (counts[value] ?? 0) : total;

	return (
		<>
			<div class="filter-slot grow bar" style={{ justifyContent: "flex-end" }}>
				<details class={`menu jfilter${activeMeta ? ` jcat--${activeMeta.tone}` : ""}`} ref={ref} onClick={handleMenuClick}>
					<summary class="chip bar" style={{ "--gap": "var(--space-2xs)", alignItems: "center", cursor: "pointer" }} aria-label={t("journal.filterAria")}>
						<ActiveIcon />
						<span>{activeLabel}</span>
						<span class="slice__n">{activeCount}</span>
						<IconChevronDown />
					</summary>
					<div class="menu-pop stack" style={{ "--gap": "0" }}>
						<ul class="stack" style={{ "--gap": "1px" }}>
							<li>
								<button type="button" aria-current={value === null ? "true" : undefined} onClick={() => onChange(null)}>
									<IconFunnel />
									<span class="jcat__label">{t("journal.filter.all")}</span>
									<span class="menu-hint">{total}</span>
								</button>
							</li>
						</ul>
						<ul class="stack" style={{ "--gap": "1px" }}>
							{FILTER_ORDER.map((key) => {
								const meta = CATEGORY_META[key];
								const Icon = meta.Icon;
								return (
									<li key={key}>
										<button type="button" class={`jcat--${meta.tone}`} aria-current={value === key ? "true" : undefined} onClick={() => onChange(key)}>
											<Icon />
											<span class="jcat__label">{t(meta.filterLabelKey)}</span>
											<span class="menu-hint">{counts[key] ?? 0}</span>
										</button>
									</li>
								);
							})}
						</ul>
					</div>
				</details>
			</div>

			<div class="filter-reel reel" style={{ "--gap": "var(--space-2xs)" }} role="group" aria-label={t("journal.filterAria")}>
				<button type="button" class={`slice bar rigid${value === null ? " slice--on" : ""}`} style={{ "--gap": "var(--space-2xs)", alignItems: "center" }} aria-pressed={value === null} onClick={() => onChange(null)}>
					<IconFunnel />
					<span>{t("journal.filter.all")}</span>
					<span class="slice__n">{total}</span>
				</button>
				{FILTER_ORDER.map((key) => {
					const meta = CATEGORY_META[key];
					const Icon = meta.Icon;
					return (
						<button key={key} type="button" class={`slice jcat jcat--${meta.tone} bar rigid${value === key ? " slice--on" : ""}`} style={{ "--gap": "var(--space-2xs)", alignItems: "center" }} aria-pressed={value === key} onClick={() => onChange(key)}>
							<Icon />
							<span>{t(meta.filterLabelKey)}</span>
							<span class="slice__n">{counts[key] ?? 0}</span>
						</button>
					);
				})}
			</div>
		</>
	);
}

// Стартовый экран после логина (place.js, DEFAULT_PLACE) — персистентный
// лог ВСЕХ сработавших уведомлений (notifyAndLog, journal.js), не заменяет
// тосты/бейджи (они остаются как есть, быстрая реакция).
//
// Экран отвечает на вопрос "что я пропустил", поэтому разделён на две
// вкладки: "Новое" — только непрочитанное, плоским списком (группировать по
// дням нечего: это всё свежее), "История" — весь лог по дням. Прочитанное
// уходит из первой во вторую само.
export default function Journal() {
	const ownerPubkey = currentUser.value.id;
	const dbKey = dbKeySig.value;
	const [tab, setTab] = useState("new");
	const [category, setCategory] = useState(null);
	const [visibleDays, setVisibleDays] = useState(INITIAL_DAYS);
	const [everSetDueDate, setEverSetDueDate] = useState(false);
	const tabsId = useId();

	useEffect(() => {
		refreshJournal(ownerPubkey, dbKey);
		refreshDueBadge(ownerPubkey, dbKey);
		loadUiSettings(ownerPubkey, dbKey).then((s) => setEverSetDueDate(s.everSetDueDate));
	}, [ownerPubkey, messagingActivity.value]);

	// Смена вкладки или фильтра начинает просмотр заново — иначе человек,
	// раскрывший двадцать дней в "Истории", получит их же после переключения
	// на другую категорию, где двадцати дней может не быть вовсе.
	useEffect(() => {
		setVisibleDays(INITIAL_DAYS);
	}, [tab, category]);

	const entries = journalEntries.value;
	const hasUnread = entries.some((e) => !e.read);

	// Счётчики считаются по НАБОРУ ТЕКУЩЕЙ ВКЛАДКИ, а не по всему журналу:
	// во вкладке "Новое" чип "Звонки 3" обязан означать три непрочитанных
	// звонка, иначе человек жмёт на него и получает пустой список.
	const scope = tab === "new" ? entries.filter((e) => !e.read) : entries;
	const counts = scope.reduce((acc, e) => {
		acc[e.category] = (acc[e.category] ?? 0) + 1;
		return acc;
	}, {});
	const visible = category ? scope.filter((e) => e.category === category) : scope;

	const allGroups = groupByDay(visible);
	const shownGroups = allGroups.slice(0, visibleDays);
	const nextGroup = allGroups[visibleDays];

	function handleOpen(entry) {
		openJournalEntry(ownerPubkey, dbKey, entry);
	}

	function handleMarkOne(entry) {
		markOneRead(ownerPubkey, dbKey, entry.id);
	}

	// Три разных пустоты, три разных текста. Одна общая заглушка на все
	// случаи ("Ничего нет") оставляет человека гадать, пусто ли вообще всё
	// или он сам сузил список фильтром до нуля.
	function renderEmpty() {
		if (entries.length === 0) {
			return (
				<div class="empty">
					<h3>{t("journal.emptyTitle")}</h3>
					<p>{t("journal.emptyBody")}</p>
				</div>
			);
		}
		if (tab === "new" && !category) {
			return (
				<div class="empty">
					<h3>{t("journal.allReadTitle")}</h3>
					<p>{t("journal.allReadBody")}</p>
				</div>
			);
		}
		return (
			<div class="empty">
				<h3>{t("journal.emptyFilterTitle")}</h3>
				<p>{t("journal.emptyFilterBody")}</p>
			</div>
		);
	}

	return (
		<Screen
			title={t("nav.journal")}
			actions={
				<>
					{everSetDueDate && (
						<button type="button" class="btn btn--ghost pill-due bar" style={{ "--gap": "var(--space-3xs)", alignItems: "center" }} onClick={() => goTo({ kind: "today" })}>
							◈ {t("journal.dueButton")} <span class="pill__n">{dueBadgeCount.value}</span>
						</button>
					)}
					<button type="button" disabled={!hasUnread} onClick={() => markAllRead(ownerPubkey, dbKey)}>
						<IconCheck />
						<span class="mark-txt">{t("journal.markAllRead")}</span>
					</button>
				</>
			}
			slices={
				<>
					<div class="filter-row bar" style={{ "--gap": "var(--space-s)", alignItems: "flex-end" }}>
						<div class="tabs bar" style={{ "--gap": "0" }} role="tablist" aria-label={t("journal.tabsAria")}>
							<button type="button" id={`${tabsId}-new`} class="tab bar" style={{ "--gap": "var(--space-2xs)", alignItems: "center" }} role="tab" aria-selected={tab === "new"} aria-controls={`${tabsId}-panel`} onClick={() => setTab("new")}>
								{t("journal.tabNew")}
								{hasUnread && <span class="pill__n">{entries.filter((e) => !e.read).length}</span>}
							</button>
							<button type="button" id={`${tabsId}-all`} class="tab bar" role="tab" aria-selected={tab === "all"} aria-controls={`${tabsId}-panel`} onClick={() => setTab("all")}>
								{t("journal.tabAll")}
							</button>
						</div>
						<CategoryFilter value={category} counts={counts} total={scope.length} onChange={setCategory} />
					</div>
				</>
			}
		>
			<div class="journal" id={`${tabsId}-panel`} role="tabpanel" aria-labelledby={tab === "new" ? `${tabsId}-new` : `${tabsId}-all`}>
				{visible.length === 0 ? (
					renderEmpty()
				) : tab === "new" ? (
					<>
						<p class="jlead">{tPlural("journal.newLead", visible.length)}</p>
						<ol class="jfeed">
							{visible.map((entry) => (
								<JournalItem key={entry.id} entry={entry} onOpen={() => handleOpen(entry)} onMarkRead={() => handleMarkOne(entry)} />
							))}
						</ol>
						<p class="jlead jlead--foot">{t("journal.newFoot")}</p>
					</>
				) : (
					<>
						{shownGroups.map((group) => (
							<section class="jgroup" key={group.key} aria-labelledby={`jg-${group.key}`}>
								<h2 class="jgroup__date stick" id={`jg-${group.key}`}>
									{dayLabel(group.entries[0].occurredAt)}
								</h2>
								<ol class="jfeed">
									{group.entries.map((entry) => (
										<JournalItem key={entry.id} entry={entry} onOpen={() => handleOpen(entry)} />
									))}
								</ol>
							</section>
						))}
						{nextGroup && (
							<div class="jmore row" style={{ "--gap": "var(--space-s)", alignItems: "center", justifyContent: "center" }}>
								<button type="button" class="btn btn--ghost" onClick={() => setVisibleDays(visibleDays + DAYS_STEP)}>
									{t("journal.showMoreDay", { date: formatDaySeparator(nextGroup.entries[0].occurredAt) })}
								</button>
							</div>
						)}
					</>
				)}
			</div>
		</Screen>
	);
}
```

---

## 6. `src/styles/custom.css`

Шесть правок. Делай их по порядку, каждую — точечно, поиском по указанному
якорю. Не переписывай файл целиком: в нём 273 КБ и десятки комментариев с
историей найденных багов, они ценны.

### 6.1. Одна линия под «головой» экрана вместо двух

**Это правка не «Журнала», а всего приложения.** Сейчас `.section-header`
рисует нижнюю границу И `.slices-zone` рисует свою — ряд срезов/фильтров
оказывается зажат между двумя линиями. Затронуты все экраны со срезами:
`chat`, `files`, `channel`, `channel-chat`, и теперь «Журнал».

Найди правило:

```css
/* .rigid/.stack/.box (раскладка) уже в JSX — здесь только граница. */
.section-header {
	border-block-end: var(--border-width) solid var(--border);
}
```

и добавь СРАЗУ ПОСЛЕ него:

```css
/* Под шапкой идёт зона срезов — и та рисует свою нижнюю границу. Две
   линии подряд визуально запирают ряд фильтров в клетку; линия должна
   быть одна, под всей "головой" экрана целиком. :has() смотрит на
   следующего соседа, поэтому экраны БЕЗ slices-zone не затронуты. */
.section-header:has(+ .slices-zone) {
	border-block-end: none;
}

/* @container для .mark-txt ниже (секция "Журнал") меряет шапку — контекст
   объявляется здесь, один раз, как .content-wrapper для области контента. */
.section-header {
	container-type: inline-size;
}
```

### 6.2. Зона срезов: контейнер + режим вкладок

Найди правило `.slices-zone { … }` и добавь ПОСЛЕ него (не внутрь):

```css
/* Порог "меню против ряда чипов" в фильтре "Журнала" меряется по ширине
   ЭТОЙ зоны, а не вьюпорта: рядом стоит боковая панель, доступная ширина
   экрана — не ширина окна. Тот же приём, что у .content-wrapper. */
.slices-zone {
	container-type: inline-size;
}

/* Зона с вкладками внутри — особый случай: подчёркивание активной вкладки
   (.tab уже имеет margin-block-end:-1px) обязано лечь ровно на нижнюю
   границу зоны, иначе вкладка висит в воздухе. Отсюда нулевой нижний
   отступ зоны и снятая собственная граница .tabs. */
.slices-zone:has(.tabs) {
	padding-block-start: var(--space-2xs);
	padding-block-end: 0;
}
.slices-zone .tabs {
	margin-block: 0;
	border-block-end: none;
}
.slices-zone .tab {
	padding-block: var(--space-xs);
}
/* Отступ меню-фильтра от линии даёт слот-обёртка (padding), а не сам
   компонент — REGLAMENT.md §3 п.1, margin на компоненте запрещён. */
.filter-slot {
	padding-block-end: var(--space-2xs);
}
```

### 6.3. Секция «Журнал»: удалить и поправить

В секции `/* Экран "Журнал" — VISUAL.md v2 … */`:

**Удалить целиком** правила `.date-field`, `.date-field input`, `.pager`,
`.pager__status` (см. §2).

**Заменить** сломанный контейнерный запрос. Было:

```css
@container (max-width: 32em) {
	.journal .mark-txt {
		display: none;
	}
}
```

Стало:

```css
/* НАЙДЕННЫЙ ДЕФЕКТ: селектор был `.journal .mark-txt`, но .mark-txt живёт
   в шапке (Screen actions), а .journal — в теле экрана. Правило не
   совпадало никогда, подпись "Отметить прочитанным" не пряталась на узком
   экране ни разу с момента написания. Контейнер теперь .section-header
   (объявлен выше), селектор — по фактическому месту кнопки. */
@container (max-width: 32em) {
	.action-buttons .mark-txt {
		display: none;
	}
}
```

**Заменить** `.jtitle` и `.jmeta`. Было:

```css
.jtitle {
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	font-weight: var(--weight-bold);
}
.jmeta {
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	color: var(--muted);
	font-size: var(--step--1);
}
```

Стало:

```css
/* Обрезка отдана композиционному классу .truncate (--lines в разметке):
   заголовок теперь в ДВЕ строки, а не одна с многоточием — на телефоне
   "Ирина Соколова" обрезалось до "Ирина Соко…". Собственных правил
   overflow/white-space здесь больше нет, иначе они спорят с .truncate. */
.jtitle {
	font-weight: var(--weight-bold);
}
.jmeta {
	color: var(--muted);
	font-size: var(--step--1);
}
```

**Заменить** `.jgroup__date`, добавив непрозрачную подложку:

```css
/* Заголовок дня липнет к верху скролл-зоны (.stick в разметке —
   композиционный слой). Подложка обязательна: без неё строки ленты
   просвечивают сквозь заголовок при прокрутке. */
.jgroup__date {
	font-size: var(--step--1);
	font-weight: var(--weight-bold);
	color: var(--muted);
	text-transform: uppercase;
	letter-spacing: 0.06em;
	margin-block: 0 var(--space-2xs);
	background-color: var(--bg);
	padding-block: var(--space-2xs);
	z-index: 1;
}
```

### 6.4. Новые правила «Журнала»

Добавь в конец секции «Журнал» (туда, где были `.pager`):

```css
/* Подводка вкладки "Новое" — одна строка, объясняющая, что это за список
   и куда девается прочитанное. */
.jlead {
	color: var(--muted);
	font-size: var(--step--1);
	margin-block: 0 var(--space-m);
}
.jlead--foot {
	margin-block: var(--space-m) 0;
	padding-block-start: var(--space-m);
	border-block-start: var(--border-width) solid var(--border);
}

/* Точечное "прочитано" на строке — обратимая по одной записи альтернатива
   разрушительному "отметить всё". Появляется по наведению/фокусу; на
   сенсорных устройствах наведения нет, там видна всегда. */
.jitem {
	position: relative;
}
.jread {
	position: absolute;
	inset-block-start: 50%;
	inset-inline-end: var(--space-3xs);
	translate: 0 -50%;
	opacity: 0;
	transition: opacity var(--transition-speed) var(--transition-ease);
}
.jitem:hover .jread,
.jread:focus-visible {
	opacity: 1;
}
@media (hover: none) {
	.jread {
		opacity: 1;
	}
}

/* "Показать ещё за <дата>" вместо пагинации. */
.jmore {
	margin-block-start: var(--space-l);
	padding-block-start: var(--space-m);
	border-block-start: var(--border-width) solid var(--border);
}
```

### 6.5. Фильтр по категории

Добавь следом:

```css
/* ---- Фильтр по категории (два вида одного органа управления) -------
   Собран из того, что уже есть: <details class="menu"> + summary.chip +
   .menu-pop + .menu-hint — тот же приём, что у AddToGroupControl
   (contacts.jsx) и меню учётной записи. Нового — только тон категории и
   состояние "выбран". */

/* Тон — те же три выражения, что уже работают в .jtype--lamp/--draught/
   --bad. В пункте МЕНЮ красится только иконка: цветной текст в плотном
   списке читается хуже и спорит с --fg. */
.jcat--lamp > .icon,
.jcat--lamp > summary > .icon:first-child {
	color: var(--accent);
}
.jcat--draught > .icon,
.jcat--draught > summary > .icon:first-child {
	color: var(--accent-2);
}
.jcat--bad > .icon,
.jcat--bad > summary > .icon:first-child {
	color: var(--bad);
}
.jcat--muted > .icon,
.jcat--muted > summary > .icon:first-child {
	color: var(--muted);
}

/* Пункт .menu-pop уже flex — подпись забирает остаток, счётчик .menu-hint
   уезжает вправо своим margin-inline-start:auto. */
.jcat__label {
	flex: 1 1 auto;
	min-inline-size: 0;
}

/* Выбранный пункт меню — единственное, чего у .menu-pop не было. */
.menu-pop button[aria-current="true"] {
	background-color: var(--surface);
	font-weight: var(--weight-bold);
}

/* Шеврон триггера — приглушён, разворачивается при открытии. Анимируется
   rotate (композитный), не height/margin — REGLAMENT.md §3 п.7. */
.jfilter > summary > .icon:last-child {
	color: var(--muted);
	transition: rotate var(--transition-speed) var(--transition-ease);
}
.jfilter[open] > summary > .icon:last-child {
	rotate: 180deg;
}
.jfilter > summary .slice__n {
	font-variant-numeric: tabular-nums;
}

/* ---- Второй вид: ряд чипов на широком контейнере ------------------- */
.filter-reel {
	padding-block: var(--space-2xs);
	scrollbar-width: none;
}
.filter-reel::-webkit-scrollbar {
	display: none;
}
.slice.jcat--lamp {
	color: var(--accent);
}
.slice.jcat--draught {
	color: var(--accent-2);
}
.slice.jcat--bad {
	color: var(--bad);
}
.slice.jcat--muted {
	color: var(--muted);
}
.jcat .icon {
	color: inherit;
}
/* Выбранный чип — обводка и подложка СВОИМ цветом (currentColor), а не
   общим акцентом: иначе выбор "Модерации" красится в тот же янтарь, что
   выбор "Сообщений", и цветовой код категории теряет смысл ровно в тот
   момент, когда он нужнее всего. */
.slice--on {
	border-color: currentColor;
	background-color: color-mix(in oklch, currentColor, transparent 88%);
}

/* Ровно ОДИН вид фильтра виден в каждый момент — дублирующего органа
   управления на экране нет. Порог по ширине .slices-zone (§6.2). */
@container (max-width: 52em) {
	.filter-reel {
		display: none;
	}
}
@container (min-width: 52em) {
	.filter-slot {
		display: none;
	}
}
```

### 6.6. Проверка после правок CSS

- `grep -n "\.pager\|\.date-field" src/styles/custom.css` — не должно
  находить ничего.
- `grep -n "\.journal \.mark-txt" src/styles/custom.css` — не должно
  находить ничего.

---

## 7. Локализация

### 7.1. Удалить из **всех 12** файлов `src/ui/i18n/locales/*.json`

Внутри узла `journal`: `selectDate`, `jumpToDate`, `showAll`,
`empty`, `emptyDate`, `pagerAriaLabel`, `pageStatus`.

### 7.2. Добавить в **все 12** файлов, внутрь узла `journal`

Русский (`ru.json`) — дословно:

```json
"tabsAria": "Разделы журнала",
"tabNew": "Новое",
"tabAll": "История",
"filterAria": "Фильтр по категории",
"markOneRead": "Отметить прочитанным",
"showMoreDay": "Показать ещё за {{date}}",
"today": "Сегодня",
"yesterday": "Вчера",
"emptyTitle": "Пока ничего не произошло",
"emptyBody": "Здесь появятся сообщения, заявки в контакты, ответы на ваши записи и события каналов — всё, что случилось, пока вас не было.",
"allReadTitle": "Всё прочитано",
"allReadBody": "Ничего нового. Всё, что произошло раньше, лежит в «Истории».",
"emptyFilterTitle": "В этой категории пусто",
"emptyFilterBody": "Выберите другую категорию или вернитесь ко всем событиям.",
"newLead": {
	"one": "{{count}} непрочитанное событие",
	"few": "{{count}} непрочитанных события",
	"many": "{{count}} непрочитанных событий",
	"other": "{{count}} непрочитанных события"
},
"newFoot": "Прочитанное уходит в «Историю» — здесь остаётся только то, что вы ещё не видели.",
"filter": {
	"all": "Все события",
	"messages": "Сообщения",
	"channels": "Каналы",
	"replies": "Ответы",
	"contacts": "Контакты",
	"calls": "Звонки",
	"moderation": "Модерация",
	"inbox": "Заявки"
}
```

Английский (`en.json`) — дословно:

```json
"tabsAria": "Journal sections",
"tabNew": "New",
"tabAll": "History",
"filterAria": "Filter by category",
"markOneRead": "Mark as read",
"showMoreDay": "Show more from {{date}}",
"today": "Today",
"yesterday": "Yesterday",
"emptyTitle": "Nothing has happened yet",
"emptyBody": "Messages, contact requests, replies to your posts and channel events will show up here — everything that happened while you were away.",
"allReadTitle": "All caught up",
"allReadBody": "Nothing new. Everything older is in History.",
"emptyFilterTitle": "Nothing in this category",
"emptyFilterBody": "Pick another category or go back to all events.",
"newLead": {
	"one": "{{count}} unread event",
	"other": "{{count}} unread events"
},
"newFoot": "Read entries move to History — only what you haven't seen stays here.",
"filter": {
	"all": "All events",
	"messages": "Messages",
	"channels": "Channels",
	"replies": "Replies",
	"contacts": "Contacts",
	"calls": "Calls",
	"moderation": "Moderation",
	"inbox": "Requests"
}
```

Остальные 10 языков (`es, de, ja, fr, pt, it, nl, pl, tr, zh`) — перевести
самостоятельно, сохранив ИМЕНА ключей один в один.

**Множественное число (`newLead`) — по правилам CLDR каждого языка, а не
копированием русской структуры:**

- `pl` — `one` / `few` / `many` / `other` (как в русском);
- `es, de, fr, pt, it, nl, tr` — `one` / `other`;
- `ja, zh` — только `other`.

Тест `tests/i18n.test.js` требует ИДЕНТИЧНОГО набора путей ключей во всех
12 файлах, поэтому набор категорий внутри `newLead` обязан совпасть везде.
Значит: **во всех 12 файлах пиши полный набор `one/few/many/other`**, даже
там, где язык различает меньше форм — лишние ветки просто не выбираются
`Intl.PluralRules`, а тест проходит. В языках без различий продублируй одну
и ту же строку во все четыре ветки.

---

## 8. Тесты

В `tests/journal-signals.test.js` добавь в конец:

```js
test("markOneRead: помечает одну запись прочитанной, остальные не трогает", async () => {
	const a = await writeJournalEntry(OWNER_PUBKEY, DB_KEY, { category: "messages", title: "a", body: "", navTarget: { screen: "messages" } });
	await writeJournalEntry(OWNER_PUBKEY, DB_KEY, { category: "calls", title: "b", body: "", navTarget: { screen: "messages" } });
	await refreshJournal(OWNER_PUBKEY, DB_KEY);

	await markOneRead(OWNER_PUBKEY, DB_KEY, a.id);

	const byId = Object.fromEntries(journalEntries.value.map((e) => [e.id, e]));
	assert.equal(byId[a.id].read, true);
	assert.equal(journalEntries.value.filter((e) => !e.read).length, 1);
});

test("markOneRead: не выполняет навигацию (в отличие от openJournalEntry)", async () => {
	const entry = await writeJournalEntry(OWNER_PUBKEY, DB_KEY, { category: "messages", title: "a", body: "", navTarget: { screen: "messages" } });
	await refreshJournal(OWNER_PUBKEY, DB_KEY);

	await markOneRead(OWNER_PUBKEY, DB_KEY, entry.id);

	assert.equal(pendingNavTarget.value, null);
});
```

Не забудь добавить `markOneRead` в список импортов вверху файла теста.

Запуск: `npm test`. Все тесты обязаны быть зелёными, включая
`tests/i18n.test.js` (он и поймает несведённые локали).

---

## 9. Приёмка

Проверь по пунктам и отчитайся по каждому явным «да»/«нет»:

- [ ] `npm test` — зелёный, включая `i18n.test.js` и `journal-signals.test.js`
- [ ] `npm run build` — проходит, бюджет бандла не превышен
- [ ] `grep -rn "PAGE_SIZE\|clampedPage\|prevLengthRef\|jumpDate" src/` — пусто
- [ ] `grep -n "\.pager\|\.date-field\|\.journal \.mark-txt" src/styles/custom.css` — пусто
- [ ] В `journal.jsx` нет ни одного `margin` в инлайн-стилях
- [ ] В `journal.jsx` нет ни одного числа вне токенов (исключение — `"2px"` в
      `--gap` у `.jbody` и `"1px"` у списков меню: они уже были в проекте,
      сохранены как есть)
- [ ] Ровно один `.scroller` на пути от `.shell` до листа (он в `Screen`,
      новых не добавлено)
- [ ] Визуально: под шапкой ровно ОДНА горизонтальная линия, подчёркивание
      активной вкладки лежит на ней
- [ ] Визуально: узкое окно — виден только выпадающий фильтр; широкое —
      только ряд чипов; никогда не оба сразу
- [ ] Визуально: заголовок дня прилипает к верху при прокрутке и не
      просвечивает
- [ ] Клавиатурой: Tab обходит вкладки, фильтр, записи; Escape закрывает
      меню фильтра; фокус возвращается на триггер

---

## 10. Открытые вопросы — НЕ реализовывать

Перечислено, чтобы ты не «дорешал» это по своей инициативе. Всё ниже ждёт
отдельного решения пользователя:

1. **Переход к произвольной дате.** Прежний `input[type=date]` удалён
   вместе с пагинацией. Замены в этой задаче нет: в «Истории» доступ к
   старым записям только через «Показать ещё». Осознанная временная потеря.
2. **Кнопка «Сегодня»** остаётся в шапке «Журнала», хотя по смыслу это
   навигация в другой раздел и её место — в боковой панели.
3. **`markAllRead` действует на весь журнал**, включая скрытое фильтром и
   вкладкой. Поведение сохранено как было. Подтверждения действия нет.
4. **`align-items` в инлайн-стилях.** По проекту 176 таких мест; в новом
   `journal.jsx` они сохранены ради единообразия с остальным кодом.
   Системное решение (параметр `--align` в композиционном слое) — правка
   `REGLAMENT.md`, отдельная задача.
