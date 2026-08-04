import { resolveEffectiveTheme } from "../theme/theme-mode.js";
import { t } from "../signals/i18n.js";
import IconSun from "../icons/sun.jsx";
import IconMoon from "../icons/moon.jsx";

// Тот же визуальный язык, что ConnectionStatusPanel (постоянная панель под
// главным меню) — пользователь: убрать плавающую кнопку-переключатель темы
// в углу экрана, перенести сюда отдельным блоком НАД ConnectionStatusPanel.
export default function ThemeStatusPanel({ themeMode, onToggle }) {
	const effective = resolveEffectiveTheme(themeMode);
	const isDark = effective === "dark";

	return (
		<div class="theme-status-panel stack" style={{ "--gap": "var(--space-3xs)" }} aria-label={t("themeStatus.panelAria")}>
			<p>
				{t("themeStatus.label")}: <span>{isDark ? t("themeStatus.dark") : t("themeStatus.light")}</span>
			</p>
			<button type="button" class="theme-status-toggle row" style={{ "--gap": "var(--space-3xs)", alignItems: "center" }} onClick={onToggle}>
				{isDark ? <IconSun /> : <IconMoon />} {t("themeStatus.toggleLink")}
			</button>
		</div>
	);
}
