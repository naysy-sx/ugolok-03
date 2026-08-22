import { activeRoomSummary } from "../screens/quick.jsx";
import IconGlobe from "../icons/globe.jsx";
import { t } from "../signals/i18n.js";

// Заменяет статичную кнопку-вход "Быстрая связь" (.quick), пока модальное
// окно открыто (app.jsx, roomsScreenActive) — развёрнуто ИЛИ свёрнуто:
// клик всегда разворачивает/возвращает к нему. Тот же принцип, что .call-bar
// (CallOverlay) — активное состояние видно и кликабельно из любого места.
// activeRoomSummary — null, пока сессии ещё нет (пользователь на экране
// входа Quick, не подключился ни к одной комнате) — тогда показываем тот же
// текст, что у статичной кнопки, просто без "разговор без учётной записи"
// (модалка уже открыта, подсказка не нужна), иначе сводка была бы пустой
// и нечем было бы вернуться к уже открытому окну.
export default function ActiveRoomSummary({ onExpand }) {
	const summary = activeRoomSummary.value;
	return (
		<button type="button" class="quick quick-active bar" style={{ "--gap": "var(--space-xs)", alignItems: "center" }} onClick={onExpand}>
			{summary ? <span class="quick-live-dot" aria-hidden="true" /> : <IconGlobe aria-hidden="true" />}
			<span class="stack grow" style={{ "--gap": "0" }}>
				<span class="truncate">{summary?.name || t("shell.quickConnect")}</span>
				{summary && <small>{t("quick.room.participantsTitle", { count: summary.count })}</small>}
			</span>
		</button>
	);
}
