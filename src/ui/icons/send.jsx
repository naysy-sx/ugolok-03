// Кнопка "Отправить" в компоуз-баре чата (пилюльное поле + круглая кнопка,
// VISUAL.md, Claude Opus) — бумажный самолётик, тот же геометрический стиль
// (viewBox 0 0 15 15, currentColor), что остальные иконки проекта.
export default function IconSend(props) {
	return (
		<svg viewBox="0 0 15 15" fill="none" xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" aria-hidden="true" class="icon" {...props}>
			<path d="M1.5 7.5 13 2 8.2 13 6.6 8.9 1.5 7.5Z" fill="currentColor" />
			<path d="M13 2 6.6 8.9" stroke="currentColor" stroke-width="0.8" stroke-linecap="round" />
		</svg>
	);
}
