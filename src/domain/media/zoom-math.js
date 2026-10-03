// Математика зума картинки в полноэкранном просмотрщике. Чистые функции без DOM:
// координаты — экранные (clientX/clientY), состояние — {scale, tx, ty}, где картинка
// рисуется как translate(tx, ty) scale(scale) вокруг СВОЕГО центра. «База» — то, где
// картинка стояла бы без зума: центр (cx, cy) и размер (w, h) в экранных пикселях.

export const MIN_SCALE = 1;
export const MAX_SCALE = 5;
export const BUTTON_STEP = 1.5; // во сколько раз меняет масштаб кнопка «+»/«−»
export const DOUBLE_TAP_SCALE = 2.5;
// Ниже этого масштаба после щипка считаем, что человек вернулся к обычному виду.
export const SNAP_BACK_SCALE = 1.05;

export function clampScale(scale) {
	if (!Number.isFinite(scale)) return MIN_SCALE;
	return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

// Смещение по одной оси так, чтобы картинка не уезжала от краёв окна просмотра дальше
// необходимого. Если она (в масштабе) не больше окна — стоит по центру (смещение 0).
export function clampAxis(t, baseCenter, scaledSize, viewportStart, viewportSize) {
	if (scaledSize <= viewportSize) return 0;
	const hi = viewportStart - baseCenter + scaledSize / 2;
	const lo = viewportStart + viewportSize - baseCenter - scaledSize / 2;
	return Math.min(hi, Math.max(lo, t));
}

export function clampState(state, base, viewport) {
	const scale = clampScale(state.scale);
	return {
		scale,
		tx: clampAxis(state.tx, base.cx, base.w * scale, viewport.left, viewport.width),
		ty: clampAxis(state.ty, base.cy, base.h * scale, viewport.top, viewport.height),
	};
}

// Новый масштаб так, чтобы точка (px, py) экрана осталась под пальцем/курсором.
export function zoomAbout(state, newScale, px, py, base, viewport) {
	const scale = clampScale(newScale);
	const ratio = scale / state.scale;
	const ux = px - base.cx;
	const uy = py - base.cy;
	return clampState({ scale, tx: ux - ratio * (ux - state.tx), ty: uy - ratio * (uy - state.ty) }, base, viewport);
}

export function distance(a, b) {
	return Math.hypot(a.x - b.x, a.y - b.y);
}

export function midpoint(a, b) {
	return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

export function isZoomed(scale) {
	return scale > MIN_SCALE + 0.001;
}
