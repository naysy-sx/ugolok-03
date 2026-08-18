// MEDIA-OVERLAY-UI-2.md, этап 7 (DESIGN.md "этап 7 — автомат жеста") —
// конечный автомат Мура (δ + λ) для pointer-жеста просмотрщика. Чистый,
// без DOM — тот же класс модуля, что media-machine.js. Математика самого
// жеста (пороги, resistance) НЕ здесь и не дублируется — переиспользует
// swipe-gesture.js как единственный источник констант/формул (spec §7.4:
// "математика жеста остаётся как есть").
//
// И-G ("единственный писатель"): этот модуль НЕ пишет DOM. Классы/стили
// применяет ровно одна функция во view-слое (media-overlay.jsx) по
// результату gestureOutput().
// И-H ("доводка идентифицируется поколением"): gen инкрементируется
// ТОЛЬКО на входе в SETTLING; settleEnd с чужим gen, пока состояние ещё
// формально SETTLING, — игнорируется (защита от опоздавшего фолбэка
// прошлой доводки). Во всех остальных состояниях settleEnd игнорируется
// безусловно — сам факт "мы уже не в SETTLING" достаточен.
import { resolveAxis, horizontalCommit, verticalCommit, verticalPull } from "./swipe-gesture.js";

export const GESTURE_STATES = ["IDLE", "PRESSED", "DRAG_H", "DRAG_V", "SETTLING"];
export const GESTURE_EVENTS = ["down", "move", "up", "cancel", "settleEnd"];

export const IDLE_STATE = { name: "IDLE", axis: null, dx: 0, dy: 0, dir: null, gen: 0 };

function freshPress(state) {
	return { name: "PRESSED", axis: null, dx: 0, dy: 0, dir: null, gen: state.gen };
}

// Коммит по горизонтали + edge-clamp (на краю плейлиста коммит гасится в
// null — mediaNext/Prev там и так no-op в media-machine.js, но без гашения
// лента доезжала бы до полной ширины и на кадр показывала пустой соседний
// слайд перед откатом; этот фикс раньше жил в handleGesturePointerUp,
// теперь часть самого δ).
function resolveHorizontalDir(dx, payload) {
	const { widthPx = 0, rank, total } = payload ?? {};
	let dir = horizontalCommit(dx, widthPx);
	if (dir === "prev" && rank === 0) dir = null;
	if (dir === "next" && rank === total - 1) dir = null;
	return dir;
}

const HANDLERS = {
	IDLE: {
		down: (state) => freshPress(state),
	},
	PRESSED: {
		move: (state, payload) => {
			const { dx, dy } = payload;
			const axis = resolveAxis(dx, dy);
			if (axis === null) return { ...state, dx, dy };
			return { ...state, name: axis === "horizontal" ? "DRAG_H" : "DRAG_V", axis, dx, dy };
		},
		up: (state) => ({ ...IDLE_STATE, gen: state.gen }),
		cancel: (state) => ({ ...IDLE_STATE, gen: state.gen }),
	},
	DRAG_H: {
		move: (state, payload) => ({ ...state, dx: payload.dx, dy: payload.dy }),
		up: (state, payload) => ({
			name: "SETTLING",
			axis: "horizontal",
			dx: state.dx,
			dy: state.dy,
			dir: resolveHorizontalDir(state.dx, payload),
			gen: state.gen + 1,
		}),
		cancel: (state) => ({ ...state, name: "SETTLING", dir: null, gen: state.gen + 1 }),
	},
	DRAG_V: {
		move: (state, payload) => ({ ...state, dx: payload.dx, dy: payload.dy }),
		// Коммит-закрытие — императивное действие (closeMedia), не забота δ.
		// Вызывающая сторона сама пересчитывает verticalCommit(prev.dy) на
		// границе DRAG_V->IDLE через "up" (см. DESIGN.md, п.4 диспетчера) —
		// здесь автомат просто уходит в IDLE безусловно, тем же путём, что и
		// пружинка (никакого нового состояния под "закрывается" заводить
		// не нужно, sessions closeMedia() всё равно обнуляет всю сессию).
		up: (state) => ({ ...IDLE_STATE, gen: state.gen }),
		cancel: (state) => ({ ...IDLE_STATE, gen: state.gen }),
	},
	SETTLING: {
		// "Завершить доводку немедленно" — под down/cancel это ОДНО и то же
		// присваивание целевого состояния; собственно "применить позицию"
		// (mediaNext/Prev) — забота диспетчера view-слоя, читающего prev.dir
		// на этой же границе перехода (DESIGN.md, п.3).
		down: (state) => freshPress(state),
		cancel: (state) => ({ ...IDLE_STATE, gen: state.gen }),
		settleEnd: (state, payload) => {
			if (payload?.gen !== state.gen) return state; // чужая (более старая) доводка — игнор
			return { ...IDLE_STATE, gen: state.gen };
		},
	},
};

export function gestureTransition(state, event, payload) {
	const handler = HANDLERS[state.name]?.[event];
	if (!handler) return state; // "игнор" — явный тотальный путь, не throw/undefined
	return handler(state, payload);
}

export function gestureOutput(state) {
	switch (state.name) {
		case "DRAG_H":
			return { dragging: true, settling: false, dragPx: state.dx, pull: 0 };
		case "DRAG_V":
			return { dragging: false, settling: false, dragPx: 0, pull: verticalPull(state.dy) };
		case "SETTLING":
			return {
				dragging: false,
				settling: true,
				dragPx: state.dir === "next" ? -1 : state.dir === "prev" ? 1 : 0,
				pull: 0,
			};
		case "PRESSED":
			return { dragging: true, settling: false, dragPx: 0, pull: 0 };
		default: // IDLE
			return { dragging: false, settling: false, dragPx: 0, pull: 0 };
	}
}
