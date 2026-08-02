// Раздел "Справка" (нав-пункт "help") — реальный контур Feather Icons
// (help-circle, MIT), обводка — тот же приём, что file-text.jsx.
export default function IconHelpCircle(props) {
	return (
		<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" aria-hidden="true" class="icon" {...props}>
			<circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2" style={{ strokeWidth: "2" }} />
			<path
				d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"
				stroke="currentColor"
				stroke-width="2"
				stroke-linecap="round"
				stroke-linejoin="round"
				fill="none"
				style={{ strokeWidth: "2" }}
			/>
			<line x1="12" y1="17" x2="12.01" y2="17" stroke="currentColor" stroke-width="2" stroke-linecap="round" style={{ strokeWidth: "2" }} />
		</svg>
	);
}
