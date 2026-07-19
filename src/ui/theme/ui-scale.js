// CONTRACTS.md, этап 34 — весь остальной дизайн уже rem-относителен (--space-unit,
// --step-* в styles/minimal.css), поэтому масштаб — это просто font-size корня.
export const SCALE_OPTIONS = [
	{ id: "small", label: "Small (90%)", percent: 90 },
	{ id: "medium", label: "Medium (100%)", percent: 100 },
	{ id: "large", label: "Large (110%)", percent: 110 },
	{ id: "xlarge", label: "Extra Large (125%)", percent: 125 },
];

export function applyUiScale(scaleId) {
	const entry = SCALE_OPTIONS.find((s) => s.id === scaleId);
	if (!entry) return;
	document.documentElement.style.fontSize = `${entry.percent}%`;
}
