import { useEffect } from "preact/hooks";
import { mediaSession, mediaNext, mediaPrev, mediaToggle, mediaMinimize, mediaRestore, mediaEnded, closeMedia } from "../../signals/media.js";
import VideoPlayer from "./video-player.jsx";
import AudioPlayer from "./audio-player.jsx";
import ImageViewer from "./image-viewer.jsx";
import IconMusicNote from "../../icons/music-note.jsx";
import IconCross from "../../icons/cross.jsx";
import IconChevronLeft from "../../icons/chevron-left.jsx";
import IconChevronRight from "../../icons/chevron-right.jsx";
import IconMinimize from "../../icons/minimize.jsx";
import { formatFileSize } from "../attachment-view.jsx";
import { t } from "../../signals/i18n.js";

const VIEWS = { video: VideoPlayer, audio: AudioPlayer, image: ImageViewer };

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

	if (!session) return null;

	// НЕ называть переменную "ref" в JSX-атрибуте ниже — "ref" зарезервирован
	// Preact'ом для форвардинга ссылки на DOM-узел и НЕ доходит до компонента
	// как обычный проп (найдено живой проверкой: компонент получал undefined
	// молча, крах на первом же .digest). Проп называется mediaRef везде.
	const currentRef = session.playlist.items[session.position];
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
	// краям экрана (приём Lity), нижняя полоса пока пуста (наполняется
	// этапом 2 — панель сведений).
	const metaLine = `${t("media.player.trackOf", { current: rank + 1, total })} · ${t(`media.classNames.${session.cls}`)} · ${formatFileSize(currentRef.size)}`;

	return (
		<div class="media-overlay" role="dialog" aria-modal="true" onClick={closeMedia}>
			<div class="media-overlay-scrim" aria-hidden="true" />
			<div class="media-overlay-viewport" onClick={(e) => { if (e.target === e.currentTarget) closeMedia(); }}>
				<div class="media-overlay-inner" onClick={(e) => e.stopPropagation()}>
					<View mediaRef={currentRef} playing={playing} onToggle={mediaToggle} onEnded={mediaEnded} compact={false} />
				</div>
			</div>
			<header class="media-overlay-top bar" onClick={(e) => e.stopPropagation()}>
				<div class="media-overlay-title stack grow">
					<span class="truncate">{currentRef.name}</span>
					<small>{metaLine}</small>
				</div>
				<div class="media-overlay-acts bar rigid">
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
						<IconChevronLeft />
					</button>
					<button
						type="button"
						class="media-overlay-nav is-next"
						onClick={(e) => { e.stopPropagation(); mediaNext(); }}
						aria-label={t("media.player.next")}
					>
						<IconChevronRight />
					</button>
				</>
			)}
			<footer class="media-overlay-bottom" onClick={(e) => e.stopPropagation()} />
		</div>
	);
}
