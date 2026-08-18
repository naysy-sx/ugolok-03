// Стрелка "предыдущий" (media-overlay.jsx). НЕ переиспользует общий
// chevron-left.jsx (тот заливной, fill="currentColor" — Radix-контур для
// пагинации) — рядом в шапке оверлея стоят обводочные иконки (cross.jsx,
// info-circle.jsx, minimize.jsx, все stroke-width 1.4). <polyline>, не
// <path> — глобальное custom.css правило `.icon path { stroke-width: 0.6 }`
// (компенсатор для заливных Radix-иконок) бьёт любой <path> внутри .icon,
// включая обводочные — см. подробный комментарий в minimize.jsx.
export default function IconNavPrev(props) {
	return (
		<svg viewBox="0 0 15 15" fill="none" xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" aria-hidden="true" class="icon" {...props}>
			<polyline points="9.5,3 5,7.5 9.5,12" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
		</svg>
	);
}
