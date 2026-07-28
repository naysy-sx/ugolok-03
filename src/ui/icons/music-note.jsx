// Тип вложения "аудио" в ссылке "Скачать" (attachment-view.jsx, item 10) —
// реальный контур Feather Icons (music, MIT), обводка.
export default function IconMusicNote(props) {
	return (
		<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" aria-hidden="true" class="icon" {...props}>
			<path d="M9 18V5l12-2v13" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style={{ strokeWidth: "2" }} />
			<circle cx="6" cy="18" r="3" stroke="currentColor" stroke-width="2" style={{ strokeWidth: "2" }} />
			<circle cx="18" cy="16" r="3" stroke="currentColor" stroke-width="2" style={{ strokeWidth: "2" }} />
		</svg>
	);
}
