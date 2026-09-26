import { useRef, useState, useEffect, useCallback } from "preact/hooks";
import {
	BUTTON_STEP,
	DOUBLE_TAP_SCALE,
	SNAP_BACK_SCALE,
	clampState,
	distance,
	isZoomed,
	midpoint,
	zoomAbout,
} from "../../domain/media/zoom-math.js";

const TAP_MAX_MS = 280;
const TAP_MAX_MOVE_PX = 10;
const DOUBLE_TAP_GAP_MS = 320;
const DOUBLE_TAP_MAX_DIST_PX = 40;
const ANIM_MS = 200;

const IDENTITY = { scale: 1, tx: 0, ty: 0 };

// Зум и перемещение картинки в полноэкранном просмотрщике: щипок двумя пальцами, колесо/трекпад,
// двойной тап/клик, кнопки. Состояние держится в ref и пишется прямо в style.transform целевой
// картинки — на каждое движение пальца перерисовывать компонент незачем. Рендер запрашивается только
// при смене «увеличено или нет» и по окончании жеста (чтобы кнопки знали, доступен ли зум).
//
// Обработчики pointer* вызываются ИЗ media-overlay.jsx до его собственного жеста листания:
// pointerDown вернёт «pinch»/«pan», если жест теперь принадлежит зуму (листание и закрытие
// свайпом в это время не работают), и null, если картинка не увеличена и жест — обычный свайп.
export function useImageZoom({ active, viewportRef, resetKey }) {
	const elRef = useRef(null);
	const state = useRef(IDENTITY);
	const pointers = useRef(new Map()); // pointerId -> {x, y, startX, startY, startT}
	const gesture = useRef(null); // {type:"pinch", startDist, startState} | {type:"pan", id, lastX, lastY} | null
	const lastTap = useRef({ t: 0, x: 0, y: 0 });
	const animTimer = useRef(null);
	const [ui, setUi] = useState(IDENTITY.scale);

	// Ref-функция для <img> текущего слайда. Сменилась картинка (другой слайд стал текущим) —
	// старой возвращаем нормальный вид, иначе она осталась бы увеличенной в соседнем слайде.
	const targetRef = useCallback((el) => {
		if (elRef.current && elRef.current !== el) {
			elRef.current.style.transform = "";
			elRef.current.classList.remove("is-zoom-anim");
		}
		elRef.current = el;
	}, []);

	function geometry() {
		const el = elRef.current;
		const viewportEl = viewportRef.current;
		if (!el || !viewportEl) return null;
		// Картинка стоит по центру слайда (flex), а слайд трансформом картинки не двигается: центр базы
		// берём у слайда, размер — у самой картинки (offsetWidth не зависит от transform).
		const slide = el.parentElement.getBoundingClientRect();
		const vp = viewportEl.getBoundingClientRect();
		return {
			base: { cx: slide.left + slide.width / 2, cy: slide.top + slide.height / 2, w: el.offsetWidth, h: el.offsetHeight },
			viewport: { left: vp.left, top: vp.top, width: vp.width, height: vp.height },
		};
	}

	// commit:false — движение пальцев: DOM обновляем каждый кадр, а состояние для кнопок
	// (setUi) — только когда картинка перешла между «обычной» и «увеличенной».
	function apply(next, { animate = false, commit = true } = {}) {
		const el = elRef.current;
		const crossing = isZoomed(state.current.scale) !== isZoomed(next.scale);
		state.current = next;
		if (el) {
			if (animate) {
				el.classList.add("is-zoom-anim");
				clearTimeout(animTimer.current);
				animTimer.current = setTimeout(() => el.classList.remove("is-zoom-anim"), ANIM_MS + 40);
			}
			el.style.transform = isZoomed(next.scale) || next.tx !== 0 || next.ty !== 0 ? `translate(${next.tx}px, ${next.ty}px) scale(${next.scale})` : "";
		}
		if (commit || crossing) setUi(next.scale);
	}

	function zoomTo(scale, px, py, opts) {
		const g = geometry();
		if (!g) return;
		apply(zoomAbout(state.current, scale, px, py, g.base, g.viewport), opts);
	}

	function centerOfViewport() {
		const vp = viewportRef.current?.getBoundingClientRect();
		return vp ? { x: vp.left + vp.width / 2, y: vp.top + vp.height / 2 } : { x: 0, y: 0 };
	}

	function reset(opts) {
		gesture.current = null;
		pointers.current.clear();
		apply(IDENTITY, opts);
	}

	// Смена картинки или выход из режима — вернуть обычный вид.
	useEffect(() => {
		reset();
	}, [resetKey, active]);

	// Поворот экрана/изменение окна меняют геометрию — проще вернуть обычный вид.
	useEffect(() => {
		if (!active) return;
		const onResize = () => reset();
		window.addEventListener("resize", onResize);
		return () => window.removeEventListener("resize", onResize);
	}, [active]);

	// Колесо мыши и щипок на трекпаде (ctrlKey) — зум к курсору. Слушатель не passive:
	// иначе preventDefault не удержит страницу от прокрутки/масштабирования.
	useEffect(() => {
		const viewportEl = viewportRef.current;
		if (!active || !viewportEl) return;
		function onWheel(e) {
			e.preventDefault();
			const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015));
			zoomTo(state.current.scale * factor, e.clientX, e.clientY);
		}
		viewportEl.addEventListener("wheel", onWheel, { passive: false });
		return () => viewportEl.removeEventListener("wheel", onWheel);
	}, [active]);

	function startPinch() {
		const pts = [...pointers.current.values()];
		gesture.current = { type: "pinch", startDist: Math.max(1, distance(pts[0], pts[1])), startState: state.current, startMid: midpoint(pts[0], pts[1]) };
	}

	function pointerDown(e) {
		if (!active) return null;
		pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY, startX: e.clientX, startY: e.clientY, startT: performance.now() });
		if (pointers.current.size >= 2) {
			startPinch();
			return "pinch";
		}
		if (isZoomed(state.current.scale)) {
			gesture.current = { type: "pan", id: e.pointerId, lastX: e.clientX, lastY: e.clientY };
			return "pan";
		}
		return null;
	}

	// true — движение принадлежит зуму, листание его не получает.
	function pointerMove(e) {
		const p = pointers.current.get(e.pointerId);
		if (!p) return false;
		p.x = e.clientX;
		p.y = e.clientY;
		const g = gesture.current;
		if (!g) return false;
		const geo = geometry();
		if (!geo) return true;
		if (g.type === "pinch") {
			const pts = [...pointers.current.values()];
			if (pts.length < 2) return true;
			const mid = midpoint(pts[0], pts[1]);
			const scale = g.startState.scale * (distance(pts[0], pts[1]) / g.startDist);
			// щипок вокруг текущей середины + сдвиг середины пальцами (перемещение двумя пальцами)
			const zoomed = zoomAbout(g.startState, scale, g.startMid.x, g.startMid.y, geo.base, geo.viewport);
			apply(clampState({ ...zoomed, tx: zoomed.tx + (mid.x - g.startMid.x), ty: zoomed.ty + (mid.y - g.startMid.y) }, geo.base, geo.viewport), { commit: false });
			return true;
		}
		if (g.type === "pan" && e.pointerId === g.id) {
			const s = state.current;
			apply(clampState({ scale: s.scale, tx: s.tx + (e.clientX - g.lastX), ty: s.ty + (e.clientY - g.lastY) }, geo.base, geo.viewport), { commit: false });
			g.lastX = e.clientX;
			g.lastY = e.clientY;
			return true;
		}
		return false;
	}

	// true — палец был частью щипка/перемещения зума. Двойной тап переключает масштаб как побочный
	// эффект и возвращает false: автомат листания должен получить свой pointerup и отпустить жест.
	function pointerUp(e) {
		const p = pointers.current.get(e.pointerId);
		if (!p) return false;
		pointers.current.delete(e.pointerId);
		const g = gesture.current;
		if (g?.type === "pinch") {
			const rest = [...pointers.current.entries()];
			if (rest.length >= 2) {
				startPinch();
			} else if (rest.length === 1 && state.current.scale >= SNAP_BACK_SCALE) {
				// один палец остался — продолжаем как перемещение
				gesture.current = { type: "pan", id: rest[0][0], lastX: rest[0][1].x, lastY: rest[0][1].y };
			} else {
				gesture.current = null;
				if (state.current.scale < SNAP_BACK_SCALE) apply(IDENTITY, { animate: true });
				else setUi(state.current.scale);
			}
			return true;
		}
		if (g?.type === "pan" && g.id === e.pointerId) {
			gesture.current = null;
			return true;
		}
		// обычный тап без движения — кандидат в двойной тап
		const now = performance.now();
		const moved = Math.hypot(e.clientX - p.startX, e.clientY - p.startY);
		if (moved <= TAP_MAX_MOVE_PX && now - p.startT <= TAP_MAX_MS) {
			const prev = lastTap.current;
			if (now - prev.t <= DOUBLE_TAP_GAP_MS && Math.hypot(e.clientX - prev.x, e.clientY - prev.y) <= DOUBLE_TAP_MAX_DIST_PX) {
				lastTap.current = { t: 0, x: 0, y: 0 };
				toggleAt(e.clientX, e.clientY);
			} else {
				lastTap.current = { t: now, x: e.clientX, y: e.clientY };
			}
		}
		return false;
	}

	function pointerCancel(e) {
		const had = pointers.current.delete(e.pointerId);
		if (had && gesture.current) {
			if (gesture.current.type === "pinch" && pointers.current.size >= 2) startPinch();
			else gesture.current = null;
		}
		return had;
	}

	// Двойной тап/клик: из обычного вида — крупнее к точке, из увеличенного — обратно.
	function toggleAt(x, y) {
		if (isZoomed(state.current.scale)) apply(IDENTITY, { animate: true });
		else zoomTo(DOUBLE_TAP_SCALE, x, y, { animate: true });
	}

	function zoomIn() {
		const c = centerOfViewport();
		zoomTo(state.current.scale * BUTTON_STEP, c.x, c.y, { animate: true });
	}

	function zoomOut() {
		const c = centerOfViewport();
		const next = state.current.scale / BUTTON_STEP;
		if (next < SNAP_BACK_SCALE) apply(IDENTITY, { animate: true });
		else zoomTo(next, c.x, c.y, { animate: true });
	}

	return {
		targetRef,
		scale: ui,
		zoomed: isZoomed(ui),
		pointerDown,
		pointerMove,
		pointerUp,
		pointerCancel,
		zoomIn,
		zoomOut,
		reset: () => apply(IDENTITY, { animate: true }),
		toggleAt,
	};
}
