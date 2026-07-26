import { useEffect, useState, useRef } from "preact/hooks";
import { currentUser, dbKeySig } from "../signals/auth.js";
import { journalEntries, refreshJournal, openJournalEntry, markAllRead } from "../signals/journal.js";
import { messagingActivity } from "../signals/chats.js";
import Screen from "../components/screen.jsx";

// Этап 50 (CONTACTS-FSM.md §7) — категория -> заголовок раздела на русском,
// тот же набор, что уже показывается в settings.jsx (per-категорийные тумблеры).
const CATEGORY_LABELS = {
	messages: "Сообщение",
	channels: "Канал",
	replies: "Ответ",
	contacts: "Контакты",
	calls: "Звонок",
	moderation: "Модерация",
	inbox: "Незнакомец",
};

// Этап 50-довесок-N (пользователь, живая проверка пагинации подтверждена —
// найден и исправлен реальный баг ниже, теперь разумное число на странице).
const PAGE_SIZE = 15;

function formatEntryTime(ms) {
	return new Date(ms).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
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
	return new Date(ms).toLocaleDateString("ru-RU", { day: "2-digit", month: "long", year: "numeric" });
}

// Список отсортирован по occurredAt по убыванию (journal.js) — переход к дате
// ищет первую запись, чей день <= выбранного (первое вхождение искомого дня,
// либо ближайшая более старая, если на саму дату записей нет).
function findPageForDate(entries, dateStr, pageSize) {
	const idx = entries.findIndex((e) => dayKey(e.occurredAt) <= dateStr);
	if (idx === -1) return Math.max(0, Math.ceil(entries.length / pageSize) - 1);
	return Math.floor(idx / pageSize);
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

	const oldestDay = entries.length > 0 ? dayKey(entries[entries.length - 1].occurredAt) : null;
	const newestDay = entries.length > 0 ? dayKey(entries[0].occurredAt) : null;

	function handleJumpToDate(dateStr) {
		setJumpDate(dateStr);
		if (!dateStr) return;
		setPage(findPageForDate(entries, dateStr, PAGE_SIZE));
	}

	const rows = [];
	let lastDayKey = null;
	for (const entry of pageEntries) {
		const entryDayKey = dayKey(entry.occurredAt);
		if (entryDayKey !== lastDayKey) {
			rows.push(
				<li key={`sep-${entryDayKey}-${entry.id}`} aria-hidden="true">
					<p style={{ color: "var(--muted)", fontWeight: "var(--weight-bold)", paddingBlockStart: "var(--space-s)" }}>{formatDaySeparator(entry.occurredAt)}</p>
				</li>,
			);
			lastDayKey = entryDayKey;
		}
		rows.push(
			<li key={entry.id} style={{ borderBlockEnd: "var(--border-width) solid var(--border)" }}>
				<button
					type="button"
					onClick={() => openJournalEntry(ownerPubkey, dbKey, entry)}
					class="cluster"
					style={{
						width: "100%",
						alignItems: "flex-start",
						justifyContent: "space-between",
						paddingBlock: "var(--space-s)",
						background: entry.read ? "none" : "var(--surface)",
						border: "none",
						cursor: "pointer",
						textAlign: "left",
						font: "inherit",
						color: "inherit",
					}}
				>
					<span class="flow" style={{ "--flow-space": "var(--space-3xs)" }}>
						<span class="cluster" style={{ "--cluster-gap": "var(--space-3xs)", alignItems: "center" }}>
							{!entry.read && (
								<span aria-label="непрочитано" style={{ color: "var(--accent)" }}>
									●
								</span>
							)}
							<strong>{entry.title}</strong>
						</span>
						{entry.body && <span style={{ color: "var(--muted)" }}>{entry.body}</span>}
						<small style={{ color: "var(--muted)" }}>
							{CATEGORY_LABELS[entry.category] ?? entry.category} · {formatEntryTime(entry.occurredAt)}
						</small>
					</span>
				</button>
			</li>,
		);
	}

	return (
		<Screen
			title="Журнал"
			actions={
				<>
					{oldestDay && (
						<span class="cluster" style={{ "--cluster-gap": "var(--space-3xs)", alignItems: "center" }}>
							<label class="visually-hidden" for="journal-jump-date">
								Перейти к дате
							</label>
							<input id="journal-jump-date" type="date" min={oldestDay} max={newestDay} value={jumpDate} onInput={(e) => handleJumpToDate(e.currentTarget.value)} />
						</span>
					)}
					<button type="button" disabled={!hasUnread} onClick={() => markAllRead(ownerPubkey, dbKey)}>
						Отметить всё прочитанным
					</button>
				</>
			}
		>
			{entries.length === 0 ? (
				<p style={{ color: "var(--muted)" }}>Пока ничего не произошло — здесь будут появляться уведомления.</p>
			) : (
				<>
					<ul role="list" style={{ listStyle: "none", paddingInlineStart: 0 }}>
						{rows}
					</ul>

					{totalPages > 1 && (
						<nav class="cluster" aria-label="Страницы журнала" style={{ justifyContent: "space-between", alignItems: "center", paddingBlockStart: "var(--space-s)" }}>
							<button type="button" disabled={clampedPage === 0} onClick={() => setPage(clampedPage - 1)}>
								← Назад
							</button>
							<span style={{ color: "var(--muted)" }}>
								Страница {clampedPage + 1} из {totalPages}
							</span>
							<button type="button" disabled={clampedPage >= totalPages - 1} onClick={() => setPage(clampedPage + 1)}>
								Вперёд →
							</button>
						</nav>
					)}
				</>
			)}
		</Screen>
	);
}
