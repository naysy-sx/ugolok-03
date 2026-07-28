// Тип вложения "изображение" в ссылке "Скачать" (attachment-view.jsx,
// item 10) — реальный контур Feather Icons (image, MIT), обводка.
export default function IconImage(props) {
	return (
		<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" aria-hidden="true" class="icon" {...props}>
			<rect x="3" y="3" width="18" height="18" rx="2" ry="2" stroke="currentColor" stroke-width="2" style={{ strokeWidth: "2" }} />
			<circle cx="8.5" cy="8.5" r="1.5" stroke="currentColor" stroke-width="2" style={{ strokeWidth: "2" }} />
			<polyline points="21 15 16 10 5 21" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none" style={{ strokeWidth: "2" }} />
		</svg>
	);
}
