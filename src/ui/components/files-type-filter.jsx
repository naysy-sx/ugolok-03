import { t } from "../signals/i18n.js";

// Подписи типа на экране «Файлы». Не MediaButtons: клик НЕ открывает оверлей.
const CHIPS = [
	{ id: "all", labelKey: "files.typeAll" },
	{ id: "image", labelKey: "files.typeImages" },
	{ id: "video", labelKey: "files.typeVideo" },
	{ id: "audio", labelKey: "files.typeAudio" },
	{ id: "other", labelKey: "files.typeDocs" },
];

export default function TypeFilterBar({ counts, active, onSelect }) {
	const visible = CHIPS.filter((c) => c.id === "all" || (counts?.[c.id] ?? 0) > 0);
	return (
		<div class="tabs file-types bar" style={{ "--gap": "var(--space-s)" }} role="tablist">
			{visible.map(({ id, labelKey }) => {
				const n = counts?.[id] ?? 0;
				const on = active === id;
				return (
					<button
						key={id}
						type="button"
						class="tab"
						role="tab"
						aria-selected={on}
						onClick={() => onSelect(id)}
					>
						{t(labelKey)}
						{id !== "all" && n > 0 ? <span class="slice__n">{n}</span> : null}
					</button>
				);
			})}
		</div>
	);
}
