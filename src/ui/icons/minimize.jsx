// MEDIA-OVERLAY-UI.md, этап 1 — иконка "свернуть" просмотрщика вложений.
// В наборе Radix Icons нет подходящего варианта под этот смысл (их
// ExitFullScreenIcon рассчитан на 4 угла, здесь нужен компактный 2-угловой
// жест) — нарисована вручную по тому же геометрическому стилю (viewBox
// 0 0 15 15, currentColor), что phone-call.jsx/bell.jsx: два уголка,
// направленные друг к другу по диагонали ("сжать к центру").
export default function IconMinimize(props) {
	return (
		<svg viewBox="0 0 15 15" fill="none" xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" aria-hidden="true" class="icon" {...props}>
			<path
				d="M9.5 2.5v3a1 1 0 0 1-1 1h-3M5.5 12.5v-3a1 1 0 0 1 1-1h3"
				stroke="currentColor"
				stroke-width="1.3"
				stroke-linecap="round"
				stroke-linejoin="round"
			/>
		</svg>
	);
}
