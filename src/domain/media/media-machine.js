import { stepInClass, stepInClassRing, firstOfClass, windowByBudget } from "./playlist.js";

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
	"setRepeat",
	"setAutoplay",
];

// Этап 10 (MEDIA-OVERLAY-UI-2.md §10.1) — repeat/autoplay компоненты
// кортежа состояния (И-J), но переживают закрытие сессии (state===null
// сбрасывает ВСЁ) — значения приходят СНАРУЖИ через payload (сохранены в
// signals/media.js в localStorage), δ их не читает ниоткуда, кроме payload.
function doOpen(state, payload) {
	const callActive = state?.callActive ?? false;
	const repeat = payload.repeat ?? "off";
	const autoplay = payload.autoplay ?? true;
	const play = callActive ? "suspended" : autoplay ? "playing" : "paused";
	return { cls: payload.cls, position: payload.position, display: "full", play, callActive, repeat, autoplay };
}

function doNext(state, payload, playlist) {
	if (state === null) return state;
	const step = state.repeat === "all" ? stepInClassRing : stepInClass;
	const p = step(playlist, state.position, +1);
	if (p === -1) return state;
	return { ...state, position: p };
}

function doPrev(state, payload, playlist) {
	if (state === null) return state;
	const step = state.repeat === "all" ? stepInClassRing : stepInClass;
	const p = step(playlist, state.position, -1);
	if (p === -1) return state;
	return { ...state, position: p };
}

function doSetRepeat(state, payload) {
	if (state === null) return state;
	if (!["off", "all", "one"].includes(payload?.mode)) return state;
	return { ...state, repeat: payload.mode };
}

function doSetAutoplay(state, payload) {
	if (state === null) return state;
	return { ...state, autoplay: payload?.value === true };
}

// Редизайн интерфейса, этап 3 (DESIGN.md) — Static = {image, other}: нет
// play/pause/currentTime/duration, toggle/minimize/ended для них — no-op.
// Playable = {audio, video} — единственные классы, где эти события что-то
// значат. "other" (файлы) присоединяется к image, не заводит третью ветку.
function isStatic(cls) {
	return cls === "image" || cls === "other";
}

function doToggle(state) {
	if (state === null) return state;
	if (state.callActive) return state;
	if (isStatic(state.cls)) return state;
	return { ...state, play: state.play === "playing" ? "paused" : "playing" };
}

function doMinimize(state) {
	if (state === null) return state;
	if (isStatic(state.cls)) return state;
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

// Этап 10 (§10.2) — таблица repeat × {есть следующий | последний в классе}.
// repeat==="one" не двигает позицию вовсе (перемотку к нулю делает вид,
// см. media-overlay.jsx onEnded — И-D, δ не трогает currentTime).
function doEnded(state, payload, playlist) {
	if (state === null) return state;
	if (isStatic(state.cls)) return state;
	if (state.callActive) return state;
	if (state.repeat === "one") return { ...state, play: "playing" };
	const p = stepInClass(playlist, state.position, +1);
	if (p !== -1) return { ...state, position: p, play: "playing" };
	if (state.repeat === "all") {
		const first = firstOfClass(playlist, state.cls);
		if (first !== -1) return { ...state, position: first, play: "playing" };
	}
	return { ...state, play: "paused" };
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
	setRepeat: doSetRepeat,
	setAutoplay: doSetAutoplay,
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
