import IconMusicNote from "../../icons/music-note.jsx";
import IconVideoCamera from "../../icons/video-camera.jsx";
import IconImage from "../../icons/image-icon.jsx";
import IconFileText from "../../icons/file-text.jsx";
import { t } from "../../signals/i18n.js";

// counts: Int32Array(4) ([audio,video,image,other]) | {audio,video,image,file}
// booleans | null/undefined. Рендерит ДО 4 маленьких цветных кнопок — только
// для классов с реальным присутствием (count>0 / true). Редизайн интерфейса,
// этап 3 (DESIGN.md) — "other"/файлы получил свою кнопку (было: "'other'
// никогда не показывается", MEDIA-SPEC.md §3.10 — решение явно отменено,
// media-overlay.jsx теперь умеет открывать файлы, см. file-viewer.jsx).
// Свободных цветовых модификаторов не осталось (--info=audio, --warn=video),
// "Файлы" делит --good с "Изображения" — не заводить 4-й цвет ради одной
// кнопки, не запрошено.
const CLASSES = [
	{ cls: "audio", Icon: IconMusicNote, labelKey: "media.buttons.audio", modifier: "btn--info" },
	{ cls: "video", Icon: IconVideoCamera, labelKey: "media.buttons.video", modifier: "btn--warn" },
	{ cls: "image", Icon: IconImage, labelKey: "media.buttons.images", modifier: "btn--good" },
	{ cls: "other", Icon: IconFileText, labelKey: "media.buttons.files", modifier: "btn--good" },
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
