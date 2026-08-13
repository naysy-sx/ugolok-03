// Rooms, этап 1 — автомат жизненного цикла комнаты. Контракт:
// PROCESS-DOCS/CONTRACTS.md "Rooms — Этап 1" (room-machine.js);
// формализация: ROOMS-MATH-v2.md §5.1.
//
// Поверх core/fsm/machine.js's transition() — чистая функция ИМЯ-состояния ->
// ИМЯ-состояния, без данных. Данные (k, drainedAt) ведёт этот модуль отдельно.
import { transition } from "../../core/fsm/machine.js";

const TRANSITIONS = {
	empty: { CREATE: "alive" },
	alive: { JOIN: "alive", LEAVE: "alive", LEAVE_LAST: "draining" },
	draining: { JOIN: "alive", TIMEOUT: "dead" },
	dead: {},
};

export function emptyRoomState() {
	return { name: "empty", k: 0 };
}

export function create(state) {
	const name = transition(TRANSITIONS, state.name, "CREATE");
	return { name, k: 1 };
}

export function join(state) {
	const name = transition(TRANSITIONS, state.name, "JOIN");
	return { name, k: state.k + 1 };
}

export function leave(state, now) {
	if (state.k > 1) {
		const name = transition(TRANSITIONS, state.name, "LEAVE");
		return { name, k: state.k - 1 };
	}
	const name = transition(TRANSITIONS, state.name, "LEAVE_LAST");
	return { name, k: 0, drainedAt: now };
}

export function checkTimeout(state, now, tau) {
	if (state.name !== "draining") return state;
	if (now - state.drainedAt >= tau) {
		const name = transition(TRANSITIONS, state.name, "TIMEOUT");
		return { name, k: 0 };
	}
	return state;
}
