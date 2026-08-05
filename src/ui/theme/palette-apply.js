import { generatePalette } from "./palette-generator.js";

export const BUILD_LBG_LIGHT = 0.99;
export const BUILD_LBG_DARK = 0.17;
// cNeutral: 0.022 (=старый --chroma-ui) визуально читался как заметный
// цветной оттенок у .card/.surface-raised для холодных hue (indigo/violet) —
// найдено пользователем живьём: нейтрали одновременно унаследовали и hue,
// и chroma одного узла с акцентом, а человеческий глаз воспринимает
// одинаковую числовую chroma у синих/фиолетовых hue как более "цветную",
// чем у тёплых (жёлтых/оранжевых) — тот же хроматический эффект, что уже
// документирован для --accent в этом файле (пришлось понизить cAccent).
// 0.010 — компромисс: заметно ближе к "chroma≈0 для нейтралей" (общая
// рекомендация дизайн-систем), но не плоский серый — лёгкий подтон
// остаётся. Диапазон слайдера (0-0.035, settings.jsx) не сужен — кто хочет
// более насыщенные нейтрали, может выкрутить сам.
export const DEFAULT_CUSTOM_PALETTE = { cNeutral: 0.01, accentHue: 265 };

export function applyCustomPalette(customPalette) {
	const { cNeutral, accentHue } = customPalette ?? DEFAULT_CUSTOM_PALETTE;
	const light = generatePalette({ dir: -1, lBg: BUILD_LBG_LIGHT, cNeutral, accentHue });
	const dark = generatePalette({ dir: 1, lBg: BUILD_LBG_DARK, cNeutral, accentHue });
	const root = document.documentElement.style;
	for (const [name, value] of Object.entries(light)) {
		if (name.endsWith("-hue")) {
			root.setProperty(name, value);
			continue;
		}
		root.setProperty(name + "-light", value);
	}
	for (const [name, value] of Object.entries(dark)) {
		if (name.endsWith("-hue")) continue;
		root.setProperty(name + "-dark", value);
	}
	root.setProperty("--accent-hue", String(accentHue));
}
