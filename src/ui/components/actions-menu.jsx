import { useDetailsMenu } from "../hooks/use-details-menu.js";
import IconDotsVertical from "../icons/dots-vertical.jsx";

// Меню "ещё действия" на нативном <details> (VISUAL.md v2, Claude Opus) —
// без JS-библиотек всплывающих меню: клик/Enter/Space открывают/закрывают
// сами по себе (нативная семантика <details>/<summary>), доступно с
// клавиатуры "из коробки". Закрытие по клику вне/по пункту/по Escape —
// useDetailsMenu (тот же хук использует AddToGroupControl, contacts.jsx,
// для чекбокс-варианта меню).
export default function ActionsMenu({ label, children }) {
	const { ref, handleMenuClick } = useDetailsMenu();

	return (
		<details class="menu" ref={ref} onClick={handleMenuClick}>
			<summary class="icon-btn" aria-label={label}>
				<IconDotsVertical />
			</summary>
			<div class="menu-pop stack" style={{ "--gap": "2px" }}>
				{children}
			</div>
		</details>
	);
}
