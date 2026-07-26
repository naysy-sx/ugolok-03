import { useRef, useEffect } from "preact/hooks";

// Общее поведение для <details class="menu"> (ActionsMenu и любой другой
// всплывающий список на нативном <details>) — сам <details> НЕ закрывается
// по клику вне себя и по Escape, это добавляем явно. closeOn — селектор
// элементов ВНУТРИ меню, клик по которым закрывает его сразу (кнопки/
// ссылки — однозначное действие); чекбоксы туда намеренно не входят
// (множественный выбор без переоткрытия меню на каждую отметку).
export function useDetailsMenu(closeOn = "button, a") {
	const ref = useRef(null);

	useEffect(() => {
		function handleDocumentClick(e) {
			if (ref.current && ref.current.open && !ref.current.contains(e.target)) {
				ref.current.open = false;
			}
		}
		function handleKeyDown(e) {
			if (e.key === "Escape" && ref.current?.open) {
				ref.current.open = false;
				ref.current.querySelector("summary")?.focus();
			}
		}
		document.addEventListener("click", handleDocumentClick);
		document.addEventListener("keydown", handleKeyDown);
		return () => {
			document.removeEventListener("click", handleDocumentClick);
			document.removeEventListener("keydown", handleKeyDown);
		};
	}, []);

	function handleMenuClick(e) {
		if (e.target.closest("summary")) return;
		if (e.target.closest(closeOn)) {
			ref.current.open = false;
		}
	}

	return { ref, handleMenuClick };
}
