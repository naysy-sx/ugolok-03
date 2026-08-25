// Единственное место, где живёт обвязка <svg> для всех иконок проекта.
// До перехода на Phosphor эти семь атрибутов были скопированы в 71 файл
// по отдельности — и разъехались: три разных viewBox, где-то fill="none"
// на корне, где-то нет, где-то забыт aria-hidden.
//
// class="icon" — часть публичного контракта оформительского слоя:
// на него завязаны .icon-btn .icon (flex:none + min-width, фикс
// flex-автоминимума для SVG) и глобальное button:has(> .icon)
// (inline-flex + gap + padding-inline). Менять имя класса нельзя.
//
// props идут ПОСЛЕ всех атрибутов — вызывающий может переопределить
// любой, включая class и aria-hidden (иконка в роли единственного
// содержимого кнопки иногда должна быть озвучена).
export default function Icon({ path, ...props }) {
	return (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			viewBox="0 0 256 256"
			fill="currentColor"
			width="1em"
			height="1em"
			aria-hidden="true"
			class="icon"
			{...props}
		>
			<path d={path} />
		</svg>
	);
}
