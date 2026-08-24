import IconMusicNote from "../../icons/music-note.jsx";
import IconVideoCamera from "../../icons/video-camera.jsx";
import IconImage from "../../icons/image-icon.jsx";
import IconFileText from "../../icons/file-text.jsx";
import { t } from "../../signals/i18n.js";

// counts: Int32Array(4) ([audio,video,image,other]) | {audio,video,image,file}
// booleans | null/undefined. Рендерит ДО 4 маленьких кнопок-срезов — только
// для классов с реальным присутствием (count>0 / true). Редизайн интерфейса,
// этап 3 (DESIGN.md) — "other"/файлы получил свою кнопку (было: "'other'
// никогда не показывается", MEDIA-SPEC.md §3.10 — решение явно отменено,
// media-overlay.jsx теперь умеет открывать файлы, см. file-viewer.jsx).
// Разметка по макету (область контента) — монохромные .slice вместо
// цветных btn--info/warn/good (пользователь: только визуал, число рядом с
// каждым срезом — счётчик уже вычислялся, просто не выводился в UI).
const CLASSES = [
	{ cls: "audio", Icon: IconMusicNote, labelKey: "media.buttons.audio" },
	{ cls: "video", Icon: IconVideoCamera, labelKey: "media.buttons.video" },
	{ cls: "image", Icon: IconImage, labelKey: "media.buttons.images" },
	{ cls: "other", Icon: IconFileText, labelKey: "media.buttons.files" },
];

// count(counts, cls, index) — counts бывает Int32Array [audio,video,image,other]
// ИЛИ объект {audio,video,image,file} booleans (см. сигнатуру выше) — второй
// случай не несёт числа (просто true/false), тогда показывать нечего.
function count(counts, cls, index) {
	if (!counts) return 0;
	if (cls in counts) return typeof counts[cls] === "number" ? counts[cls] : counts[cls] ? 1 : 0;
	return counts[index] ?? 0;
}

export default function MediaButtons({ counts, onOpen }) {
	const visible = CLASSES.map((c, i) => ({ ...c, n: count(counts, c.cls, i) })).filter((c) => c.n > 0);
	if (visible.length === 0) return null;
	return (
		<div class="media-buttons-bar row" style={{ "--gap": "var(--space-2xs)" }}>
			{visible.map(({ cls, Icon, labelKey, n }) => (
				<button key={cls} type="button" class="slice bar" style={{ "--gap": "var(--space-3xs)", "--align": "center" }} onClick={() => onOpen(cls)}>
					<Icon aria-hidden="true" /> {t(labelKey)} <span class="slice__n">{n}</span>
				</button>
			))}
		</div>
	);
}
