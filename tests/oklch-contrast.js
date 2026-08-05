// Тестовый хелпер этапа 70 (DESIGN.md/CONTRACTS.md) — транскрипция ОПУБЛИКОВАННЫХ
// матриц CSS Color 4 (OKLab -> линейный sRGB, автор преобразования — Björn Ottosson)
// и формулы относительной яркости WCAG. Написан напрямую (не воркером) по тому же
// принципу, что криптопримитивы (правило 13b оркестрации): транскрипция фиксированного
// внешнего стандарта — не место для угадывания коэффициентов слабой моделью.
//
// Не используется в рантайм-бандле приложения (только tests/*.test.js импортируют
// этот файл) — проверка контраста нужна на этапе разработки, не в браузере пользователя.

/** OKLCH(L, C, H[deg]) -> линейный sRGB [r,g,b], БЕЗ клэмпа и БЕЗ гамма-кодирования.
 *  Компоненты вне [0,1] означают, что цвет вне гаммы sRGB — это намеренно не
 *  скрывается (тест этапа 70 обязан заметить такой случай, не тихо подрезать). */
export function oklchToLinearSrgb(l, c, hDeg) {
	const hRad = (hDeg * Math.PI) / 180;
	const a = c * Math.cos(hRad);
	const b = c * Math.sin(hRad);

	const l_ = l + 0.3963377774 * a + 0.2158037573 * b;
	const m_ = l - 0.1055613458 * a - 0.0638541728 * b;
	const s_ = l - 0.0894841775 * a - 1.2914855480 * b;

	const l3 = l_ ** 3;
	const m3 = m_ ** 3;
	const s3 = s_ ** 3;

	const r = 4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3;
	const g = -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3;
	const bChan = -0.0041960863 * l3 - 0.7034186147 * m3 + 1.7076147010 * s3;

	return [r, g, bChan];
}

/** Относительная яркость WCAG. Вход — линейный sRGB (не гамма-кодированный),
 *  поэтому шаг "разгаммить 0..255" из канонической формулы WCAG здесь не нужен —
 *  oklchToLinearSrgb уже возвращает линейные значения. */
export function relativeLuminance([r, g, b]) {
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Контраст WCAG между двумя цветами. Каждый цвет — [L, C, H] (OKLCH). */
export function oklchContrastRatio(colorA, colorB) {
	const lumA = relativeLuminance(oklchToLinearSrgb(...colorA));
	const lumB = relativeLuminance(oklchToLinearSrgb(...colorB));
	const lighter = Math.max(lumA, lumB);
	const darker = Math.min(lumA, lumB);
	return (lighter + 0.05) / (darker + 0.05);
}

/** true, если все три канала линейного sRGB лежат в [0,1] (внутри гаммы). */
export function isInSrgbGamut(l, c, hDeg) {
	return oklchToLinearSrgb(l, c, hDeg).every((ch) => ch >= 0 && ch <= 1);
}

/** "oklch(0.7 0.15 25)" -> [0.7, 0.15, 25]. Строго требует именно эту форму
 *  (три числа через пробел) — это ровно то, что генератор этапа 70 обязан
 *  выдавать по контракту (CONTRACTS.md), не общий CSS-парсер. */
export function parseOklch(cssString) {
	const match = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)$/.exec(cssString);
	if (!match) throw new Error(`не похоже на oklch(L C H): ${cssString}`);
	return [Number(match[1]), Number(match[2]), Number(match[3])];
}
