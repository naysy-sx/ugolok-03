export function computeMenuPopPosition(trigger, pop, viewport, opts = {}) {
	const { gap = 4, align = "end" } = opts;
	let top, left;

	const spaceBelow = viewport.height - trigger.bottom - gap;
	const spaceAbove = trigger.top - gap;

	if (pop.height <= spaceBelow) {
		top = trigger.bottom + gap;
	} else if (pop.height <= spaceAbove) {
		top = trigger.top - gap - pop.height;
	} else if (spaceBelow > spaceAbove) {
		top = trigger.bottom + gap;
	} else {
		top = trigger.top - gap - pop.height;
	}

	top = Math.min(Math.max(top, gap), viewport.height - pop.height - gap);
	if (pop.height > viewport.height - 2 * gap) {
		top = gap;
	}

	if (align === "start") {
		left = trigger.left;
	} else {
		left = trigger.right - pop.width;
	}

	left = Math.min(Math.max(left, gap), viewport.width - pop.width - gap);
	if (pop.width > viewport.width - 2 * gap) {
		left = gap;
	}

	return { top, left };
}
