// Стрелка "следующий" (media-overlay.jsx) — зеркало nav-prev.jsx, см.
// комментарий там про отказ от <path> (`.icon path` бьёт stroke-width).
export default function IconNavNext(props) {
	return (
		<svg viewBox="0 0 15 15" fill="none" xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" aria-hidden="true" class="icon" {...props}>
			<polyline points="5.5,3 10,7.5 5.5,12" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
		</svg>
	);
}
