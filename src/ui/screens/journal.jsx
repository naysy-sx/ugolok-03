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
import IconEye from "../icons/eye.jsx";
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
	// CONTRACTS.md §DISCOVERY — истечение собственной трансляции видимости
	// (обнаруживается локально таймером discovery.jsx, не приходит с реле).
	discovery: { labelKey: "journal.category.discovery", filterLabelKey: "journal.filter.discovery", Icon: IconEye, tone: "muted" },
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
				<span class={`jtype jtype--${meta?.tone ?? "muted"} row`} style={{ "--align": "center", justifyContent: "center" }} aria-hidden="true">
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
				<span class="jside stack" style={{ "--gap": "var(--space-3xs)", "--align": "flex-end", justifyContent: "center" }}>
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
					<summary class="chip bar" style={{ "--gap": "var(--space-2xs)", "--align": "center", cursor: "pointer" }} aria-label={t("journal.filterAria")}>
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
				<button type="button" class={`slice bar rigid${value === null ? " slice--on" : ""}`} style={{ "--gap": "var(--space-2xs)", "--align": "center" }} aria-pressed={value === null} onClick={() => onChange(null)}>
					<IconFunnel />
					<span>{t("journal.filter.all")}</span>
					<span class="slice__n">{total}</span>
				</button>
				{FILTER_ORDER.map((key) => {
					const meta = CATEGORY_META[key];
					const Icon = meta.Icon;
					return (
						<button key={key} type="button" class={`slice jcat jcat--${meta.tone} bar rigid${value === key ? " slice--on" : ""}`} style={{ "--gap": "var(--space-2xs)", "--align": "center" }} aria-pressed={value === key} onClick={() => onChange(key)}>
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
						<button type="button" class="btn btn--ghost pill-due bar" style={{ "--gap": "var(--space-3xs)", "--align": "center" }} onClick={() => goTo({ kind: "today" })}>
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
					<div class="filter-row bar" style={{ "--gap": "var(--space-s)", "--align": "flex-end" }}>
						<div class="tabs bar" style={{ "--gap": "0" }} role="tablist" aria-label={t("journal.tabsAria")}>
							<button type="button" id={`${tabsId}-new`} class="tab bar" style={{ "--gap": "var(--space-2xs)", "--align": "center" }} role="tab" aria-selected={tab === "new"} aria-controls={`${tabsId}-panel`} onClick={() => setTab("new")}>
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
							<div class="jmore row" style={{ "--gap": "var(--space-s)", "--align": "center", justifyContent: "center" }}>
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
