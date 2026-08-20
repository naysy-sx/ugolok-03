// Медиа-подсистема, этап D (MEDIA-SPEC.md §3.5) — единственный владелец
// сессии просмотра. Автомат (transition/allocWindow) построен и
// исчерпывающе проверен этапом A — этот модуль ТОЛЬКО собирает его в
// сигнал, синхронизирует владение ресурсами и слушает звонок.
import { signal, effect } from "@preact/signals";
import { transition, allocWindow } from "../../domain/media/media-machine.js";
import { buildPlaylist } from "../../domain/media/playlist.js";
import { classOf } from "../../domain/media/media-ref.js";
import { createResourceOwner } from "../../domain/media/adapters/resource-owner.js";
import { acquireMediaUrl, releaseMediaUrlHandle } from "../../domain/media/adapters/media-url.js";
import { callState } from "./call.js";
import { BUILD_DEFAULT_BLOSSOM_SERVERS } from "../../config.js";

// Продуктовое решение PM (в MEDIA-MATH/ALGO/SPEC числа нет — тот же класс
// решения, что MAX_ATTACHMENTS_PER_MESSAGE на этапе B4): окно эагерной
// подгрузки соседних изображений при просмотре, не влияет на video/audio
// (там allocWindow всегда отдаёт ровно текущий digest, budgetBytes не
// используется в этой ветке media-machine.js).
const MEDIA_WINDOW_BUDGET_BYTES = 16 * 1024 * 1024;
const BLOSSOM_SERVER_URL = BUILD_DEFAULT_BLOSSOM_SERVERS[0];

export const mediaSession = signal(null); // MediaState & {playlist} | null

let playlistRef = null; // снимок вне сигнала (SPEC §3.3 — "копируется при открытии")

// MEDIA-OVERLAY-UI-2.md, этап 10 (§10.1) — repeat/autoplay обязаны
// пережить закрытие сессии (mediaSession между сессиями null), поэтому
// живут ЗДЕСЬ, обычными переменными модуля + localStorage, а не в
// кортеже состояния автомата напрямую. δ (media-machine.js) их не читает
// ниоткуда, кроме payload события "open" — это и есть та развязка,
// которая оставляет δ чистой и тестируемой node --test без DOM/storage.
const MEDIA_PREFS_KEY = "ugolok.media.prefs";

function loadMediaPrefs() {
	try {
		const raw = localStorage.getItem(MEDIA_PREFS_KEY);
		if (!raw) return { repeat: "off", autoplay: true };
		const parsed = JSON.parse(raw);
		return {
			repeat: ["off", "all", "one"].includes(parsed.repeat) ? parsed.repeat : "off",
			autoplay: parsed.autoplay !== false,
		};
	} catch {
		return { repeat: "off", autoplay: true };
	}
}

function saveMediaPrefs(prefs) {
	try {
		localStorage.setItem(MEDIA_PREFS_KEY, JSON.stringify(prefs));
	} catch {
		// приватный режим/квота — не критично, значения остаются в памяти вкладки
	}
}

let mediaPrefs = loadMediaPrefs();

const resourceOwner = createResourceOwner({
	// .catch — resourceOwner сам не интересуется результатом (лайфсайкл,
	// не показ); ошибку показывает view-компонент, вызвав acquireMediaUrl
	// ЕЩЁ РАЗ САМ (мемоизация — тот же promise, свой .catch на своей стороне).
	acquire: (ref) => {
		acquireMediaUrl(ref, { serverUrl: BLOSSOM_SERVER_URL }).catch(() => {});
	},
	release: (digest) => {
		releaseMediaUrlHandle(digest).catch(() => {});
	},
});

function dispatch(event, payload) {
	// mediaSession.value уже несёт playlist (см. присваивание ниже) — transition()
	// его не читает (только cls/position/display/play/callActive), спреды в
	// media-machine.js его молча протаскивают, мы его тут же перезатираем тем
	// же playlistRef — лишний strip перед вызовом не нужен.
	const next = transition(mediaSession.value, event, payload, playlistRef);
	mediaSession.value = next && { ...next, playlist: playlistRef };

	const desiredDigests = next ? allocWindow(next, playlistRef, MEDIA_WINDOW_BUDGET_BYTES) : [];
	resourceOwner.sync(desiredDigests, playlistRef ?? { items: [] });

	if (next === null) playlistRef = null; // ключи файлов не переживают закрытие сессии (SPEC §3.5)
}

export function openMedia({ refs, position, dedupe }) {
	playlistRef = buildPlaylist(refs, dedupe ? { dedupeClasses: dedupe } : undefined);
	dispatch("open", { cls: classOf(playlistRef.items[position].mime), position, repeat: mediaPrefs.repeat, autoplay: mediaPrefs.autoplay });
}

// MEDIA-OVERLAY-UI.md, этап 4 — прыжок на произвольную позицию плёнкой
// миниатюр. Сессия уже открыта — НЕ openMedia (та пересобрала бы
// playlistRef заново через buildPlaylist, лишняя работа и семантически
// неверно, это тот же плейлист). Переиспользует событие "open" —
// media-machine.js уже умеет ставить произвольную позицию, новый
// обработчик в автомат не добавляется (spec явно это оговаривает).
//
// Этап 10 — repeat/autoplay из mediaPrefs, НЕ из старого mediaSession.value:
// та же "open" ветка δ иначе молча сбросила бы режим повтора на каждый клик
// по миниатюре плёнки (doOpen всегда берёт payload.repeat/autoplay, не
// наследует их от прежнего state — намеренно, "open — это СБРОС, не стек").
export function mediaGoTo(position) {
	dispatch("open", { cls: classOf(playlistRef.items[position].mime), position, repeat: mediaPrefs.repeat, autoplay: mediaPrefs.autoplay });
}

export function mediaNext() {
	dispatch("next", null);
}

export function mediaPrev() {
	dispatch("prev", null);
}

export function mediaToggle() {
	dispatch("toggle", null);
}

// Найдено при сборке D3 (не в исходном списке экспортов SPEC §3.5) —
// <video onEnded>/<audio onEnded> обязаны дойти до автомата (doEnded в
// media-machine.js уже умеет "следующий трек своего класса, иначе пауза"),
// без этого экспорта событию EVENTS.ended неоткуда было бы прийти.
export function mediaEnded() {
	dispatch("ended", null);
}

export function mediaSeek(t) {
	dispatch("seek", { t });
}

// Этап 10 — пишут И в состояние (через δ, для текущей сессии), И в
// mediaPrefs/localStorage (переживает закрытие/новое открытие).
export function setRepeat(mode) {
	if (!["off", "all", "one"].includes(mode)) return;
	mediaPrefs = { ...mediaPrefs, repeat: mode };
	saveMediaPrefs(mediaPrefs);
	dispatch("setRepeat", { mode });
}

export function setAutoplay(value) {
	const v = value === true;
	mediaPrefs = { ...mediaPrefs, autoplay: v };
	saveMediaPrefs(mediaPrefs);
	dispatch("setAutoplay", { value: v });
}

export function mediaMinimize() {
	dispatch("minimize", null);
}

export function mediaRestore() {
	dispatch("restore", null);
}

export function closeMedia() {
	dispatch("close", null);
}

// Подписка на callState — НОВЫЙ для проекта паттерн (effect() вне
// компонента, DESIGN.md "Этап D"). Edge-detection: callStart/callEnd
// уходят в автомат ТОЛЬКО на границе неактивен<->активен, не на каждый
// внутренний переход FSM звонка (OUTGOING_RINGING->CONNECTING->CONNECTED
// не должны дать три callStart).
let wasCallActive = false;
effect(() => {
	const active = callState.value.name !== "IDLE" && callState.value.name !== "ENDED";
	if (active !== wasCallActive) {
		dispatch(active ? "callStart" : "callEnd", null);
		wasCallActive = active;
	}
});
