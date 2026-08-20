// Иконка "повтор" (этап 10, MEDIA-OVERLAY-UI-2.md §10.5) — контур взят из
// mini-bar-mockup.html (пользовательский макет), два разомкнутых плеча
// петли + два наконечника-стрелки. stroke, не fill — тот же класс формы,
// что у большинства иконок мини-бара; .icon path{stroke-width:0.6} (см.
// custom.css) применится как обычно, отдельного stroke-width не задаём.
export default function IconRepeat(props) {
	return (
		<svg viewBox="0 0 15 15" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" aria-hidden="true" class="icon" {...props}>
			<path d="M3 6V5a2 2 0 0 1 2-2h7M12 9v1a2 2 0 0 1-2 2H3" />
			<path d="M10.5 1.5 12.5 3l-2 1.5M4.5 10.5 2.5 12l2 1.5" />
		</svg>
	);
}
