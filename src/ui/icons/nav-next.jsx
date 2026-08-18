// Стрелка "следующий" (media-overlay.jsx) — зеркало nav-prev.jsx, см.
// комментарий там про отказ от заливного chevron-right.jsx.
export default function IconNavNext(props) {
	return (
		<svg viewBox="0 0 15 15" fill="none" xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" aria-hidden="true" class="icon" {...props}>
			<path d="M5.5 3L10 7.5L5.5 12" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
		</svg>
	);
}
