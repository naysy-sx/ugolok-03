import { useEffect } from "preact/hooks";
import { mediaSession, mediaNext, mediaPrev, mediaToggle, mediaMinimize, mediaRestore, mediaEnded, closeMedia } from "../../signals/media.js";
import VideoPlayer from "./video-player.jsx";
import AudioPlayer from "./audio-player.jsx";
import ImageViewer from "./image-viewer.jsx";
import IconMusicNote from "../../icons/music-note.jsx";
import IconCross from "../../icons/cross.jsx";
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

	return (
		<div
			class={isMini ? "media-mini-bar row" : "media-overlay"}
			role={isMini ? "status" : "dialog"}
			aria-modal={isMini ? undefined : "true"}
			onClick={isMini ? undefined : closeMedia}
		>
			<div class={isMini ? "media-mini-bar-preview" : "media-overlay-inner"} onClick={isMini ? undefined : (e) => e.stopPropagation()}>
				{isMini && session.cls === "audio" && <IconMusicNote aria-hidden="true" />}
				<View mediaRef={currentRef} playing={playing} onToggle={mediaToggle} onEnded={mediaEnded} compact={isMini} />
			</div>
			{isMini ? (
				<>
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
				</>
			) : (
				<div class="media-overlay-controls row" onClick={(e) => e.stopPropagation()}>
					{total > 1 && (
						<>
							<button type="button" onClick={mediaPrev} aria-label={t("media.player.prev")}>
								‹
							</button>
							<span class="media-overlay-track-of">{t("media.player.trackOf", { current: rank + 1, total })}</span>
							<button type="button" onClick={mediaNext} aria-label={t("media.player.next")}>
								›
							</button>
						</>
					)}
					<span class="grow" />
					{canMinimize && (
						<button type="button" onClick={mediaMinimize} aria-label={t("media.player.minimize")}>
							⤡
						</button>
					)}
					<button type="button" onClick={closeMedia} aria-label={t("common.close")}>
						<IconCross />
					</button>
				</div>
			)}
		</div>
	);
}
