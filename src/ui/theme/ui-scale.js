// CONTRACTS.md, этап 34 — весь остальной дизайн уже rem-относителен (--space-unit,
// --step-* в styles/minimal.css), поэтому масштаб — это просто font-size корня.
export const SCALE_OPTIONS = [
	{ id: "small", percent: 90 },
	{ id: "medium", percent: 100 },
	{ id: "large", percent: 110 },
	{ id: "xlarge", percent: 125 },
];

export function applyUiScale(scaleId) {
	const entry = SCALE_OPTIONS.find((s) => s.id === scaleId);
	if (!entry) return;
	document.documentElement.style.fontSize = `${entry.percent}%`;
}
