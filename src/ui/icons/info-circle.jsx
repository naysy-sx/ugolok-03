// MEDIA-OVERLAY-UI.md, этап 1 — иконка "сведения" (кнопка info-панели,
// сама панель появится на этапе 2). Нарисована вручную по стилю иконок
// проекта (viewBox 0 0 15 15, currentColor) — круг с точкой и штрихом.
// stroke-width 1.4 — та же ширина, что у cross.jsx (эталон: уже используется
// по всему приложению) — единый штрих у всех иконок в шапке оверлея, живой
// фидбек пользователя ("stroke разная").
export default function IconInfoCircle(props) {
	return (
		<svg viewBox="0 0 15 15" fill="none" xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" aria-hidden="true" class="icon" {...props}>
			<circle cx="7.5" cy="7.5" r="6" stroke="currentColor" stroke-width="1.4" />
			<circle cx="7.5" cy="4.8" r="0.75" fill="currentColor" />
			<line x1="7.5" y1="6.8" x2="7.5" y2="10.8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
		</svg>
	);
}
