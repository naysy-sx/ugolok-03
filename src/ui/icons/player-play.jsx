// MEDIA-OVERLAY-UI.md, этап 1 — иконка "пуск" (мини-бар и будущие
// собственные контролы). Нарисована вручную по стилю иконок проекта
// (viewBox 0 0 15 15, currentColor) — заливной треугольник.
export default function IconPlayerPlay(props) {
	return (
		<svg viewBox="0 0 15 15" fill="none" xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" aria-hidden="true" class="icon" {...props}>
			<path d="M4 2.5l8 5-8 5z" fill="currentColor" stroke="currentColor" stroke-width="1" stroke-linejoin="round" />
		</svg>
	);
}
