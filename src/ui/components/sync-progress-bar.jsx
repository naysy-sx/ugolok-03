import { useState, useEffect } from "preact/hooks";
import { connState, synced } from "../signals/transport.js";
import { syncLog } from "../signals/sync-log.js";

const SLOW_SYNC_THRESHOLD_MS = 3000; // пользователь: "если требует больше 3 секунд"

// Уже есть тихий текстовый статус (ConnectionStatusPanel, "Relay:
// синхронизация…") — постоянно виден в сайдбаре, но легко не заметить сразу
// после логина (найдено пользователем: "аватар и био остались пустыми...
// не мешало бы поверх всего приложения отобразить прогрессбар"). Этот
// компонент — вторая, заметная поверхность для ТОГО ЖЕ состояния (не
// отдельный источник истины): полоса появляется, только если синхронизация
// уже идёт ДОЛЬШЕ порога (не мелькает на быстрых, обычных подключениях —
// см. DoD "не мешать" любой ценой), и пропадает сразу же, как только
// synced становится true.
export default function SyncProgressBar() {
	const [visible, setVisible] = useState(false);
	const [expanded, setExpanded] = useState(false);
	const isSyncing = (connState.value === "connected" || connState.value === "subscribed") && !synced.value;

	useEffect(() => {
		if (!isSyncing) {
			setVisible(false);
			return;
		}
		const timer = setTimeout(() => setVisible(true), SLOW_SYNC_THRESHOLD_MS);
		return () => clearTimeout(timer);
	}, [isSyncing]);

	if (!visible || !isSyncing) return null;

	const lastEntry = syncLog.value[syncLog.value.length - 1];
	const labelText = lastEntry ? lastEntry.text : "Синхронизация данных с сетью…";

	return (
		<div class="sync-progress-bar" role="status" aria-live="polite">
			<div class="sync-progress-bar-track" aria-hidden="true" />
			<span 
				class="sync-progress-bar-label" 
				onClick={() => setExpanded((v) => !v)} 
				style={{ cursor: "pointer" }} 
				title="Показать/скрыть журнал синхронизации"
			>
				{labelText}
			</span>
			{expanded && syncLog.value.length > 0 && (
				<div class="sync-progress-bar-log">
					<ul>
						{syncLog.value.map((entry, i) => (
							<li key={i}>
								{new Date(entry.ts).toLocaleTimeString()} {entry.text}
							</li>
						))}
					</ul>
				</div>
			)}
		</div>
	);
}
