import { getPlatform } from "../../platform/index.js";

// Этап "визуальный редизайн" (VISUAL.md, Claude Opus) — пользователь: демо-образец
// форсировал тёмную тему кодом ("не надо так"), но переключатель наверху приложения
// стоит добавить. mode: "light" | "dark" | null (null = "как в системе", data-theme
// не выставляется вовсе — light-dark() в minimal.css решает по prefers-color-scheme,
// как было всегда). Тот же приём DI/применения, что palette-apply.js/ui-scale.js.
export function applyThemeMode(mode) {
	if (mode === "light" || mode === "dark") {
		document.documentElement.setAttribute("data-theme", mode);
	} else {
		document.documentElement.removeAttribute("data-theme");
	}
	syncSystemBarsTheme(mode);
}

// Текущая ЭФФЕКТИВНАЯ тема — либо явный выбор пользователя, либо (mode=null)
// системная — нужна кнопке-переключателю, чтобы знать, в какую сторону переключать
// и какую иконку (солнце/луна) показать ПРЯМО СЕЙЧАС.
export function resolveEffectiveTheme(mode) {
	if (mode === "light" || mode === "dark") return mode;
	return globalThis.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

// Э4.6 ТЗ-NATIVE-APPS — "цвет иконок статус-бара следует теме". Best-effort и
// молчаливо (та же форма, что openExternal в app.jsx) — web.js уже честный
// no-op, tauri.js пока notImplemented (throw синхронный, native-stub.js) —
// сбой здесь не должен ронять применение самой темы интерфейса выше.
function syncSystemBarsTheme(mode) {
	try {
		Promise.resolve(getPlatform().ui.setSystemBarsTheme(resolveEffectiveTheme(mode))).catch(() => {});
	} catch {
		// не реализовано на этой платформе — статус-бар просто не подстроился
	}
}

// Простой бинарный тумблер (тот же UX, что демо Opus: одна кнопка "день/ночь",
// не 3-позиционный select) — переключает от ТЕКУЩЕЙ эффективной темы, даже если
// пользователь ещё ни разу не делал явный выбор (mode=null, "как в системе").
export function toggleThemeMode(mode) {
	return resolveEffectiveTheme(mode) === "dark" ? "light" : "dark";
}
