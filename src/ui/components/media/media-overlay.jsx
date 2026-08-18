import { useEffect, useRef, useState } from "preact/hooks";
import { mediaSession, mediaNext, mediaPrev, mediaGoTo, mediaToggle, mediaMinimize, mediaRestore, mediaEnded, closeMedia } from "../../signals/media.js";
import { stepInClass } from "../../../domain/media/playlist.js";
import { elasticDx, verticalCommit } from "../../../domain/media/swipe-gesture.js";
import { IDLE_STATE, gestureTransition, gestureOutput } from "../../../domain/media/gesture-machine.js";
import { consumeMediaOrigin } from "../../signals/media-origin.js";
import { getMemoryCachedUrl } from "../../attachment-memory-cache.js";
import VideoPlayer from "./video-player.jsx";
import AudioPlayer from "./audio-player.jsx";
import ImageViewer from "./image-viewer.jsx";
import IconMusicNote from "../../icons/music-note.jsx";
import IconCross from "../../icons/cross.jsx";
import IconNavPrev from "../../icons/nav-prev.jsx";
import IconNavNext from "../../icons/nav-next.jsx";
import IconMinimize from "../../icons/minimize.jsx";
import IconRestore from "../../icons/restore.jsx";
import IconInfoCircle from "../../icons/info-circle.jsx";
import IconPlayerPlay from "../../icons/player-play.jsx";
import IconPlayerPause from "../../icons/player-pause.jsx";
import { formatFileSize } from "../attachment-view.jsx";
import { t } from "../../signals/i18n.js";

const OPEN_ANIMATION_MS = 420;
const CLOSE_ANIMATION_MS = 200;
const WAAPI_EASE = "cubic-bezier(0.22, 0.61, 0.36, 1)"; // == --ease (minimal.css) — WAAPI не читает custom properties
const SWAP_FADE_FALLBACK_MS = 220; // подстраховка, если animationend не пришёл (Этап 3.1, audio/video)

function prefersReducedMotion() {
	return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

const VIEWS = { video: VideoPlayer, audio: AudioPlayer, image: ImageViewer };

function formatDuration(seconds) {
	const total = Math.round(seconds);
	const m = Math.floor(total / 60);
	const s = total % 60;
	return `${m}:${String(s).padStart(2, "0")}`;
}

function shortHash(digest) {
	return digest.length <= 10 ? digest : `${digest.slice(0, 4)}…${digest.slice(-4)}`;
}

// Корень медиа-сессии (Этап D) — единственное место, монтирующее один из
// трёх "глупых" видов по mediaSession.value.cls. Ничего не рендерит, если
// сессии нет (И3 — allocWindow тогда тоже пуст, здесь симметрично — нечего
// показывать).
//
// Довесок (найдено живой проверкой пользователя) — MEDIA-SPEC.md §7.5
// "свёрнутое аудио продолжает играть" на деле НЕ выполнялось: display==="mini"
// раньше монтировал ОТДЕЛЬНЫЙ компонент (media-mini-bar.jsx, ныне удалён) без
// единого <audio>/<video> внутри — переключение в mini размонтировало
// проигрыватель целиком, воспроизведение обрывалось. Теперь <View> — ОДНА
// точка в дереве, всегда смонтированная, пока сессия жива.
//
// Второй довесок (найдено живой проверкой ПОСЛЕ MEDIA-OVERLAY-UI.md этапа 1)
// — тот же баг вернулся в другом виде. Этап 1 развёл mini/full на ДВА
// ПОЛНОСТЬЮ РАЗНЫХ return: mini — div>div(preview)>View, full — div>[div
// (scrim), div(viewport)>div(inner)>View, header, nav×2?, footer]. У Preact
// нет "смены компонента" при переключении mini/full (тот же MediaOverlay),
// но diff идёт ПОЗИЦИОННО по детям: в full's дереве View лежит ВТОРЫМ
// ребёнком корня (после scrim), в mini's — ПЕРВЫМ. При сворачивании Preact
// сверяет позицию 1 (scrim, пусто) с позицией 1 (preview, содержит Icon?+
// View) — создаёт НОВЫЙ View там; и отдельно позицию 2 (viewport с
// НАСТОЯЩИМ играющим View) с позицией 2 (span.media-mini-bar-name,
// другой тег) — размонтирует НАСТОЯЩИЙ View целиком. Отсюда "музыка
// обрывается при сворачивании/разворачивании".
//
// Исправлено: ОДИН return, ОДНА пара обёрток вокруг <View> в ОБОИХ режимах
// (div.viewport-или-preview > div.inner-или-contents > [Icon?] + View) —
// всегда ПЕРВый ребёнок корня, всегда та же форма поддерева. Всё, что
// отличается между режимами (шапка/навигация/подвал vs имя+кнопки),
// стоит ПОСЛЕ этой пары — там смена тегов безопасна, там нет состояния,
// которое жалко потерять. .media-overlay-scrim перестала быть DOM-узлом
// (мешала быть "первым ребёнком" наравне с viewport) — стала ::before
// на корне (custom.css), тот же порядок покраски, что и раньше.
// IconMusicNote для audio теперь в DOM ВСЕГДА (при cls==="audio", не
// isMini&&cls==="audio") — иначе видимость иконки от isMini сдвигала бы
// индекс View внутри inner-обёртки ровно между mini и full ТОЛЬКО для
// аудио; видимость теперь через display:none в full-режиме, не через
// отсутствие в дереве.
//
// compact-проп у VideoPlayer/AudioPlayer убирает нативные controls (в
// mini свои кнопки) и переключает размер/видимость через CSS — сам
// элемент не пересоздаётся.
export default function MediaOverlay() {
	const session = mediaSession.value;
	const currentRef = session ? session.playlist.items[session.position] : null;

	// MEDIA-OVERLAY-UI.md, этап 2.1/2.2 — чистая эргономика показа, СЕССИЯ
	// (mediaSession/автомат) про неё не знает и не должна: chromeVisible,
	// infoPinned, meta (разрешение/длительность текущего файла) — локальное
	// состояние компонента.
	const [chromeVisible, setChromeVisible] = useState(true);
	const [infoPinned, setInfoPinned] = useState(false);
	const [meta, setMeta] = useState(null);
	// Этап 6 — время воспроизведения в свёрнутом мини-баре ("0:12 / 1:34").
	// Только там: в полном виде за это отвечают нативные controls (spec §6).
	const [miniTime, setMiniTime] = useState(0);
	const hideTimerRef = useRef(null);
	const infoPinnedRef = useRef(false);

	// MEDIA-OVERLAY-UI.md, этап 3 — refs жеста/анимации. Всё, что двигается на
	// каждый pointermove (--media-pull, --drag-px), пишется НАПРЯМУЮ в DOM
	// через эти refs, в обход Preact state — ре-рендер компонента на 60
	// событий/с не нужен и заметно лагал бы (см. CONTRACTS.md).
	const overlayRef = useRef(null);
	const viewportRef = useRef(null);
	const innerRef = useRef(null);
	const trackRef = useRef(null);
	const originRectRef = useRef(null); // rect источника открытия — для симметричного закрытия
	const prevSessionExistedRef = useRef(false);
	// MEDIA-OVERLAY-UI-2.md, этап 7 — состояние автомата жеста (Мура,
	// gesture-machine.js) живёт здесь, а не в useState: диспетчер читает и
	// пишет его синхронно НЕСКОЛЬКО раз за один pointer-эвент (см.
	// dispatchGesture ниже), лишний ре-рендер компонента на 60 событий/с не
	// нужен — то же обоснование, что у остальных gesture-ref'ов этого файла.
	const gestureStateRef = useRef(IDLE_STATE);
	// pointerId/стартовая точка — DOM-специфичная часть жеста, сознательно
	// ВНЕ чистого автомата (тот получает уже готовые dx/dy через payload).
	const pointerTrackRef = useRef(null); // {pointerId, startX, startY} | null
	const widthPxRef = useRef(0); // ширина .media-overlay-inner, измерена на "down"
	const didDragRef = useRef(false); // подавляет "случайный" click сразу после реального свайпа
	const activeThumbRef = useRef(null); // Этап 4 — активная миниатюра плёнки, для scrollIntoView

	useEffect(() => {
		infoPinnedRef.current = infoPinned;
	}, [infoPinned]);

	useEffect(() => {
		setMiniTime(0);
	}, [currentRef?.digest]);

	// Этап 4 — плёнка миниатюр докручивается к активному кадру на КАЖДУЮ
	// смену позиции (стрелки/клавиатура/клик по самой плёнке — DoD требует
	// явно только "при листании стрелками", но завязка на session?.position,
	// а не на источник перехода, покрывает это как частный случай, без
	// отдельного кода). ref привязан ТОЛЬКО к активной кнопке (условно в
	// JSX) — Preact сам переносит его при смене позиции. behavior не задан
	// явно ("smooth") — берёт scroll-behavior из CSS, тот уже глушится
	// глобально под prefers-reduced-motion (minimal.css), дублировать
	// JS-проверку незачем.
	useEffect(() => {
		activeThumbRef.current?.scrollIntoView({ block: "nearest", inline: "center" });
	}, [session?.position]);

	// §3.3 — анимация "разлёт из миниатюры". Зависимость [!!session], не
	// [session]: последний меняется на КАЖДЫЙ dispatch (next/prev/toggle/...),
	// а justOpened всё равно фильтрует по факту перехода null->not null —
	// булев тумблер просто не перезапускает эффект зря на каждую навигацию.
	useEffect(() => {
		const justOpened = !prevSessionExistedRef.current && !!session;
		prevSessionExistedRef.current = !!session;
		if (!justOpened || !session || session.display !== "full") return;
		const rect = consumeMediaOrigin();
		originRectRef.current = rect;
		const el = viewportRef.current;
		if (!rect || !el || prefersReducedMotion()) return;
		const target = el.getBoundingClientRect();
		const dx = rect.left + rect.width / 2 - (target.left + target.width / 2);
		const dy = rect.top + rect.height / 2 - (target.top + target.height / 2);
		el.animate(
			[
				{ transform: `translate(${dx}px, ${dy}px) scale(0.35)`, opacity: 0 },
				{ transform: "translate(0, 0) scale(1)", opacity: 1 },
			],
			{ duration: OPEN_ANIMATION_MS, easing: WAAPI_EASE },
		);
	}, [!!session]);

	// Закрытие — зеркально открытию (§3.3): WAAPI в обратную сторону к тому
	// же originRect, closeMedia() ТОЛЬКО после animation.finished (иначе
	// сессия уйдёт раньше кадра). Заменяет прямой closeMedia() на всех
	// click-путях закрытия (backdrop/кнопка/Escape) — НЕ на commit свайпа
	// вниз, тот уже отыграл сжатие в реальном времени через --media-pull.
	function handleClose() {
		const el = viewportRef.current;
		if (!el || prefersReducedMotion()) {
			closeMedia();
			return;
		}
		const rect = originRectRef.current;
		let keyframes;
		if (rect) {
			const target = el.getBoundingClientRect();
			const dx = rect.left + rect.width / 2 - (target.left + target.width / 2);
			const dy = rect.top + rect.height / 2 - (target.top + target.height / 2);
			keyframes = [
				{ transform: "translate(0, 0) scale(1)", opacity: 1 },
				{ transform: `translate(${dx}px, ${dy}px) scale(0.35)`, opacity: 0 },
			];
		} else {
			keyframes = [{ opacity: 1 }, { opacity: 0 }];
		}
		const animation = el.animate(keyframes, { duration: CLOSE_ANIMATION_MS, easing: WAAPI_EASE, fill: "forwards" });
		animation.finished.then(() => closeMedia()).catch(() => {});
	}

	// Клик сразу после отпускания реального свайпа (didDragRef) не должен
	// доходить ни до одной кнопки хрома. Причина шире, чем просто "закрытие
	// фоном": стрелки .media-overlay-nav стоят буквально у краёв экрана —
	// туда естественно попадает курсор МЫШИ в конце горизонтального свайпа
	// (в отличие от тача, у мыши :hover активен весь жест, кнопки не
	// невидимы). Синтетический click, который браузер шлёт СРАЗУ после
	// pointerup, бьёт по стрелке уже ПОСЛЕ обработки свайпа в
	// handleGesturePointerUp — лишний mediaNext/mediaPrev поверх уже
	// сделанного свайпом (найдено живой проверкой: "свайпнул — картинка то
	// откатывается назад, то снова уезжает" — ровно два разнонаправленных
	// или задвоенных перехода). Единая обёртка на ВСЕ кликабельные элементы
	// хрома (закрыть/свернуть/инфо/стрелки), не только на закрытие.
	function withDragGuard(fn) {
		return (e) => {
			if (didDragRef.current) {
				didDragRef.current = false;
				return;
			}
			fn(e);
		};
	}

	useEffect(() => {
		if (!session || session.display !== "full") return;
		function handleKeyDown(e) {
			if (e.key === "Escape") handleClose();
			else if (e.key === "ArrowLeft") mediaPrev();
			else if (e.key === "ArrowRight") mediaNext();
			else if (e.key === " ") {
				e.preventDefault(); // иначе прокрутка страницы под fixed-оверлеем
				mediaToggle();
			}
		}
		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [session?.display]);

	// MEDIA-OVERLAY-UI.md, этап 1.2 — во весь экран .top-corner-actions (тема/
	// бургер, z-index 300) стоит выше .media-overlay (190) и перекрывает его
	// шапку; поднимать сам оверлей нельзя (сознательно ниже .call-overlay,
	// 200), поэтому на время полноэкранного показа прячем шапку приложения
	// атрибутом на <html>, а не двигаем z-index.
	useEffect(() => {
		if (!session || session.display !== "full") return;
		document.documentElement.dataset.mediaFull = "1";
		return () => {
			delete document.documentElement.dataset.mediaFull;
		};
	}, [session?.display]);

	// Этап 2.1 — таймер прячет хром через 2800мс бездействия; пока панель
	// сведений закреплена (infoPinnedRef), срабатывание таймера НЕ прячет
	// (проверка на момент срабатывания, не на момент постановки — иначе
	// закрепление ПОСЛЕ уже идущего таймера не спасло бы от скрытия).
	useEffect(() => {
		if (!session || session.display !== "full") return;
		scheduleHide();
		return () => clearTimeout(hideTimerRef.current);
		function scheduleHide() {
			clearTimeout(hideTimerRef.current);
			hideTimerRef.current = setTimeout(() => {
				if (!infoPinnedRef.current) setChromeVisible(false);
			}, 2800);
		}
	}, [session?.display]);

	function handleChromeActivity() {
		setChromeVisible(true);
		clearTimeout(hideTimerRef.current);
		hideTimerRef.current = setTimeout(() => {
			if (!infoPinnedRef.current) setChromeVisible(false);
		}, 2800);
	}

	if (!session) return null;

	// НЕ называть переменную "ref" в JSX-атрибуте ниже — "ref" зарезервирован
	// Preact'ом для форвардинга ссылки на DOM-узел и НЕ доходит до компонента
	// как обычный проп (найдено живой проверкой: компонент получал undefined
	// молча, крах на первом же .digest). Проп называется mediaRef везде.
	const playing = session.play === "playing";
	const View = VIEWS[session.cls];
	const isMini = session.display === "mini";
	const canMinimize = session.cls !== "image"; // И5 — картинка не сворачивается
	const rank = session.playlist.rank[session.position];
	const total = session.playlist.idx[session.cls].length;

	const metaLine = `${t("media.player.trackOf", { current: rank + 1, total })} · ${t(`media.classNames.${session.cls}`)} · ${formatFileSize(currentRef.size)}`;
	// meta помечена digest'ом файла, для которого она пришла (см. onMeta ниже) —
	// сверка здесь, а не сброс через эффект после смены currentRef, потому что
	// эффект успевает выполниться только ПОСЛЕ первого рендера с новым digest:
	// окно в один кадр, где старые значения мелькнули бы рядом с новым файлом.
	const isCurrentMeta = meta?.digest === currentRef.digest;
	const hasResolution = isCurrentMeta && meta.width != null && meta.height != null;
	const hasDuration = isCurrentMeta && meta.duration != null && Number.isFinite(meta.duration);

	// §3.1, И-B — соседние позиции ТОЛЬКО для ленты изображений; stepInClass
	// (playlist.js), не allocWindow-бюджет из signals/media.js — окно жеста и
	// окно предзагрузки ресурсов не обязаны совпадать 1-в-1 (см. CONTRACTS.md).
	const leftPos = session.cls === "image" ? stepInClass(session.playlist, session.position, -1) : -1;
	const rightPos = session.cls === "image" ? stepInClass(session.playlist, session.position, +1) : -1;
	const leftRef = leftPos === -1 ? null : session.playlist.items[leftPos];
	const rightRef = rightPos === -1 ? null : session.playlist.items[rightPos];

	// MEDIA-OVERLAY-UI-2.md, этап 7 — автомат жеста (gesture-machine.js,
	// DESIGN.md "этап 7"). И-G: applyGestureOutput — ЕДИНСТВЕННАЯ функция,
	// пишущая classList/style на trackRef/overlayRef; ни pointerdown, ни
	// какой-либо другой обработчик классов больше не трогает.
	function playSwapFade() {
		const el = innerRef.current;
		if (!el || prefersReducedMotion()) return;
		el.classList.remove("is-swapping");
		void el.offsetWidth; // форс reflow — перезапуск CSS-анимации при быстром повторном next/prev
		el.classList.add("is-swapping");
		let done = false;
		const clear = () => {
			if (done) return;
			done = true;
			el.classList.remove("is-swapping");
			el.removeEventListener("animationend", clear);
		};
		el.addEventListener("animationend", clear);
		setTimeout(clear, SWAP_FADE_FALLBACK_MS);
	}

	// ЕДИНСТВЕННЫЙ писатель classList/style для is-dragging/is-settling/
	// --drag-px/--media-pull (И-G) — buквально: во всём файле нет другого
	// места, трогающего эти четыре имени (is-swapping в playSwapFade —
	// другой, cls-специфичный механизм fade для audio/video, вне периметра
	// И-G, который явно ограничен именно этой четвёркой). Семантический
	// выход λ (gestureOutput) переводится в конкретные пиксели здесь и
	// только здесь: elasticDx (нужны rank/total — их нет в чистом
	// состоянии) и domножение знакового dragPx SETTLING на измеренный
	// widthPxRef (DESIGN.md, п. λ).
	//
	// instant=true — выход ИЗ SETTLING: --drag-px обязан упасть на 0 БЕЗ
	// анимации, форс-reflow (offsetWidth) фиксирует пересчёт стиля
	// синхронно, пока transition:none ещё в силе — buквально тот же приём,
	// что уже стоит в playSwapFade, здесь применён к тому же элементу
	// перед тем, как ниже применится обычная (уже не форсированная)
	// классификация состояния.
	function applyGestureOutput(state, { instant = false } = {}) {
		const out = gestureOutput(state);
		const suppressPull = state.name === "PRESSED" || state.name === "DRAG_V";
		const suppressDrag = state.name === "PRESSED" || state.name === "DRAG_H";

		const overlay = overlayRef.current;
		if (overlay) {
			overlay.classList.toggle("is-pulling", suppressPull);
			overlay.style.setProperty("--media-pull", String(out.pull));
		}

		const track = trackRef.current;
		if (track) {
			let dragPx = 0;
			if (state.name === "DRAG_H") {
				const atEdge = (state.dx > 0 && rank === 0) || (state.dx < 0 && rank === total - 1);
				dragPx = elasticDx(out.dragPx, atEdge);
			} else if (state.name === "SETTLING") {
				dragPx = out.dragPx * widthPxRef.current;
			}
			if (instant) {
				track.classList.remove("is-settling");
				track.classList.add("is-dragging");
				track.style.setProperty("--drag-px", `${dragPx}px`);
				void track.offsetWidth;
			}
			track.classList.toggle("is-dragging", suppressDrag);
			track.classList.toggle("is-settling", out.settling);
			track.style.setProperty("--drag-px", `${dragPx}px`);
		}
	}

	// Заводит наблюдателей завершения ОДНОЙ конкретной доводки (gen).
	// Для audio/video трека в DOM нет вовсе (И-B) — анимировать нечего,
	// доводка считается завершённой синхронно тем же тиком (это и раньше
	// было мгновенным mediaNext/Prev без анимации для этих классов).
	function armSettleWatchers(gen) {
		if (session.cls !== "image") {
			dispatchGesture("settleEnd", { gen });
			return;
		}
		const track = trackRef.current;
		if (!track) {
			dispatchGesture("settleEnd", { gen });
			return;
		}
		let timeoutId;
		const finish = () => {
			track.removeEventListener("transitionend", onTransitionEnd);
			clearTimeout(timeoutId);
			dispatchGesture("settleEnd", { gen });
		};
		function onTransitionEnd(ev) {
			if (ev.target !== track) return; // не реагировать на всплывшие transitionend от потомков
			finish();
		}
		track.addEventListener("transitionend", onTransitionEnd);
		// фолбэк, если transitionend не пришёл (напр. targetPx===0 без
		// реального изменения значения — transition тогда не запускается).
		timeoutId = setTimeout(finish, 500);
	}

	// Единственный диспетчер (аналог dispatch() в signals/media.js —
	// оборачивает чистый gestureTransition побочными эффектами). НЕ трогает
	// classList/style сам (И-G) — только решает, ЧТО применить, применяет
	// через applyGestureOutput. Порядок (DESIGN.md "этап 7, п.5"):
	// 1) на границе выхода из SETTLING — применить решение доводки
	//    (mediaNext/Prev, fade для audio/video), λ ниже мгновенно (instant)
	//    сбросит --drag-px в 0 тем же вызовом;
	// 2) закрытие по вертикали (verticalCommit) — тоже на границе перехода;
	// 3) зафиксировать новое состояние;
	// 4) применить λ (единственный писатель, с instant при выходе из
	//    SETTLING);
	// 5) при СВЕЖЕМ входе в SETTLING — завести наблюдателей ПОСЛЕ (4), иначе
	//    синхронный settleEnd для audio/video (рекурсивный вызов
	//    dispatchGesture ИЗНУТРИ armSettleWatchers) применил бы λ(IDLE)
	//    раньше, чем родительский вызов успел применить λ(SETTLING) —
	//    итоговый DOM откатился бы на кадр назад.
	function dispatchGesture(event, payload) {
		const prev = gestureStateRef.current;
		const next = gestureTransition(prev, event, payload);
		const exitingSettling = prev.name === "SETTLING" && next.name !== "SETTLING";

		if (exitingSettling) {
			if (prev.dir === "next") mediaNext();
			else if (prev.dir === "prev") mediaPrev();
			if (session.cls !== "image" && prev.dir) playSwapFade();
		}

		if (prev.name === "DRAG_V" && event === "up" && next.name === "IDLE" && verticalCommit(prev.dy)) {
			closeMedia();
		}

		gestureStateRef.current = next;
		applyGestureOutput(next, { instant: exitingSettling });

		if (prev.name !== "SETTLING" && next.name === "SETTLING") {
			armSettleWatchers(next.gen);
		}
	}

	// didDragRef взводится, но НЕ полагается только на потребление в
	// withDragGuard: синтетический click, идущий сразу после pointerup,
	// может попасть НЕ на охраняемую кнопку, а на саму картинку — там
	// onClick лишь делает stopPropagation, флаг никто не сбросит, и он
	// "утёк" бы в СЛЕДУЮЩИЙ, никак не связанный, клик пользователя позже.
	// Автосброс на ближайший тик (click для ЭТОГО жеста, если он вообще
	// будет, синхронно идёт следом за pointerup в той же обработке жеста
	// браузером — успевает раньше setTimeout(0)).
	function armDragGuard() {
		didDragRef.current = true;
		setTimeout(() => {
			didDragRef.current = false;
		}, 0);
	}

	// §3.1/3.2 — pointer-обработчики, все на корне .media-overlay (не
	// только на viewport: вертикальная тяга-закрытие должна работать и над
	// хромом/фоном). Игнор жестов, начавшихся на кнопке/нативных controls —
	// буквально по spec, иначе перемотка видео/громкость превратились бы в
	// листание. "down" не перехватывает жест у УЖЕ активного указателя —
	// автомат сам проигнорировал бы лишний down (PRESSED/DRAG_H/DRAG_V.down
	// — игнор), но pointerTrackRef обязан остаться привязан к ПЕРВОМУ
	// указателю, не быть угнанным вторым.
	function handleGesturePointerDown(e) {
		if (isMini) return;
		if (e.target.closest("button, video, audio")) return;
		const accepting = gestureStateRef.current.name === "IDLE" || gestureStateRef.current.name === "SETTLING";
		if (!accepting) return;
		pointerTrackRef.current = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY };
		// .media-overlay-inner — контентная область БЕЗ паддинга viewport'а
		// (var(--space-l) с каждой стороны); ширина viewport'а завышала бы
		// widthPx примерно на 2×--space-l — цель коммита-довода промахивалась
		// бы мимо истинной ширины слайда, давая заметный "довесок" на сбросе.
		widthPxRef.current = innerRef.current?.getBoundingClientRect().width ?? 0;
		overlayRef.current?.setPointerCapture(e.pointerId);
		dispatchGesture("down", null);
	}

	function handleGesturePointerMove(e) {
		const track = pointerTrackRef.current;
		if (!track || e.pointerId !== track.pointerId) return;
		dispatchGesture("move", { dx: e.clientX - track.startX, dy: e.clientY - track.startY });
	}

	function handleGesturePointerUp(e) {
		const track = pointerTrackRef.current;
		if (!track || e.pointerId !== track.pointerId) return;
		const wasRealDrag = gestureStateRef.current.name === "DRAG_H" || gestureStateRef.current.name === "DRAG_V";
		dispatchGesture("up", { widthPx: widthPxRef.current, rank, total });
		pointerTrackRef.current = null;
		if (wasRealDrag) armDragGuard();
		// иначе — обычный тап, didDragRef не трогаем, клик отработает сам
	}

	function handleGesturePointerCancel(e) {
		const track = pointerTrackRef.current;
		if (!track || e.pointerId !== track.pointerId) return;
		dispatchGesture("cancel", null);
		pointerTrackRef.current = null;
	}

	return (
		<div
			ref={overlayRef}
			class={isMini ? "media-mini-bar row" : "media-overlay"}
			role={isMini ? "status" : "dialog"}
			aria-modal={isMini ? undefined : "true"}
			data-chrome={isMini ? undefined : chromeVisible ? "on" : "off"}
			data-info={isMini ? undefined : infoPinned ? "on" : "off"}
			onClick={isMini ? undefined : withDragGuard(handleClose)}
			onPointerMove={isMini ? undefined : (e) => { handleChromeActivity(); handleGesturePointerMove(e); }}
			onPointerDown={isMini ? undefined : (e) => { handleChromeActivity(); handleGesturePointerDown(e); }}
			onPointerUp={isMini ? undefined : handleGesturePointerUp}
			onPointerCancel={isMini ? undefined : handleGesturePointerCancel}
			onFocusIn={isMini ? undefined : handleChromeActivity}
		>
			{/* Первый ребёнок корня — ВСЕГДА эта пара обёрток вокруг <View>, той же
			    формы что при isMini, что при full (см. комментарий выше компонента).
			    Не трогать позицию/форму без крайней необходимости. */}
			<div
				ref={viewportRef}
				class={isMini ? `media-mini-bar-preview${session.cls === "audio" ? " is-audio" : ""}` : "media-overlay-viewport"}
				onClick={isMini ? undefined : withDragGuard((e) => { if (e.target === e.currentTarget) handleClose(); })}
			>
				<div
					ref={innerRef}
					class={isMini ? undefined : "media-overlay-inner"}
					style={isMini ? { display: "contents" } : undefined}
					onClick={isMini ? undefined : (e) => e.stopPropagation()}
				>
					{session.cls === "audio" && <IconMusicNote aria-hidden="true" style={isMini ? undefined : { display: "none" }} />}
					{!isMini && session.cls === "image" ? (
						<div class="media-overlay-track" ref={trackRef}>
							{/* key — АБСОЛЮТНАЯ позиция в плейлисте, не индекс слота (0/1/2).
							    Без key Preact сопоставляет слайды позиционно: на next/prev
							    ТЕ ЖЕ 3 инстанса ImageViewer просто получают чужой mediaRef,
							    их собственный digest-стейт на кадр устаревает — "Загрузка..."
							    мигает у всех трёх сразу, даже если картинка уже была
							    показана соседним слайдом мгновение назад. С key по позиции
							    Preact при сдвиге [P-1,P,P+1]->[P,P+1,P+2] ПЕРЕСТАВЛЯЕТ узлы
							    (у двух совпадает key со старым слотом — состояние/загрузка
							    едут вместе с узлом), создаётся заново только один, самый
							    дальний, невидимый в момент сброса. gap-slot'ы (нет соседа)
							    держат отдельный стабильный key, не путаются с реальными
							    позициями. */}
							<div class="media-overlay-slide" key={leftPos === -1 ? "gap-prev" : leftPos}>
								{leftRef && <ImageViewer mediaRef={leftRef} />}
							</div>
							<div class="media-overlay-slide" key={session.position}>
								<ImageViewer mediaRef={currentRef} onMeta={(m) => setMeta({ digest: currentRef.digest, ...m })} />
							</div>
							<div class="media-overlay-slide" key={rightPos === -1 ? "gap-next" : rightPos}>
								{rightRef && <ImageViewer mediaRef={rightRef} />}
							</div>
						</div>
					) : (
						<View
							mediaRef={currentRef}
							playing={playing}
							onToggle={mediaToggle}
							onEnded={mediaEnded}
							compact={isMini}
							onMeta={(m) => setMeta({ digest: currentRef.digest, ...m })}
							onTimeUpdate={isMini ? setMiniTime : undefined}
						/>
					)}
				</div>
			</div>

			{isMini ? (
				<>
					<div class="media-mini-bar-info stack grow">
						<span class="media-mini-bar-name">{currentRef.name}</span>
						{/* Этап 6 — время только в мини-баре (в полном виде это отдают
						    нативные controls). hasDuration уже сверен по digest —
						    тот же флаг, что использует полный вид для панели сведений. */}
						{hasDuration && (
							<small class="media-mini-bar-time">
								{formatDuration(miniTime)} / {formatDuration(meta.duration)}
							</small>
						)}
					</div>
					<button type="button" class="media-overlay-btn" onClick={mediaToggle} aria-label={playing ? t("media.player.pause") : t("media.player.play")}>
						{playing ? <IconPlayerPause /> : <IconPlayerPlay />}
					</button>
					<button type="button" class="media-overlay-btn" onClick={mediaRestore} aria-label={t("media.player.restore")}>
						<IconRestore />
					</button>
					<button type="button" class="media-overlay-btn" onClick={closeMedia} aria-label={t("common.close")}>
						<IconCross />
					</button>
				</>
			) : (
				<>
					<header class="media-overlay-top bar" onClick={(e) => e.stopPropagation()}>
						<div class="media-overlay-title stack grow">
							<span class="truncate">{currentRef.name}</span>
							<small>{metaLine}</small>
						</div>
						<div class="media-overlay-acts bar rigid">
							<button
								type="button"
								class="media-overlay-btn"
								onClick={withDragGuard(() => setInfoPinned((v) => !v))}
								aria-pressed={infoPinned}
								aria-label={t("media.player.info")}
							>
								<IconInfoCircle />
							</button>
							{canMinimize && (
								<button type="button" class="media-overlay-btn" onClick={withDragGuard(mediaMinimize)} aria-label={t("media.player.minimize")}>
									<IconMinimize />
								</button>
							)}
							<button type="button" class="media-overlay-btn is-close" onClick={withDragGuard(handleClose)} aria-label={t("common.close")}>
								<IconCross />
							</button>
						</div>
					</header>
					{total > 1 && (
						<>
							<button
								type="button"
								class="media-overlay-nav is-prev"
								onClick={withDragGuard((e) => { e.stopPropagation(); mediaPrev(); })}
								aria-label={t("media.player.prev")}
							>
								<IconNavPrev />
							</button>
							<button
								type="button"
								class="media-overlay-nav is-next"
								onClick={withDragGuard((e) => { e.stopPropagation(); mediaNext(); })}
								aria-label={t("media.player.next")}
							>
								<IconNavNext />
							</button>
						</>
					)}
					<footer class="media-overlay-bottom" onClick={(e) => e.stopPropagation()}>
						{session.cls === "image" && total > 1 && (
							<div class="media-overlay-strip reel">
								{[...session.playlist.idx.image].map((pos) => {
									const thumbRef = session.playlist.items[pos];
									const thumbUrl = getMemoryCachedUrl(thumbRef.digest);
									const isActive = pos === session.position;
									return (
										<button
											key={pos}
											type="button"
											class="media-overlay-thumb"
											ref={isActive ? activeThumbRef : undefined}
											aria-current={isActive}
											aria-label={t("media.player.trackOf", { current: session.playlist.rank[pos] + 1, total })}
											onClick={withDragGuard(() => mediaGoTo(pos))}
										>
											{thumbUrl && <img src={thumbUrl} alt="" draggable={false} />}
										</button>
									);
								})}
							</div>
						)}
						<div class="media-overlay-info">
							<div>
								<div class="media-overlay-meta bar">
									<span>
										<b>{t("media.info.type")}</b>
										{currentRef.mime}
									</span>
									<span>
										<b>{t("media.info.size")}</b>
										{formatFileSize(currentRef.size)}
									</span>
									{hasResolution && (
										<span>
											<b>{t("media.info.resolution")}</b>
											{meta.width}×{meta.height}
										</span>
									)}
									{hasDuration && (
										<span>
											<b>{t("media.info.duration")}</b>
											{formatDuration(meta.duration)}
										</span>
									)}
									<span>
										<b>{t("media.info.hash")}</b>
										{shortHash(currentRef.digest)}
									</span>
								</div>
							</div>
						</div>
					</footer>
				</>
			)}
		</div>
	);
}
