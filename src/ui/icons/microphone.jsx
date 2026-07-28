// Кнопка "Записать голосовое сообщение" (chat.jsx, item 11) — реальный
// контур Feather Icons (mic, MIT), обводка — тот же приём override, что
// paperclip.jsx/back-button (viewBox 24×24, инлайн stroke-width).
export default function IconMicrophone(props) {
	return (
		<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" aria-hidden="true" class="icon" {...props}>
			<path
				d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"
				stroke="currentColor"
				stroke-width="2"
				stroke-linecap="round"
				stroke-linejoin="round"
				style={{ strokeWidth: "2" }}
			/>
			<path
				d="M19 10v2a7 7 0 0 1-14 0v-2"
				stroke="currentColor"
				stroke-width="2"
				stroke-linecap="round"
				stroke-linejoin="round"
				style={{ strokeWidth: "2" }}
			/>
			<line x1="12" y1="19" x2="12" y2="23" stroke="currentColor" stroke-width="2" stroke-linecap="round" style={{ strokeWidth: "2" }} />
			<line x1="8" y1="23" x2="16" y2="23" stroke="currentColor" stroke-width="2" stroke-linecap="round" style={{ strokeWidth: "2" }} />
		</svg>
	);
}
