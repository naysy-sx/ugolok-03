// CONTRACTS.md, этап 34 — hue те же числа, что уже управляют --accent-hue
// (styles/minimal.css: --accent: light-dark(oklch(.55 .17 var(--accent-hue)), ...)) —
// именованные точки на цветовом круге, никакой новой CSS-архитектуры.
export const ACCENT_COLORS = [
	{ id: "blue", label: "Blue", hue: 255 },
	{ id: "indigo", label: "Indigo", hue: 275 },
	{ id: "sky", label: "Sky", hue: 230 },
	{ id: "teal", label: "Teal", hue: 185 },
	{ id: "cyan", label: "Cyan", hue: 200 },
	{ id: "lavender", label: "Lavender", hue: 290 },
	{ id: "violet", label: "Violet", hue: 305 },
	{ id: "terracotta", label: "Terracotta", hue: 35 },
	{ id: "amber", label: "Amber", hue: 75 },
	{ id: "peach", label: "Peach", hue: 45 },
	{ id: "saffron", label: "Saffron", hue: 85 },
	{ id: "orange", label: "Orange", hue: 55 },
	{ id: "olive", label: "Olive", hue: 115 },
	{ id: "moss", label: "Moss", hue: 140 },
];

// Неизвестный colorId -> no-op (не throw): вызывающий код мог прочитать устаревший
// локальный кэш до правки палитры — деградация в "текущий акцент остаётся", не крах.
export function applyAccentColor(colorId) {
	const entry = ACCENT_COLORS.find((c) => c.id === colorId);
	if (!entry) return;
	document.documentElement.style.setProperty("--accent-hue", String(entry.hue));
}
