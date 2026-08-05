export class PaletteConfigError extends Error {}

export const ACCENT_FORBIDDEN_ZONES = [
	{ hue: 25, halfWidth: 20 },
	{ hue: 85, halfWidth: 20 },
	{ hue: 145, halfWidth: 20 },
	{ hue: 235, halfWidth: 20 },
];

function isHueForbidden(hue) {
	return ACCENT_FORBIDDEN_ZONES.some((zone) => {
		const diff = Math.abs(((hue - zone.hue + 540) % 360) - 180);
		return diff < zone.halfWidth;
	});
}

// Экспортирована — общая для миграции старого accentColorId (ui-settings.js) и
// для UI-слайдера accentHue (settings.jsx): при перетаскивании в запретную зону
// нужно так же сдвинуть к ближайшему краю, не отвергать/не оставлять внутри
// зоны. Один источник истины на оба случая использования, не два дубликата.
// При точном совпадении расстояний до обоих краёв (hue ровно в центре зоны) —
// детерминированно выбирается ЛЕВЫЙ (меньший) край.
export function nudgeHueOutOfForbiddenZones(hue) {
	for (const zone of ACCENT_FORBIDDEN_ZONES) {
		const diff = Math.abs(((hue - zone.hue + 540) % 360) - 180);
		if (diff < zone.halfWidth) {
			const lowEdge = (zone.hue - zone.halfWidth + 360) % 360;
			const highEdge = (zone.hue + zone.halfWidth) % 360;
			const distToLow = Math.abs(((hue - lowEdge + 540) % 360) - 180);
			const distToHigh = Math.abs(((hue - highEdge + 540) % 360) - 180);
			return distToHigh < distToLow ? highEdge : lowEdge;
		}
	}
	return hue;
}

function clamp(value, min, max) {
	return Math.min(max, Math.max(min, value));
}

// Исходная версия (множитель от расстояния L до "безопасной середины") оказалась
// НЕ ДОСТАТОЧНО агрессивной у самого края L->1: реальная максимально безопасная
// chroma в sRGB-гамме падает почти до нуля при L~0.99, а линейный множитель с
// наклоном 2.4 такое не ловит (найдено этим же тестом — --bg клиппился на синих
// hue при lBg~0.95, cNeutral=0.035). Заменено на прямой потолок по chroma,
// пропорциональный расстоянию до края (0/1).
// Верхний коэффициент 0.40 у L=1 — запас от найденных расчётом 0.44 (по всем hue,
// шаг 2°, tests/oklch-contrast.js).
// Нижний порог/коэффициент прошли ДВЕ итерации:
//  - сначала подняты с (0.35, 0.16) до (0.5, 0.19), т.к. --warn-edge/--info-edge
//    (chroma 0.09) клиппились уже при L=0.37, хотя старый порог считал L>0.35
//    "безопасной серединой";
//  - но 0.19 был откалиброван только по 4 ФИКСИРОВАННЫМ hue служебных тонов
//    (25/85/145/235) — а gamutClamp используется и для accentHue (крутится по
//    ВСЕМ 360°), где худший случай — не эти 4 hue, а зона ~185-200 (голубо-зелёный),
//    которой в фиксированных тонах просто нет. Это тут же сломало --fg (accentHue
//    195, lBg 0.93, cNeutral 0.035 — L=0.21 после проекции fg на светлую тему).
// Итог: коэффициент рассчитан ПЕРЕБОРОМ по объединению — все accentHue с шагом 5°
// (кроме запретных зон) ПЛЮС точные 25/85/145/235 (которые accentHue исключает,
// но которые напрямую использует hue служебных тонов) — минимальное отношение
// safe-chroma/L по всей этой сетке (L от 0.02 до 0.6, шаг 0.005) оказалось 0.15
// (у L=0.02, hue≈190); порог, где safe-chroma для худшего hue впервые достигает
// 0.09 (макс. запрошенной chroma, --*-edge) — L≈0.535. Взяты 0.145 (запас от 0.15)
// и порог 0.55 (запас от 0.535).
function gamutClamp(chroma, l) {
	const highCap = l > 0.85 ? 0.4 * (1 - l) : Infinity;
	const lowCap = l < 0.55 ? 0.145 * l : Infinity;
	return Math.min(chroma, highCap, lowCap);
}

function formatOklch(l, c, h) {
	return `oklch(${l.toFixed(4)} ${c.toFixed(4)} ${h.toFixed(2)})`;
}

function validateConfig(config) {
	if (config.dir !== 1 && config.dir !== -1) throw new PaletteConfigError("dir должен быть -1 или 1");
	const lBgMin = config.dir === 1 ? 0.12 : 0.93;
	const lBgMax = config.dir === 1 ? 0.24 : 0.995;
	if (config.lBg < lBgMin || config.lBg > lBgMax) throw new PaletteConfigError(`lBg вне диапазона [${lBgMin}, ${lBgMax}]`);
	if (config.cNeutral < 0 || config.cNeutral > 0.035) throw new PaletteConfigError("cNeutral вне диапазона [0, 0.035]");
	if (config.accentHue < 0 || config.accentHue >= 360) throw new PaletteConfigError("accentHue вне диапазона [0, 360)");
	if (isHueForbidden(config.accentHue)) throw new PaletteConfigError(`accentHue ${config.accentHue} в запретной зоне`);
}

const ROLE_DELTAS = { surface: 0.05, surfaceRaised: 0.11, border: 0.16, muted: 0.45, fg: 0.72 };

// Значения подобраны расчётом (tests/oklch-contrast.js), не на глаз: для каждого
// тона — максимальная хрома, при которой ОБЕ полярности проходят контраст ≥4.5
// (WCAG) против самого неудобного bg в своём диапазоне lBg И остаются внутри
// гаммы sRGB. h/c исходно взяты из уже существующих в проекте литералов
// (var(--bad, oklch(0.58 0.21 25)) и т.п., 50+ мест) — L пересчитан заново,
// т.к. старые фолбэки были одним значением на обе полярности темы и не
// гарантированно проходили контраст на светлом фоне (см. DESIGN.md, этап 70).
const SERVICE_TONES = {
	bad: { h: 25, c: 0.2, lDark: 0.68, lLight: 0.5 },
	warn: { h: 85, c: 0.1, lDark: 0.66, lLight: 0.5 },
	good: { h: 145, c: 0.15, lDark: 0.65, lLight: 0.48 },
	info: { h: 235, c: 0.1, lDark: 0.66, lLight: 0.48 },
};

export function generatePalette(config) {
	validateConfig(config);
	const { dir, lBg, cNeutral, accentHue } = config;
	const tokens = {};

	// gamutClamp обязателен и тут: у самой светлой границы lBg (0.995/0.93 см.
	// validateConfig) даже нейтральная cNeutral=0.035 реально клиппится в
	// sRGB на части hue-круга (найдено этим же тестом).
	tokens["--bg"] = formatOklch(lBg, gamutClamp(cNeutral, lBg), accentHue);

	for (const role of ["surface", "surfaceRaised", "border", "muted"]) {
		const l = clamp(lBg + dir * ROLE_DELTAS[role], 0, 1);
		const cssName = "--" + role.replace(/([A-Z])/g, "-$1").toLowerCase();
		tokens[cssName] = formatOklch(l, gamutClamp(cNeutral, l), accentHue);
	}

	const fgL = clamp(lBg + dir * ROLE_DELTAS.fg, 0, 1);
	const fgChroma = Math.min(cNeutral * 1.6, 0.05);
	tokens["--fg"] = formatOklch(fgL, gamutClamp(fgChroma, fgL), accentHue);

	const accentL = dir === 1 ? 0.74 : 0.55;
	// 0.085, не 0.14: --accent/--accent-2 обязаны оставаться в гамме sRGB на ЛЮБОМ
	// hue (пользователь крутит accentHue по всему кругу) — gamutClamp(l) без учёта
	// hue не ловит "жёлтую"/"голубую" зоны, где даже 0.14 клиппится при L≈0.55/0.74
	// (найдено этим же тестом). 0.085 — верифицированный расчётом (tests/
	// oklch-contrast.js) минимум, безопасный на ВСЕХ hue при обеих L (0.55/0.74) —
	// цена: акцент не такой яркий, каким мог бы быть на red/magenta, где гамма
	// позволяет больше. По-hue таблица максимальной безопасной хромы — задел на
	// будущее (DESIGN.md, этап 70), не блокирует эту версию.
	const cAccent = 0.085;
	tokens["--accent"] = formatOklch(accentL, gamutClamp(cAccent, accentL), accentHue);
	// Раньше --accent-contrast был захардкожен в белый (0.99) — ломался на тёмной
	// теме, где accentL=0.74 (светлый акцент на тёмном фоне): белый текст поверх
	// светлого акцента даёт контраст ~2.3, а не 4.5 (найдено этим же тестом на
	// ВСЕХ hue сразу — не hue-специфично, это чисто L/L контраст). Тёмный текст
	// (L=0.1) на accentL=0.74 даёт запас ×8.5; белый (L=1.0) на accentL=0.55 даёт
	// запас ×4.6 (проверено полным перебором hue, tests/oklch-contrast.js) — 0.99
	// давал только 4.51, слишком тонкий запас для всей сетки. Поэтому именно 1.0,
	// не 0.99.
	const accentContrastL = dir === 1 ? 0.1 : 1.0;
	tokens["--accent-contrast"] = formatOklch(accentContrastL, 0, 0);

	const accent2Hue = (accentHue + 150) % 360;
	tokens["--accent-2-hue"] = String(accent2Hue);
	const accent2L = clamp(accentL - 0.02, 0, 1);
	tokens["--accent-2"] = formatOklch(accent2L, gamutClamp(cAccent * 0.9, accent2L), accent2Hue);

	for (const [name, tone] of Object.entries(SERVICE_TONES)) {
		const toneL = dir === 1 ? tone.lDark : tone.lLight;
		// Гейт-клэмп обязателен и здесь — без него тон сам может выйти за гамму sRGB
		// (найдено этим же тестом: warn/info при исходных константах реально клиппились).
		tokens["--" + name] = formatOklch(toneL, gamutClamp(tone.c, toneL), tone.h);

		const surfaceL = clamp(lBg + dir * ROLE_DELTAS.surface, 0, 1);
		tokens["--" + name + "-surface"] = formatOklch(surfaceL, gamutClamp(0.04, surfaceL), tone.h);

		const edgeL = clamp(lBg + dir * ROLE_DELTAS.border, 0, 1);
		tokens["--" + name + "-edge"] = formatOklch(edgeL, gamutClamp(0.09, edgeL), tone.h);
	}

	return tokens;
}
