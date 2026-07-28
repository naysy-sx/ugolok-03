// Кнопка "Отменить" (запись голосового, chat.jsx, item 13) — простой крест,
// <line> вместо <path> — не задет глобальным .icon path{stroke-width:.6}
// (рассчитанным на залитые фигуры), поэтому свой stroke-width работает
// напрямую, без инлайн-override.
export default function IconCross(props) {
	return (
		<svg viewBox="0 0 15 15" fill="none" xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" aria-hidden="true" class="icon" {...props}>
			<line x1="3" y1="3" x2="12" y2="12" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
			<line x1="12" y1="3" x2="3" y2="12" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
		</svg>
	);
}
