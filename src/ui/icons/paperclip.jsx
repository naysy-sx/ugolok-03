// Кнопка "Прикрепить файл" (chat.jsx/channel-chat.jsx, item 11/24) — реальный
// контур Feather Icons (paperclip, MIT), обводка (не заливка, как у большинства
// остальных иконок проекта) — тонкая S-образная скрепка плохо читается
// залитой фигурой на 15×15, поэтому viewBox 24×24 + stroke, тот же приём,
// что уже применялся к back-button (инлайн stroke-width перебивает общее
// .icon path{stroke-width:.6}, рассчитанное на заливку).
export default function IconPaperclip(props) {
	return (
		<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" aria-hidden="true" class="icon" {...props}>
			<path
				d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 1 1 5.66 5.66l-9.2 9.19a2 2 0 1 1-2.83-2.83l8.49-8.48"
				stroke="currentColor"
				stroke-width="2"
				stroke-linecap="round"
				stroke-linejoin="round"
				style={{ strokeWidth: "2" }}
			/>
		</svg>
	);
}
