// Тип вложения "документ" в ссылке "Скачать" (attachment-view.jsx, item 10) —
// реальный контур Feather Icons (file-text, MIT), обводка.
export default function IconFileText(props) {
	return (
		<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" aria-hidden="true" class="icon" {...props}>
			<path
				d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"
				stroke="currentColor"
				stroke-width="2"
				stroke-linecap="round"
				stroke-linejoin="round"
				style={{ strokeWidth: "2" }}
			/>
			<polyline points="14 2 14 8 20 8" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none" style={{ strokeWidth: "2" }} />
			<line x1="16" y1="13" x2="8" y2="13" stroke="currentColor" stroke-width="2" stroke-linecap="round" style={{ strokeWidth: "2" }} />
			<line x1="16" y1="17" x2="8" y2="17" stroke="currentColor" stroke-width="2" stroke-linecap="round" style={{ strokeWidth: "2" }} />
		</svg>
	);
}
