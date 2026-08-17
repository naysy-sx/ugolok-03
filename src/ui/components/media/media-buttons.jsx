import IconMusicNote from "../../icons/music-note.jsx";
import IconVideoCamera from "../../icons/video-camera.jsx";
import IconImage from "../../icons/image-icon.jsx";
import { t } from "../../signals/i18n.js";

// counts: Int32Array(4) ([audio,video,image,other]) | {audio,video,image}
// booleans | null/undefined. Рендерит ДО 3 маленьких цветных кнопок — только
// для классов с реальным присутствием (count>0 / true). "other" никогда не
// показывается (нет своей UI-кнопки — MEDIA-SPEC.md §3.10). Первый проход
// размещения/визуала (Этап E, пользователь этой сессии: "потом визуал ещё
// долго полировать") — переиспользует уже существующие цветные модификаторы
// .btn--ghost.btn--info/warn/good (Этап 70-довесок), а не заводит новую
// цветовую систему заново.
const CLASSES = [
	{ cls: "audio", Icon: IconMusicNote, labelKey: "media.buttons.audio", modifier: "btn--info" },
	{ cls: "video", Icon: IconVideoCamera, labelKey: "media.buttons.video", modifier: "btn--warn" },
	{ cls: "image", Icon: IconImage, labelKey: "media.buttons.images", modifier: "btn--good" },
];

function present(counts, cls, index) {
	if (!counts) return false;
	if (cls in counts) return !!counts[cls];
	return (counts[index] ?? 0) > 0;
}

export default function MediaButtons({ counts, onOpen }) {
	const visible = CLASSES.filter((c, i) => present(counts, c.cls, i));
	if (visible.length === 0) return null;
	return (
		<div class="media-buttons-bar row" style={{ "--gap": "var(--space-2xs)" }}>
			{visible.map(({ cls, Icon, labelKey, modifier }) => (
				<button key={cls} type="button" class={`btn--ghost ${modifier}`} onClick={() => onOpen(cls)}>
					<Icon aria-hidden="true" /> {t(labelKey)}
				</button>
			))}
		</div>
	);
}
