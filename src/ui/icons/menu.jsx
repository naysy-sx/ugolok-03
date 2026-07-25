// Кнопка "открыть меню" на узких экранах (бургер) — тот же геометрический
// стиль (viewBox 0 0 15 15, currentColor), что остальные иконки проекта.
export default function IconMenu(props) {
	return (
		<svg viewBox="0 0 15 15" fill="none" xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" aria-hidden="true" class="icon" {...props}>
			<path d="M1.5 3.5h12v1h-12zM1.5 7h12v1h-12zM1.5 10.5h12v1h-12z" fill="currentColor" />
		</svg>
	);
}
