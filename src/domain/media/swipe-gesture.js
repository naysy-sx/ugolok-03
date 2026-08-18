// MEDIA-OVERLAY-UI.md, этап 3 — чистая математика жеста (без DOM),
// вынесена отдельно от media-overlay.jsx ровно затем, чтобы её можно
// было проверить node --test (у UI-слоя этого модуля нет jsdom —
// прецедент см. CONTRACTS.md/log.md прошлых довесков). pointer-события,
// --media-pull, WAAPI — во view-слое, здесь только числа.

export const AXIS_LOCK_PX = 8; // порог, после которого ось не меняется до pointerup
export const HORIZONTAL_COMMIT_RATIO = 0.16; // §3.1 "16% ширины окна"
export const EDGE_RESISTANCE = 0.3; // §3.1 "смещение умножается на 0.3"
export const VERTICAL_PULL_RANGE_PX = 260; // §3.2 "--media-pull = min(1, dy/260)"
export const VERTICAL_COMMIT_PX = 110; // §3.2 "отпустили при dy > 110"

// Ось жеста. undetermined, пока max(|dx|,|dy|) < AXIS_LOCK_PX — вызывающая
// сторона обязана держать первый ненулевой результат неизменным до
// pointerup (сама функция не хранит состояния, это чистая функция от
// текущего dx/dy — блокировку держит вызывающий код).
export function resolveAxis(dx, dy) {
	if (Math.max(Math.abs(dx), Math.abs(dy)) < AXIS_LOCK_PX) return null;
	return Math.abs(dx) >= Math.abs(dy) ? "horizontal" : "vertical";
}

// Сопротивление на краях плейлиста — визуальное смещение ленты во время
// перетаскивания, НЕ решение о переходе (переход по факту безопасно
// no-op на границе, media-machine.js уже это гарантирует).
export function elasticDx(dx, atEdge) {
	return atEdge ? dx * EDGE_RESISTANCE : dx;
}

// Решение по отпусканию при горизонтальной оси: "prev" | "next" | null.
// widthPx <= 0 не может дать committed-жест (защита от деления на 0).
export function horizontalCommit(dx, widthPx) {
	if (!(widthPx > 0)) return null;
	if (Math.abs(dx) / widthPx < HORIZONTAL_COMMIT_RATIO) return null;
	return dx < 0 ? "next" : "prev";
}

// Живая величина --media-pull во время вертикального жеста. Свайп вверх
// не задействован (§3.2) — отрицательные dy прижимаются к 0.
export function verticalPull(dy) {
	return Math.min(1, Math.max(0, dy) / VERTICAL_PULL_RANGE_PX);
}

// Решение по отпусканию при вертикальной оси.
export function verticalCommit(dy) {
	return dy > VERTICAL_COMMIT_PX;
}
