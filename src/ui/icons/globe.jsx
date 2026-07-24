// Простая геометрическая иконка (не копия стороннего набора — в отличие от
// остальных иконок этого каталога, скопированных из Radix Icons буквально;
// не стал гадать точные bezier-координаты чужого globe.svg по памяти).
export default function IconGlobe(props) {
	return (
		<svg viewBox="0 0 15 15" fill="none" xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" aria-hidden="true" class="icon" {...props}>
			<circle cx="7.5" cy="7.5" r="6" stroke="currentColor" stroke-width="1" fill="none" />
			<ellipse cx="7.5" cy="7.5" rx="2.5" ry="6" stroke="currentColor" stroke-width="1" fill="none" />
			<line x1="1.5" y1="7.5" x2="13.5" y2="7.5" stroke="currentColor" stroke-width="1" />
		</svg>
	);
}
