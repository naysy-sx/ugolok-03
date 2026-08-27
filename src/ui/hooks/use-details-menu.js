import { useRef, useEffect, useLayoutEffect } from "preact/hooks";
import { computeMenuPopPosition } from "./compute-menu-pop-position.js";

// Общее поведение для <details> с .menu-pop (ActionsMenu, account-card,
// contacts, journal). Нативный <details> не закрывается по клику вне и
// по Escape — это добавляем явно. closeOn — селектор пунктов, клик по
// которым закрывает сразу (кнопки/ссылки); чекбоксы туда не входят.
//
// .menu-pop на время открытия переезжает на document.body + position:fixed:
// иначе его режет overflow скролла ленты (.content-wrapper.scroller),
// overflow:hidden у aside и transform выезжающего сайдбара. Координаты —
// computeMenuPopPosition, флип вверх у нижнего края, кламп в вьюпорт.
export function useDetailsMenu(closeOn = "button, a") {
	const ref = useRef(null);
	const closeOnRef = useRef(closeOn);
	closeOnRef.current = closeOn;

	useLayoutEffect(() => {
		const details = ref.current;
		if (!details) return;
		if (!details.dataset.menuParkId) details.dataset.menuParkId = "m" + Math.random().toString(36).slice(2, 9);
		const parkId = details.dataset.menuParkId;
		const pop =
			details.querySelector(".menu-pop") ??
			document.querySelector(`.menu-pop[data-menu-park-id="${parkId}"]`);
		if (!pop) return;
		pop.dataset.menuParkId = parkId;

		if (!pop.dataset.menuAlign) {
			if (details.classList.contains("account-menu")) {
				pop.dataset.menuAlign = "start";
			} else {
				const cs = getComputedStyle(pop);
				pop.dataset.menuAlign =
					cs.insetInlineStart === "0px" && (cs.insetInlineEnd === "auto" || cs.insetInlineEnd === "") ? "start" : "end";
			}
		}

		let lastW = Math.max(pop.offsetWidth, 176);
		let lastH = pop.offsetHeight;

		function applyPlace(w, h) {
			const summary = details.querySelector("summary");
			if (!summary || h === 0) return;
			const pos = computeMenuPopPosition(summary.getBoundingClientRect(), { width: w, height: h }, { width: window.innerWidth, height: window.innerHeight }, { align: pop.dataset.menuAlign || "end" });
			pop.style.position = "fixed";
			pop.style.zIndex = "400";
			pop.style.margin = "0";
			pop.style.right = "auto";
			pop.style.bottom = "auto";
			pop.style.top = `${pos.top}px`;
			pop.style.left = `${pos.left}px`;
			pop.style.width = `${w}px`;
			pop.style.height = `${h}px`;
		}

		function clearPlace() {
			pop.style.position = "";
			pop.style.zIndex = "";
			pop.style.margin = "";
			pop.style.right = "";
			pop.style.bottom = "";
			pop.style.top = "";
			pop.style.left = "";
			pop.style.width = "";
			pop.style.height = "";
		}

		function park() {
			if (pop.parentNode !== document.body) document.body.appendChild(pop);
		}

		function restore() {
			clearPlace();
			if (pop.parentNode === document.body && details.isConnected) {
				details.appendChild(pop);
			} else if (pop.parentNode === document.body && !details.isConnected) {
				pop.remove();
			}
		}

		function onToggle() {
			if (details.open) {
				lastW = Math.max(pop.offsetWidth, pop.scrollWidth, 176);
				lastH = Math.max(pop.offsetHeight, pop.scrollHeight);
				park();
				applyPlace(lastW, lastH);
			} else {
				restore();
			}
		}

		function onReposition() {
			if (details.open) applyPlace(lastW, lastH);
		}

		function onPopClick(e) {
			if (e.target.closest("summary")) return;
			if (e.target.closest(closeOnRef.current)) details.open = false;
		}

		if (details.open) {
			park();
			applyPlace(lastW, lastH);
		}

		details.addEventListener("toggle", onToggle);
		pop.addEventListener("click", onPopClick);
		window.addEventListener("resize", onReposition);
		window.addEventListener("scroll", onReposition, true);
		return () => {
			details.removeEventListener("toggle", onToggle);
			pop.removeEventListener("click", onPopClick);
			window.removeEventListener("resize", onReposition);
			window.removeEventListener("scroll", onReposition, true);
			queueMicrotask(() => {
				if (!details.isConnected && pop.parentNode === document.body) pop.remove();
			});
		};
	});

	useEffect(() => {
		function handleDocumentClick(e) {
			const details = ref.current;
			if (!details?.open) return;
			const parkId = details.dataset.menuParkId;
			const pop =
				details.querySelector(".menu-pop") ??
				(parkId ? document.querySelector(`.menu-pop[data-menu-park-id="${parkId}"]`) : null);
			if (details.contains(e.target) || pop?.contains(e.target)) return;
			details.open = false;
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
