import { useEffect } from "preact/hooks";
import { currentUser, dbKeySig } from "../signals/auth.js";
import { journalEntries, refreshJournal, openJournalEntry } from "../signals/journal.js";
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

function formatEntryTime(createdAt) {
	return new Date(createdAt).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

// Стартовый экран после логина (nav-items.js, DEFAULT_ACTIVE) — персистентный
// лог ВСЕХ сработавших уведомлений (notifyAndLog, journal.js), не заменяет
// тосты/бейджи (они остаются как есть, быстрая реакция) — дополнительный слой
// "что вообще произошло", пока пользователя не было на экране.
export default function Journal() {
	const ownerPubkey = currentUser.value.id;
	const dbKey = dbKeySig.value;

	useEffect(() => {
		refreshJournal(ownerPubkey, dbKey);
	}, [ownerPubkey, messagingActivity.value]);

	const entries = journalEntries.value;

	return (
		<Screen title="Журнал">
			{entries.length === 0 ? (
				<p style={{ color: "var(--muted)" }}>Пока ничего не произошло — здесь будут появляться уведомления.</p>
			) : (
				<ul role="list" style={{ listStyle: "none", paddingInlineStart: 0 }}>
					{entries.map((entry) => (
						<li
							key={entry.id}
							style={{
								borderBlockEnd: "var(--border-width) solid var(--border)",
							}}
						>
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
										{!entry.read && <span aria-label="непрочитано" style={{ color: "var(--accent)" }}>●</span>}
										<strong>{entry.title}</strong>
									</span>
									{entry.body && <span style={{ color: "var(--muted)" }}>{entry.body}</span>}
									<small style={{ color: "var(--muted)" }}>
										{CATEGORY_LABELS[entry.category] ?? entry.category} · {formatEntryTime(entry.createdAt)}
									</small>
								</span>
							</button>
						</li>
					))}
				</ul>
			)}
		</Screen>
	);
}
