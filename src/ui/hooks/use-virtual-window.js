import { useState, useEffect, useRef } from "preact/hooks";

// Виртуализация списка (задача 3.2 TASK.md): "папка на 10⁴ элементов не
// рендерится целиком. Строка фиксированной высоты — экономит целую
// структуру данных." Отслеживает скролл БЛИЖАЙШЕГО скроллящегося предка
// (.content-wrapper, screen.jsx — единственная зона скролла экрана, тот
// же приём "скроллится ровно то, что осталось от flex-родителя") — не
// заводит СВОЙ, второй скролл-контейнер внутри списка (иначе — два скролла
// на одном экране, не тот UX, что у остальных списков приложения).
//
// anchorRef — пустой элемент, ставится ПЕРЕД списком: даёт точку отсчёта
// "где начинается список" в координатах скролл-контейнера, независимо от
// CSS-позиционирования (getBoundingClientRect, не offsetTop — тот
// завязан на offsetParent, который может оказаться не тем предком).
export function useVirtualWindow({ count, rowHeight, overscan = 6 }) {
	const anchorRef = useRef(null);
	const [range, setRange] = useState({ start: 0, end: Math.min(count, 40) });

	useEffect(() => {
		const anchor = anchorRef.current;
		if (!anchor) return;
		const scrollEl = anchor.closest(".content-wrapper") ?? window;

		function recompute() {
			const anchorRect = anchor.getBoundingClientRect();
			let scrollTop;
			let viewportHeight;
			let anchorTop;
			if (scrollEl === window) {
				scrollTop = window.scrollY;
				viewportHeight = window.innerHeight;
				anchorTop = anchorRect.top + window.scrollY;
			} else {
				const scrollRect = scrollEl.getBoundingClientRect();
				scrollTop = scrollEl.scrollTop;
				viewportHeight = scrollEl.clientHeight;
				anchorTop = anchorRect.top - scrollRect.top + scrollEl.scrollTop;
			}

			const firstVisible = Math.floor(Math.max(0, scrollTop - anchorTop) / rowHeight);
			const visibleCount = Math.ceil(viewportHeight / rowHeight);
			const start = Math.max(0, firstVisible - overscan);
			const end = Math.min(count, firstVisible + visibleCount + overscan);
			setRange((prev) => (prev.start === start && prev.end === end ? prev : { start, end }));
		}

		recompute();
		scrollEl.addEventListener("scroll", recompute, { passive: true });
		window.addEventListener("resize", recompute);
		return () => {
			scrollEl.removeEventListener("scroll", recompute);
			window.removeEventListener("resize", recompute);
		};
	}, [count, rowHeight, overscan]);

	// count может уменьшиться (фильтр/удаление) между рендерами — не ждать
	// следующего скролл-события, чтобы не показать пустой "хвост" окна.
	const start = Math.min(range.start, count);
	const end = Math.min(range.end, count);
	return { anchorRef, start, end };
}
