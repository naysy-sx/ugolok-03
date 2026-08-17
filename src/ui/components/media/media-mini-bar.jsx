import IconMusicNote from "../../icons/music-note.jsx";
import IconVideoCamera from "../../icons/video-camera.jsx";
import IconCross from "../../icons/cross.jsx";
import { t } from "../../signals/i18n.js";

const CLASS_ICONS = { audio: IconMusicNote, video: IconVideoCamera };

// Свёрнутый вид (display==="mini") — только audio/video (И5: изображение
// никогда не сворачивается, media-machine.js это уже гарантирует, сюда
// компонент для cls="image" просто не смонтируют). Переживает переход между
// разделами приложения (MEDIA-SPEC.md §7.5) — сам он этого не делает, это
// свойство ЕГО РОДИТЕЛЯ (media-overlay.jsx смонтирован в app.jsx вне
// .app-layout, не размонтируется при смене вкладки).
export default function MediaMiniBar({ mediaRef, cls, playing, onToggle, onRestore, onClose }) {
	const Icon = CLASS_ICONS[cls] || IconMusicNote;
	return (
		<div class="media-mini-bar row" role="status" style={{ "--gap": "var(--space-s)", alignItems: "center" }}>
			<Icon aria-hidden="true" />
			<span class="media-mini-bar-name grow">{mediaRef.name}</span>
			<button type="button" onClick={onToggle} aria-label={playing ? t("media.player.pause") : t("media.player.play")}>
				{playing ? "⏸" : "▶"}
			</button>
			<button type="button" onClick={onRestore} aria-label={t("media.player.restore")}>
				⤢
			</button>
			<button type="button" onClick={onClose} aria-label={t("common.close")}>
				<IconCross />
			</button>
		</div>
	);
}
