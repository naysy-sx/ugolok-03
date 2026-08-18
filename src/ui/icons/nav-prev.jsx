// Стрелка "предыдущий" (media-overlay.jsx). НЕ переиспользует общий
// chevron-left.jsx (тот заливной, fill="currentColor" — Radix-контур для
// пагинации) — рядом в шапке оверлея стоят обводочные иконки (cross.jsx,
// info-circle.jsx, minimize.jsx, все stroke-width 1.4), заливная стрелка
// на их фоне выглядела заметно толще/иначе. Нарисована той же обводкой.
export default function IconNavPrev(props) {
	return (
		<svg viewBox="0 0 15 15" fill="none" xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" aria-hidden="true" class="icon" {...props}>
			<path d="M9.5 3L5 7.5L9.5 12" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
		</svg>
	);
}
