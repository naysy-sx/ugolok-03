// Фильтр по категории записей "Журнала" — воронка. Самодельный контур в
// том же стиле, что заливные Radix-иконки проекта (viewBox 0 0 15 15,
// fill="currentColor", размер в em) — в наборе Radix Icons воронки нет.
export default function IconFunnel(props) {
	return (
		<svg viewBox="0 0 15 15" fill="none" xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" aria-hidden="true" class="icon" {...props}>
			<path
				d="M1.5 3h12a.5.5 0 0 1 .38.82L9.5 9.06V13a.5.5 0 0 1-.72.45l-2-1A.5.5 0 0 1 6.5 12V9.06L2.12 3.82A.5.5 0 0 1 2.5 3z"
				fill="currentColor"
			/>
		</svg>
	);
}
