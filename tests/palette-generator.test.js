import { test } from "node:test";
import assert from "node:assert/strict";
import { generatePalette, ACCENT_FORBIDDEN_ZONES, PaletteConfigError, nudgeHueOutOfForbiddenZones } from "../src/ui/theme/palette-generator.js";
import { oklchContrastRatio, isInSrgbGamut, parseOklch } from "./oklch-contrast.js";

// Этап 70 (DESIGN.md/CONTRACTS.md) — исполняемый инвариант И1, не ревью на глаз.
// Перебор сетки допустимых конфигураций, а не отдельные "красивые" примеры —
// именно то доказательство, которого требовало второе сообщение Claude 5 в
// обсуждении с пользователем (перебор + порог контраста, а не мнение).

const LIGHT_RANGE = [0.93, 0.995];
const DARK_RANGE = [0.12, 0.24];

function samplesInRange([min, max], count) {
	const out = [];
	for (let i = 0; i < count; i++) out.push(min + ((max - min) * i) / (count - 1));
	return out;
}

function isInForbiddenZone(hue) {
	return ACCENT_FORBIDDEN_ZONES.some((zone) => {
		const diff = Math.abs(((hue - zone.hue + 540) % 360) - 180);
		return diff < zone.halfWidth;
	});
}

function allowedHueSamples(stepDeg) {
	const out = [];
	for (let h = 0; h < 360; h += stepDeg) {
		if (!isInForbiddenZone(h)) out.push(h);
	}
	return out;
}

function* configs() {
	for (const dir of [-1, 1]) {
		const range = dir === 1 ? DARK_RANGE : LIGHT_RANGE;
		for (const lBg of samplesInRange(range, 5)) {
			for (const cNeutral of [0, 0.012, 0.035]) {
				for (const accentHue of allowedHueSamples(5)) {
					yield { dir, lBg, cNeutral, accentHue };
				}
			}
		}
	}
}

test("ACCENT_FORBIDDEN_ZONES — 4 служебных тона, ±20°, значения из DESIGN.md", () => {
	assert.equal(ACCENT_FORBIDDEN_ZONES.length, 4);
	const hues = ACCENT_FORBIDDEN_ZONES.map((z) => z.hue).sort((a, b) => a - b);
	assert.deepEqual(hues, [25, 85, 145, 235]);
	for (const zone of ACCENT_FORBIDDEN_ZONES) assert.equal(zone.halfWidth, 20);
});

test("generatePalette: валидация диапазонов — бросает PaletteConfigError, не угадывает", () => {
	assert.throws(() => generatePalette({ dir: 1, lBg: 0.5, cNeutral: 0.012, accentHue: 0 }), PaletteConfigError);
	assert.throws(() => generatePalette({ dir: -1, lBg: 0.5, cNeutral: 0.012, accentHue: 0 }), PaletteConfigError);
	assert.throws(() => generatePalette({ dir: 1, lBg: 0.18, cNeutral: 0.1, accentHue: 0 }), PaletteConfigError);
	assert.throws(() => generatePalette({ dir: 1, lBg: 0.18, cNeutral: 0.012, accentHue: 25 }), PaletteConfigError, "hue в запретной зоне bad (25±20)");
	assert.throws(() => generatePalette({ dir: 0, lBg: 0.18, cNeutral: 0.012, accentHue: 0 }), PaletteConfigError, "dir обязан быть -1|1");
});

test("generatePalette: возвращает полный набор токенов из CONTRACTS.md", () => {
	const tokens = generatePalette({ dir: 1, lBg: 0.18, cNeutral: 0.012, accentHue: 0 });
	const expectedKeys = [
		"--bg", "--surface", "--surface-raised", "--border", "--muted", "--fg",
		"--accent", "--accent-contrast", "--accent-2", "--accent-2-hue",
		"--bad", "--bad-surface", "--bad-edge",
		"--warn", "--warn-surface", "--warn-edge",
		"--good", "--good-surface", "--good-edge",
		"--info", "--info-surface", "--info-edge",
	];
	for (const key of expectedKeys) assert.ok(key in tokens, `отсутствует токен ${key}`);
});

test("nudgeHueOutOfForbiddenZones: hue уже вне запретных зон -> не меняется", () => {
	assert.equal(nudgeHueOutOfForbiddenZones(0), 0);
	assert.equal(nudgeHueOutOfForbiddenZones(185), 185);
	assert.equal(nudgeHueOutOfForbiddenZones(265), 265);
});

test("nudgeHueOutOfForbiddenZones: hue внутри запретной зоны -> ближайший край, результат сам не запретный", () => {
	assert.equal(nudgeHueOutOfForbiddenZones(230), 215, "sky=230 -> info-зона [215,255], ближе 215");
	assert.equal(nudgeHueOutOfForbiddenZones(35), 45, "terracotta=35 -> bad-зона [5,45], ближе 45");
	assert.equal(nudgeHueOutOfForbiddenZones(75), 65, "amber=75 -> warn-зона [65,105], ближе 65");
	assert.equal(nudgeHueOutOfForbiddenZones(140), 125, "moss=140 -> good-зона [125,165], ближе 125");
});

test("nudgeHueOutOfForbiddenZones: hue ровно в центре зоны -> детерминированно левый край", () => {
	assert.equal(nudgeHueOutOfForbiddenZones(85), 65, "центр warn-зоны — равноудалён от 65/105, выбирается левый");
});

test("nudgeHueOutOfForbiddenZones: результат для ЛЮБОГО hue по кругу (шаг 1°) сам не попадает в запретную зону", () => {
	for (let h = 0; h < 360; h++) {
		const nudged = nudgeHueOutOfForbiddenZones(h);
		const stillForbidden = ACCENT_FORBIDDEN_ZONES.some((zone) => {
			const diff = Math.abs(((nudged - zone.hue + 540) % 360) - 180);
			return diff < zone.halfWidth;
		});
		assert.equal(stillForbidden, false, `hue=${h} -> nudged=${nudged} всё ещё в запретной зоне`);
	}
});

test("И1 — контраст и гамма для ВСЕХ допустимых конфигураций сетки (исполняемое доказательство)", () => {
	let checked = 0;
	const failures = [];

	for (const config of configs()) {
		checked++;
		const tokens = generatePalette(config);
		const parsed = {};
		for (const [name, value] of Object.entries(tokens)) {
			if (name.endsWith("-hue")) continue; // не цвет, число (--accent-2-hue)
			parsed[name] = parseOklch(value);
		}

		const bg = parsed["--bg"];
		const checks = [
			["fg/bg >= 4.5", oklchContrastRatio(parsed["--fg"], bg), 4.5],
			["muted/bg >= 3.0", oklchContrastRatio(parsed["--muted"], bg), 3.0],
			["accent-contrast/accent >= 4.5", oklchContrastRatio(parsed["--accent-contrast"], parsed["--accent"]), 4.5],
			["bad/bg >= 4.5", oklchContrastRatio(parsed["--bad"], bg), 4.5],
			["warn/bg >= 4.5", oklchContrastRatio(parsed["--warn"], bg), 4.5],
			["good/bg >= 4.5", oklchContrastRatio(parsed["--good"], bg), 4.5],
			["info/bg >= 4.5", oklchContrastRatio(parsed["--info"], bg), 4.5],
		];

		for (const [label, actual, threshold] of checks) {
			if (actual < threshold) failures.push({ config, label, actual, threshold });
		}

		for (const [name, [l, c, h]] of Object.entries(parsed)) {
			if (!isInSrgbGamut(l, c, h)) failures.push({ config, label: `${name} вне гаммы sRGB`, value: tokens[name] });
		}
	}

	assert.ok(checked > 100, `сетка слишком мала (${checked} комбинаций) — тест не перебор, а иллюзия перебора`);
	if (failures.length > 0) {
		const preview = failures.slice(0, 5).map((f) => JSON.stringify(f)).join("\n");
		assert.fail(`${failures.length} нарушений И1 из ${checked} конфигураций, первые 5:\n${preview}`);
	}
});
