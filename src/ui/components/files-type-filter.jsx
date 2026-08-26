import IconSquaresFour from "../icons/squares-four.jsx";
import IconImage from "../icons/image-icon.jsx";
import IconVideoCamera from "../icons/video-camera.jsx";
import IconMusicNote from "../icons/music-note.jsx";
import IconFileText from "../icons/file-text.jsx";
import { t } from "../signals/i18n.js";

// Чипы фильтра типа на экране «Файлы». Не MediaButtons: клик НЕ открывает оверлей.
const CHIPS = [
	{ id: "all", labelKey: "files.typeAll", Icon: IconSquaresFour },
	{ id: "image", labelKey: "files.typeImages", Icon: IconImage },
	{ id: "video", labelKey: "files.typeVideo", Icon: IconVideoCamera },
	{ id: "audio", labelKey: "files.typeAudio", Icon: IconMusicNote },
	{ id: "other", labelKey: "files.typeDocs", Icon: IconFileText },
];

export default function TypeFilterBar({ counts, active, onSelect }) {
	const visible = CHIPS.filter((c) => c.id === "all" || (counts?.[c.id] ?? 0) > 0);
	return (
		<div class="reel" style={{ "--gap": "var(--space-2xs)" }}>
			{visible.map(({ id, labelKey, Icon }) => {
				const n = counts?.[id] ?? 0;
				const on = active === id;
				return (
					<button
						key={id}
						type="button"
						class={"slice bar rigid" + (on ? " slice--on" : "")}
						style={{ "--gap": "var(--space-3xs)", "--align": "center" }}
						aria-pressed={on}
						onClick={() => onSelect(id)}
					>
						<Icon aria-hidden="true" /> {t(labelKey)}
						{id === "all" || n > 0 ? <span class="slice__n">{n}</span> : null}
					</button>
				);
			})}
		</div>
	);
}
