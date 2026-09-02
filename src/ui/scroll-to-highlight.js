import { normalize } from "../domain/search/matching.js";

// Живой фидбек: переход из поиска в длинный пост оставлял человека
// наверху страницы — искомую строку приходилось искать глазами заново.
// Ищет ПЕРВЫЙ блочный элемент (абзац/пункт списка/заголовок/цитату),
// чей текст содержит любую из частей запроса, прокручивает к нему и
// на время подсвечивает целиком (не отдельную подстроку внутри —
// произвольно вложенная разметка MarkdownView делает точечное
// выделение подстроки в DOM несоразмерно сложным для того, что человек
// просил: "долго искать глазами, где же там нужная строка" — решает и
// подсветка всего абзаца).
//
// DOM-зависимая функция — юнит-тестов node --test нет (в проекте нет
// DOM в чистом node --test, PLAN.md "Уроки предыдущих этапов"), проверка
// только живая (run-ugolok/Playwright).
const BLOCK_SELECTOR = "p, li, h1, h2, h3, h4, h5, h6, blockquote, pre, td, th, dt, dd";
const FLASH_CLASS = "search-flash";
const FLASH_DURATION_MS = 4000;

export function scrollToAndFlashMatch(container, parts) {
	if (!container || !parts?.length) return false;
	const blocks = [...container.querySelectorAll(BLOCK_SELECTOR)];
	const candidates = blocks.length ? blocks : [container];
	for (const el of candidates) {
		const haystack = normalize(el.textContent || "");
		if (!parts.some((p) => haystack.includes(p))) continue;
		el.scrollIntoView({ behavior: "smooth", block: "center" });
		el.classList.add(FLASH_CLASS);
		setTimeout(() => el.classList.remove(FLASH_CLASS), FLASH_DURATION_MS);
		return true;
	}
	return false;
}
