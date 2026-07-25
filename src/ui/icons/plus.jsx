// Кнопка "Создать канал" (channels.jsx) — тот же геометрический стиль
// (viewBox 0 0 15 15, currentColor), что остальные иконки проекта.
export default function IconPlus(props) {
	return (
		<svg viewBox="0 0 15 15" fill="none" xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" aria-hidden="true" class="icon" {...props}>
			<path d="M7 1.5h1v5h5v1h-5v5H7v-5H2v-1h5z" fill="currentColor" />
		</svg>
	);
}
