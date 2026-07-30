import { transition } from "../../core/fsm/machine.js";

// TECH.md §9.4 / DESIGN.md "Этап 28" — ровно 5 переходов, буквально как в спецификации.
// encrypting+ERROR намеренно НЕ определён (см. DESIGN.md) — FSM не покрывает путь,
// которого нет в TECH.md, вызывающий код ловит исключение шифрования сам.
export const TRANSFER_TRANSITIONS = {
	idle: { START: "encrypting" },
	encrypting: { ENCRYPTED: "uploading" },
	uploading: { UPLOADED: "completed", ERROR: "failed" },
	failed: { RETRY: "encrypting" },
};

export function transitionTransfer(state, event) {
	return transition(TRANSFER_TRANSITIONS, state, event);
}
