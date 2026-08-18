import { useEffect, useRef, useState } from "preact/hooks";
import { mediaSession, mediaNext, mediaPrev, mediaToggle, mediaMinimize, mediaRestore, mediaEnded, closeMedia } from "../../signals/media.js";
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

	useEffect(() => {
		infoPinnedRef.current = infoPinned;
	}, [infoPinned]);

	useEffect(() => {
		if (!session || session.display !== "full") return;
		function handleKeyDown(e) {
			if (e.key === "Escape") closeMedia();
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

	return (
		<div
			class={isMini ? "media-mini-bar row" : "media-overlay"}
			role={isMini ? "status" : "dialog"}
			aria-modal={isMini ? undefined : "true"}
			data-chrome={isMini ? undefined : chromeVisible ? "on" : "off"}
			data-info={isMini ? undefined : infoPinned ? "on" : "off"}
			onClick={isMini ? undefined : closeMedia}
			onPointerMove={isMini ? undefined : handleChromeActivity}
			onPointerDown={isMini ? undefined : handleChromeActivity}
			onFocusIn={isMini ? undefined : handleChromeActivity}
		>
			{/* Первый ребёнок корня — ВСЕГДА эта пара обёрток вокруг <View>, той же
			    формы что при isMini, что при full (см. комментарий выше компонента).
			    Не трогать позицию/форму без крайней необходимости. */}
			<div
				class={isMini ? "media-mini-bar-preview" : "media-overlay-viewport"}
				onClick={isMini ? undefined : (e) => { if (e.target === e.currentTarget) closeMedia(); }}
			>
				<div
					class={isMini ? undefined : "media-overlay-inner"}
					style={isMini ? { display: "contents" } : undefined}
					onClick={isMini ? undefined : (e) => e.stopPropagation()}
				>
					{session.cls === "audio" && <IconMusicNote aria-hidden="true" style={isMini ? undefined : { display: "none" }} />}
					<View
						mediaRef={currentRef}
						playing={playing}
						onToggle={mediaToggle}
						onEnded={mediaEnded}
						compact={isMini}
						onMeta={isMini ? undefined : (m) => setMeta({ digest: currentRef.digest, ...m })}
					/>
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
								onClick={() => setInfoPinned((v) => !v)}
								aria-pressed={infoPinned}
								aria-label={t("media.player.info")}
							>
								<IconInfoCircle />
							</button>
							{canMinimize && (
								<button type="button" class="media-overlay-btn" onClick={mediaMinimize} aria-label={t("media.player.minimize")}>
									<IconMinimize />
								</button>
							)}
							<button type="button" class="media-overlay-btn is-close" onClick={closeMedia} aria-label={t("common.close")}>
								<IconCross />
							</button>
						</div>
					</header>
					{total > 1 && (
						<>
							<button
								type="button"
								class="media-overlay-nav is-prev"
								onClick={(e) => { e.stopPropagation(); mediaPrev(); }}
								aria-label={t("media.player.prev")}
							>
								<IconNavPrev />
							</button>
							<button
								type="button"
								class="media-overlay-nav is-next"
								onClick={(e) => { e.stopPropagation(); mediaNext(); }}
								aria-label={t("media.player.next")}
							>
								<IconNavNext />
							</button>
						</>
					)}
					<footer class="media-overlay-bottom" onClick={(e) => e.stopPropagation()}>
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
