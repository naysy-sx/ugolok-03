import { stepInClass, windowByBudget } from "./playlist.js";

export const EVENTS = [
	"open",
	"next",
	"prev",
	"toggle",
	"minimize",
	"restore",
	"close",
	"callStart",
	"callEnd",
	"ended",
	"seek",
];

function doOpen(state, payload) {
	const callActive = state?.callActive ?? false;
	const play = callActive ? "suspended" : "playing";
	return { cls: payload.cls, position: payload.position, display: "full", play, callActive };
}

function doNext(state, payload, playlist) {
	if (state === null) return state;
	const p = stepInClass(playlist, state.position, +1);
	if (p === -1) return state;
	return { ...state, position: p };
}

function doPrev(state, payload, playlist) {
	if (state === null) return state;
	const p = stepInClass(playlist, state.position, -1);
	if (p === -1) return state;
	return { ...state, position: p };
}

function doToggle(state) {
	if (state === null) return state;
	if (state.callActive) return state;
	if (state.cls === "image") return state;
	return { ...state, play: state.play === "playing" ? "paused" : "playing" };
}

function doMinimize(state) {
	if (state === null) return state;
	if (state.cls === "image") return state;
	return { ...state, display: "mini" };
}

function doRestore(state) {
	if (state === null) return state;
	return { ...state, display: "full" };
}

function doClose() {
	return null;
}

function doCallStart(state) {
	if (state === null) return state;
	const play = state.play === "playing" ? "suspended" : state.play;
	return { ...state, play, callActive: true };
}

function doCallEnd(state) {
	if (state === null) return state;
	const play = state.play === "suspended" ? "paused" : state.play;
	return { ...state, play, callActive: false };
}

function doEnded(state, payload, playlist) {
	if (state === null) return state;
	if (state.cls === "image") return state;
	if (state.callActive) return state;
	const p = stepInClass(playlist, state.position, +1);
	if (p === -1) return { ...state, play: "paused" };
	return { ...state, position: p, play: "playing" };
}

function doSeek(state) {
	return state;
}

const HANDLERS = {
	open: doOpen,
	next: doNext,
	prev: doPrev,
	toggle: doToggle,
	minimize: doMinimize,
	restore: doRestore,
	close: doClose,
	callStart: doCallStart,
	callEnd: doCallEnd,
	ended: doEnded,
	seek: doSeek,
};

export function transition(state, event, payload, playlist) {
	const handler = HANDLERS[event];
	if (!handler) return state;
	return handler(state, payload, playlist);
}

export function allocWindow(state, playlist, budgetBytes) {
	if (state === null) return [];
	if (state.cls !== "image") {
		return [playlist.items[state.position].digest];
	}
	const { l, r } = windowByBudget(playlist, state.position, budgetBytes, 3);
	const digests = [];
	for (let j = l; j < r; j++) digests.push(playlist.items[j].digest);
	return digests;
}
