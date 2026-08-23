// Избранное (ASIDE-REDESIGN/SIDEBAR-SPEC-2.md, этап 3) — замена флажка
// ⚑/⚐: звезда контурная в покое, залитая во включённом состоянии (цвет —
// на вызывающей стороне, .fav-toggle[aria-pressed="true"] красит в
// --gold). Radix Icons звезды не заводит — контур нарисован сам, тот же
// формат (viewBox 15×15, currentColor), что остальные самодельные иконки
// проекта (см. custom.css про stroke-based/fill-based историю).
export default function IconStar({ filled, ...props }) {
	return (
		<svg viewBox="0 0 15 15" fill="none" xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" aria-hidden="true" class="icon" {...props}>
			<path
				d="M7.5 1.7L8.85 5.64L13.02 5.71L9.69 8.21L10.91 12.19L7.5 9.8L4.09 12.19L5.31 8.21L1.98 5.71L6.15 5.64Z"
				fill={filled ? "currentColor" : "none"}
				stroke="currentColor"
				stroke-width="1"
				stroke-linejoin="round"
			/>
		</svg>
	);
}
