// Этап "визуальный редизайн" (VISUAL.md, Claude Opus) — пользователь: демо-образец
// форсировал тёмную тему кодом ("не надо так"), но переключатель наверху приложения
// стоит добавить. mode: "light" | "dark" | null (null = "как в системе", data-theme
// не выставляется вовсе — light-dark() в minimal.css решает по prefers-color-scheme,
// как было всегда). Тот же приём DI/применения, что accent-palette.js/ui-scale.js.
export function applyThemeMode(mode) {
	if (mode === "light" || mode === "dark") {
		document.documentElement.setAttribute("data-theme", mode);
	} else {
		document.documentElement.removeAttribute("data-theme");
	}
}

// Текущая ЭФФЕКТИВНАЯ тема — либо явный выбор пользователя, либо (mode=null)
// системная — нужна кнопке-переключателю, чтобы знать, в какую сторону переключать
// и какую иконку (солнце/луна) показать ПРЯМО СЕЙЧАС.
export function resolveEffectiveTheme(mode) {
	if (mode === "light" || mode === "dark") return mode;
	return globalThis.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

// Простой бинарный тумблер (тот же UX, что демо Opus: одна кнопка "день/ночь",
// не 3-позиционный select) — переключает от ТЕКУЩЕЙ эффективной темы, даже если
// пользователь ещё ни разу не делал явный выбор (mode=null, "как в системе").
export function toggleThemeMode(mode) {
	return resolveEffectiveTheme(mode) === "dark" ? "light" : "dark";
}
