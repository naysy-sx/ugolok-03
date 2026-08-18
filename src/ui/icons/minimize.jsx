// Иконка "свернуть" просмотрщика вложений — по мотивам tabler:window-
// minimize (Tabler Icons, Paweł Kuna, MIT — github.com/tabler/tabler-icons),
// выбранной пользователем на icones.js.org, отражённой по горизонтали
// (сворачивает "вниз-вправо" — туда, где реально появляется мини-бар, не
// "вниз-влево" как оригинал — тот читался как символ закрытия).
//
// НЕ через <path> с arc-командами и не через <g transform> (первая версия
// делала так) — найдено живой проверкой: глобальное правило custom.css
// `.icon path { stroke-width: 0.6 }` (компенсатор для ЗАЛИВНЫХ Radix-
// иконок — тонкая обводка поверх fill) бьёт по любому <path>, включая
// обводочные самодельные иконки типа этой, и побеждает любой stroke-width,
// заданный на самом элементе (CSS всегда сильнее presentation-атрибута).
// cross.jsx этой беды избежал только потому, что там <line>, не <path>.
// Решение — geometрия теми же примитивами, что cross.jsx: <rect>/
// <polyline>/<line>, ни один не совпадает с селектором `.icon path`.
// Координаты — результат того же зеркалирования и масштаба (×15/24), что
// раньше делал transform, посчитанный один раз руками (дуг здесь нет,
// пересчёт safe).
export default function IconMinimize(props) {
	return (
		<svg viewBox="0 0 15 15" fill="none" xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" aria-hidden="true" class="icon" {...props}>
			<g stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
				<rect x="2.5" y="2.5" width="10" height="10" rx="1.25" ry="1.25" />
				<rect x="10" y="10" width="3.125" height="3.125" rx="0.625" ry="0.625" />
				<polyline points="5.625,8.125 8.125,8.125 8.125,5.625" />
				<line x1="8.125" y1="8.125" x2="5" y2="5" />
			</g>
		</svg>
	);
}
