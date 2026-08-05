import { generatePalette } from "./palette-generator.js";

export const BUILD_LBG_LIGHT = 0.99;
export const BUILD_LBG_DARK = 0.17;
export const DEFAULT_CUSTOM_PALETTE = { cNeutral: 0.022, accentHue: 265 };

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
