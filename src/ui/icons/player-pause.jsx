// MEDIA-OVERLAY-UI.md, этап 1 — иконка "пауза" (мини-бар и будущие
// собственные контролы). Нарисована вручную по стилю иконок проекта
// (viewBox 0 0 15 15, currentColor) — две заливные полосы.
export default function IconPlayerPause(props) {
	return (
		<svg viewBox="0 0 15 15" fill="none" xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" aria-hidden="true" class="icon" {...props}>
			<rect x="4" y="2.5" width="2.3" height="10" rx="0.6" fill="currentColor" />
			<rect x="8.7" y="2.5" width="2.3" height="10" rx="0.6" fill="currentColor" />
		</svg>
	);
}
