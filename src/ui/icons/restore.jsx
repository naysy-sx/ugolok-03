// Иконка "развернуть" мини-бара — по мотивам tabler:window-maximize (Tabler
// Icons, Paweł Kuna, MIT — github.com/tabler/tabler-icons), выбранной
// пользователем на icones.js.org (та же база "окно + мини-квадрат", что и
// minimize.jsx, только стрелка развёрнута навстречу — из мини-квадрата
// внутрь окна, а не наоборот). Отражена по горизонтали тем же способом,
// что minimize.jsx — координаты уже посчитаны руками в мирorованном виде,
// mini-квадрат в правом нижнем углу (там, где реально стоит мини-бар).
//
// <rect>/<polyline>/<line>, не <path> — global custom.css правило
// `.icon path { stroke-width: 0.6 }` (компенсатор для заливных Radix-
// иконок) бьёт stroke-width любого <path> внутри .icon, см. подробный
// комментарий в minimize.jsx.
export default function IconRestore(props) {
	return (
		<svg viewBox="0 0 15 15" fill="none" xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" aria-hidden="true" class="icon" {...props}>
			<g stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
				<rect x="2.5" y="2.5" width="10" height="10" rx="1.25" ry="1.25" />
				<rect x="10" y="10" width="3.125" height="3.125" rx="0.625" ry="0.625" />
				<polyline points="7.5,5 5,5 5,7.5" />
				<line x1="5" y1="5" x2="8.125" y2="8.125" />
			</g>
		</svg>
	);
}
