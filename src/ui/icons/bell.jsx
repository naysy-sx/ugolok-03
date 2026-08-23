// Этап 50 — иконка "Журнал" (лог уведомлений). Простой колокольчик, тот же
// геометрический стиль (viewBox 0 0 15 15, currentColor), что остальные иконки
// проекта (Radix Icons) — не сам Radix (в наборе нет подходящего варианта под
// этот смысл), нарисована вручную по тому же принципу, что phone-call.jsx (этап 48).
// Живой фидбек пользователя: заливной вариант читался хуже контурного —
// та же геометрия (path уже был готовым силуэтом колокола), просто
// fill→stroke, без переработки координат.
export default function IconBell(props) {
	return (
		<svg viewBox="0 0 15 15" fill="none" xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" aria-hidden="true" class="icon" {...props}>
			<path
				d="M7.5 1a1 1 0 0 1 1 1v.1c1.7.4 3 2 3 3.9v2.6l1 1.9a.5.5 0 0 1-.45.73H2.95a.5.5 0 0 1-.45-.73l1-1.9V6c0-1.9 1.3-3.5 3-3.9V2a1 1 0 0 1 1-1zM6 12.5a.5.5 0 0 1 .5-.5h2a.5.5 0 0 1 0 1h-2a.5.5 0 0 1-.5-.5z"
				stroke="currentColor"
				stroke-width="1"
				stroke-linejoin="round"
				fill="none"
			/>
		</svg>
	);
}
