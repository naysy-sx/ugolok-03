// Кнопка "Назад" в шапке экрана (screen.jsx) — пользователь: "не стрелка,
// а стрелка в виде уголка, corner, который указывает направление назад" —
// поворот на 90° (вертикаль -> горизонталь) с наконечником, тот же мотив,
// что имя проекта. В отличие от остальных иконок (заливка) — здесь линия
// (stroke), инлайн stroke-width перебивает общее .icon path{stroke-width:.6}
// (та реинфорс-обводка для ЗАЛИТЫХ фигур, не подходит как основной штрих).
export default function IconCornerBack(props) {
	return (
		<svg viewBox="0 0 15 15" fill="none" xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" aria-hidden="true" class="icon" {...props}>
			<path
				d="M12.5 2.5v4.375a2.5 2.5 0 0 1-2.5 2.5H2.5"
				stroke="currentColor"
				stroke-width="1.4"
				stroke-linecap="round"
				stroke-linejoin="round"
				style={{ strokeWidth: "1.4" }}
			/>
			<polyline
				points="5.625 6.25 2.5 9.375 5.625 12.5"
				stroke="currentColor"
				stroke-width="1.4"
				stroke-linecap="round"
				stroke-linejoin="round"
				fill="none"
				style={{ strokeWidth: "1.4" }}
			/>
		</svg>
	);
}
