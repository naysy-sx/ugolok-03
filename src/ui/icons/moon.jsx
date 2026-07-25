// Переключатель темы (тёмная) — простой полумесяц, тот же геометрический
// стиль (viewBox 0 0 15 15, currentColor), что остальные иконки проекта —
// нарисована вручную, тот же принцип, что sun.jsx рядом.
export default function IconMoon(props) {
	return (
		<svg viewBox="0 0 15 15" fill="none" xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" aria-hidden="true" class="icon" {...props}>
			<path
				d="M6.5 1.5c-2.9.6-5 3.2-5 6.2 0 3.4 2.8 6.2 6.2 6.2 3 0 5.6-2.1 6.2-5-.9.5-2 .8-3.1.8-3.4 0-6.2-2.8-6.2-6.2 0-.7.1-1.4.3-2z"
				fill="currentColor"
			/>
		</svg>
	);
}
