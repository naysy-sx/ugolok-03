import { useEffect } from "preact/hooks";
import { mediaSession, mediaNext, mediaPrev, mediaToggle, mediaMinimize, mediaRestore, mediaEnded, closeMedia } from "../../signals/media.js";
import VideoPlayer from "./video-player.jsx";
import AudioPlayer from "./audio-player.jsx";
import ImageViewer from "./image-viewer.jsx";
import MediaMiniBar from "./media-mini-bar.jsx";
import IconCross from "../../icons/cross.jsx";
import { t } from "../../signals/i18n.js";

const VIEWS = { video: VideoPlayer, audio: AudioPlayer, image: ImageViewer };

// Корень медиа-сессии (Этап D) — единственное место, монтирующее один из
// четырёх "глупых" видов по mediaSession.value.cls/display. Ничего не
// рендерит, если сессии нет (И3 — allocWindow тогда тоже пуст, здесь
// симметрично — нечего показывать). Свёрнутый вид (display==="mini") —
// свой отдельный компонент без chrome полноэкранного просмотра.
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

	if (session.display === "mini") {
		return <MediaMiniBar mediaRef={currentRef} cls={session.cls} playing={playing} onToggle={mediaToggle} onRestore={mediaRestore} onClose={closeMedia} />;
	}

	const View = VIEWS[session.cls];
	const canMinimize = session.cls !== "image"; // И5 — картинка не сворачивается
	const rank = session.playlist.rank[session.position];
	const total = session.playlist.idx[session.cls].length;

	return (
		<div class="media-overlay" role="dialog" aria-modal="true" onClick={closeMedia}>
			<div class="media-overlay-inner" onClick={(e) => e.stopPropagation()}>
				<View mediaRef={currentRef} playing={playing} onToggle={mediaToggle} onEnded={mediaEnded} />
			</div>
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
		</div>
	);
}
