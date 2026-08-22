import Quick from "../screens/quick.jsx";
import IconMinimize from "../icons/minimize.jsx";
import IconCross from "../icons/cross.jsx";
import { t } from "../signals/i18n.js";

// Редизайн интерфейса, "область контента" — "Быстрая связь" теперь модальным
// окном ПОВЕРХ MainShell (было — полноэкранная замена всего интерфейса,
// app.jsx), с тем же close+minimize языком, что MediaOverlay (кнопка
// "видео сверху").
//
// Пользователь (живая проверка, второй заход): "не выглядит как модальное
// окно" — не было ни затемнённого фона позади (MainShell не просвечивал),
// ни явной кнопки закрытия рядом со сворачиванием (только "Назад"/"Выйти"
// внутри самого Quick, легко спутать с "Покинуть комнату" — оба варианта
// перевода "Выйти", живой находкой на первом заходе). Добавлены оба:
// .rooms-overlay — backdrop с отступом, .rooms-overlay-panel — сама
// плавающая карточка (Quick рендерится ВНУТРИ неё, без изменений).
//
// Компонент-обёртка, НЕ правка quick.jsx: сворачивание — просто CSS-скрытие
// этой обёртки (.is-minimized), Quick остаётся смонтированным — размонтирование
// закрыло бы комнату (ROOMS-SPEC §0, cleanup-эффект в quick.jsx). Минимизация
// и закрытие живут СНАРУЖИ, а не внутри Quick, чтобы не трогать компонент,
// которому и так есть что делать (WebRTC/чат/голос) — обе кнопки не имеют
// отношения к его собственной логике. Закрытие зовёт ТОТ ЖЕ onExit, что и
// "Назад" внутри Quick — семантически то же действие (завершить комнату),
// просто ещё один, более заметный (и однозначный) способ его вызвать.
export default function RoomsOverlay({ minimized, onExit, onMinimize }) {
	return (
		<div class={`rooms-overlay${minimized ? " is-minimized" : ""}`}>
			<div class="rooms-overlay-panel" role="dialog" aria-modal="true" aria-label={t("quick.overlayAria")}>
				<div class="rooms-overlay-controls">
					<button type="button" class="rooms-overlay-minimize icon-btn" onClick={onMinimize} aria-label={t("quick.minimizeAria")}>
						<IconMinimize />
					</button>
					<button type="button" class="rooms-overlay-close icon-btn" onClick={onExit} aria-label={t("quick.closeAria")}>
						<IconCross />
					</button>
				</div>
				<Quick onExit={onExit} />
			</div>
		</div>
	);
}
