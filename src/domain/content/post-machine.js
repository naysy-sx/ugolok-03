import { transition } from "../../core/fsm/machine.js";

// TECH.md §9.2 / DESIGN.md "Этап 31" — буквально 3 состояния, никаких добавлений.
// draft НИКОГДА не публикуется (см. post.js) — переход существует только локально.
export const POST_TRANSITIONS = {
	draft: { PUBLISH: "published" },
	published: { ARCHIVE: "archived", UNPUBLISH: "draft" },
};

export function transitionPost(state, event) {
	return transition(POST_TRANSITIONS, state, event);
}
