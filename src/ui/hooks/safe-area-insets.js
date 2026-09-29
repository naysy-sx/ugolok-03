// Найдено живой проверкой (владелец, реальный телефон, 2026-09-29) —
// .menu-pop, приклеенное к нижнему краю window.innerHeight (compute-menu-
// pop-position.js), пряталось под системной навигационной панелью Android
// (three-button bar / жест-полоса): в edge-to-edge WebView window.innerHeight
// включает эту область, хотя она физически перекрыта чужим UI.
//
// env(safe-area-inset-*) читается напрямую в CSS повсюду в проекте, но
// use-details-menu.js считает пиксели сам (JS, не CSS) — единственный
// надёжный способ получить те же значения числом: зонд с padding:env(...),
// вычисленный computedStyle которого браузер уже перевёл в px. Зонд создаётся
// один раз и живёт до конца жизни страницы (дешевле, чем DOM insert/remove
// на каждый вызов — onReposition дёргается на resize/scroll открытого меню).
let probe = null;

function ensureProbe() {
	if (probe) return probe;
	probe = document.createElement("div");
	probe.setAttribute("aria-hidden", "true");
	probe.style.cssText =
		"position:fixed;inset:0;visibility:hidden;pointer-events:none;" +
		"padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px);";
	document.body.appendChild(probe);
	return probe;
}

export function getSafeAreaInsets() {
	if (typeof document === "undefined") return { top: 0, right: 0, bottom: 0, left: 0 };
	const cs = getComputedStyle(ensureProbe());
	return {
		top: parseFloat(cs.paddingTop) || 0,
		right: parseFloat(cs.paddingRight) || 0,
		bottom: parseFloat(cs.paddingBottom) || 0,
		left: parseFloat(cs.paddingLeft) || 0,
	};
}
