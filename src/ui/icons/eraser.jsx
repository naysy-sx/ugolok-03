// Кнопка "Очистить переписку" (chat.jsx, item 8) — ластик: тот же
// геометрический стиль (viewBox 0 0 15 15, currentColor), что остальные
// иконки проекта, отличается от .trash (удаление сообщения) — тут "стереть
// историю", не "удалить объект".
export default function IconEraser(props) {
	return (
		<svg viewBox="0 0 15 15" fill="none" xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" aria-hidden="true" class="icon" {...props}>
			<rect x="3" y="5.5" width="9" height="4.5" rx="1" transform="rotate(-40 7.5 7.5)" fill="currentColor" />
		</svg>
	);
}
