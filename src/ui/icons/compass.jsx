// «Знакомства» (ASIDE-REDESIGN/SIDEBAR-SPEC-2.md, этап 4) — ТЗ прямо
// запрещает лупу (занята поиском строкой выше, два значения одного
// значка на одном экране путают). Компас — окружность + стрелка-игла,
// самодельный контур (Radix Icons компаса не даёт), тот же формат
// viewBox 15×15/currentColor, что остальные такие иконки проекта.
export default function IconCompass(props) {
	return (
		<svg viewBox="0 0 15 15" fill="none" xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" aria-hidden="true" class="icon" {...props}>
			<circle cx="7.5" cy="7.5" r="6" stroke="currentColor" stroke-width="1" />
			<path d="M9.8 5.2L6.6 6.6L5.2 9.8L8.4 8.4L9.8 5.2Z" fill="currentColor" stroke="currentColor" stroke-width="0.6" stroke-linejoin="round" />
		</svg>
	);
}
