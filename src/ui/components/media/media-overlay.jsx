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
// точка в дереве, всегда смонтированная, пока сессия жива; mini/full меняют
// только ОБВЯЗКУ (обёртка/контролы) вокруг НЕЁ, той же формы дерева (div>div>
// View), чтобы Preact не считал переключение unmount+remount. compact-проп
// у VideoPlayer/AudioPlayer убирает нативные controls (в mini свои кнопки) и
// переключает размер/видимость через CSS — сам элемент не пересоздаётся.
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

	if (isMini) {
		// Мини-бар переделывается на этапе 6 (MEDIA-OVERLAY-UI.md) — здесь
		// намеренно оставлена прежняя разметка и текстовые символы ⏸/▶/⤢.
		return (
			<div class="media-mini-bar row" role="status">
				<div class="media-mini-bar-preview">
					{session.cls === "audio" && <IconMusicNote aria-hidden="true" />}
					<View mediaRef={currentRef} playing={playing} onToggle={mediaToggle} onEnded={mediaEnded} compact={true} />
				</div>
				<span class="media-mini-bar-name grow">{currentRef.name}</span>
				<button type="button" onClick={mediaToggle} aria-label={playing ? t("media.player.pause") : t("media.player.play")}>
					{playing ? "⏸" : "▶"}
				</button>
				<button type="button" onClick={mediaRestore} aria-label={t("media.player.restore")}>
					⤢
				</button>
				<button type="button" onClick={closeMedia} aria-label={t("common.close")}>
					<IconCross />
				</button>
			</div>
		);
	}

	// MEDIA-OVERLAY-UI.md, этап 1.1 — заголовок над кадром всегда содержит
	// имя и строку "N из M · класс · размер"; стрелки листания разнесены к
	// краям экрана (приём Lity). Этап 2.2 — нижняя полоса больше не пуста:
	// панель сведений (тип/размер/разрешение/длительность/хеш), раскрытие по
	// наведению или закреплённая кнопкой "i".
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
			class="media-overlay"
			role="dialog"
			aria-modal="true"
			data-chrome={chromeVisible ? "on" : "off"}
			data-info={infoPinned ? "on" : "off"}
			onClick={closeMedia}
			onPointerMove={handleChromeActivity}
			onPointerDown={handleChromeActivity}
			onFocusIn={handleChromeActivity}
		>
			<div class="media-overlay-scrim" aria-hidden="true" />
			<div class="media-overlay-viewport" onClick={(e) => { if (e.target === e.currentTarget) closeMedia(); }}>
				<div class="media-overlay-inner" onClick={(e) => e.stopPropagation()}>
					<View
						mediaRef={currentRef}
						playing={playing}
						onToggle={mediaToggle}
						onEnded={mediaEnded}
						compact={false}
						onMeta={(m) => setMeta({ digest: currentRef.digest, ...m })}
					/>
				</div>
			</div>
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
		</div>
	);
}
