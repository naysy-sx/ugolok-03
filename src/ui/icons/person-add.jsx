// Поле "Добавить контакт" (contacts.jsx, item 26) — силуэт person.jsx (Radix
// Icons, MIT) чуть сжатый влево-вверх + плюс-бейдж внизу справа (свой
// рисунок, тот же приём, что pencil.jsx/eraser.jsx — простая фигура, без
// заимствованного контура).
export default function IconPersonAdd(props) {
	return (
		<svg viewBox="0 0 15 15" fill="none" xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" aria-hidden="true" class="icon" {...props}>
			<path
				d="M6.5 0.875C8.19 0.875 9.625 2.31 9.625 4C9.625 5.42 8.66 6.62 7.35 6.98C8.4 7.11 9.29 7.48 9.97 8.1C10.83 8.9 11.27 10.13 11.27 11.7C11.27 11.93 11.08 12.12 10.85 12.12C10.62 12.12 10.43 11.93 10.43 11.7C10.43 10.29 10.06 9.32 9.4 8.71C8.74 8.1 7.76 7.77 6.5 7.77C5.24 7.77 4.25 8.1 3.59 8.71C2.93 9.32 2.55 10.29 2.55 11.7C2.55 11.93 2.36 12.12 2.13 12.12C1.9 12.12 1.71 11.93 1.71 11.7C1.71 10.13 2.14 8.9 3 8.1C3.68 7.48 4.56 7.11 5.62 6.98C4.3 6.62 3.35 5.42 3.35 4C3.35 2.31 4.78 0.875 6.5 0.875Z"
				fill="currentColor"
			/>
			<path d="M12.5 6.5v4.5M10.25 8.75h4.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" style={{ strokeWidth: "1.2" }} />
		</svg>
	);
}
