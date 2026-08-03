import { useEffect, useState, useRef } from "preact/hooks";
import { currentUser, dbKeySig } from "../signals/auth.js";
import { journalEntries, refreshJournal, openJournalEntry, markAllRead } from "../signals/journal.js";
import { messagingActivity } from "../signals/chats.js";
import Screen from "../components/screen.jsx";
import IconEnvelopeClosed from "../icons/envelope-closed.jsx";
import IconReader from "../icons/reader.jsx";
import IconChatBubble from "../icons/chat-bubble.jsx";
import IconPeople from "../icons/people.jsx";
import IconPhoneCall from "../icons/phone-call.jsx";
import IconLockClosed from "../icons/lock-closed.jsx";
import IconPerson from "../icons/person.jsx";
import IconCheck from "../icons/check.jsx";
import IconChevronLeft from "../icons/chevron-left.jsx";
import IconChevronRight from "../icons/chevron-right.jsx";
import { t, currentLocale } from "../signals/i18n.js";

// Этап 50 (CONTACTS-FSM.md §7) — категория -> подпись + иконка + оттенок
// чипа (VISUAL.md v2, Claude Opus: "разные типы записи узнаются по цвету
// иконки, не только по тексту"). Тон — не декоративный произвол: lamp
// (акцент) для прямого личного контакта (сообщения/звонки), draught
// (акцент-компаньон) для социального/обратной связи (ответы/контакты),
// bad для модерации (предупреждающий смысл), muted для остального.
//
// Этап 64 — labelKey (не готовый текст), переводится t(meta.labelKey) В
// РЕНДЕРЕ (не здесь — это модульная константа, вычисляется один раз при
// импорте, реактивности на смену языка тут нет).
const CATEGORY_META = {
	messages: { labelKey: "journal.category.messages", Icon: IconEnvelopeClosed, tone: "lamp" },
	channels: { labelKey: "journal.category.channels", Icon: IconReader, tone: "muted" },
	replies: { labelKey: "journal.category.replies", Icon: IconChatBubble, tone: "draught" },
	contacts: { labelKey: "journal.category.contacts", Icon: IconPeople, tone: "draught" },
	calls: { labelKey: "journal.category.calls", Icon: IconPhoneCall, tone: "lamp" },
	moderation: { labelKey: "journal.category.moderation", Icon: IconLockClosed, tone: "bad" },
	inbox: { labelKey: "journal.category.inbox", Icon: IconPerson, tone: "muted" },
};

// Этап 50-довесок-N (пользователь, живая проверка пагинации подтверждена —
// найден и исправлен реальный баг ниже, теперь разумное число на странице).
const PAGE_SIZE = 15;

// Только время — дата уже вынесена в заголовок группы дня (jgroup__date),
// повторять её в каждой строке избыточно (VISUAL.md v2: .jtime "21:16").
function formatEntryTime(ms) {
	return new Date(ms).toLocaleTimeString(currentLocale.value, { hour: "2-digit", minute: "2-digit" });
}

// Ключ календарного дня в ЛОКАЛЬНОМ времени (не UTC) — обязан совпадать с тем,
// что показывает formatEntryTime (тоже локальное время) и с value <input type="date">
// (плоская дата без временной зоны), иначе группировка "разъедется" с отображением
// около полуночи в не-UTC поясах.
function dayKey(ms) {
	const d = new Date(ms);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function formatDaySeparator(ms) {
	return new Date(ms).toLocaleDateString(currentLocale.value, { day: "2-digit", month: "long", year: "numeric" });
}

// Список отсортирован по occurredAt по убыванию (journal.js) — переход к дате
// ищет первую запись, чей день <= выбранного (первое вхождение искомого дня,
// либо ближайшая более старая, если на саму дату записей нет).
function findPageForDate(entries, dateStr, pageSize) {
	const idx = entries.findIndex((e) => dayKey(e.occurredAt) <= dateStr);
	if (idx === -1) return Math.max(0, Math.ceil(entries.length / pageSize) - 1);
	return Math.floor(idx / pageSize);
}

// Группировка страницы по календарному дню — стабильный порядок (страница
// уже отсортирована по occurredAt), каждая группа — отдельная <section> с
// собственным заголовком (a11y: список читается как оглавление по дням, не
// плоской лентой).
function groupByDay(pageEntries) {
	const groups = [];
	let current = null;
	for (const entry of pageEntries) {
		const key = dayKey(entry.occurredAt);
		if (!current || current.key !== key) {
			current = { key, entries: [] };
			groups.push(current);
		}
		current.entries.push(entry);
	}
	return groups;
}

// Стартовый экран после логина (nav-items.js, DEFAULT_ACTIVE) — персистентный
// лог ВСЕХ сработавших уведомлений (notifyAndLog, journal.js), не заменяет
// тосты/бейджи (они остаются как есть, быстрая реакция) — дополнительный слой
// "что вообще произошло", пока пользователя не было на экране.
export default function Journal() {
	const ownerPubkey = currentUser.value.id;
	const dbKey = dbKeySig.value;
	const [page, setPage] = useState(0);
	const [jumpDate, setJumpDate] = useState("");

	useEffect(() => {
		refreshJournal(ownerPubkey, dbKey);
	}, [ownerPubkey, messagingActivity.value]);

	const entries = journalEntries.value;

	// НАЙДЕНО ПОЛЬЗОВАТЕЛЕМ (живая проверка) — реальный баг был не в сортировке
	// (occurredAt по убыванию и так верный, см. journal.js), а в том, что "page"
	// это СТАТИЧНЫЙ числовой индекс в список, который растёт снизу вверх (новая
	// запись — всегда entries[0], сортировка по времени убывающая): пока
	// пользователь смотрел, скажем, страницу 2, новое событие сдвигало ВЕСЬ
	// массив на одну позицию, и та же страница 2 начинала показывать СОВСЕМ
	// другие (более старые) записи — новое событие визуально оказывалось "где-то
	// в середине" вместо ожидаемого верха списка. prevLengthRef — рост длины
	// однозначно означает "пришла новая запись" (записи в этой модели никогда не
	// удаляются, только read-флаг меняется — длина иначе не меняется), сбрасываем
	// на страницу 0, где и обязана быть самая свежая запись.
	const prevLengthRef = useRef(entries.length);
	useEffect(() => {
		if (entries.length > prevLengthRef.current) {
			setPage(0);
		}
		prevLengthRef.current = entries.length;
	}, [entries.length]);

	const totalPages = Math.max(1, Math.ceil(entries.length / PAGE_SIZE));
	// Страница могла "исчезнуть" (записи прочитаны/удалены на другом устройстве,
	// список сократился) — не показывать пустую страницу молча.
	const clampedPage = Math.min(page, totalPages - 1);
	const pageEntries = entries.slice(clampedPage * PAGE_SIZE, clampedPage * PAGE_SIZE + PAGE_SIZE);
	const hasUnread = entries.some((e) => !e.read);
	const dayGroups = groupByDay(pageEntries);

	const oldestDay = entries.length > 0 ? dayKey(entries[entries.length - 1].occurredAt) : null;
	const newestDay = entries.length > 0 ? dayKey(entries[0].occurredAt) : null;

	function handleJumpToDate(dateStr) {
		setJumpDate(dateStr);
		if (!dateStr) return;
		setPage(findPageForDate(entries, dateStr, PAGE_SIZE));
	}

	return (
		<Screen
			title={t("nav.journal")}
			actions={
				<>
					{oldestDay && (
						<label class="date-field">
							{/* Пользователь: убрать SVG-иконку (рядом с ней всё равно
							    рисуется системная иконка календаря самого <input
							    type="date">, две подряд — лишнее), вместо нёё —
							    информативная текстовая подпись. */}
							<span aria-hidden="true">{t("journal.selectDate")}</span>
							<span class="visually-hidden">{t("journal.jumpToDate")}</span>
							<input type="date" min={oldestDay} max={newestDay} value={jumpDate} onInput={(e) => handleJumpToDate(e.currentTarget.value)} />
						</label>
					)}
					<button type="button" disabled={!hasUnread} onClick={() => markAllRead(ownerPubkey, dbKey)}>
						<IconCheck />
						<span class="mark-txt">{t("journal.markAllRead")}</span>
					</button>
				</>
			}
		>
			{entries.length === 0 ? (
				<p style={{ color: "var(--muted)" }}>{t("journal.empty")}</p>
			) : (
				<div class="journal">
					{dayGroups.map((group) => (
						<section class="jgroup" key={group.key} aria-labelledby={`jg-${group.key}`}>
							<h2 class="jgroup__date" id={`jg-${group.key}`}>
								{formatDaySeparator(group.entries[0].occurredAt)}
							</h2>
							<ol class="jfeed">
								{group.entries.map((entry) => {
									const meta = CATEGORY_META[entry.category];
									const Icon = meta?.Icon ?? IconPerson;
									const categoryLabel = meta ? t(meta.labelKey) : entry.category;
									// Этап 64 — titleKey/bodyKey (записи ПОСЛЕ этого этапа) рендерятся
									// t()'ом в ТЕКУЩЕЙ локали читателя; записи без ключа (старый формат,
									// ДО этого этапа) показывают уже сохранённый title/body как есть —
									// они навсегда остаются на русском (пользователь подтвердил, без миграции).
									const entryTitle = entry.titleKey ? t(entry.titleKey, entry.titleParams) : entry.title;
									const entryBody = entry.bodyKey ? t(entry.bodyKey, entry.bodyParams) : entry.body;
									return (
										<li class="jitem" key={entry.id} data-read={entry.read || undefined}>
											<button type="button" class="jitem__link" onClick={() => openJournalEntry(ownerPubkey, dbKey, entry)}>
												<span class={`jtype jtype--${meta?.tone ?? "muted"}`} aria-hidden="true">
													<Icon />
												</span>
												<span class="jbody">
													<span class="jtitle">{entryTitle}</span>
													{entryBody && <span class="jmeta">{entryBody}</span>}
													<span class="jmeta">{categoryLabel}</span>
												</span>
												<span class="jside">
													<span class="jtime">{formatEntryTime(entry.occurredAt)}</span>
													{!entry.read && <span class="jdot" aria-label={t("journal.unreadDot")} />}
												</span>
											</button>
										</li>
									);
								})}
							</ol>
						</section>
					))}

					{totalPages > 1 && (
						<nav class="pager" aria-label={t("journal.pagerAriaLabel")}>
							<button type="button" class="btn btn--ghost" disabled={clampedPage === 0} onClick={() => setPage(clampedPage - 1)}>
								<IconChevronLeft /> {t("common.back")}
							</button>
							<span class="pager__status" aria-current="page">
								{t("journal.pageStatus", { current: clampedPage + 1, total: totalPages })}
							</span>
							<button type="button" class="btn btn--ghost" disabled={clampedPage >= totalPages - 1} onClick={() => setPage(clampedPage + 1)}>
								{t("common.forward")} <IconChevronRight />
							</button>
						</nav>
					)}
				</div>
			)}
		</Screen>
	);
}
