import Quick from "../screens/quick.jsx";
import IconMinimize from "../icons/minimize.jsx";
import { t } from "../signals/i18n.js";

// Редизайн интерфейса, "область контента" — "Быстрая связь" теперь модальным
// окном ПОВЕРХ MainShell (было — полноэкранная замена всего интерфейса,
// app.jsx), с тем же close+minimize языком, что MediaOverlay (кнопка
// "видео сверху"): крестик — уже есть внутри самого Quick ("Выйти", оба его
// экрана), сворачивание — новое, единственное, чего в Quick не было.
//
// Компонент-обёртка, НЕ правка quick.jsx: сворачивание — просто CSS-скрытие
// этой обёртки (.is-minimized), Quick остаётся смонтированным — размонтирование
// закрыло бы комнату (ROOMS-SPEC §0, cleanup-эффект в quick.jsx). Минимизация
// живёт СНАРУЖИ, а не внутри Quick, чтобы не трогать компонент, которому и так
// есть что делать (WebRTC/чат/голос) — кнопка минимизации не имеет отношения
// к его собственной логике.
export default function RoomsOverlay({ minimized, onExit, onMinimize }) {
	return (
		<div class={`rooms-overlay${minimized ? " is-minimized" : ""}`} role="dialog" aria-modal="true" aria-label={t("quick.overlayAria")}>
			<button type="button" class="rooms-overlay-minimize icon-btn" onClick={onMinimize} aria-label={t("quick.minimizeAria")}>
				<IconMinimize />
			</button>
			<Quick onExit={onExit} />
		</div>
	);
}
