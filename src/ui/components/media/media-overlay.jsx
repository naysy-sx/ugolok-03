import { useEffect, useRef, useState } from "preact/hooks";
import { mediaSession, mediaNext, mediaPrev, mediaGoTo, mediaToggle, mediaMinimize, mediaRestore, mediaEnded, closeMedia } from "../../signals/media.js";
import { stepInClass } from "../../../domain/media/playlist.js";
import { resolveAxis, elasticDx, horizontalCommit, verticalPull, verticalCommit } from "../../../domain/media/swipe-gesture.js";
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
	const gestureRef = useRef({ active: false, pointerId: null, startX: 0, startY: 0, axis: null, widthPx: 0 });
	const didDragRef = useRef(false); // подавляет "случайный" click сразу после реального свайпа
	const activeThumbRef = useRef(null); // Этап 4 — активная миниатюра плёнки, для scrollIntoView

	useEffect(() => {
		infoPinnedRef.current = infoPinned;
	}, [infoPinned]);

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

	// §3.1/3.2 — pointer-обработчики жеста, все на корне .media-overlay (не
	// только на viewport: вертикальная тяга-закрытие должна работать и над
	// хромом/фоном). Игнор жестов, начавшихся на кнопке/нативных controls —
	// буквально по spec, иначе перемотка видео/громкость превратились бы в
	// листание.
	function handleGesturePointerDown(e) {
		if (isMini) return;
		if (e.target.closest("button, video, audio")) return;
		const g = gestureRef.current;
		g.active = true;
		g.pointerId = e.pointerId;
		g.startX = e.clientX;
		g.startY = e.clientY;
		g.axis = null;
		// .media-overlay-inner — контентная область БЕЗ паддинга viewport'а
		// (var(--space-l) с каждой стороны); ширина viewport'а завышала бы
		// widthPx примерно на 2×--space-l — цель коммита-довода промахивалась
		// бы мимо истинной ширины слайда, давая заметный "довесок" на сбросе.
		g.widthPx = innerRef.current?.getBoundingClientRect().width ?? 0;
		overlayRef.current?.setPointerCapture(e.pointerId);
		overlayRef.current?.classList.add("is-pulling"); // отключает transition на весь жест, см. custom.css
		trackRef.current?.classList.add("is-dragging");
		trackRef.current?.classList.remove("is-settling");
	}

	function handleGesturePointerMove(e) {
		const g = gestureRef.current;
		if (!g.active || e.pointerId !== g.pointerId) return;
		const dx = e.clientX - g.startX;
		const dy = e.clientY - g.startY;
		if (g.axis === null) g.axis = resolveAxis(dx, dy);
		if (g.axis === "vertical") {
			overlayRef.current?.style.setProperty("--media-pull", String(verticalPull(dy)));
		} else if (g.axis === "horizontal" && session.cls === "image" && trackRef.current) {
			const atEdge = (dx > 0 && rank === 0) || (dx < 0 && rank === total - 1);
			trackRef.current.style.setProperty("--drag-px", `${elasticDx(dx, atEdge)}px`);
		}
	}

	function settleTrack(direction, widthPx) {
		const el = trackRef.current;
		if (!el) return;
		el.classList.remove("is-dragging");
		if (prefersReducedMotion()) {
			el.style.setProperty("--drag-px", "0px");
			if (direction) (direction === "next" ? mediaNext : mediaPrev)();
			return;
		}
		el.classList.add("is-settling");
		const targetPx = direction === "next" ? -widthPx : direction === "prev" ? widthPx : 0;
		el.style.setProperty("--drag-px", `${targetPx}px`);
		let done = false;
		const finish = () => {
			if (done) return;
			done = true;
			el.removeEventListener("transitionend", onTransitionEnd);
			el.classList.remove("is-settling");
			el.classList.add("is-dragging"); // transition:none — сброс должен быть мгновенным
			if (direction) (direction === "next" ? mediaNext : mediaPrev)();
			el.style.setProperty("--drag-px", "0px");
			// requestAnimationFrame здесь был БАГОМ: transitionend и следующий rAF
			// браузер обрабатывает в рамках ОДНОГО прохода "update the rendering"
			// (animation-события -> rAF-колбэки), ДО пересчёта стиля — снятие
			// is-dragging в rAF успевало произойти раньше, чем стиль хоть раз
			// пересчитывался с "transition:none + drag-px:0", поэтому браузер видел
			// только переход из ПРЕЖНЕГО (ещё анимирующегося) значения прямо в 0 —
			// с уже включённым transition, то есть анимировал по новой. Форс-reflow
			// (offsetWidth) фиксирует пересчёт стиля СИНХРОННО, пока transition:none
			// ещё точно в силе — тот же приём, что уже стоит в playSwapFade.
			void el.offsetWidth;
			el.classList.remove("is-dragging");
		};
		function onTransitionEnd(ev) {
			if (ev.target !== el) return; // не реагировать на всплывшие transitionend от потомков
			finish();
		}
		el.addEventListener("transitionend", onTransitionEnd);
		setTimeout(finish, 500); // фолбэк, если transitionend не пришёл (напр. targetPx===0 без реального изменения)
	}

	function springBackPull() {
		overlayRef.current?.style.setProperty("--media-pull", "0");
	}

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

	function endGesture() {
		gestureRef.current.active = false;
		gestureRef.current.pointerId = null;
		overlayRef.current?.classList.remove("is-pulling");
		trackRef.current?.classList.remove("is-dragging"); // settleTrack() re-adds/manages it correctly if called right after
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

	function handleGesturePointerUp(e) {
		const g = gestureRef.current;
		if (!g.active || e.pointerId !== g.pointerId) return;
		const dx = e.clientX - g.startX;
		const dy = e.clientY - g.startY;
		const axis = g.axis;
		const widthPx = g.widthPx;
		endGesture();
		if (axis === "vertical") {
			armDragGuard();
			if (verticalCommit(dy)) closeMedia();
			else springBackPull();
			return;
		}
		if (axis === "horizontal") {
			armDragGuard();
			let direction = horizontalCommit(dx, widthPx);
			if (session.cls === "image") {
				// На краю плейлиста commit по РАЗМАХУ жеста возможен (horizontalCommit
				// не знает о rank/total), но реального перехода нет (media-machine.js
				// уже no-op) — без этой проверки трек уезжал бы на полную ширину и
				// на кадр показывал бы ПУСТОЙ слайд (leftRef/rightRef===null) перед
				// откатом. На краю коммит гасится — обычная пружинка, как ниже порога.
				const atEdge = (direction === "prev" && rank === 0) || (direction === "next" && rank === total - 1);
				if (atEdge) direction = null;
				settleTrack(direction, widthPx);
			} else if (direction) {
				(direction === "next" ? mediaNext : mediaPrev)();
				playSwapFade();
			}
		}
		// axis === null — обычный тап, didDragRef не трогаем, клик отработает сам
	}

	function handleGesturePointerCancel(e) {
		const g = gestureRef.current;
		if (!g.active || e.pointerId !== g.pointerId) return;
		const wasImage = session.cls === "image";
		const widthPx = g.widthPx;
		endGesture();
		springBackPull();
		if (wasImage) settleTrack(null, widthPx);
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
				class={isMini ? "media-mini-bar-preview" : "media-overlay-viewport"}
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
							onMeta={isMini ? undefined : (m) => setMeta({ digest: currentRef.digest, ...m })}
						/>
					)}
				</div>
			</div>

			{isMini ? (
				<>
					<span class="media-mini-bar-name grow">{currentRef.name}</span>
					<button type="button" onClick={mediaToggle} aria-label={playing ? t("media.player.pause") : t("media.player.play")}>
						{playing ? "⏸" : "▶"}
					</button>
					<button type="button" onClick={mediaRestore} aria-label={t("media.player.restore")}>
						<IconRestore />
					</button>
					<button type="button" onClick={closeMedia} aria-label={t("common.close")}>
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
