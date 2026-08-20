// Иконка "повтор" (этап 10, MEDIA-OVERLAY-UI-2.md §10.5) — контур выбран
// пользователем (Tabler Icons "repeat", unicode eb72, MIT). viewBox 24×24
// (не 15×15, как у соседних кнопок) — контур с дугами (SVG-команда A),
// не выражается через <polyline>/<line>, значит идёт через <path> и ловит
// глобальный .icon path{stroke-width:0.6} (custom.css) — толщина
// восстановлена отдельным правилом с более высокой специфичностью
// (.media-mini-bar-btn.is-repeat .icon path), пропорционально толщине
// соседних 15-viewBox/1.4-stroke иконок: 1.4/15×24 ≈ 2.24, см. CSS.
export default function IconRepeat(props) {
	return (
		<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" aria-hidden="true" class="icon" {...props}>
			<path d="M4 12v-3a3 3 0 0 1 3 -3h13m-3 -3l3 3l-3 3" />
			<path d="M20 12v3a3 3 0 0 1 -3 3h-13m3 3l-3 -3l3 -3" />
		</svg>
	);
}
